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
  const credentials = authResolver.loadCredentials()
  let cred = findCredential(credentials, config.providerId)

  // 纵深防御：请求的 provider 无凭证时，自动降级到首个可用 provider
  if (!cred && credentials.length > 0) {
    cred = credentials[0]
    console.warn(
      `[SandboxFetch] ${config.providerId} 无可用凭证，自动降级至 ${cred.providerId}`,
    )
  }

  if (!cred) {
    return {
      content: "",
      success: false,
      error: "Dual-LLM 沙箱凭证不可用，请检查 auth.json",
    }
  }

  const endpoint = cred.baseUrl ?? authResolver.getApiEndpoint(cred.providerId)
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

    let content = ""

    if (isAnthropic) {
      const rawContent = data.content
      if (Array.isArray(rawContent)) {
        content = rawContent
          .map((c: unknown) => (c as { text?: string })?.text ?? "")
          .join("")
      }
    } else {
      const choices = data.choices
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as { message?: { content?: string } }
        content = first?.message?.content ?? ""
      }
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
  const exact = credentials.find((c) => c.providerId.toLowerCase() === lower)
  if (exact) return exact
  return credentials.find((c) => c.providerId.toLowerCase().includes(lower))
}
