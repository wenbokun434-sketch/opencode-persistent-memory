/**
 * 嵌入引擎 — 进程内 ONNX 推理
 *
 * 直接在插件进程内加载 @xenova/transformers 模型，
 * 不 spawn 子进程，避免 OpenCode 的进程管理器冲突。
 * 使用动态 import 延迟加载，避免模块级静态导入时的 WASM 初始化阻塞。
 */

const MODEL_NAME = "Xenova/bge-base-en-v1.5"

async function loadTransformers() {
  const mod = await import("@xenova/transformers")
  const env = mod.env
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = false
  // HuggingFace 直连不通时用镜像站
  env.remoteHost = process.env.HF_ENDPOINT ?? "https://hf-mirror.com"
  return mod
}

type TransformersMod = Awaited<ReturnType<typeof loadTransformers>>
type Extractor = (texts: string[]) => Promise<Array<{ data: Float32Array }>>

class EmbeddingEngine {
  private extractor: Extractor | null = null
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      const mod = await loadTransformers()

      const pipe = await mod.pipeline("feature-extraction", MODEL_NAME, {
        quantized: true,
      })

      this.extractor = async (texts: string[]) => {
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

      console.log(`[EmbeddingEngine] 模型 ${MODEL_NAME} 加载完成`)
    })()

    return this.initPromise
  }

  async embed(texts: string[], mode: "query" | "passage"): Promise<number[][]> {
    await this.init()

    if (!this.extractor) throw new Error("嵌入模型未初始化")

    const prefixed = texts.map((text) =>
      mode === "query" ? `query: ${text}` : `passage: ${text}`,
    )

    const results = await this.extractor(prefixed)
    return results.map((r) => Array.from(r.data))
  }

  async close(): Promise<void> {
    this.extractor = null
    this.initPromise = null
  }
}

export const embeddingEngine = new EmbeddingEngine()

export class EmbeddingDaemon {
  private ready = false

  async start(): Promise<void> {
    // 异步初始化模型，不阻塞插件启动
    embeddingEngine.init().then(() => {
      this.ready = true
      console.log("[EmbeddingDaemon] 嵌入引擎就绪（进程内模式）")
    }).catch((err) => {
      console.warn(`[EmbeddingDaemon] 嵌入引擎启动失败: ${(err as Error).message}`)
    })
  }

  async embed(texts: string[], mode: "query" | "passage"): Promise<number[][]> {
    if (!this.ready) throw new Error("嵌入引擎未就绪")
    return embeddingEngine.embed(texts, mode)
  }

  async stop(): Promise<void> {
    await embeddingEngine.close()
    this.ready = false
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }
}

export const embeddingDaemon = new EmbeddingDaemon()
