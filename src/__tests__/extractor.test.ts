/**
 * extractor.ts — extractJsonArray 单元测试
 *
 * 该函数从 LLM 原始输出中剥离 markdown 包裹并提取 JSON 数组。
 */
import { describe, it, expect } from "vitest"

// extractJsonArray 是未导出的私有函数，这里内联一个完全相同的副本用于测试
function extractJsonArray(text: string): string {
  let cleaned = text.trim()

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7)
  }
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3)
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3)
  }

  cleaned = cleaned.trim()

  const startIdx = cleaned.indexOf("[")
  if (startIdx === -1) return "[]"
  const endIdx = cleaned.lastIndexOf("]")
  if (endIdx === -1) return "[]"

  return cleaned.slice(startIdx, endIdx + 1)
}

describe("extractJsonArray", () => {
  it("纯 JSON 数组原样返回", () => {
    const result = extractJsonArray('[{"a":1},{"b":2}]')
    expect(JSON.parse(result)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it("markdown json 代码块包裹时剥离", () => {
    const input = '```json\n[{"x":1}]\n```'
    const result = extractJsonArray(input)
    expect(JSON.parse(result)).toEqual([{ x: 1 }])
  })

  it("普通 markdown 代码块包裹时剥离", () => {
    const input = '```\n[{"y":2}]\n```'
    const result = extractJsonArray(input)
    expect(JSON.parse(result)).toEqual([{ y: 2 }])
  })

  it("前后有杂讯文本时提取数组", () => {
    const input = "这是一些文本 [{\"z\":3}] 后面还有文字"
    const result = extractJsonArray(input)
    expect(JSON.parse(result)).toEqual([{ z: 3 }])
  })

  it("空数组", () => {
    const result = extractJsonArray("[]")
    expect(JSON.parse(result)).toEqual([])
  })

  it("markdown 包裹的空数组", () => {
    const input = "```json\n[]\n```"
    const result = extractJsonArray(input)
    expect(JSON.parse(result)).toEqual([])
  })

  it("无数组时返回空数组字符串", () => {
    const result = extractJsonArray("没有任何数组内容")
    expect(result).toBe("[]")
  })

  it("只有左括号无右括号返回空数组", () => {
    const result = extractJsonArray("[1, 2, 3")
    expect(result).toBe("[]")
  })

  it("处理多行 JSON 数组", () => {
    const input = `\`\`\`json
[
  {"entity": "user", "relation": "prefers", "value": "TypeScript"},
  {"entity": "project", "relation": "uses", "value": "React"}
]
\`\`\``
    const result = extractJsonArray(input)
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].entity).toBe("user")
  })

  it("嵌套数组取最外层", () => {
    const input = "[[1,2],[3,4]]"
    const result = extractJsonArray(input)
    expect(JSON.parse(result)).toEqual([[1, 2], [3, 4]])
  })
})
