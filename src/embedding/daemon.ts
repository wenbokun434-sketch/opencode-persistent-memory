/**
 * 长驻子进程管理器 — Daemon + 健康检查 + 自愈
 *
 * 管理 ONNX 嵌入推理子进程的全生命周期：
 * 启动 → 长驻 → 60s Ping-Pong 看门狗 → 僵死重建 → 优雅终止
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

interface PendingRequest {
  resolve: (vector: number[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 30_000
const HEALTH_CHECK_INTERVAL_MS = 60_000
const HEALTH_CHECK_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 60_000

export class EmbeddingDaemon {
  private child: ChildProcess | null = null
  private pending: Map<string, PendingRequest> = new Map()
  private healthTimer: NodeJS.Timeout | null = null
  private ready = false
  private dying = false

  private resolveWorkerPath(): string {
    const compiledPath = join(__dirname, "..", "..", "dist", "embedding", "worker.js")
    if (existsSync(compiledPath)) {
      return compiledPath
    }
    const sourcePath = join(__dirname, "worker.js")
    return sourcePath
  }

  async start(): Promise<void> {
    const workerPath = this.resolveWorkerPath()
    const runtime = process.env.BUN ? "bun" : "node"
    const execArgs: string[] = [workerPath]

    this.child = spawn(runtime, execArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      cwd: join(__dirname, "..", ".."),
    })

    // stderr 改用 readline 逐行解析，防止 OS 缓冲区切割导致分片
    let workerReady = false
    const rlErr = createInterface({ input: this.child.stderr! })
    rlErr.on("line", (line: string) => {
      const msg = line.trim()
      if (!msg) return
      console.warn(`[EmbeddingDaemon] ${msg}`)
      if (!workerReady && msg.includes("模型加载完成")) {
        workerReady = true
      }
    })

    this.child.on("exit", (code, signal) => {
      if (!this.dying) {
        console.warn(
          `[EmbeddingDaemon] 子进程意外退出 (code=${code}, signal=${signal})，将自动重建`,
        )
        this.ready = false
        this.rejectAllPending(new Error("子进程退出"))
        setTimeout(() => this.start(), 1000)
      }
    })

    const rlOut = createInterface({ input: this.child.stdout! })
    rlOut.on("line", (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const data = JSON.parse(trimmed) as {
          id: string
          vector?: number[]
          error?: string
          pong?: boolean
        }

        if (data.id && data.pong) {
          const request = this.pending.get(data.id)
          if (request) {
            clearTimeout(request.timer)
            this.pending.delete(data.id)
            request.resolve([])
          }
          return
        }

        const request = this.pending.get(data.id)
        if (!request) return

        clearTimeout(request.timer)
        this.pending.delete(data.id)

        if (data.error) {
          request.reject(new Error(data.error))
        } else if (data.vector) {
          request.resolve(data.vector)
        } else {
          request.reject(new Error("子进程返回空向量"))
        }
      } catch {
        // 忽略非 JSON 输出
      }
    })

    // Promise 内聚：超时 + stderr 就绪检测合并到一处
    await new Promise<void>((resolve) => {
      const readyTimeout = setTimeout(() => {
        if (!workerReady) {
          console.warn("[EmbeddingDaemon] 嵌入模型加载超时，将标记为就绪")
        }
        this.ready = true
        resolve()
      }, READY_TIMEOUT_MS)

      const poll = setInterval(() => {
        if (workerReady) {
          clearTimeout(readyTimeout)
          clearInterval(poll)
          this.ready = true
          resolve()
        }
      }, 100)
    })

    this.startHealthCheck()
  }

  async embed(texts: string[], mode: "query" | "passage"): Promise<number[][]> {
    if (!this.child || !this.ready) {
      throw new Error("嵌入引擎未就绪")
    }

    const results: number[][] = []

    for (const text of texts) {
      const id = `emb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const promise = new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`嵌入请求超时: ${id}`))
        }, REQUEST_TIMEOUT_MS)

        this.pending.set(id, { resolve, reject, timer })
      })

      this.child!.stdin!.write(
        JSON.stringify({ mode, text, id }) + "\n",
      )

      results.push(await promise)
    }

    return results
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      if (!this.child || !this.ready) return

      const pingId = `ping_${Date.now()}`
      const timedOut = setTimeout(() => {
        console.warn("[EmbeddingDaemon] 健康检查超时，重建子进程")
        this.restart()
      }, HEALTH_CHECK_TIMEOUT_MS)

      this.child.stdin!.write(
        JSON.stringify({ mode: "ping", text: "ping", id: pingId }) + "\n",
      )

      const resolveWatcher = (id: string) => {
        if (id === pingId) {
          clearTimeout(timedOut)
        }
      }
      this.pending.set(pingId, {
        resolve: () => resolveWatcher(pingId),
        reject: () => {
          clearTimeout(timedOut)
        },
        timer: timedOut,
      })
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private rejectAllPending(error: Error): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async stop(): Promise<void> {
    this.dying = true
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }

    this.rejectAllPending(new Error("引擎正在关闭"))

    if (this.child) {
      this.child.stdin?.end()
      this.child.kill("SIGTERM")
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL")
        }
      }, 5000)
      this.child = null
    }

    this.ready = false
    this.dying = false
  }
}

export const embeddingDaemon = new EmbeddingDaemon()
