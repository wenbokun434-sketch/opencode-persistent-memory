/**
 * 存储层抽象接口 — 统一 ruvector 与 vectorvault 的调用契约
 */
import type { MemoryRecord, MemoryQueryResult } from "../memory/schema.js"

export interface StorageConfig {
  storePath: string
  projectId?: string
}

export interface SearchOptions {
  vector: number[]
  limit?: number
  projectId?: string
  scope?: string
  status?: string
  minConfidence?: number
}

export interface IMemoryStore {
  initialize(config: StorageConfig): Promise<void>

  insert(record: MemoryRecord): Promise<string>

  search(options: SearchOptions): Promise<MemoryQueryResult[]>

  update(id: string, updates: Partial<MemoryRecord>): Promise<void>

  delete(id: string): Promise<void>

  markInvalid(id: string): Promise<void>

  listByStatus(status: string, projectId?: string): Promise<MemoryRecord[]>

  countByProject(projectId: string): Promise<number>

  close(): Promise<void>
}

export function createDefaultConfig(storePath: string): StorageConfig {
  return { storePath }
}
