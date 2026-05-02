# opencode-persistent-memory

[![npm version](https://img.shields.io/npm/v/opencode-persistent-memory)](https://www.npmjs.com/package/opencode-persistent-memory)
[![license](https://img.shields.io/npm/l/opencode-persistent-memory)](./LICENSE)

**OpenCode 跨会话记忆插件** — 让 AI 记住你的编码偏好、架构决策和项目习惯，跨会话持久保留。

- 🔒 **100% 本地脱机** — 所有数据存储在本地，不上传任何第三方云端
- ⚡ **零配置** — 无需 Docker、无需数据库、无需 API Key 注册
- 🧠 **双模型沙箱防御** — 记忆提取使用独立的无工具权限 LLM 调用，物理隔绝 Prompt Injection
- 📐 **时间衰减算法** — 30 天半衰期，自动遗忘陈旧偏好
- 🔄 **双轨存储降级** — ruvector（Rust Native）→ vectorvault（纯 TypeScript），跨平台零编译依赖

---

## 安装

### 方式一：NPM（推荐）

在 `opencode.json` 中添加：

```json
{
  "plugin": ["opencode-persistent-memory"]
}
```

重启 OpenCode，插件将自动安装并激活。

### 方式二：本地克隆

```bash
git clone https://github.com/wenbokun434-sketch/opencode-persistent-memory.git ~/.config/opencode/plugins/opencode-persistent-memory
cd ~/.config/opencode/plugins/opencode-persistent-memory
npm install
```

---

## 使用

### 自然语言交互（无需记忆命令）

插件注册了 4 个工具，LLM 会根据你的自然语言自动调用：

| 你输入的内容 | LLM 调用的工具 | 效果 |
|-------------|---------------|------|
| "看看你都记住了什么" | `memory_digest` | 展示待审批的记忆列表 |
| "审批并保存全部记忆" | `memory_approve` | 将 PENDING 记忆激活 |
| "删除记忆 abcdef12" | `memory_forget` | 标记指定记忆为无效 |
| "搜索关于 React 偏好的记忆" | `memory_search` | 语义检索相关记忆 |

### 自动化功能

- **自动提取** — 每次执行 `bash` / `edit` / `write` 工具后，后台自动提取编码偏好存入 PENDING
- **上下文注入** — 创建新会话时，静默注入当前项目的 ACTIVE 记忆
- **时间衰减** — 30 天未使用的记忆权重减半；PENDING 超过 90 天自动失效

---

## 工作原理

```
用户对话 → tool.execute.after 触发 → 记忆提取 (Dual-LLM 沙箱)
         ↓
    去重 + 冲突消解 (余弦相似度 + 时间衰减)
         ↓
    PENDING 记忆 → 用户审批 → ACTIVE 记忆
         ↓
    新会话创建 → 检索 ACTIVE 记忆 → noReply 静默注入
```

### 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 嵌入模型 | Xenova/bge-base-en-v1.5 (ONNX q8) | 102M 参数，150MB 内存，纯本地 WASM 推理 |
| 并发隔离 | child_process.spawn() + JSONL IPC | 长驻子进程 + 60s Ping-Pong 健康检查 |
| 主存储 | ruvector | Rust Native → WASM 降级 |
| 降级存储 | vectorvault | 100% TypeScript，零原生依赖 |
| 安全沙箱 | Dual-LLM (绕过 SDK，无 tools 载荷) | 物理级别 Prompt Injection 防御 |
| 时间衰减 | W = cos_sim × e^(-0.0231×Δt) | 30 天半衰期，权重 <0.65 静默遗忘 |

---

## 内存占用

| 场景 | 内存 |
|------|------|
| ONNX 嵌入模型（常驻子进程） | ~150MB |
| 存储引擎（ruvector / vectorvault） | ~50-100MB |
| OpenCode 本体 | ~200MB |
| **总计（含余量）** | **500-700MB** |

建议 8GB+ 内存的开发机使用。

---

## 安全性

- **零数据外泄** — 记忆数据仅存储在 `~/.config/opencode/memory_store/`
- **Dual-LLM 物理沙箱** — 记忆提取使用独立的无工具权限 API 调用，恶意 Prompt Injection 无法执行任何破坏性操作
- **项目作用域隔离** — 记忆强制绑定项目 ID，防止跨项目污染
- **鉴权本地存储** — API Key 从系统 auth.json 读取，不额外存储

---

## 从源码编译

```bash
git clone https://github.com/wenbokun434-sketch/opencode-persistent-memory.git
cd opencode-persistent-memory
npm install
npm run typecheck
```

---

## License

MIT
