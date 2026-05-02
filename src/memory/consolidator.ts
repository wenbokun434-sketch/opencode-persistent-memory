/**
 * 记忆合并器 — 去重、冲突消解、时间衰减
 *
 * 处理记忆入库前的质量管控：
 * 1. 余弦相似度 >0.95 → 自动覆盖更新
 * 2. 余弦相似度 0.85-0.95 → 调用沙箱 LLM 判定
 * 3. 时间衰减权重 <0.65 → 标记 INVALID
 */
import { sandboxFetch } from "../security/sandbox-fetch.js"
import { embeddingDaemon } from "../embedding/daemon.js"
import type { MemoryRecord, MemoryQueryResult } from "./schema.js"
import {
  SIMILARITY_AUTO_OVERRIDE,
  SIMILARITY_LLM_THRESHOLD,
  FORGETTING_WEIGHT_THRESHOLD,
  computeWeightedScore,
  generateMemoryId,
} from "./schema.js"
import type { IMemoryStore } from "../storage/interface.js"

const CONFLICT_JUDGE_PROMPT =
  `你是一个代码偏好冲突判定引擎。判断以下两条编程习惯是否存在冲突。

如果是同一偏好的更新版本 → 回复 YES
如果是不相关的不同偏好 → 回复 NO
如果是直接矛盾的偏好 → 回复 CONFLICT

只回复 YES, NO 或 CONFLICT，不要输出其他内容。`

export interface ConsolidateOptions {
  providerId?: string
}

export class MemoryConsolidator {
  private store: IMemoryStore

  constructor(store: IMemoryStore) {
    this.store = store
  }

  async consolidate(
    newRecords: Array<{
      entity: string
      relation: string
      value: string
      entityType: MemoryRecord["entityType"]
      scope: MemoryRecord["scope"]
      confidence: number
      source: string
      projectId: string
    }>,
    options: ConsolidateOptions = {},
  ): Promise<MemoryRecord[]> {
    const providerId = options.providerId ?? "anthropic"
    const results: MemoryRecord[] = []

    for (const rec of newRecords) {
      const existing = await this.findSimilar(rec)

      if (existing.length === 0) {
        const record = this.createRecord(rec, "PENDING")
        await this.store.insert(record)
        results.push(record)
        continue
      }

      const topMatch = existing[0]

      if (topMatch.similarity >= SIMILARITY_AUTO_OVERRIDE) {
        await this.handleAutoOverride(topMatch.record, rec)
        results.push(topMatch.record)
        continue
      }

      if (topMatch.similarity >= SIMILARITY_LLM_THRESHOLD) {
        const resolved = await this.handleLLMConflict(
          topMatch.record,
          rec,
          providerId,
        )
        results.push(resolved)
        continue
      }

      const record = this.createRecord(rec, "PENDING")
      await this.store.insert(record)
      results.push(record)
    }

    return results
  }

  async applyTimeDecay(projectId: string): Promise<number> {
    const activeMemories = await this.store.listByStatus("ACTIVE", projectId)
    let forgottenCount = 0

    for (const memory of activeMemories) {
      const daysSinceAccess =
        (Date.now() - memory.lastAccessed) / (1000 * 60 * 60 * 24)
      const weight = computeWeightedScore(1, daysSinceAccess)

      if (weight < FORGETTING_WEIGHT_THRESHOLD) {
        await this.store.markInvalid(memory.id)
        forgottenCount++
      }
    }

    const pendingMemories = await this.store.listByStatus("PENDING", projectId)
    for (const memory of pendingMemories) {
      const daysSinceCreation =
        (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24)
      if (daysSinceCreation > 90) {
        await this.store.markInvalid(memory.id)
        forgottenCount++
      }
    }

    return forgottenCount
  }

  private async findSimilar(rec: {
    entity: string
    value: string
    projectId: string
  }): Promise<MemoryQueryResult[]> {
    try {
      const vectors = await embeddingDaemon.embed(
        [`${rec.entity}: ${rec.value}`],
        "query",
      )
      const queryVector = vectors[0]
      return this.store.search({
        vector: queryVector,
        limit: 3,
        projectId: rec.projectId,
        status: "ACTIVE",
      })
    } catch (err) {
      console.warn(`[Consolidator] 相似度搜索失败: ${(err as Error).message}`)
      return []
    }
  }

  private createRecord(
    rec: {
      entity: string
      relation: string
      value: string
      entityType: MemoryRecord["entityType"]
      scope: MemoryRecord["scope"]
      confidence: number
      source: string
      projectId: string
    },
    status: MemoryRecord["status"],
  ): MemoryRecord {
    const now = Date.now()
    return {
      id: generateMemoryId(),
      entity: rec.entity,
      relation: rec.relation,
      value: rec.value,
      entityType: rec.entityType,
      scope: rec.scope,
      projectId: rec.projectId,
      status,
      confidence: rec.confidence,
      source: rec.source,
      timestamp: now,
      lastAccessed: now,
    }
  }

  private async handleAutoOverride(
    existing: MemoryRecord,
    update: {
      entity: string
      relation: string
      value: string
      entityType: MemoryRecord["entityType"]
      scope: MemoryRecord["scope"]
      confidence: number
      source: string
    },
  ): Promise<void> {
    await this.store.update(existing.id, {
      value: update.value,
      relation: update.relation,
      confidence: Math.max(existing.confidence, update.confidence),
      source: update.source,
      lastAccessed: Date.now(),
    })
  }

  private async handleLLMConflict(
    existing: MemoryRecord,
    update: {
      entity: string
      relation: string
      value: string
      entityType: MemoryRecord["entityType"]
      scope: MemoryRecord["scope"]
      confidence: number
      source: string
      projectId: string
    },
    providerId: string,
  ): Promise<MemoryRecord> {
    const prompt = `记忆A: ${existing.entity} → ${existing.relation} → ${existing.value}\n记忆B: ${update.entity} → ${update.relation} → ${update.value}`

    const response = await sandboxFetch({
      systemPrompt: CONFLICT_JUDGE_PROMPT,
      userPrompt: prompt,
      providerId,
      maxTokens: 10,
      temperature: 0,
    })

    const verdict = response.content.trim().toUpperCase()

    if (verdict === "YES") {
      await this.handleAutoOverride(existing, update)
      return existing
    }

    if (verdict === "CONFLICT") {
      await this.store.markInvalid(existing.id)
      const record = this.createRecord(update, "PENDING")
      await this.store.insert(record)
      return record
    }

    if (verdict === "NO") {
      const record = this.createRecord(update, "PENDING")
      await this.store.insert(record)
      return record
    }

    console.warn(
      `[Consolidator] LLM 冲突判定返回非预期值: "${verdict}"，按 NO 处理并新建记忆`,
    )
    const record = this.createRecord(update, "PENDING")
    await this.store.insert(record)
    return record
  }
}
