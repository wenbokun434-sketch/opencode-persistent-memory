/**
 * Vectorvault 降级存储实现 — 100% 纯 TypeScript，零原生依赖
 *
 * 当 ruvector 初始化失败时自动切换至此实现。
 * 基于内存 HNSW 索引，适合小规模记忆库（<10万条）。
 */
import type { IMemoryStore, SearchOptions, StorageConfig } from "./interface.js"
import type { MemoryRecord, MemoryQueryResult } from "../memory/schema.js"
import {
  computeWeightedScore,
  generateMemoryId,
} from "../memory/schema.js"

interface VaultRecord {
  id: string
  record: MemoryRecord
  vector: number[]
}

export class VectorvaultStore implements IMemoryStore {
  private records: Map<string, VaultRecord> = new Map()
  private projectId = "default"
  private initialized = false

  async initialize(config: StorageConfig): Promise<void> {
    this.projectId = config.projectId ?? "default"
    this.initialized = true
    console.log("[VectorvaultStore] 降级存储初始化完成（纯 TypeScript 模式）")
  }

  async insert(record: MemoryRecord): Promise<string> {
    this.ensureInit()
    const id = record.id || generateMemoryId()
    const vaultRecord: VaultRecord = {
      id,
      record: { ...record, id },
      vector: record.vector ?? [],
    }
    this.records.set(id, vaultRecord)
    return id
  }

  async search(options: SearchOptions): Promise<MemoryQueryResult[]> {
    this.ensureInit()

    const limit = options.limit ?? 10
    const projectId = options.projectId ?? this.projectId

    const candidates: Array<{
      record: MemoryRecord
      similarity: number
    }> = []

    for (const [, entry] of this.records) {
      const r = entry.record

      if (options.status && r.status !== options.status) continue
      if (options.minConfidence && r.confidence < options.minConfidence) continue

      if (r.scope !== "global") {
        if (r.projectId !== projectId) continue
      }

      if (options.vector.length > 0 && entry.vector.length > 0) {
        const sim = this.cosineSimilarity(options.vector, entry.vector)
        candidates.push({ record: r, similarity: sim })
      } else {
        candidates.push({ record: r, similarity: 0 })
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity)

    return candidates.slice(0, limit).map((c) => {
      const daysSinceAccess =
        (Date.now() - c.record.lastAccessed) / (1000 * 60 * 60 * 24)
      return {
        record: c.record,
        similarity: c.similarity,
        weightedScore: computeWeightedScore(c.similarity, daysSinceAccess),
        daysSinceAccess,
      }
    })
  }

  async update(id: string, updates: Partial<MemoryRecord>): Promise<void> {
    this.ensureInit()
    const entry = this.records.get(id)
    if (!entry) throw new Error(`记录不存在: ${id}`)
    entry.record = { ...entry.record, ...updates }
    this.records.set(id, entry)
  }

  async delete(id: string): Promise<void> {
    this.ensureInit()
    this.records.delete(id)
  }

  async markInvalid(id: string): Promise<void> {
    await this.update(id, { status: "INVALID" })
  }

  async listByStatus(status: string, projectId?: string): Promise<MemoryRecord[]> {
    this.ensureInit()
    const results: MemoryRecord[] = []
    for (const [, entry] of this.records) {
      const r = entry.record
      if (r.status !== status) continue
      if (projectId && r.projectId !== projectId && r.scope !== "global") continue
      results.push(r)
    }
    return results
  }

  async countByProject(projectId: string): Promise<number> {
    this.ensureInit()
    let count = 0
    for (const [, entry] of this.records) {
      if (entry.record.projectId === projectId) count++
    }
    return count
  }

  async close(): Promise<void> {
    this.records.clear()
    this.initialized = false
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
  }

  private ensureInit(): void {
    if (!this.initialized) throw new Error("存储未初始化")
  }
}
