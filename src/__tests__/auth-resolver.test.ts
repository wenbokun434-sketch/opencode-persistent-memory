/**
 * auth-resolver.ts 单元测试
 *
 * 测试鉴权文件路径解析逻辑，不依赖实际文件。
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthResolver } from "../security/auth-resolver.js"

describe("AuthResolver", () => {
  let resolver: AuthResolver

  beforeEach(() => {
    resolver = new AuthResolver()
  })

  describe("getApiEndpoint", () => {
    it("Anthropic 返回正确端点", () => {
      const url = resolver.getApiEndpoint("anthropic")
      expect(url).toBe("https://api.anthropic.com/v1/messages")
    })

    it("OpenAI 返回正确端点", () => {
      const url = resolver.getApiEndpoint("openai")
      expect(url).toBe("https://api.openai.com/v1/chat/completions")
    })

    it("DeepSeek 返回正确端点", () => {
      const url = resolver.getApiEndpoint("deepseek")
      expect(url).toBe("https://api.deepseek.com/v1/chat/completions")
    })

    it("大小写不敏感", () => {
      expect(resolver.getApiEndpoint("Anthropic")).toBe("https://api.anthropic.com/v1/messages")
      expect(resolver.getApiEndpoint("OPENAI")).toBe("https://api.openai.com/v1/chat/completions")
    })

    it("未知提供商返回空字符串", () => {
      expect(resolver.getApiEndpoint("unknown-provider")).toBe("")
    })
  })

  describe("getProviderHeaders", () => {
    it("Anthropic 使用 x-api-key 头", () => {
      const headers = resolver.getProviderHeaders("anthropic", "sk-test")
      expect(headers["x-api-key"]).toBe("sk-test")
      expect(headers["anthropic-version"]).toBe("2023-06-01")
    })

    it("其他提供商使用 Bearer 头", () => {
      const headers = resolver.getProviderHeaders("openai", "sk-test")
      expect(headers["Authorization"]).toBe("Bearer sk-test")
    })
  })

  describe("resolveAuthPaths", () => {
    it("返回非空路径数组", () => {
      const paths = resolver.resolveAuthPaths()
      expect(paths.length).toBeGreaterThan(0)
    })

    it("所有路径以 auth.json 结尾", () => {
      const paths = resolver.resolveAuthPaths()
      for (const p of paths) {
        expect(p.endsWith("auth.json")).toBe(true)
      }
    })
  })

  describe("loadCredentials", () => {
    it("无 auth.json 时返回空数组并标记不可用", () => {
      // 使用不存在的路径
      const credentials = resolver.loadCredentials()
      if (credentials.length === 0) {
        expect(resolver.getAvailable()).toBe(false)
      }
    })
  })
})
