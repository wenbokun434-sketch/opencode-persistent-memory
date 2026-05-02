/**
 * 嵌入引擎 — 占位实现（OpenCode 插件上下文不支持 ONNX WASM）
 *
 * OpenCode 内置 Node.js 环境不支持 @xenova/transformers（原生模块 sharp 缺失），
 * 且 spawn 子进程被 OpenCode 进程管理器拦截。嵌入推理功能暂时禁用。
 *
 * 影响的用户功能：memory_search 语义搜索、相似记忆自动去重。
 * 不受影响的功能：记忆提取、审批、遗忘、会话上下文注入。
 */

export const embeddingDaemon = {
  ready: false,

  async start(): Promise<void> {
    console.log("[EmbeddingDaemon] 嵌入引擎已禁用 — 语义搜索和去重暂不可用")
  },

  async embed(_texts: string[], _mode: string): Promise<number[][]> {
    throw new Error("嵌入引擎未就绪")
  },

  async stop(): Promise<void> {
    // no-op
  },

  async restart(): Promise<void> {
    // no-op
  },
}
