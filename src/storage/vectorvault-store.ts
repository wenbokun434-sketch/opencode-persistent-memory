/**
 * Vectorvault 降级存储实现 — 100% 纯 TypeScript，零原生依赖
 *
 * 当 ruvector 初始化失败时自动切换至此实现。
 * 基于内存 Map + JSON 文件持久化，适合小规模记忆库（<10万条）。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname } from "node:path"
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
  private filePath = ""

  async initialize(config: StorageConfig): Promise<void> {
    this.projectId = config.projectId ?? "default"
    this.filePath = `${config.storePath}/vectorvault_memories.json`
    this.initialized = true

    try {
      await this.loadFromDisk()
    } catch (err) {
      console.warn(
        `[VectorvaultStore] 无法从磁盘恢复数据: ${(err as Error).message}`,
      )
    }

    console.log("[VectorvaultStore] 降级存储初始化完成（纯 TypeScript + 磁盘持久化模式）")
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
    await this.saveToDisk()
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
      if (options.minConfidence !== undefined && r.confidence < options.minConfidence) continue

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
    await this.saveToDisk()
  }

  async delete(id: string): Promise<void> {
    this.ensureInit()
    this.records.delete(id)
    await this.saveToDisk()
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
    try {
      await this.saveToDisk()
    } catch {
      // 关闭时保存失败不应阻止资源释放
    }
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

  private async saveToDisk(): Promise<void> {
    if (!this.filePath) return
    const data: Array<{
      id: string
      record: MemoryRecord
      vector: number[]
    }> = []
    for (const [, entry] of this.records) {
      data.push({
        id: entry.id,
        record: entry.record,
        vector: entry.vector,
      })
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8")
    } catch (err) {
      throw new Error(`[VectorvaultStore] 保存磁盘失败: ${(err as Error).message}`)
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.filePath || !existsSync(this.filePath)) return
    const raw = readFileSync(this.filePath, "utf-8")
    const data = JSON.parse(raw) as Array<{
      id: string
      record: MemoryRecord
      vector: number[]
    }>
    for (const entry of data) {
      this.records.set(entry.id, {
        id: entry.id,
        record: entry.record,
        vector: entry.vector,
      })
    }
  }

  private ensureInit(): void {
    if (!this.initialized) throw new Error("存储未初始化")
  }
}
