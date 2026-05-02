/**
 * session-hooks.ts 单元测试
 */
import { describe, it, expect } from "vitest"
import { hashProjectPath, buildMemoryContextBlock } from "../hooks/session-hooks.js"

describe("hashProjectPath", () => {
  it("返回 proj_ 前缀", () => {
    const result = hashProjectPath("/home/user/projects/my-app")
    expect(result.startsWith("proj_")).toBe(true)
  })

  it("相同路径产生相同哈希", () => {
    const a = hashProjectPath("/Users/test/project")
    const b = hashProjectPath("/Users/test/project")
    expect(a).toBe(b)
  })

  it("不同路径产生不同哈希", () => {
    const a = hashProjectPath("/path/a")
    const b = hashProjectPath("/path/b")
    expect(a).not.toBe(b)
  })

  it("空字符串返回合法值", () => {
    const result = hashProjectPath("")
    expect(result).toBe("proj_0")
  })

  it("Windows 路径格式同样可用", () => {
    const result = hashProjectPath("C:\\Users\\test\\project")
    expect(result.startsWith("proj_")).toBe(true)
    expect(result.length).toBeGreaterThan(5)
  })

  it("确定性：同一输入多次调用结果一致", () => {
    const path = "/some/random/path/here"
    const results = Array.from({ length: 10 }, () => hashProjectPath(path))
    expect(new Set(results).size).toBe(1)
  })
})

describe("buildMemoryContextBlock", () => {
  const makeMem = (entity: string, value: string, confidence: number) => ({
    entity,
    relation: "prefers",
    value,
    entityType: "preference",
    scope: "project",
    confidence,
  })

  it("按置信度降序排列", () => {
    const memories = [
      makeMem("A", "v1", 0.5),
      makeMem("B", "v2", 0.9),
      makeMem("C", "v3", 0.7),
    ]
    const result = buildMemoryContextBlock(memories)
    const lines = result.split("\n")
    expect(lines[0]).toContain("B")
    expect(lines[1]).toContain("C")
    expect(lines[2]).toContain("A")
  })

  it("超过 15 条时截断为 15 条", () => {
    const memories = Array.from({ length: 25 }, (_, i) =>
      makeMem(`Entity${i}`, `value${i}`, i / 25),
    )
    const result = buildMemoryContextBlock(memories)
    const lines = result.split("\n")
    expect(lines.length).toBe(15)
  })

  it("少于 15 条时全部返回", () => {
    const memories = [makeMem("A", "v1", 0.8), makeMem("B", "v2", 0.6)]
    const result = buildMemoryContextBlock(memories)
    expect(result.split("\n").length).toBe(2)
  })

  it("空数组返回空字符串", () => {
    const result = buildMemoryContextBlock([])
    expect(result).toBe("")
  })

  it("输出包含标签和箭头格式", () => {
    const memories = [makeMem("React", "functional components", 0.95)]
    const result = buildMemoryContextBlock(memories)
    expect(result).toContain("[preference, project]")
    expect(result).toContain("→")
    expect(result).toContain("置信度: 0.95")
  })
})
