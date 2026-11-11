# Internet应用开发作业 2：FrontAgent

作业方向：AI Agent 项目。项目是用于前端工程的 AI 编程智能体，通过规划、执行与工具调用完成开发任务。

## 需求分析

让 AI 在已有前端仓库中工作，需要明确目标、仓库结构与修改约束，并能够查看计划、执行过程和结果。FrontAgent 围绕这些需求组织能力：规划阶段形成执行计划，执行阶段调用工具，SDD 提供规格约束，Filesense 提供仓库结构上下文。

本次课程提交展示这条核心链路，不以工具数量或宣传指标代替功能演示。项目完整功能和命令以根目录 [README](../README.md) 为准。

## 方案设计与代码入口

| 内容 | 代码/文档入口 | 讲解重点 |
| --- | --- | --- |
| CLI 入口 | `apps/cli/` | 用户如何输入任务，如何选择运行方式 |
| Agent 核心 | `packages/core/` | 规划与执行如何分层、交换信息并处理执行结果 |
| 运行时接入 | `packages/runtime-node/` | CLI 等宿主如何复用执行能力 |
| 规格约束 | `packages/sdd/` | SDD 约束怎样参与开发流程 |
| 仓库结构上下文 | `packages/mcp-filesense/` | 如何向 Agent 提供仓库结构信息 |
| 工具调用 | `packages/mcp-file/`、`packages/mcp-shell/` 等 | 文件、命令等操作如何接入及受限 |

更多架构信息见 [architecture.md](architecture.md)。个人负责目标、双阶段分层、技术方案和 SDD 思路，AI 辅助实现的范围见根目录 [AI_USAGE.md](../AI_USAGE.md)。

## 运行说明

环境要求与版本以提交版本的 `package.json`、`pnpm-lock.yaml` 和根目录 README 为准。以下命令在 FrontAgent 仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build:verify
node dist/index.mjs --help
```

执行真实 AI 任务需要用户自行配置可用的模型服务、模型名与凭据；具体配置项见根目录 README。提交材料不包含 API key。命令帮助能显示只证明 CLI 可启动，不代表真实模型任务已经通过。

## 演示方式

在一个独立的小型前端示例仓库中，按根目录 README 完成初始化，提交一个明确的小任务，观察计划、工具执行与结果。建议选择单个页面或组件的有限修改，并验证最终页面或检查命令的结果。

答辩时重点说明：为什么拆成规划与执行、SDD 与 Filesense 各解决什么问题、模型怎样调用工具、遇到错误如何处理、哪些判断由人负责。实际运行结果须以现场演示或对应版本的运行记录为准。

## 提交内容

公开仓库保留源码、README、设计与运行文档、AI 使用声明和完整 Git 历史。课程云盘的提交说明记录提交人、学号、仓库链接和固定 commit，便于教师定位本次提交版本。FrontAgent 为本人已有项目，课程提交材料如实注明该背景，不声称全部代码在本课程期间完成。
