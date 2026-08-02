# 更新日志

该文件记录项目的主要版本变更。

## [Unreleased]

### 修复

- **guard**：`hallucinationGuard.enabled: false` 现在会关闭 agent 路径上的所有 `HallucinationGuard` 检查，同时保留项目根目录包含性的安全边界。它管不到执行器自带的文件系统事实 grounding——后者在 `apply_patch` 命中已知不存在路径时照样拦截，与 guard 配置无关，因此设了这个开关的消融臂并不等于「所有拦截都关掉了」。另外，单独关闭 `fileExistence` 时 `validate()` 现在也会保留越界包含性判定，此前这条路径不产出任何结果。（#400）

## [2.2.0] - 2026-07-30

### 新增
- **desktop**：全新 Electron 桌面客户端——类型化 IPC 契约与执行 reducer、Task Console 与设置面板（React + Vite）、主进程 runtime bridge 与设置存储、IPC 故障降级态、无障碍语义（ARIA live region、focus-visible、reduced-motion），并通过 electron-builder 打包多平台 zip 附到 GitHub Releases。
- **cli/headless**：非交互 headless 模式与 JSON 输出契约——校验 `--output`、payload 暴露 artifacts 与安全拒绝记录、JSON 运行期间拦截 stdout 直写、顶层错误分类。
- **core/session**：会话恢复——完整 step schema、顺序无关的恢复解锁、跨步骤文件上下文水合、加载时按 schema 校验会话记录。
- **runtime/hooks**：生命周期 hooks——项目 hooks 显式 opt-in、加固 hook 管线、postToolUse 观测每个工具结果、日志回调故障与 hook 策略决策隔离。
- **security/permissions**：声明式权限规则与会话内派生 allow 规则（转义字面通配符；always-allow 审批不再派生裸工具规则）。
- **core/context**：上下文分区预算——最终序列化 prompt 全路径预算化（含 fallback），保证预算后置条件与单次压缩摘要。
- **core/instructions**：AGENTS.md 项目指令加载，指令文件读取受字节上限约束。
- **mcp-web-fetch**：新增 `@frontagent/mcp-web-fetch` 适配包并接入 agent registry 与 planner。
- **prompts**：codegen 与 planner 注入外部知识、安全工程与代码极简纪律；code-quality 子代理新增安全评审维度。
- **benchmarks/eval**：可复现的 SDD 消融评测——冻结 30 任务集、typecheck-clean fixture 工程、双臂编排器（支持断点续跑）、机器可校验验收，附结果报告与复现指南。
- **docs**：README 可验证 npm 下载量计数（每日刷新）；桌面客户端文档。

### 修复
- **cli**：全局安装的 `fa`（npm/pnpm/homebrew symlink bin）不再静默退出——入口守卫比较前先解析 argv 的 symlink 真实路径。（#396）
- **guard**：executor 校验路径（`validateFilePath` / `validateCode`）现在尊重 `hallucinationGuard.checks` 配置；禁用 `fileExistence` 时项目根目录包含性安全边界仍然生效。（#386）
- **core/llm**：迁移至 AI SDK v5（清除 GHSA-rwvc-j5jr-mgvh），OpenAI provider 对 OpenAI 兼容 baseURL 显式固定 Chat Completions 端点。
- **planner**：生成计划时保留 `web_fetch` 动作。
- **agent**：依赖恢复使用项目自身的包管理器。
- **desktop**：默认工作区设置生效、telemetry 日志仅在底部时自动滚动、移除 TaskComposer 演示内容、设置保存成功向辅助技术播报。
- **runtime-node**：会话 id 约束在 sessions 目录内并原子写入；失败的 taskComplete hooks 携带真实 taskId；win32 进程树终止。
- **workflow**：workflow-rules 门禁兼容 vars 形式的自托管 Repo Guard runner，干净检出下 pre-commit/pre-push 钩子恢复绿色。（#397）

### 变更
- **ci**：Repo Guard 迁移至自托管 Claude Code 引擎，`pull_request_target` + fork PR 触发者白名单；catch-all CODEOWNERS 规则要求所有 PR 经 owner 评审；OpenRouter provider 顺序透传至 Repo Guard。
- **deps**：ts-morph 升级至 ^28；AI SDK 迁移至 v5 线。

### 测试
- CLI 入口守卫 symlink 覆盖；guard 开关独立性与禁用态包含性覆盖；executor read_file 判别性用例。
- runtime 编排与关停顺序、两阶段计划生成、step 回调契约、executor skills、跨语言语义边界检测。


## [2.1.1] - 2026-06-09

### 变更
- **core/executor**：拆分 Executor 的工具调用处理、校验跳过逻辑、进度约束、步骤反馈和 trace 记录逻辑，保持执行行为不变，同时降低核心执行路径的维护成本。
- **core/agent**：从 FrontAgent 主编排流程中提取上下文收集、facts 刷新、项目预扫描、任务执行准备和执行回调逻辑，减少主循环耦合。
- **core/context**：拆分 context fact 序列化、facts 合并、文件系统 facts 更新和模块依赖图更新逻辑，提升上下文持久化与工作区事实刷新的可测性。
- **core/planner**：拆分 planner phase helper，并补充 phase 处理相关测试。
- **mcp-filesense**：拆分 Filesense engine 的 helper、索引、notes、query 和 schema 编排职责，为查询、notes、schema 与索引持久化补充独立模块边界。
- **mcp-memory**：拆分 memory preload/recall helper 和持久化 writer，隔离记忆 I/O 与召回编排逻辑。
- **mcp-memory/rag**：从知识库实现中提取语义检索编排逻辑，保持 hybrid RAG 行为不变。
- **runtime-node**：拆分 runtime MCP task invocation setup，使 MCP server 的 schema 断言和 task handler 组装更清晰。
- **vscode**：拆分 webview body、script、style 和 template renderer，并补充对应测试，保持侧边栏 UI 行为不变。
- **sub-agents**：拆分 code-quality subagent prompt policy。
- **tooling**：移除临时 GitNexus RC patch，并对齐 Biome schema 版本。

### 修复
- **vscode/security**：加固 VS Code webview nonce 生成。
- **filesense**：保留 Filesense query 的相对路径语义。
- **filesense**：生成 Filesense notes 时保留 notes schema path 归属。
- **workflow**：恢复并加固本地 GitNexus contract gate。
- **workflow**：修复 core worktree 相对路径解析，并防止 bootstrap 在 worktree 不匹配时继续执行。

### 测试
- 新增 CLI command router 覆盖。
- 新增 runtime MCP contract 与 schema assertion 覆盖。
- 新增 hybrid RAG knowledge-base 覆盖。
- 新增 executor 在校验跳过、进度约束、步骤反馈、工具调用处理和 trace 记录上的覆盖。
- 新增 agent 在上下文收集、facts 刷新、项目预扫描、执行回调和任务执行准备上的覆盖。
- 新增 ContextManager 在 fact 序列化、facts 合并、文件系统 facts 更新和模块依赖图上的覆盖。
- 新增 Filesense engine helper、索引持久化、notes 生成、query result 和 schema 编排覆盖。
- 新增 memory preload/recall helper 与 persistence writer 覆盖。
- 新增 VS Code webview body、script、style 和 template renderer 覆盖。
- 清理 executor、shared utility 和 LLM service 测试中的 Biome warning。

### 兼容性说明
- npm CLI 包与 VS Code 扩展版本更新为 `2.1.1`。
- Node.js 要求保持 `>=20.0.0`。
- VS Code 扩展要求保持 `^1.120.0`。

## [1.0.1] - 2026-04-30

### 新增
- 新增首版 FrontAgent VS Code 桌面插件，在 Activity Bar 提供侧边栏任务台。
- 新增 VS Code 内的任务输入、当前文件/选区上下文、浏览器 URL 上下文、Run/Cancel、阶段与步骤进度、审批卡片和运行日志入口。
- 新增 VS Code 插件中的 SDD 初始化与校验命令。
- 新增共享的 `@frontagent/runtime-node` 运行时 API，供 CLI 与 VS Code 插件复用。
- 新增 FrontAgent 执行链路中的协作式 `AbortSignal` 取消支持。

### 变更
- 更新 npm 包元数据，对齐 `1.0.1` 版本发布。
- 文档补充 CLI 与 VS Code 插件两种使用方式。
- `fa run` 改为复用共享 Node runtime，同时保留原有 Ink 终端交互体验。

## [0.1.8] - 2026-04-29

### 新增
- 新增 `fa -v` 作为 CLI 版本输出短参数。
- 新增 `fa version` 显式版本命令。

## [0.1.7] - 2026-04-29

### 新增
- 新增渐进式探索协议，引导文件系统变更先观察、再确认、最后写入。
- 新增 FrontAgent 内置身份上下文，让“你是谁 / 你能做什么”这类 query 能基于稳定身份事实回答。

### 变更
- 将发布后的 CLI 命令从 `frontagent` 缩短为 `fa`。
- 精简 `fa run` 默认输出为状态摘要、工具调用摘要和最终回答，冗长内部日志仅在 `--debug` 中展示。

### 修复
- 修复 ESM bundle 中缺少 `__filename` 导致 `fa run` 崩溃的问题。
- 规范化已经包含 `/chat/completions` 的 OpenAI-compatible base URL。
- 修复 query 任务只完成工具步骤却没有最终回答时仍显示成功的问题。

## [0.1.6] - 2026-03-22

### 新增
- 新增基于 Weaviate 的 RAG 语义向量存储，同时保留本地 BM25 索引。
- 新增 RAG 缓存包导出/导入流程，用于分发预构建知识库索引。
- 新增仅用于检索前的大模型查询改写步骤，可将用户输入改写为更适合前端知识库检索的专业查询。

### 变更
- 明确统一 RAG 相关术语：远程 RAG 证据统一称为“知识库”，不再与当前工作区仓库混淆。
- 更新中英文文档，补充 Weaviate、查询改写和缓存包分发示例。

### 修复
- 修复 query 任务中 Planner 将远程 RAG 命中误判为当前工作区本地文件的问题。
- 优化 Weaviate 语义索引与相关 RAG 执行链路的稳定性。

## [0.1.5] - 2026-03-16

### 修复
- 修正 npm 发布元数据：
  - `bin.frontagent` 调整为 `dist/index.cjs`，避免 npm 发布时自动移除 CLI 入口。
  - `repository.url` 规范为 `git+https://github.com/ceilf6/FrontAgent.git`。
- 新增中英文变更日志，提升版本可追踪性。

## [0.1.4] - 2026-03-16

### 新增
- 引入 Planner / Executor Skills 层，支持技能化扩展与阶段注入。

### 变更
- 统一浏览器工具命名为 `browser_*`，并保留兼容别名。
- 更新中英文 README 的 Skills 使用说明与示例。

### 修复
- Planner 快照类型收敛为 `ReadonlyMap`，降低技能误改上下文风险。
- 修正文档中 `search_code` 示例参数为 `filePattern`。
