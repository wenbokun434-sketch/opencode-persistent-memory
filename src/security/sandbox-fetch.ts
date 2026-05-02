/**
 * 安全沙箱 Fetch — 剥夺 tools 权限的 Dual-LLM 调用
 *
 * 绕过 OpenCode SDK 直接向 LLM 提供商发送 REST 请求，
 * Payload 中完全不包含 tools 字段，实现物理级别 Prompt Injection 防御。
 */
import { authResolver, type AuthCredentials } from "./auth-resolver.js"

export interface SandboxPromptConfig {
  systemPrompt: string
  userPrompt: string
  providerId: string
  modelId?: string
  maxTokens?: number
  temperature?: number
}

export interface SandboxResponse {
  content: string
  success: boolean
  error?: string
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-3-haiku-20240307",
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
}

export async function sandboxFetch(
  config: SandboxPromptConfig,
): Promise<SandboxResponse> {
  if (!authResolver.getAvailable()) {
    return {
      content: "",
      success: false,
      error: "Dual-LLM 沙箱凭证不可用",
    }
  }

  const credentials = authResolver.loadCredentials()
  const cred = findCredential(credentials, config.providerId)

  if (!cred) {
    return {
      content: "",
      success: false,
      error: `未找到提供商 ${config.providerId} 的 API 密钥`,
    }
  }

  const endpoint = authResolver.getApiEndpoint(cred.providerId)
  const headers = authResolver.getProviderHeaders(cred.providerId, cred.apiKey)

  const modelId =
    config.modelId ?? DEFAULT_MODELS[cred.providerId.toLowerCase()] ?? "gpt-4o-mini"

  const isAnthropic = cred.providerId.toLowerCase().includes("anthropic")

  try {
    let body: string

    if (isAnthropic) {
      body = JSON.stringify({
        model: modelId,
        max_tokens: config.maxTokens ?? 1024,
        temperature: config.temperature ?? 0.1,
        system: config.systemPrompt,
        messages: [{ role: "user", content: config.userPrompt }],
        // 核心：不包含 tools 字段，物理隔离
      })
    } else {
      body = JSON.stringify({
        model: modelId,
        max_tokens: config.maxTokens ?? 1024,
        temperature: config.temperature ?? 0.1,
        messages: [
          { role: "system", content: config.systemPrompt },
          { role: "user", content: config.userPrompt },
        ],
        // 核心：不包含 tools 字段，物理隔离
      })
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown")
      return {
        content: "",
        success: false,
        error: `API 错误 ${response.status}: ${errText.slice(0, 200)}`,
      }
    }

    const data = (await response.json()) as Record<string, unknown>

    let content: string

    if (isAnthropic) {
      const contentList = data.content as Array<{ type: string; text: string }>
      content = contentList?.map((c) => c.text).join("") ?? ""
    } else {
      const choices = data.choices as Array<{
        message: { content: string }
      }>
      content = choices?.[0]?.message?.content ?? ""
    }

    return { content, success: true }
  } catch (err) {
    return {
      content: "",
      success: false,
      error: `沙箱请求异常: ${(err as Error).message}`,
    }
  }
}

function findCredential(
  credentials: AuthCredentials[],
  providerId: string,
): AuthCredentials | undefined {
  const lower = providerId.toLowerCase()
  return credentials.find((c) => c.providerId.toLowerCase().includes(lower))
}
