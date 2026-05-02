/**
 * Ruvector 主存储实现 — 优先使用的向量数据库引擎
 *
 * 支持 Rust Native 绑定（高性能）并可降级为 WASM。
 * 若初始化失败，系统自动切换到 VectorvaultStore。
 */
import type { IMemoryStore, SearchOptions, StorageConfig } from "./interface.js"
import type { MemoryRecord, MemoryQueryResult } from "../memory/schema.js"
import { computeWeightedScore } from "../memory/schema.js"

let RuvectorClass: unknown = null

async function loadRuvector(): Promise<unknown> {
  try {
    const mod = await import("ruvector")
    return mod
  } catch {
    throw new Error("ruvector 加载失败，请检查依赖安装")
  }
}

export class RuvectorStore implements IMemoryStore {
  private db: unknown = null
  private table: unknown = null
  private projectId = "default"

  async initialize(config: StorageConfig): Promise<void> {
    this.projectId = config.projectId ?? "default"

    try {
      const ruvector = (await loadRuvector()) as { connect: (path: string) => Promise<unknown> }
      this.db = await ruvector.connect(config.storePath)

      const dbAny = this.db as { createTable: (name: string, schema: unknown) => Promise<unknown> }
      this.table = await dbAny.createTable("memories", {
        id: "string",
        entity: "string",
        relation: "string",
        value: "string",
        entityType: "string",
        scope: "string",
        projectId: "string",
        status: "string",
        confidence: "number",
        source: "string",
        timestamp: "number",
        lastAccessed: "number",
      })

      console.log("[RuvectorStore] 初始化完成")
    } catch (err) {
      console.warn(
        `[RuvectorStore] 初始化失败: ${(err as Error).message}`,
      )
      throw err
    }
  }

  async insert(record: MemoryRecord): Promise<string> {
    if (!this.table) throw new Error("存储未初始化")
    const tbl = this.table as { add: (data: unknown) => Promise<{ id: string }> }
    const result = await tbl.add({
      ...record,
      vector: record.vector ? new Float32Array(record.vector) : undefined,
    })
    return result.id
  }

  async search(options: SearchOptions): Promise<MemoryQueryResult[]> {
    if (!this.table) throw new Error("存储未初始化")

    const tbl = this.table as {
      search: (vector: Float32Array) => {
        limit: (n: number) => {
          filter: (fn: (r: Record<string, unknown>) => boolean) => Promise<Array<{ record: Record<string, unknown>; similarity: number }>>
        }
      }
    }

    const vector = new Float32Array(options.vector)
    const limit = options.limit ?? 10
    const projectId = options.projectId ?? this.projectId

    const results = await tbl.search(vector).limit(limit * 3).filter((r) => {
      if (options.status && r.status !== options.status) return false
      if (options.scope) {
        if (r.scope === "global") return true
        if (r.projectId === projectId) return true
        return false
      }
      if (r.projectId !== projectId && r.scope !== "global") return false
      if (options.minConfidence && (r.confidence as number) < options.minConfidence) return false
      return true
    })

    return results.slice(0, limit).map((r) => {
      const record = r.record as unknown as MemoryRecord
      const daysSinceAccess =
        (Date.now() - record.lastAccessed) / (1000 * 60 * 60 * 24)
      return {
        record,
        similarity: r.similarity,
        weightedScore: computeWeightedScore(r.similarity, daysSinceAccess),
        daysSinceAccess,
      }
    })
  }

  async update(id: string, updates: Partial<MemoryRecord>): Promise<void> {
    if (!this.table) throw new Error("存储未初始化")
    const tbl = this.table as { update: (id: string, data: unknown) => Promise<void> }
    await tbl.update(id, updates)
  }

  async delete(id: string): Promise<void> {
    if (!this.table) throw new Error("存储未初始化")
    const tbl = this.table as { delete: (id: string) => Promise<void> }
    await tbl.delete(id)
  }

  async markInvalid(id: string): Promise<void> {
    await this.update(id, { status: "INVALID" })
  }

  async listByStatus(status: string, projectId?: string): Promise<MemoryRecord[]> {
    if (!this.table) throw new Error("存储未初始化")
    const tbl = this.table as {
      filter: (fn: (r: Record<string, unknown>) => boolean) => Promise<Array<{ record: Record<string, unknown> }>>
    }
    const results = await tbl.filter((r) => {
      if (r.status !== status) return false
      if (projectId && r.projectId !== projectId && r.scope !== "global") return false
      return true
    })
    return results.map((r) => r.record as unknown as MemoryRecord)
  }

  async countByProject(projectId: string): Promise<number> {
    if (!this.table) throw new Error("存储未初始化")
    const tbl = this.table as {
      filter: (fn: (r: Record<string, unknown>) => boolean) => Promise<Array<unknown>>
    }
    const results = await tbl.filter((r) => r.projectId === projectId)
    return results.length
  }

  async close(): Promise<void> {
    this.table = null
    this.db = null
  }
}
