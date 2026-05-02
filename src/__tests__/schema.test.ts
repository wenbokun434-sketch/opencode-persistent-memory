/**
 * schema.ts 单元测试
 */
import { describe, it, expect } from "vitest"
import {
  computeWeightedScore,
  generateMemoryId,
  TIME_DECAY_LAMBDA,
  FORGETTING_WEIGHT_THRESHOLD,
} from "../memory/schema.js"

describe("computeWeightedScore", () => {
  it("刚访问时权重等于相似度", () => {
    const result = computeWeightedScore(0.9, 0)
    expect(result).toBeCloseTo(0.9, 5)
  })

  it("30天后权重衰减约一半 (e^(-0.0231*30) ≈ 0.5)", () => {
    const result = computeWeightedScore(1.0, 30)
    expect(result).toBeCloseTo(0.5, 1)
  })

  it("无限天数趋近于 0", () => {
    const result = computeWeightedScore(1.0, 1000)
    expect(result).toBeCloseTo(0, 3)
  })

  it("60天后权重下降到 0.25 左右", () => {
    // e^(-0.0231 * 60) = e^(-1.386) ≈ 0.25
    const result = computeWeightedScore(1.0, 60)
    expect(result).toBeCloseTo(0.25, 1)
  })

  it("低于遗忘阈值 (0.65) 应该发生在约 18.6 天后", () => {
    // e^(-0.0231 * d) = 0.65 → d = ln(0.65) / -0.0231 ≈ 18.6
    const result18 = computeWeightedScore(1.0, 18)
    expect(result18).toBeGreaterThan(FORGETTING_WEIGHT_THRESHOLD)
    const result19 = computeWeightedScore(1.0, 20)
    expect(result19).toBeLessThan(FORGETTING_WEIGHT_THRESHOLD)
  })
})

describe("generateMemoryId", () => {
  it("以 mem_ 前缀开头", () => {
    const id = generateMemoryId()
    expect(id.startsWith("mem_")).toBe(true)
  })

  it("每次生成不重复", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateMemoryId())
    }
    expect(ids.size).toBe(100)
  })

  it("长度固定为 20", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateMemoryId().length).toBe(20)
    }
  })

  it("格式为 mem_ 后跟 16 位十六进制字符", () => {
    const id = generateMemoryId()
    const suffix = id.slice(4)
    expect(suffix).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("TIME_DECAY_LAMBDA", () => {
  it("30 天半衰期公式正确: e^(-lambda * 30) ≈ 0.5", () => {
    const halfLife = Math.exp(-TIME_DECAY_LAMBDA * 30)
    expect(halfLife).toBeCloseTo(0.5, 1)
  })
})
