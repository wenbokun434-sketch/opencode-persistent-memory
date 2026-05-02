/**
 * sandbox-fetch.ts 单元测试
 *
 * 测试 API 返回格式运行时校验 (P1-3)。
 * 使用 mock fetch 模拟异常 API 返回格式。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("../security/auth-resolver.js", () => ({
  authResolver: {
    loadCredentials: vi.fn(() => [{ providerId: "openai", apiKey: "sk-test", baseUrl: "https://test.api/v1" }]),
    getAvailable: vi.fn(() => true),
    getApiEndpoint: vi.fn(() => "https://test.api/v1/chat/completions"),
    getProviderHeaders: vi.fn(() => ({ Authorization: "Bearer sk-test", "content-type": "application/json" })),
    resolveAuthPaths: vi.fn(() => []),
    tryAddCredential: vi.fn(),
  },
}))

import { sandboxFetch } from "../security/sandbox-fetch.js"

describe("sandboxFetch", () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("Anthropic 返回 content 为字符串时兜底为空字符串", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: "不是数组" }),
    })

    const result = await sandboxFetch({
      systemPrompt: "test",
      userPrompt: "test",
      providerId: "anthropic",
    })

    expect(result.success).toBe(true)
    expect(result.content).toBe("")
  })

  it("OpenAI 返回 choices 缺少 message 时兜底为空字符串", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ something: "else" }] }),
    })

    const result = await sandboxFetch({
      systemPrompt: "test",
      userPrompt: "test",
      providerId: "openai",
    })

    expect(result.success).toBe(true)
    expect(result.content).toBe("")
  })

  it("正常 OpenAI 返回格式正确解析", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "你好" } }],
      }),
    })

    const result = await sandboxFetch({
      systemPrompt: "test",
      userPrompt: "test",
      providerId: "openai",
    })

    expect(result.success).toBe(true)
    expect(result.content).toBe("你好")
  })

  it("网络异常时返回 success: false", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("网络中断"))

    const result = await sandboxFetch({
      systemPrompt: "test",
      userPrompt: "test",
      providerId: "openai",
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("网络中断")
  })
})
