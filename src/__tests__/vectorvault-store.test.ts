/**
 * vectorvault-store.ts 单元测试
 *
 * 测试内存存储 + JSON 持久化的完整生命周期。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rmSync, existsSync } from "node:fs"
import { VectorvaultStore } from "../storage/vectorvault-store.js"
import type { MemoryRecord } from "../memory/schema.js"

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now()
  return {
    id: `test_${now}_${Math.random().toString(36).slice(2, 8)}`,
    entity: "test-entity",
    relation: "prefers",
    value: "TypeScript",
    entityType: "preference",
    scope: "project",
    projectId: "proj_test",
    status: "PENDING",
    confidence: 0.9,
    source: "chat",
    timestamp: now,
    lastAccessed: now,
    vector: Array.from({ length: 768 }, () => Math.random()),
    ...overrides,
  }
}

describe("VectorvaultStore", () => {
  let store: VectorvaultStore
  let storePath: string

  beforeEach(async () => {
    storePath = join(tmpdir(), `vv_test_${Date.now()}`)
    store = new VectorvaultStore()
    await store.initialize({ storePath, projectId: "proj_test" })
  })

  afterEach(async () => {
    await store.close()
    if (existsSync(storePath)) {
      try { rmSync(storePath, { recursive: true, force: true }) } catch {}
    }
  })

  describe("insert + listByStatus", () => {
    it("插入后可列出", async () => {
      const record = makeRecord({ status: "PENDING" })
      await store.insert(record)

      const pending = await store.listByStatus("PENDING")
      expect(pending).toHaveLength(1)
      expect(pending[0].entity).toBe("test-entity")
    })

    it("不同状态分别列出", async () => {
      await store.insert(makeRecord({ status: "PENDING" }))
      await store.insert(makeRecord({ status: "ACTIVE" }))
      await store.insert(makeRecord({ status: "INVALID" }))

      expect(await store.listByStatus("PENDING")).toHaveLength(1)
      expect(await store.listByStatus("ACTIVE")).toHaveLength(1)
    })

    it("listByStatus 可过滤 projectId", async () => {
      await store.insert(makeRecord({ projectId: "proj_a", status: "ACTIVE" }))
      await store.insert(makeRecord({ projectId: "proj_b", status: "ACTIVE" }))

      const a = await store.listByStatus("ACTIVE", "proj_a")
      expect(a).toHaveLength(1)
      expect(a[0].projectId).toBe("proj_a")
    })

    it("global scope 记忆跨项目可见", async () => {
      await store.insert(makeRecord({ projectId: "proj_a", scope: "global", status: "ACTIVE" }))

      const fromB = await store.listByStatus("ACTIVE", "proj_b")
      expect(fromB).toHaveLength(1)
    })
  })

  describe("update", () => {
    it("更新记录字段", async () => {
      const record = makeRecord({ status: "PENDING", confidence: 0.3 })
      const id = await store.insert(record)

      await store.update(id, { status: "ACTIVE", confidence: 0.95 })

      const active = await store.listByStatus("ACTIVE")
      expect(active).toHaveLength(1)
      expect(active[0].confidence).toBeCloseTo(0.95)
    })

    it("更新不存在的 ID 抛出异常", async () => {
      await expect(store.update("nonexistent", { status: "ACTIVE" })).rejects.toThrow()
    })
  })

  describe("delete", () => {
    it("删除后不可列出", async () => {
      const record = makeRecord()
      const id = await store.insert(record)

      await store.delete(id)
      const all = await store.listByStatus("PENDING")
      expect(all).toHaveLength(0)
    })
  })

  describe("markInvalid", () => {
    it("标记为 INVALID 后 listByStatus 可查", async () => {
      const record = makeRecord({ status: "ACTIVE" })
      const id = await store.insert(record)

      await store.markInvalid(id)
      const invalid = await store.listByStatus("INVALID")
      expect(invalid).toHaveLength(1)
    })
  })

  describe("countByProject", () => {
    it("统计项目记忆数", async () => {
      await store.insert(makeRecord({ projectId: "proj_x" }))
      await store.insert(makeRecord({ projectId: "proj_x" }))
      await store.insert(makeRecord({ projectId: "proj_y" }))

      expect(await store.countByProject("proj_x")).toBe(2)
      expect(await store.countByProject("proj_y")).toBe(1)
    })
  })

  describe("search", () => {
    it("按相似度排序返回结果", async () => {
      const v = Array.from({ length: 768 }, () => Math.random())
      await store.insert(makeRecord({ vector: v, status: "ACTIVE", value: "target" }))

      const results = await store.search({
        vector: v,
        limit: 5,
        projectId: "proj_test",
        status: "ACTIVE",
      })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].similarity).toBeCloseTo(1, 3)
    })

    it("过滤非指定状态", async () => {
      const v = Array.from({ length: 768 }, () => Math.random())
      await store.insert(makeRecord({ vector: v, status: "PENDING", value: "hidden" }))

      const results = await store.search({
        vector: v,
        limit: 5,
        status: "ACTIVE",
      })
      expect(results).toHaveLength(0)
    })
  })

  describe("磁盘持久化", () => {
    it("insert 后持久化文件存在", async () => {
      await store.insert(makeRecord())
      expect(existsSync(join(storePath, "vectorvault_memories.json"))).toBe(true)
    })

    it("关闭后重新初始化可恢复数据", async () => {
      const record = makeRecord({ status: "ACTIVE" })
      await store.insert(record)
      await store.close()

      const store2 = new VectorvaultStore()
      await store2.initialize({ storePath, projectId: "proj_test" })

      const active = await store2.listByStatus("ACTIVE")
      expect(active.length).toBeGreaterThanOrEqual(1)
      expect(active.some((r) => r.entity === record.entity)).toBe(true)

      await store2.close()
    })

    it("delete 后持久化文件更新", async () => {
      const record = makeRecord()
      const id = await store.insert(record)
      await store.delete(id)

      const raw = await store.listByStatus("PENDING")
      expect(raw).toHaveLength(0)
    })
  })
})
