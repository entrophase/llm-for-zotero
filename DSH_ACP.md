# 官方 DSH ACP 接入

本分支 `codex/dsh-acp-integration` 从 Antigravity 定制分支的 `bd691f54` 开始，新增与 Codex、Antigravity 并列的 DSH 对话系统。使用本机安装的官方 `dsh --profile acp`，不修改 DSH 安装，不维护 DSH 分叉。

## 设置与使用

1. 安装 Node.js ≥24.9.0 和官方 `@deepseek-ai/dsh`，先在 DSH 中完成认证及模型配置。
2. 将本分支构建的 XPI 安装到 Zotero，进入插件设置的 Agent 页，启用 **DSH**。
3. 通常保留路径为空即可。Windows 自动查找 npm 全局安装和 Node，然后直接启动 `node.exe` 与 `@deepseek-ai/dsh/lib/bin.js`；不会拼接 `cmd.exe` 命令。
4. 自动定位失败时，填写 **DSH entry script** 和 **Node executable** 的完整路径。典型路径分别是 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` 和 `C:\Program Files\nodejs\node.exe`，路径含空格可直接填写。
5. **DSH Home** 默认遵循 `DSH_HOME` 或原有 `~/.dsh`。如使用独立 Home，需先在该 Home 完成认证。更改 Home 后，已有会话不会被自动迁移。
6. 点击 **Refresh DSH options** 从 ACP 读取模型和推理选项；使用运行时返回的标识，不硬编码模型清单。
7. 先测试协议与 Zotero 工具，再单独测试模型。模型测试会实际调用当前选择的模型，可能产生模型费用。
8. 在论文或文献库对话中选择 DSH。可以新建、重命名、搜索、在独立窗口打开、清空和本地删除。运行时徽标菜单中的 **Clear DSH conversation** 清空显示历史并解除旧原生会话绑定。

DSH 管理模型调用、推理上下文、原生工具和权限策略。插件提供论文、附件、选区、附加论文/历史上下文、Zotero 工具、确认窗口、可定位的引用及本地显示历史。PDF 通过 Zotero 工具读取。

DSH 原生审批只提供单次允许和拒绝；Zotero 文库写入另经宿主确认。停止会先撤销本轮 Zotero 工具凭证，再取消 DSH。已完成的写入不会被回滚，仍应查看任务进度中的操作回执。断线、进程退出和恢复失败不会自动重发任务；查看已完成操作后，再主动发送继续指令。

## 会话与维护边界

- `src/dsh/` 实现 ACP 通信、Gecko 子进程管理、会话适配、选项发现、设置和存储适配；协议使用逐行 JSON-RPC。
- 同一启动配置复用后台进程。同一对话仅有一个活动请求；各对话单独绑定原生 session、事件订阅及审批。DSH 包版本属于进程缓存身份的一部分，升级后重新握手。
- 每轮 `session/new` 或 `session/resume` 挂载新的短期 MCP 凭证，结束时 `session/close` 关闭活动实例，保留原生持久化会话。初始化超时 60 秒；新建/恢复超时 180 秒。取消后先等待最多 5 秒，再尝试关闭；关闭 10 秒无响应则回收进程并中断受影响对话。
- 插件持久化原生 session ID、稳定工作目录、Home/启动路径绑定、会话代次和模型选项。清空递增代次并撤销旧绑定；过期、取消、删除及旧代次工具事件不能再授权写入。
- MCP 凭证通过授权头发送，按对话、运行 ID、代次隔离；工具仍经过注册表、参数校验、写入锁和操作回执。在审批返回后再次检查作用域。必要工具发现失败时不派发模型请求。
- 共享运行时存储工厂新增 `llm_for_zotero_dsh_messages` 和 `llm_for_zotero_dsh_conversations`，并迁移共享枚举约束。文献库编号区间 `[10¹⁵, 2×10¹⁵)`，论文区间 `[2×10¹⁵, 3×10¹⁵)`，与既有系统区间不重叠。
- 本地删除不删除 DSH Home 内的原生历史；保留 DSH 原生数据的管理权。首次版本不提供分叉、回滚或修改旧问题后重新生成。
- 代理沿用进程环境和 DSH 配置，同时将 `localhost`、`127.0.0.1`、`::1` 加入 `NO_PROXY`。不替换用户的 DSH 认证或代理配置。
- DSH 0.2.2-rc.1 协商结果不支持图片，因此图片输入会明确报错。`usage_update.used/size` 显示为实际上下文占用，不伪装成计费输入/输出 token 用量。

设计参考 [llm-for-zotero #501](https://github.com/yilewang/llm-for-zotero/pull/501) 的 ACP 通信结构及 [switch #1479](https://github.com/sandbox-quantum/switch/pull/1479) 的 DSH 适配，按本分支现有接口接线。验证结论以本分支实际测试为准。

## 验收记录（2026-11-06）

验证环境：Windows、Zotero **10.0.7**、Node.js **24.18.0**、官方 DSH **0.2.2-rc.1**、插件 **3.9.16.1**。Zotero 验收使用 `.scaffold/test/profile` 和 `.scaffold/test/data`，仅操作临时论文和笔记；真实模型使用本机既有 DSH 认证。macOS/Linux 未做实机验收。

| 验证层                  | 覆盖内容与结果                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议/运行时单元测试     | 分片、乱序、超时、错误、能力缺失、事件隔离、启动取消、进程退出、同对话并发拒绝、每轮换凭证、失败恢复不重放、原生审批操作预览、文档返回、实际上下文用量、MCP 去重与跨运行事件过滤 |
| 存储及 MCP 回归         | 旧库约束迁移、编号边界、搜索和重命名、持久绑定与代次、清空、本地删除、拒绝写入、审批后撤销凭证及写入检查                                                                         |
| 官方 CLI + 模拟模型/MCP | 新建、复用进程续问、重启 DSH 后恢复、每轮新凭证、原生文件操作先拒绝再允许，全部通过                                                                                              |
| 真实 Zotero + 真实模型  | 单篇读取、原文引用跳转、同 session 续问、选区标识传递、附加第二篇论文并返回两篇来源、批准写子笔记后停止，全部通过                                                                |
| 真实 Zotero 界面        | DSH 运行时切换、统一历史搜索/重命名、清空代次、跨论文打开历史、独立窗口恢复，通过                                                                                                |
| 共享界面回归            | 运行时徽标 6 项、Codex/Agent 切换 9 项通过；统一历史独立复核见下方检查结果                                                                                                       |

另通过两次独立 Zotero 进程验证实际重启：恢复相同原生 session 并找回上一轮口令；原生 write 工具在 Zotero 展示一次审批，允许后写入临时文件。

以下为单次开发机观测值，不是统计基准，也不能用来声称 ACP 比 Codex 更快。CLI 使用模拟模型/MCP，真实模型耗时另列。

| 场景                              |     冷启动握手 |   首次正文 | 本轮总耗时 |
| --------------------------------- | -------------: | ---------: | ---------: |
| CLI 首次请求（模拟模型）          |       5,551 ms |     563 ms |     570 ms |
| CLI 复用进程续问（模拟模型）      |   无需重新启动 |     151 ms |     155 ms |
| CLI 重启进程后恢复（模拟模型）    |       单独重启 |     507 ms |     514 ms |
| Zotero 首轮论文读取（真实模型）   | 包含在总耗时内 | 未独立采样 |   5,681 ms |
| Zotero 续问及选区识别（真实模型） |       复用进程 | 未独立采样 |   1,969 ms |

CLI 首轮与续问的进程 PID 相同，重启测试 PID 不同。这里的 CLI 首次正文/总耗时从 session 已就绪后发出 prompt 计时，冷启动握手另计。

## 可重复验证

```powershell
npm run typecheck
npx tsx node_modules/mocha/bin/mocha.js --parallel --jobs 4 --timeout 10000 --require ./test/register.cjs "test/dsh*.test.ts" "test/codexZoteroMcpServer.test.ts"
npx tsx scripts/test-dsh-acp-live.ts
npm run check:architecture
npm run check:cycles
npm run lint:check
npm run build
```

真实 Zotero 工作流可选 `dshAcp.workflow.test.ts`，设置 `LLM_FOR_ZOTERO_DSH_LIVE=1` 才调用真实模型。`dshRestart.workflow.test.ts` 分别用 `LLM_FOR_ZOTERO_DSH_RESTART_PHASE=create` 和 `resume` 执行；第一阶段停止测试 Zotero 后复制其数据目录，第二阶段通过 `LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT` 指向该副本。两阶段都调用真实模型。

Windows 运行 scaffold 测试时将 `ZOTERO_PLUGIN_KILL_COMMAND` 设置为 `cmd /c exit 0`，然后只停止命令行包含本项目 `.scaffold/test/profile` 绝对路径的测试 Zotero。不要使用 scaffold 默认的全局结束 Zotero 命令。

完整日志位于本地 `tmp/dsh-*.txt`，真实 CLI 指标位于 `tmp/dsh-live2-log.txt`，真实模型指标位于 `tmp/dsh-acp-acceptance.json`。这些本机日志不纳入发布包。

## 检查结果与已知限制

- 全量普通单元测试：**12,344 通过，27 失败**。在未修改的基线 `bd691f54` 上复跑，27 项相同失败均可复现，集中在原有工具/命令授权、Claude 进程与路径、MinerU 恢复及工具指引；本次没有将这些失败计为通过。
- DSH 与 Zotero MCP 定向回归：**132 通过**，包括取消期间已提交回执的保留，以及没有明确结果的操作标为“待核对”。类型检查（主项目、工作流、Claude bridge）及生产构建通过。
- 性能单元测试：**4 通过**。
- Claude bridge 包测试：**145 通过，12 失败，5 跳过**；未修改基线得到相同结果，属于既有失败。
- 格式检查通过；ESLint 无错误，现有 live 测试存在 3 条顶层 hook 警告。
- 架构边界和循环依赖检查通过；架构检查仍列出项目既有迁移义务及类型引用警告。
- 工具词汇和内置 skill hash 检查通过。
- 共享 `unifiedHistory.workflow.test.ts` 首项在创建 Agent 草稿时超时，本分支单独复跑和未修改基线 `bd691f54` 均复现。测试运行器遇到此项失败即停止，该文件后续项未计为通过；本次新增的 DSH 历史、跨论文搜索和独立窗口测试已独立通过。
- 真实模型延迟、回复和工具选择受模型及网络影响；停止不能撤销已经提交的写入。DSH 自身原生工具的权限范围由其配置决定。

## 安装包

Windows 实机验收使用开发构建 `3.9.16.1`。发布版 `3.9.16.2` 重新打包并复跑了 132 项 DSH/MCP 定向测试。已核对安装包版本、DSH 资源和更新清单中的 SHA-512。[下载发布版 XPI](https://github.com/entrophase/llm-for-zotero/releases/download/v3.9.16.2/llm-for-zotero.xpi)

SHA-256 `1c8e00cdc94bc8abe7c0ad7a1d4bb761acdc82ed6cb594f3a846a74a90852c7d`。
