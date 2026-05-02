/**
 * 嵌入推理 Worker 子进程
 *
 * 独立进程运行 ONNX 推理，通过 stdin/stdout JSONL 与主进程通信。
 * 生命周期由 daemon.ts 管理。
 */
import { pipeline, env } from "@xenova/transformers"
import { createInterface } from "node:readline"

const MODEL_NAME = "Xenova/bge-base-en-v1.5"

interface WorkerRequest {
  mode: "query" | "passage" | "ping"
  text: string
  id: string
}

interface WorkerResponse {
  id: string
  vector?: number[]
  error?: string
  pong?: boolean
}

let extractor: ((texts: string[]) => Promise<Array<{ data: Float32Array }>>) | null = null

async function initialize() {
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = false

  const pipe = await pipeline("feature-extraction", MODEL_NAME, {
    quantized: true,
  })

  extractor = async (texts: string[]) => {
    const results: Array<{ data: Float32Array }> = []
    for (const text of texts) {
      const result = await pipe(text, {
        pooling: "mean",
        normalize: true,
      })
      results.push({ data: new Float32Array(result.data as Float32Array) })
    }
    return results
  }

  process.stderr.write(`[EmbeddingWorker] 模型 ${MODEL_NAME} 加载完成\n`)
}

function toResponse(response: WorkerResponse): string {
  return JSON.stringify(response) + "\n"
}

async function processRequest(request: WorkerRequest): Promise<void> {
  if (request.mode === "ping") {
    process.stdout.write(toResponse({ id: request.id, pong: true }))
    return
  }

  if (!extractor) {
    process.stdout.write(
      toResponse({ id: request.id, error: "模型尚未加载" }),
    )
    return
  }

  try {
    const prefixedText =
      request.mode === "query"
        ? `query: ${request.text}`
        : `passage: ${request.text}`

    const [result] = await extractor([prefixedText])
    const vector = Array.from(result.data)

    process.stdout.write(toResponse({ id: request.id, vector }))
  } catch (err) {
    process.stdout.write(
      toResponse({
        id: request.id,
        error: `推理失败: ${(err as Error).message}`,
      }),
    )
  }
}

async function main() {
  await initialize()

  const rl = createInterface({ input: process.stdin })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const request = JSON.parse(trimmed) as WorkerRequest
      await processRequest(request)
    } catch {
      process.stdout.write(
        toResponse({ id: "unknown", error: "JSON 解析失败" }),
      )
    }
  }
}

process.on("SIGTERM", () => {
  process.stderr.write("[EmbeddingWorker] 收到 SIGTERM，正在退出\n")
  process.exit(0)
})

process.on("SIGINT", () => {
  process.stderr.write("[EmbeddingWorker] 收到 SIGINT，正在退出\n")
  process.exit(0)
})

main().catch((err) => {
  process.stderr.write(`[EmbeddingWorker] 致命错误: ${err.message}\n`)
  process.exit(1)
})
