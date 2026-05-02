/**
 * 记忆实体 Schema — 跨会话持久记忆的核心数据结构
 */
export type MemoryScope = "session" | "project" | "global"

export type MemoryStatus = "PENDING" | "ACTIVE" | "INVALID"

export type MemoryEntityType =
  | "preference"
  | "architecture"
  | "error_solution"
  | "convention"
  | "decision"
  | "fact"

export interface MemoryRecord {
  id: string
  entity: string
  relation: string
  value: string
  entityType: MemoryEntityType
  scope: MemoryScope
  projectId: string
  status: MemoryStatus
  confidence: number
  source: string
  timestamp: number
  lastAccessed: number
  vector?: number[]
}

export interface MemoryQueryResult {
  record: MemoryRecord
  similarity: number
  weightedScore: number
  daysSinceAccess: number
}

export interface ExtractionInput {
  messages: Array<{ role: string; content: string }>
  projectId: string
  directory: string
}

export interface ExtractionOutput {
  memories: Array<{
    entity: string
    relation: string
    value: string
    entityType: MemoryEntityType
    scope: MemoryScope
    confidence: number
    source: string
  }>
}

export const TIME_DECAY_LAMBDA = 0.0231

export const SIMILARITY_AUTO_OVERRIDE = 0.95

export const SIMILARITY_LLM_THRESHOLD = 0.85

export const FORGETTING_WEIGHT_THRESHOLD = 0.65

export function computeWeightedScore(
  similarity: number,
  daysSinceAccess: number,
): number {
  return similarity * Math.exp(-TIME_DECAY_LAMBDA * daysSinceAccess)
}

import { randomUUID } from "node:crypto"

export function generateMemoryId(): string {
  return `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`
}
