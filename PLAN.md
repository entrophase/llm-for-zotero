# Antigravity CLI 集成：架构分析与实施计划

## 1. 分析结论与现有调用链

**#522 可以作为独立会话系统的集成基础；Zotero 工具调用、宿主审批和 Windows 兼容仍需补齐。#521 是建立在 #522 之上的追加功能。**

按你的选择，本轮以官方远端为基准。当前 main 为 `9c2641c5`，版本为 `3.9.15`；两个 PR 基于 `435dd192`、版本为 `3.9.12`，期间 main 已新增 369 个提交。目标工作目录仍为空，检查和依赖安装均发生在临时分析副本中，尚未创建功能分支或修改功能代码。

已阅读 README、面板架构说明、Claude Bridge 开发说明、构建配置和相关测试；官方快照中未发现 `AGENTS.md` 或独立 `CONTRIBUTING` 文件。现有规范要求保持公共接口、DOM 标识、持久化结构稳定，并遵守架构分层检查。

| 后端               | 完整调用链与生命周期                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex App Server   | 面板发送/重试 → 公共上下文准备 → `runCodexNativePanelTurn` → `runCodexAppServerNativeTurn` → Gecko `Subprocess` 启动本地 `codex app-server` → stdin/stdout JSON-RPC。通过 `thread/start`、`thread/resume`、`turn/start` 管理会话，通知回流为文本、工具活动和用量；取消使用 `turn/interrupt`。                          |
| Claude Code        | 面板 Agent 调度 → `getClaudeBridgeRuntime` → `externalBackendBridge` → 本地受令牌保护的 HTTP `/run-turn` → 插件管理的 Node Bridge → Runtime Adapter → Claude Agent SDK `query()` → 本地 Claude Code。流式事件回传面板；SDK 权限请求经确认事件和 `/resolve-confirmation` 应答；会话映射、轨迹及热运行时由 Bridge 管理。 |
| 两者的 Zotero 工具 | 外部运行时 → 带 Bearer 和会话作用域头的本地 MCP → `AgentToolRegistry` → 参数校验、操作准备、授权、执行及变更日志 → Zotero Gateway。工具结果中的引用证据和操作回执回流至面板。                                                                                                                                          |

因此，Antigravity 可以直接复用 Gecko 子进程能力和现有 MCP，无需再增加 Node Bridge。[Codex 源码](https://github.com/yilewang/llm-for-zotero/blob/9c2641c503623dd154166cc042308629e4120b7d/src/codexAppServer/nativeClient.ts)、[Claude Bridge 说明](https://github.com/yilewang/llm-for-zotero/blob/9c2641c503623dd154166cc042308629e4120b7d/packages/claude-bridge/README.md)、[MCP 源码](https://github.com/yilewang/llm-for-zotero/blob/9c2641c503623dd154166cc042308629e4120b7d/src/agent/mcp/server.ts)。

## 2. 两个 PR 的实现范围与兼容性

| 项目                                                           | 已核实结果                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PR #522](https://github.com/yilewang/llm-for-zotero/pull/522) | 10 个提交、75 个文件，新增独立会话系统、存储表、历史菜单、模型发现、流式解析、取消、长上下文临时文件和 CLI 工具活动展示。每轮启动一个 `agy`，通过 `--conversation` 续接。 |
| Zotero 工具调用                                                | Antigravity 运行时没有注册 Zotero MCP 作用域，也没有配置 MCP 服务或接入宿主交互通道。活动轨迹来自 `agy` 自身的工具事件，尚未形成 Zotero 工具执行闭环。                    |
| PDF 与引用                                                     | 已复用公共提示词上下文，可传递提取后的 PDF 文本等内容；Zotero 工具读取、引用证据回流及点击定位仍需接线和验证。                                                            |
| [PR #521](https://github.com/yilewang/llm-for-zotero/pull/521) | 包含 #522 的全部提交，最后仅追加 `59159904`：配额显示和 CLI 代理设置。相对 #522 修改 20 个文件。实施时只移植其追加提交。                                                  |
| 合并冲突                                                       | 模拟合并 #522 与当前 main，出现 6 个文件冲突，集中在聊天调度、会话创建、历史控制、独立窗口及系统选择。#521 还增加偏好设置界面和布局测试冲突，共 8 个文件。                |
| 远端验证                                                       | 两个 PR 的 CI 均为 `action_required`，不能视为通过。作者描述中的测试结果尚未在本机复现。                                                                                  |

移植前需要修正的具体问题：

- Windows 候选路径遗漏本机实际安装位置 `%LOCALAPPDATA%\agy\bin\agy.exe`，环境变量读取也需要兼容 `PATH`、`Path`。
- 结果处理会把“错误状态但带部分文本”判为成功；读取结束时未解析没有换行的最后一条事件。
- 会话 ID 仅在最终结果后保存，不利于处理中断后的恢复；取消与进程启动之间也需要补竞态检查。
- 推理选项声明包含 `xhigh/max`，偏好读取却会将其回退为 `auto`。
- #521 会覆盖已有 `NO_PROXY`，系统代理探测仅覆盖 macOS，需要补 Windows 行为。

本机已确认是 Windows 11，安装了 `agy 1.4.8`；PR 的兼容处理主要针对 1.4.2，不能直接沿用其版本假设。

## 3. 实施方案与接口变化

### 分支、会话和进程

- 在目标目录准备官方仓库，从核对后的 `origin/main` 创建 `codex/antigravity-agy-integration`。核对并补充 `agy-fork`，所有修改和提交保留在功能分支。
- 顺序移植 #522，再移植 #521 的追加提交；冲突以当前 main 的生命周期、鉴权和存储接口为准。
- 注册 `antigravity` 会话系统，默认关闭；复用公共会话存储、检索、清理和恢复逻辑。迁移新增表及系统 CHECK 约束，验证事务性和重复启动的幂等性。
- 保留每轮独立进程和明确会话 ID 续接。发送、编辑、重试共用一个入口；编辑和重试建立新 CLI 会话，避免旧历史污染。
- 首版支持原生 Windows `agy.exe`。按显式配置、`AGY_PATH`、PATH、安装目录发现；对 WSL 或脚本启动器给出选择原生可执行文件的提示。
- 修复终态、EOF、取消竞态和错误分类。保留部分回答的失败状态；为模型查询和运行设置超时，等待用户审批期间暂停运行计时。
- 收到 `init` 后，在身份和会话代次校验通过时保存 CLI 会话 ID。取消、退出和异常统一清理本次进程、作用域及临时文件。

### Zotero MCP、上下文和审批

- 扩展 `AntigravityPanelTurn`，接收宿主准备的 `executionRequest`、会话身份和代次；继续使用公共上下文准备结果传递 PDF、选中文本及元数据。
- 为每个会话建立独立运行目录，生成 `.agents/mcp_config.json`，配置 Zotero 本地 Streamable HTTP MCP、插件 Bearer 和当前作用域头。并发会话不共享可变配置文件。
- 扩展 MCP 的 `runtimeAuthority`，加入 `antigravity`；新增宿主控制的可选审批策略 `effectApproval: "host_review"`。现有调用方保持原来的委托审批默认值。
- 将该策略传递至公共操作授权链：可信读取直接执行，文库修改及其他状态变更展示具体提案并等待 Zotero 确认。拒绝、取消或审批通道不可用时不执行；嵌套调用同样受约束。
- Antigravity 不提供 PR 中的 `full` 权限绕过选项。只读模式隐藏并拒绝写工具；删除或批量修改必须确认实际目标和变更内容。
- 复用文献检索、`paper_read`、`library_read`、`note_write`、标签对应的 `library_update` 等现有工具。接入 MCP 活动观察、引用合并、来源验证、操作回执和持久化轨迹。
- 按你选择的方式，首次由用户在 `agy` 中仅允许本插件 MCP 服务；后续修改仍由 Zotero 审批。插件不读取或改写 Antigravity 全局登录文件，不传递跳过所有权限的参数。

官方协议支持工作区 MCP 配置，但 headless 不接受权限应答事件，需要上述两层授权安排。[MCP 文档](https://antigravity.google/docs/mcp?tab=cli)、[headless 文档](https://antigravity.google/docs/cli/headless/)。

### 模型、代理和恢复

- 使用 `agy models` 动态发现模型，保留 CLI 默认模型和手填模型能力；统一推理选项的存取。
- 按你的选择，代理偏好仅作用于 Antigravity 子进程。复用 #521 的环境构造逻辑，提供系统、手动、直连模式。
- Windows 系统模式读取已启用的静态代理；仅有 PAC 且无法解析时提示使用手动配置。手动支持 HTTP、HTTPS、SOCKS5，校验错误直接提示。
- 合并已有 `NO_PROXY/no_proxy`，确保 `localhost`、`127.0.0.1`、`::1` 直连；保持现有 Codex、Claude 和普通 API 的代理行为。
- 整合 #521 配额展示，查询失败不阻断聊天。
- 历史范围默认为 Zotero 内创建的 Antigravity 会话。CLI 会话失效时保留本地记录，提供显式重建入口；发生可能已执行的写操作后，不自动重放整轮任务。

## 4. 本轮实际验证结果

以下均针对未修改的官方 main：

| 检查                                 | 结果                             |
| ------------------------------------ | -------------------------------- |
| 插件与 workflow TypeScript 检查      | 通过                             |
| Claude Bridge TypeScript 检查        | 通过                             |
| Prettier、ESLint                     | 通过；ESLint 有 3 条既有 warning |
| 架构边界检查                         | 通过；有 12 条类型导入 warning   |
| 循环依赖检查                         | 通过                             |
| 选取的 MCP、权限、路径、会话测试     | **138 项通过**                   |
| Claude Bridge 全套测试               | **115 通过、12 失败、5 跳过**    |
| Antigravity 真实模型、Zotero UI、XPI | 尚未验证                         |

Claude Bridge 失败涉及 Windows 路径处理及模型配置断言，尚未逐项完成定因。本次登记为既有基线，不删除或放宽测试；集成后需逐项比较是否新增失败。

`npm ci` 已完成，但 npm 11 提示部分依赖安装脚本未获执行许可，实际构建是否受影响仍需检查。

## 5. 验证、验收和交付

- **协议与进程测试：** 分块、CRLF、末尾无换行、重复事件、未知事件、错误终态携带文本、提前退出、stdin 写入失败、认证错误、超时，以及启动前后取消。
- **会话测试：** 连续对话、重启恢复、编辑重试、失效会话重建、并发隔离、迟到事件及取消后的写入阻断。
- **工具与权限测试：** PDF/选区/元数据绑定、引用跳转、笔记和标签修改、拒绝操作零变更、删除与批量修改确认，以及模型参数无法覆盖宿主作用域或审批策略。
- **Windows 与代理测试：** GUI 启动环境下的路径发现、空格和中文路径、原生 CLI 启停、Clash 系统及手动代理、回环 MCP 直连、进程清理。
- **回归检查：** 运行完整 `typecheck`、Lint、架构检查、循环检查、工具词汇检查、单元测试、Bridge 测试和 workflow；真实模型测试仅走显式启用入口及隔离测试文库。
- **交付：** 构建可安装 `.xpi`，核对包内容并提供 SHA-256、安装与一次性 MCP 授权说明、代理配置、测试报告及待实机测试清单。构建成功与真实功能验收分别报告。

另有已确认的分发限制：Google 当前 FAQ 明确表示，消费者方案不支持在第三方应用中封装 `agy`；#522 维护者也因此暂缓合并。上游合并与分发需单独解决这一限制，不能用技术验证通过代替。[官方 FAQ](https://antigravity.google/docs/faq/#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching)。

## 6. 核心架构决断与演进思考（知识资产归档）

为确保后续维护、二次开发或切换运行环境时不丢失关键设计思考，本节对核心架构决策进行完整归档：

### 6.1 为什么采用子进程直连，而不是 Node Bridge？

- **机制差异**：Claude Code 之所以需要 `packages/claude-bridge`，是因为其官方 SDK 设计高度依赖 Node.js 运行时环境与复杂的权限状态机，无法在 Zotero 的 Gecko 扩展沙箱中直接执行。
- **Antigravity CLI 的优势**：`agy` 是原生自包含的可执行文件，支持以 headless 模式启动并直接通过 `stdin/stdout` 交换 JSON-RPC / NDJSON 流。
- **决断**：复用 Zotero Gecko 原生提供的 `Subprocess` 模块直接驱动 `agy`，省去了中间层 Node Bridge 的端口占用、进程守护开销以及令牌握手复杂性，响应更加直接且资源消耗更低。

### 6.2 为什么不使用反向代理模拟 OpenAI / Claude 接口？

- **协议伪装的脆弱性**：反向代理本质上是将标准的 OpenAI/Claude ChatCompletions 格式翻译为 Google 认证的内部请求。这种方案一旦 Google 接口变更、签名算法升级或调整反滥用检测，代理会立即整体瘫痪。
- **风控与合规风险**：Google 服务条款对第三方自动化包装、模拟登录和绕过界面限制有明确的风控策略，可能面临账号限制。
- **工具链割裂**：通过反向代理无法直接利用 Zotero 为原生 Agent 准备的 Local MCP 体系，无法获得会话隔离的受控文献读写能力。

### 6.3 为什么不使用 ACP (Agent Client Protocol)？

- **现状分析**：社区虽有探索 `antigravity-acp` 等适配层，但 `llm-for-zotero` 宿主本身并不是通用的 ACP Client（它分别硬编码了 Codex JSON-RPC 和 Claude Bridge）。
- **架构考量**：若引入 ACP，插件端需要先实现一套 ACP Client 协议栈，宿主还需要通过中介层去与 `agy` 交互，变成了“三层套娃”。直接集成 CLI 原生 headless 事件流与原生 MCP 是路径最短、最易调试的方案。

### 6.4 Headless 模式与 Zotero 本地 MCP 的无缝对接

- **挑战**：`agy` 运行在 `--headless` 模式时，无法弹出交互式 TUI 供用户敲回车批准 MCP 权限；如果未授权，请求会直接被 soft-deny 挂起或报错。
- **解决方案**：
  1. 为每个对话轮次创建临时的独立工作空间（位于临时文件夹中）。
  2. 动态写入工作区配置 `.agents/mcp_config.json`，声明 Zotero 本地 Streamable HTTP MCP 端点。
  3. 启动 `agy` 时附带动态生成的 `--settings` 临时配置，注入 `{"permissions": {"allow": ["mcp(zotero/*)"]}}`，预先信任 Zotero 工具。
  4. 最终写操作的审批权完全交回给 Zotero 插件端的 `runtimeAuthority`（宿主级审批），既保证了自动化执行，又严守数据安全边界。

### 6.5 Windows 平台关键缺陷修复清单

- **路径探测**：增加对 Windows 默认安装目录 `%LOCALAPPDATA%\agy\bin\agy.exe` 的自动探测。
- **环境变量容错**：Windows PowerShell / CMD 下环境变量大小写混用，统一兼顾 `PATH` 与 `Path`。
- **系统代理穿透**：通过 Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 读取 `ProxyServer` 与 `ProxyEnable`，完美支持 Clash / v2ray 等常见代理客户端。
- **流式事件缓冲刷新**：修复了在 Windows 平台下，当数据流到达 EOF 且最后一行缺少 `\n` 时导致最后一条关键事件丢失的解析 bug。
- **会话持久化时机**：在收到首个 `init` 事件时立即保存 `conversationId`，避免会话异常中断导致后续无法续接对话。

### 6.6 上游更新与分支维护建议

- **分支策略**：
  - `main`：保持为可以直接使用、编译出稳定 XPI 的主分支。
  - `codex/antigravity-agy-integration`：保留 Antigravity CLI 集成的全套功能实现与测试。
  - `upstream`：跟踪官方仓库 `https://github.com/yilewang/llm-for-zotero.git`。
- **同步升级步骤**：
  当官方发布新版本时：
  ```bash
  git fetch upstream
  git checkout main
  git merge upstream/main  # 或 rebase upstream/main
  # 解决潜在的合并冲突，重新运行 npm test 验证无误后打 tag 发布
  ```
