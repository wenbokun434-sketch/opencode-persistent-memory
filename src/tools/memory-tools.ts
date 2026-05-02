/**
 * 用户交互 Tool 集合 — 自定义工具的隔离模块
 *
 * 每个 Tool 使用 OpenCode 原生 Zod schema 定义参数，
 * 通过自然语言与 LLM 交互来触发。
 */
import type { IMemoryStore } from "../storage/interface.js"
import { embeddingDaemon } from "../embedding/daemon.js"
import { computeWeightedScore } from "../memory/schema.js"
import { hashProjectPath } from "../hooks/session-hooks.js"

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("zh-CN")
}

async function findFullId(
  store: IMemoryStore,
  idSuffix: string,
): Promise<string> {
  const pending = await store.listByStatus("PENDING")
  const active = await store.listByStatus("ACTIVE")
  const all = [...pending, ...active]
  const match = all.find((m) => m.id.endsWith(idSuffix))
  if (!match) throw new Error(`未找到 ID: ${idSuffix}`)
  return match.id
}

export function createMemoryDigestTool(store: IMemoryStore) {
  return {
    description:
      "检索并展示最近捕获的待审批隐式记忆事实列表",
    args: {
      limit: {
        type: "number" as const,
        description: "返回的记忆条数上限，默认 10",
      },
    },
    async execute(
      args: { limit?: number },
      context: { directory: string },
    ) {
      const limit = args.limit ?? 10
      const projectId = hashProjectPath(context.directory)
      const pending = await store.listByStatus("PENDING", projectId)

      if (pending.length === 0) {
        return "当前没有待审批的记忆。"
      }

      const rows = pending.slice(0, limit).map((m, i) => {
        return `| ${i + 1} | \`${m.id.slice(-8)}\` | ${m.entity}: ${m.value} | ${m.entityType} | ${m.confidence.toFixed(2)} | ${formatDate(m.timestamp)} |`
      })

      const table = [
        "| # | ID | 内容 | 类型 | 置信度 | 日期 |",
        "|---|-----|------|------|--------|------|",
        ...rows,
        "",
        `共 ${pending.length} 条待审批记忆。`,
        `输入"审批并保存前 N 条记忆"来管理。`,
      ].join("\n")

      return table
    },
  }
}

export function createMemoryApproveTool(store: IMemoryStore) {
  return {
    description: "批量审批并激活记忆，将 PENDING 转为 ACTIVE",
    args: {
      ids: {
        type: "string" as const,
        description: "要审批的记忆 ID（逗号分隔），或输入 'all' 审批全部",
      },
    },
    async execute(
      args: { ids?: string },
      context: { directory: string },
    ) {
      const projectId = hashProjectPath(context.directory)

      if (!args.ids || args.ids === "all") {
        const pending = await store.listByStatus("PENDING", projectId)
        for (const m of pending) {
          await store.update(m.id, {
            status: "ACTIVE",
            lastAccessed: Date.now(),
          })
        }
        return `已审批并激活全部 ${pending.length} 条记忆。`
      }

      const idList = args.ids.split(",").map((s) => s.trim())
      let count = 0
      for (const idSuffix of idList) {
        try {
          const fullId = await findFullId(store, idSuffix)
          await store.update(fullId, {
            status: "ACTIVE",
            lastAccessed: Date.now(),
          })
          count++
        } catch {
          // 忽略不存在的 ID
        }
      }

      return `已审批并激活 ${count} 条记忆。`
    },
  }
}

export function createMemoryForgetTool(store: IMemoryStore) {
  return {
    description: "删除或标记指定记忆为无效",
    args: {
      id: {
        type: "string" as const,
        description: "要删除的记忆 ID（后 8 位字符）",
      },
    },
    async execute(args: { id: string }) {
      try {
        const fullId = await findFullId(store, args.id)
        await store.markInvalid(fullId)
        return `已标记记忆 \`${args.id}\` 为无效。`
      } catch {
        return `未找到 ID 包含 \`${args.id}\` 的记忆。`
      }
    },
  }
}

export function createMemorySearchTool(store: IMemoryStore) {
  return {
    description: "语义检索记忆库，输入查询返回最相关记忆",
    args: {
      query: {
        type: "string" as const,
        description: "自然语言搜索查询",
      },
      limit: {
        type: "number" as const,
        description: "返回结果数上限，默认 5",
      },
    },
    async execute(
      args: { query: string; limit?: number },
      context: { directory: string },
    ) {
      const limit = args.limit ?? 5
      const projectId = hashProjectPath(context.directory)

      try {
        const vectors = await embeddingDaemon.embed([args.query], "query")
        const queryVector = vectors[0]

        const results = await store.search({
          vector: queryVector,
          limit,
          projectId,
          status: "ACTIVE",
        })

        if (results.length === 0) {
          return "未找到相关记忆。"
        }

        const rows = results.map((r, i) => {
          const ws = computeWeightedScore(
            r.similarity,
            r.daysSinceAccess,
          )
          return `| ${i + 1} | ${r.record.entity}: ${r.record.value} | ${r.similarity.toFixed(2)} | ${ws.toFixed(2)} | ${formatDate(r.record.lastAccessed)} |`
        })

        const table = [
          "| # | 记忆 | 相似度 | 衰减权重 | 最后访问 |",
          "|---|------|--------|----------|----------|",
          ...rows,
        ].join("\n")

        return table
      } catch (err) {
        return `记忆搜索失败: ${(err as Error).message}`
      }
    },
  }
}
