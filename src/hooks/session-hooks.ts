/**
 * 会话事件钩子
 *
 * session.created: 新会话启动时注入持久记忆上下文
 * tool.execute.after: 工具执行后提取记忆
 */
import type { MemoryRecord as MemoryRecordForContext, MemoryScope as MemoryScopeForContext, MemoryEntityType as MemoryEntityTypeForContext } from "../memory/schema.js"

export function buildMemoryContextBlock(
  memories: Array<{
    entity: string
    relation: string
    value: string
    entityType: string
    scope: string
    confidence: number
  }>,
): string {
  const sorted = [...memories]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15)

  return sorted
    .map((m) => {
      const tags = [m.entityType, m.scope].filter(Boolean).join(", ")
      return `- [${tags}] ${m.entity} → ${m.relation} → ${m.value} (置信度: ${m.confidence.toFixed(2)})`
    })
    .join("\n")
}

export function hashProjectPath(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return `proj_${Math.abs(hash).toString(36)}`
}
