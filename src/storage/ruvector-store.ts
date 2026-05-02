/**
 * Ruvector 主存储实现 — 优先使用的向量数据库引擎
 *
 * 使用 ruvector 的真实 API：VectorDB 构造器 + insert/search/get/delete。
 * 若初始化失败，系统自动切换到 VectorvaultStore。
 */
import type { IMemoryStore, SearchOptions, StorageConfig } from "./interface.js"
import type { MemoryRecord, MemoryQueryResult } from "../memory/schema.js"
import { computeWeightedScore, generateMemoryId } from "../memory/schema.js"

const VECTOR_DIMENSIONS = 768

type RuvectorDB = {
  insert: (entry: {
    id?: string
    vector: Float32Array | number[]
    metadata?: Record<string, unknown>
  }) => Promise<string>
  insertBatch: (entries: Array<{
    id?: string
    vector: Float32Array | number[]
    metadata?: Record<string, unknown>
  }>) => Promise<string[]>
  search: (query: {
    vector: Float32Array | number[]
    k: number
    filter?: Record<string, unknown>
    efSearch?: number
  }) => Promise<Array<{
    id: string
    score: number
    vector?: Float32Array
    metadata?: Record<string, unknown>
  }>>
  get: (id: string) => Promise<{ id?: string; vector: Float32Array; metadata?: Record<string, unknown> } | null>
  delete: (id: string) => Promise<boolean>
  len: () => Promise<number>
  isEmpty: () => Promise<boolean>
}

let RuvectorVectorDB: (new (options: {
  dimensions: number
  storagePath?: string
  distanceMetric?: string
  metric?: string
  hnswConfig?: Record<string, unknown>
}) => RuvectorDB) | null = null

async function loadRuvector(): Promise<void> {
  if (RuvectorVectorDB) return
  try {
    const mod = (await import("ruvector")) as unknown as {
      VectorDB?: new (options: Record<string, unknown>) => RuvectorDB
      VectorDb?: new (options: Record<string, unknown>) => RuvectorDB
    }
    RuvectorVectorDB = mod.VectorDB ?? mod.VectorDb ?? null
    if (!RuvectorVectorDB) {
      throw new Error("ruvector 导出未找到 VectorDB/VectorDb")
    }
  } catch (err) {
    throw new Error(
      `ruvector 加载失败: ${(err as Error).message}`,
    )
  }
}

function memoryRecordToMetadata(record: MemoryRecord): Record<string, unknown> {
  return {
    entity: record.entity,
    relation: record.relation,
    value: record.value,
    entityType: record.entityType,
    scope: record.scope,
    projectId: record.projectId,
    status: record.status,
    confidence: record.confidence,
    source: record.source,
    timestamp: record.timestamp,
    lastAccessed: record.lastAccessed,
  }
}

function metadataToMemoryRecord(
  id: string,
  metadata: Record<string, unknown>,
  _vector?: number[],
): MemoryRecord {
  return {
    id,
    entity: (metadata.entity as string) ?? "",
    relation: (metadata.relation as string) ?? "",
    value: (metadata.value as string) ?? "",
    entityType: (metadata.entityType as MemoryRecord["entityType"]) ?? "preference",
    scope: (metadata.scope as MemoryRecord["scope"]) ?? "project",
    projectId: (metadata.projectId as string) ?? "default",
    status: (metadata.status as MemoryRecord["status"]) ?? "PENDING",
    confidence: (metadata.confidence as number) ?? 0.5,
    source: (metadata.source as string) ?? "",
    timestamp: (metadata.timestamp as number) ?? Date.now(),
    lastAccessed: (metadata.lastAccessed as number) ?? Date.now(),
  }
}

export class RuvectorStore implements IMemoryStore {
  private db: RuvectorDB | null = null
  private vectorCache: Map<string, number[]> = new Map()
  private projectId = "default"

  async initialize(config: StorageConfig): Promise<void> {
    this.projectId = config.projectId ?? "default"
    await loadRuvector()

    if (!RuvectorVectorDB) {
      throw new Error("ruvector 未加载")
    }

    this.db = new RuvectorVectorDB({
      dimensions: VECTOR_DIMENSIONS,
      storagePath: config.storePath,
      distanceMetric: "cosine",
    })

    console.log("[RuvectorStore] 初始化完成")
  }

  async insert(record: MemoryRecord): Promise<string> {
    if (!this.db) throw new Error("存储未初始化")
    const id = record.id || generateMemoryId()
    const vectorArr = record.vector ?? []

    await this.db.insert({
      id,
      vector: vectorArr.length > 0 ? new Float32Array(vectorArr) : new Float32Array(VECTOR_DIMENSIONS),
      metadata: memoryRecordToMetadata(record),
    })

    if (vectorArr.length > 0) {
      this.vectorCache.set(id, vectorArr)
    }

    return id
  }

  async search(options: SearchOptions): Promise<MemoryQueryResult[]> {
    if (!this.db) throw new Error("存储未初始化")

    const limit = options.limit ?? 10
    const projectId = options.projectId ?? this.projectId
    const k = Math.max(limit * 3, 30)

    const rawResults = await this.db.search({
      vector: new Float32Array(options.vector),
      k,
    })

    const filtered: Array<{ id: string; score: number; metadata: Record<string, unknown> }> = []
    for (const r of rawResults) {
      const meta = r.metadata ?? {}
      if (options.status && meta.status !== options.status) continue
      const scope = (meta.scope as string) ?? "project"
      const recordProjectId = (meta.projectId as string) ?? "default"
      if (scope !== "global" && recordProjectId !== projectId) continue
      if (options.minConfidence !== undefined && ((meta.confidence as number) ?? 0) < options.minConfidence) continue
      filtered.push({ id: r.id, score: r.score, metadata: meta })
    }

    return filtered.slice(0, limit).map((r) => {
      const record = metadataToMemoryRecord(r.id, r.metadata)
      const daysSinceAccess =
        (Date.now() - record.lastAccessed) / (1000 * 60 * 60 * 24)
      return {
        record,
        similarity: r.score,
        weightedScore: computeWeightedScore(r.score, daysSinceAccess),
        daysSinceAccess,
      }
    })
  }

  async update(id: string, updates: Partial<MemoryRecord>): Promise<void> {
    if (!this.db) throw new Error("存储未初始化")

    const existing = await this.db.get(id)
    if (!existing) throw new Error(`记录不存在: ${id}`)

    const oldMeta = existing.metadata ?? {}
    const merged: Record<string, unknown> = { ...oldMeta, ...updates }
    const vectorArr = this.vectorCache.get(id) ??
      (existing.vector ? Array.from(existing.vector) : [])

    // ruvector 无原生 update，用 delete + insert 实现
    await this.db.delete(id)
    await this.db.insert({
      id,
      vector: vectorArr.length > 0 ? new Float32Array(vectorArr) : new Float32Array(VECTOR_DIMENSIONS),
      metadata: merged,
    })
  }

  async delete(id: string): Promise<void> {
    if (!this.db) throw new Error("存储未初始化")
    this.vectorCache.delete(id)
    await this.db.delete(id)
  }

  async markInvalid(id: string): Promise<void> {
    await this.update(id, { status: "INVALID" })
  }

  async listByStatus(status: string, projectId?: string): Promise<MemoryRecord[]> {
    if (!this.db) throw new Error("存储未初始化")

    const count = await this.db.len()
    const k = Math.max(count, 100)
    const dummyVector = new Float32Array(VECTOR_DIMENSIONS)

    const rawResults = await this.db.search({
      vector: dummyVector,
      k,
    })

    const results: MemoryRecord[] = []
    for (const r of rawResults) {
      const meta = r.metadata ?? {}
      if (meta.status !== status) continue
      if (projectId) {
        const scope = (meta.scope as string) ?? "project"
        const recordProjectId = (meta.projectId as string) ?? "default"
        if (scope !== "global" && recordProjectId !== projectId) continue
      }
      results.push(metadataToMemoryRecord(r.id, meta))
    }

    return results
  }

  async countByProject(projectId: string): Promise<number> {
    if (!this.db) throw new Error("存储未初始化")

    const count = await this.db.len()
    const k = Math.max(count, 100)
    const dummyVector = new Float32Array(VECTOR_DIMENSIONS)

    const rawResults = await this.db.search({
      vector: dummyVector,
      k,
    })

    let projectCount = 0
    for (const r of rawResults) {
      const meta = r.metadata ?? {}
      if ((meta.projectId as string) === projectId) {
        projectCount++
      }
    }

    return projectCount
  }

  async close(): Promise<void> {
    this.vectorCache.clear()
    this.db = null
  }
}
