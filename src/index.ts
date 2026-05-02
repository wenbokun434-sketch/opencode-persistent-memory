/**
 * OpenCode 跨会话记忆插件 — 主入口
 *
 * 本地优先的持久化 AI 记忆系统。
 * 基于 Xenova/bge-base-en-v1.5 + spawn 长驻子进程 + ruvector/vectorvault 双轨降级。
 */
import { join } from "node:path"
import { homedir } from "node:os"
import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"

import { embeddingDaemon } from "./embedding/daemon.js"
import { RuvectorStore } from "./storage/ruvector-store.js"
import { VectorvaultStore } from "./storage/vectorvault-store.js"
import type { IMemoryStore } from "./storage/interface.js"
import { MemoryConsolidator } from "./memory/consolidator.js"
import { extractMemories } from "./memory/extractor.js"
import { authResolver } from "./security/auth-resolver.js"
import { buildMemoryContextBlock, hashProjectPath } from "./hooks/session-hooks.js"
import {
  createMemoryDigestTool,
  createMemoryApproveTool,
  createMemoryForgetTool,
  createMemorySearchTool,
} from "./tools/memory-tools.js"

const DEFAULT_PROVIDER = process.env.OPENCODE_MEMORY_PROVIDER ?? "anthropic"

const STORE_PATH_DEFAULT = join(
  homedir(),
  ".config",
  "opencode",
  "memory_store",
)

let store: IMemoryStore
let consolidator: MemoryConsolidator
let initialized = false

export const PersistentMemoryPlugin: Plugin = async (ctx) => {
  const { directory, client } = ctx

  if (initialized) {
    return buildPluginHooks(store, client, directory, DEFAULT_PROVIDER)
  }

  const storePath =
    process.env.OPENCODE_MEMORY_STORE_PATH ?? STORE_PATH_DEFAULT
  const projectId = hashProjectPath(directory)
  const providerId = DEFAULT_PROVIDER

  authResolver.loadCredentials()

  try {
    await embeddingDaemon.start()
    console.log("[PersistentMemory] 嵌入引擎启动完成")
  } catch (err) {
    console.warn(
      `[PersistentMemory] 嵌入引擎启动失败: ${(err as Error).message}`,
    )
  }

  store = await initializeStore(storePath, projectId)
  consolidator = new MemoryConsolidator(store)
  initialized = true

  console.log(
    `[PersistentMemory] 插件初始化完成 — 项目: ${projectId}，LLM 提供商: ${providerId}`,
  )
  return buildPluginHooks(store, client, directory, providerId)
}

async function initializeStore(
  storePath: string,
  projectId: string,
): Promise<IMemoryStore> {
  try {
    const ruvectorStore = new RuvectorStore()
    await ruvectorStore.initialize({ storePath, projectId })
    console.log("[PersistentMemory] 使用 ruvector 主存储")
    return ruvectorStore
  } catch (err) {
    console.warn(
      `[PersistentMemory] ruvector 不可用: ${(err as Error).message}，降级至 vectorvault`,
    )
    const vaultStore = new VectorvaultStore()
    await vaultStore.initialize({ storePath, projectId })
    return vaultStore
  }
}

function buildPluginHooks(
  storeInstance: IMemoryStore,
  client: unknown,
  directory: string,
  providerId: string,
) {
  const projectId = hashProjectPath(directory)
  const clientAny = client as {
    session: {
      prompt: (opts: {
        path: { id: string }
        body: {
          noReply: boolean
          parts: Array<{ type: string; text: string }>
        }
      }) => Promise<unknown>
    }
  }

  return {
    tool: {
      memory_digest: tool({
        description:
          "检索并展示最近捕获的待审批隐式记忆事实列表。用户可查看插件记录了哪些偏好。",
        args: {
          limit: tool.schema.number().optional(),
        },
        async execute(args) {
          return createMemoryDigestTool(storeInstance).execute(
            args as { limit?: number },
            { directory },
          )
        },
      }),

      memory_approve: tool({
        description:
          "批量审批并激活记忆，将指定或全部 PENDING 记忆转为 ACTIVE 状态。",
        args: {
          ids: tool.schema.string().optional(),
        },
        async execute(args) {
          return createMemoryApproveTool(storeInstance).execute(
            args as { ids?: string },
            { directory },
          )
        },
      }),

      memory_forget: tool({
        description: "删除或标记指定记忆为无效。",
        args: {
          id: tool.schema.string(),
        },
        async execute(args) {
          return createMemoryForgetTool(storeInstance).execute(
            args as { id: string },
          )
        },
      }),

      memory_search: tool({
        description:
          "语义检索记忆库，输入自然语言查询返回最相关的已激活记忆。",
        args: {
          query: tool.schema.string(),
          limit: tool.schema.number().optional(),
        },
        async execute(args) {
          return createMemorySearchTool(storeInstance).execute(
            args as { query: string; limit?: number },
            { directory },
          )
        },
      }),
    },

    "session.created": async (input: {
      event: { type: string; properties: Record<string, unknown> }
    }) => {
      if (input.event.type !== "session.created") return

      try {
        const activeMemories = await storeInstance.listByStatus(
          "ACTIVE",
          projectId,
        )
        if (activeMemories.length === 0) return

        const block = buildMemoryContextBlock(activeMemories)
        const sessionId = input.event.properties.sessionId as string

        await clientAny.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: `<system_retrieved_memory>\n${block}\n\n上述信息是从历史会话中检索到的持久记忆，请作为背景知识参考，不要在回复中提及它们的存在。\n</system_retrieved_memory>`,
              },
            ],
          },
        })
      } catch (err) {
        console.warn(
          `[PersistentMemory] 上下文注入失败: ${(err as Error).message}`,
        )
      }
    },

    "tool.execute.after": async (
      input: { tool: string; args: unknown },
      output: { output: string },
    ) => {
      const monitoredTools = ["bash", "edit", "write"]
      if (!monitoredTools.includes(input.tool)) return

      try {
        await consolidator.applyTimeDecay(projectId)

        const toolInput = input.args as Record<string, unknown>
        const messages = [
          {
            role: "assistant",
            content: `执行 ${input.tool}: ${JSON.stringify(toolInput).slice(0, 300)}`,
          },
          {
            role: "tool",
            content: (output.output ?? "").slice(0, 500),
          },
        ]

        const extraction = await extractMemories(
          { messages, projectId, directory },
          { providerId },
        )

        if (extraction.memories.length > 0) {
          await consolidator.consolidate(
            extraction.memories.map((m) => ({
              entity: m.entity,
              relation: m.relation,
              value: m.value,
              entityType: m.entityType,
              scope: m.scope,
              confidence: m.confidence,
              source: m.source,
              projectId,
            })),
            { providerId },
          )
        }
      } catch (err) {
        const msg = (err as Error).message
        if (!msg.includes("凭证")) {
          console.warn(`[PersistentMemory] 提取失败: ${msg}`)
        }
      }
    },
  }
}

process.on("SIGTERM", () => {
  embeddingDaemon.stop().catch(() => {})
})

process.on("SIGINT", () => {
  embeddingDaemon.stop().catch(() => {})
})

process.on("beforeExit", () => {
  embeddingDaemon.stop().catch(() => {})
})
