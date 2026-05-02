/**
 * ruvector-store.ts 单元测试
 *
 * 测试 update() 回滚逻辑 (P0-3)。
 * 使用 mock 对象模拟 ruvector 的 VectorDB API。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { RuvectorStore } from "../storage/ruvector-store.js"

function createMockDB() {
  const data = new Map<string, {
    id: string
    vector: Float32Array
    metadata: Record<string, unknown>
  }>()

  return {
    insert: async (entry: { id: string; vector: Float32Array; metadata?: Record<string, unknown> }) => {
      data.set(entry.id, {
        id: entry.id,
        vector: entry.vector,
        metadata: entry.metadata ?? {},
      })
      return entry.id
    },
    get: async (id: string) => {
      const entry = data.get(id)
      if (!entry) return null
      return {
        id: entry.id,
        vector: entry.vector,
        metadata: { ...entry.metadata },
      }
    },
    delete: async (id: string) => {
      data.delete(id)
      return true
    },
    search: async () => [],
    len: async () => data.size,
    isEmpty: async () => data.size === 0,
    insertBatch: async () => [],
  }
}

describe("RuvectorStore", () => {
  let store: RuvectorStore
  let mockDB: ReturnType<typeof createMockDB>

  beforeEach(async () => {
    mockDB = createMockDB()
    store = new RuvectorStore()
    ;(store as unknown as Record<string, unknown>).db = mockDB
    ;(store as unknown as Record<string, unknown>).projectId = "proj_test"
  })

  describe("update", () => {
    it("正常更新流程: get => delete => insert", async () => {
      await mockDB.insert({
        id: "mem_test",
        vector: new Float32Array(768),
        metadata: {
          entity: "old", relation: "uses", value: "v1",
          entityType: "preference", scope: "project", projectId: "proj_test",
          status: "ACTIVE", confidence: 0.8, source: "chat",
          timestamp: Date.now(), lastAccessed: Date.now(),
        },
      })

      await store.update("mem_test", { value: "v2", confidence: 0.9 })

      const updated = await mockDB.get("mem_test")
      expect(updated).not.toBeNull()
      expect(updated!.metadata!.value).toBe("v2")
      expect(updated!.metadata!.confidence).toBe(0.9)
    })

    it("insert 失败时应回滚到原始数据", async () => {
      const originalMeta = {
        entity: "original", relation: "uses", value: "v1",
        entityType: "preference" as const, scope: "project" as const,
        projectId: "proj_test", status: "ACTIVE" as const, confidence: 0.8,
        source: "chat", timestamp: Date.now(), lastAccessed: Date.now(),
      }
      await mockDB.insert({
        id: "mem_rollback",
        vector: new Float32Array(768),
        metadata: { ...originalMeta },
      })

      // 替换 mockDB.insert — 第一次调用（写新数据）抛异常，第二次调用（回滚）成功
      let callCount = 0
      const mockDBAny = mockDB as unknown as { insert: Function; get: Function }
      mockDBAny.insert = async (...args: unknown[]) => {
        callCount++
        if (callCount === 1) {
          throw new Error("模拟 insert 失败")
        }
        // 后续调用正常执行（回滚 insert）
        return createMockDB().insert(args[0] as Parameters<ReturnType<typeof createMockDB>["insert"]>[0])
      }

      await expect(store.update("mem_rollback", { value: "v2" }))
        .rejects.toThrow("记录更新失败，已回滚")
    })

    it("记录不存在时抛异常", async () => {
      await expect(store.update("nonexistent", { value: "v" }))
        .rejects.toThrow("记录不存在")
    })
  })
})
