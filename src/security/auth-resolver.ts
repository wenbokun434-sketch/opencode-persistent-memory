/**
 * 跨平台鉴权文件寻址 — 读取 OpenCode 的 auth.json 获取 API 密钥
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"

export interface AuthCredentials {
  providerId: string
  apiKey: string
  baseUrl?: string
}

export interface AuthFileEntry {
  id: string
  type: string
  key?: string
  apiKey?: string
  baseUrl?: string
}

export class AuthResolver {
  private cache: Map<string, AuthCredentials> = new Map()
  private available = true

  getAvailable(): boolean {
    return this.available
  }

  resolveAuthPaths(): string[] {
    const paths: string[] = []
    const home = homedir()

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA
      if (localAppData) {
        paths.push(join(localAppData, "opencode", "auth.json"))
      }
      paths.push(join(home, ".local", "share", "opencode", "auth.json"))
    } else if (process.platform === "darwin") {
      paths.push(
        join(home, "Library", "Application Support", "opencode", "auth.json"),
      )
      paths.push(join(home, ".local", "share", "opencode", "auth.json"))
    } else {
      paths.push(join(home, ".local", "share", "opencode", "auth.json"))
    }

    return paths
  }

  loadCredentials(): AuthCredentials[] {
    const paths = this.resolveAuthPaths()
    const credentials: AuthCredentials[] = []

    for (const filePath of paths) {
      if (!existsSync(filePath)) continue
      try {
        const raw = readFileSync(filePath, "utf-8")
        const data: unknown = JSON.parse(raw)

        if (Array.isArray(data)) {
          // 数组格式: [{ id: "deepseek", key: "sk-..." }]
          for (const entry of data as AuthFileEntry[]) {
            this.tryAddCredential(entry.id, entry.key ?? entry.apiKey, entry.baseUrl, credentials)
          }
        } else if (typeof data === "object" && data !== null) {
          // OpenCode 对象格式: { "deepseek": { "type": "api", "key": "sk-..." } }
          for (const [providerId, config] of Object.entries(data as Record<string, unknown>)) {
            if (typeof config !== "object" || config === null) continue
            const cfg = config as Record<string, unknown>
            const apiKey = (cfg.key ?? cfg.apiKey) as string | undefined
            const baseUrl = cfg.baseUrl as string | undefined
            this.tryAddCredential(providerId, apiKey, baseUrl, credentials)
          }
        }
      } catch (err) {
        console.warn(
          `[PersistentMemory] 无法读取鉴权文件 ${filePath}:`,
          (err as Error).message,
        )
      }
    }

    if (credentials.length === 0) {
      this.available = false
      console.warn(
        "[PersistentMemory] Dual-LLM 沙箱凭证失效，记忆提取将跳过云端点。请检查 auth.json。",
      )
    }

    return credentials
  }

  private tryAddCredential(
    providerId: string,
    apiKey: string | undefined,
    baseUrl: string | undefined,
    credentials: AuthCredentials[],
  ): void {
    if (!apiKey || !providerId) return

    const cred: AuthCredentials = {
      providerId,
      apiKey,
      baseUrl,
    }

    const cacheKey = `${cred.providerId}:${cred.apiKey.slice(-8)}`
    if (!this.cache.has(cacheKey)) {
      this.cache.set(cacheKey, cred)
      credentials.push(cred)
    }
  }

  getApiEndpoint(providerId: string): string {
    const lower = providerId.toLowerCase()
    if (lower.includes("anthropic")) {
      return "https://api.anthropic.com/v1/messages"
    }
    if (lower.includes("openai")) {
      return "https://api.openai.com/v1/chat/completions"
    }
    if (lower.includes("deepseek")) {
      return "https://api.deepseek.com/v1/chat/completions"
    }
    return ""
  }

  getProviderHeaders(providerId: string, apiKey: string): Record<string, string> {
    const lower = providerId.toLowerCase()
    if (lower.includes("anthropic")) {
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      }
    }
    return {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    }
  }
}

export const authResolver = new AuthResolver()
