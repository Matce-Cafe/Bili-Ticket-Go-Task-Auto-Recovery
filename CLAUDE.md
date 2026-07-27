# CLAUDE.md — Bili-Ticket-Go-Task-Auto-Recovery

## 项目概述

[BiliTicketGo](https://github.com/HHsome/BiliTicketGo)（BTG）的 Windows 守护进程。BTG 以 `btg-windows-amd64-dynamic.exe -web -no-browser` 长期运行蹲票，本守护进程负责保活、健康监控、异常退避重启，并在每次重启后自动恢复最近一次抢票任务。

核心流程：守护进程启动 BTG 子进程 → 轮询 BTG Web 就绪 → 健康端点汇总 → 退出则退避重启 → 新 generation Web 就绪后调用恢复 helper。

> BTG 本体不在本仓库。本仓库只提供守护脚本、配置模板、浏览器恢复 helper 和 Windows 计划任务安装器。

## 架构

```
bili-ticket-go-task-auto-recovery.js   守护进程主程序
├── loadConfig()                读取并严格校验配置（路径防穿越、端口范围、互斥项）
├── named pipe 单实例           IPC 管道名 = BTG 应用目录 SHA256 前 16 位
├── BTG 子进程管理
│   ├── spawn(shell:false, cwd=BTG 应用目录)
│   ├── 启动前 Win32_Process 核对完整 EXE 路径（外部进程只监控不接管）
│   ├── stdout/stderr tee + DailyFile 按本地日期切分日志
│   └── 退避重启 1/2/4/8/16/32/60s，连续 5min 后归零
├── 健康监控
│   ├── 主动探测 BTG Web (:18080) readiness
│   ├── 连续失败达阈值 → 仅重启 managed BTG
│   └── 汇总到 :18081/health（HTTP 200/503 + JSON 排障字段）
├── 恢复 helper 调度
│   ├── 新 generation Web 就绪 → 读 order_jobs.json 预检 active job
│   ├── oncePerGeneration 最多调一次 helper
│   └── BTG 退出时终止 helper + Edge 子进程树
└── IPC 命令 status / restart / stop / run

bili-ticket-go-task-recover-latest.js   浏览器恢复 helper
├── 读 session_token + order_jobs.json
├── 校验目标 job 仍是最新、无 active job、项目/日期一致
├── headless Edge CDP：登录 → 找「恢复这个任务」按钮 → 点击
├── 恢复锁 bili-ticket-go-task-recovery-state.json 防重复点击
└── 校验新 active job 产生 → phase:verified / 否则 unverified

install-bili-ticket-go-task-auto-recovery.ps1   Windows 计划任务安装器
├── 校验必填文件 / Node ≥22 / 语法检查 / 文件 SHA256
├── 注册任务 Interactive 首选 → S4U fallback → S4U LogonTrigger
├── 升级保护：stop 旧进程 + 等待 named pipe 释放 + hash 校验
└── 立即启动 + named pipe 验证期望实例与 BTG Web 就绪
```

## 行为和安全边界

- BTG 始终通过 `spawn(..., { shell: false, cwd: <BTG 应用目录> })` 启动，参数来自配置且必须包含 `-web` 和 `-no-browser`。
- `consoleTee: true` 时，守护进程把 BTG 子进程 stdout/stderr 原样 tee 到自己的 stdout，并在 BTG 启动/退出/重启、Web 就绪、恢复 helper 起停、外部进程接管、健康失败重启等关键节点打印一行带时间戳摘要。Interactive 计划任务下显示在桌面控制台窗口；session 0（S4U）下 `process.stdout.write` 失败会被静默吞掉，不影响守护逻辑。
- 路径防穿越：`executable`、`logDirectory`、`jobsFile`、`requiredFiles` 等相对路径经 `resolveInside` 校验不得逃逸出 BTG 应用目录或守护目录。
- `acceptTerms` 必须显式布尔值。守护进程不会盲写输入；只有 BTG 输出命中“规约/条款 + Y/N”组合提示后，才向该次子进程写入一次 `Y`。
- named pipe 单实例：管道名由 BTG 应用目录哈希生成，同一应用目录只能运行一个守护进程。
- 每次启动 BTG 前用 `Win32_Process` 核对完整 EXE 路径。发现手工启动的同路径进程时，守护进程不会再开一份、不终止它，只轮询；外部进程结束后才接管启动。
- 异常退出后按 1/2/4/8/16/32/60s 退避，最长 60s。连续运行 `resetAfterMs`（默认 5 分钟）后，下一次退出从 1s 重新计数。
- `stop` 只终止守护进程自己启动的 BTG；`restart` 若检测到的是外部进程会拒绝操作，避免误杀手工任务。
- `supervisorHealth.host` 必须为 `127.0.0.1`；`btgHealth.url` 必须是回环 HTTP(S) URL；守护进程不得绑定 BTG Web 端口。

## 配置

实际配置文件 `bili-ticket-go-task-auto-recovery.config.json` 不提交（含蹲票项目参数），从 `bili-ticket-go-task-auto-recovery.config.example.json` 复制后修改。

关键项：

| 字段 | 说明 |
| --- | --- |
| `executable` | BTG 可执行文件名（相对 BTG 应用目录） |
| `args` | 启动参数，必须含 `-web` 和 `-no-browser` |
| `acceptTerms` | 显式布尔，true 表示操作者已回复 Y 确认 |
| `consoleTee` | true 时 BTG 输出 tee 到守护进程 stdout |
| `supervisorHealth` | 健康端点，`host` 必须 `127.0.0.1`，`port` 默认 18081 |
| `btgHealth` | BTG Web 探测：`url`、`intervalMs`、`timeoutMs`、`startupGraceMs`、`failureThreshold`、`restartManagedOnFailure`、状态码范围 |
| `restart` | 退避：`initialDelayMs`/`maxDelayMs`/`resetAfterMs` |
| `duplicateCheck` | 启动前核对同路径进程：`enabled`/`pollIntervalMs`/`queryTimeoutMs` |
| `jobRecovery` | 浏览器恢复 helper（详见下节），与 `taskRecovery` 互斥 |
| `taskRecovery` | 直接 endpoint 恢复（保留为将来选项，默认禁用），需 `endpointVerified` + 非空 `verifiedEndpoint` |

配置互斥/约束（`loadConfig` 强制校验）：

- `restart.initialDelayMs` 不得大于 `restart.maxDelayMs`。
- `btgHealth.acceptedStatusMin` 不得大于 `acceptedStatusMax`。
- `supervisorHealth.port` 不得等于 BTG Web 端口。
- `taskRecovery.enabled` 要求 `endpointVerified=true` 且 `verifiedEndpoint` 非空。
- `taskRecovery.enabled` 与 `jobRecovery.enabled` 不能同时为 true。
- `jobRecovery.enabled` 时 `oncePerGeneration` 必须为 true。

修改恢复配置后需重启整个守护进程；IPC `restart` 只重启 BTG，不重载配置。

## 状态和日志

```powershell
cd <守护目录>
.\node.exe .\bili-ticket-go-task-auto-recovery.js status
.\node.exe .\bili-ticket-go-task-auto-recovery.js restart
.\node.exe .\bili-ticket-go-task-auto-recovery.js stop
Invoke-RestMethod http://127.0.0.1:18081/health
```

健康端点只监听 `127.0.0.1:18081`；`127.0.0.1:18080` 保留给 BTG Web，守护进程绝不绑定该端口。BTG 进程存在且 Web readiness 正常时返回 HTTP 200；进程存在但 Web 未就绪、连续失败、退避或检查阶段返回 503，JSON 提供 `btgReadiness` 详情。达连续失败阈值后只重启 managed BTG；外部 BTG 仅记录不健康，绝不误杀。

日志写入 `bili-ticket-go-task-auto-recovery-logs`（按服务器本地日期切换）：

- `btg-YYYY-MM-DD.stdout.log` / `btg-YYYY-MM-DD.stderr.log`
- `job-recovery-YYYY-MM-DD.stdout.log` / `job-recovery-YYYY-MM-DD.stderr.log`
- `supervisor-YYYY-MM-DD.jsonl`（事件日志，`supervisor` 前缀是历史事件类型名，非目录名）

事件日志每行一个 JSON，`type` 字段标识事件，记录子进程 PID、启动参数、退出码、Windows 十六进制退出码、运行时长、退避、条款提示处理结果、helper 起停。

## 监控

`:18081/health` 是监控唯一入口，只监听回环，外部监控必须从服务器本机访问。HTTP 状态码即信号：**200 = 健康，503 = 不健康**。

### 健康判据

| 字段 | 含义 | 健康值 |
| --- | --- | --- |
| `healthy` | 综合健康，= BTG 进程存活 **且** Web 就绪 | `true` |
| `running` | 守护进程本身在跑 | `true` |
| `app.managedPid` | 守护进程启动的 BTG PID；`null` 表示退避/检查窗口 | 非 null |
| `btgReadiness.ready` | BTG Web 最近一次探测是否成功 | `true` |
| `btgReadiness.consecutiveFailures` | 连续探测失败次数，达 `failureThreshold`(默认 6) 触发重启 | 0 |
| `recovery.browserHook.state` | 恢复 helper 当前状态 | `succeeded` / `helper-running` / `disabled` |

`503` 的典型成因：BTG 刚重启还在 `startupGraceMs` 宽限内、Web 未就绪、连续探测失败中、退避等待、检查现有进程阶段。

### 关键状态字段的监控含义

- `app.generation` 单调递增，每次 BTG 重启 +1。短时间大涨说明 BTG 频繁崩溃，需查 `restart.lastExit`。
- `restart.lastExit.code` / `codeHex` 是 BTG 退出码。`0`/`2` 常见（正常退出或参数错误），非零不必慌——守护进程会按退避自动重启。只有连续不健康（`consecutiveFailures` 卡阈值、`healthy` 长期 `false`）才是真故障。
- `lastError` 是**最近一次**错误序列化，可能残留已恢复的旧错误。判断当前健康以 `healthy` + `recovery.browserHook.state` 为准，`lastError` 仅作线索。
- `externalProcesses` 非空时，当前 BTG 是外部手工启动的，守护进程只监控不接管、不重启。

### 事件日志关键类型

`supervisor-YYYY-MM-DD.jsonl` 每行一个事件，`type` 字段标识：

- `btg-started` / `btg-exited`：BTG 子进程起停，含 PID、generation、退出码。
- `btg-became-ready` / `btg-health-check-failed`：Web 就绪与探测失败。
- `btg-restart-scheduled`：退避重启调度，含 `delayMs`、`attempt`、`reason`。
- `btg-unhealthy-restart-requested`：连续失败达阈值，请求重启（仅 managed 进程）。
- `existing-btg-process-detected` / `existing-btg-process-ended`：外部进程接管切换。
- `job-recovery-helper-started` / `job-recovery-helper-exited`：恢复 helper 起停，含退出码。
- `supervisor-started` / `supervisor-stopped`：守护进程自身生命周期。

## 最近抢票任务恢复

BTG 的 `/api/v1/query` 使用应用内部加密协议，不能安全猜测普通 REST 请求。因此默认启用同目录的 `bili-ticket-go-task-recover-latest.js` 浏览器 helper，并保持直接 endpoint 方式 `taskRecovery.enabled: false`。安装前必须把 helper 一并放到守护目录，否则安装器拒绝启动。

每一代 BTG 子进程启动后，守护进程先轮询确认 18080 Web readiness，再等待 `jobRecovery.readyDelayMs`（默认 2s），然后读 `data/web/order_jobs.json`。瞬态的文件缺失、共享冲突或 JSON 半写入会在同一代有限重试。当前 BTG 历史记录是 wrapper 结构，因此默认检查 `job.status`/`snapshot.state`，从 `job.id` 读 ID：

- 所有 job 的 `status`/`state` 都必须能明确归入配置的 `inactiveStatuses`，或文件是空 job 数组，才允许启动 helper。
- 任一配置状态字段缺失/空白、job 条目畸形、状态未知，均按 fail-closed 处理。
- active job 预检完成后，helper 仍在浏览器页面内再次确认无运行中任务，覆盖文件检查与点击之间的竞态。
- 每个 BTG generation 最多调用 helper 一次；helper 超时、非零退出或被取消都落事件日志，不在同一代自动重放。
- BTG 退出时正在运行的 helper 及其 Edge 子进程树被终止，避免脱离守护。
- 新 BTG generation 会等旧 helper 进程树确认退出后才启动，避免两代 helper 重叠点击。

helper 用 `shell: false` 在守护目录运行，stdout/stderr 分别写入每日 `job-recovery-*.log`，事件日志记录 helper PID、generation、退出码、十六进制退出码、运行时长。

`jobRecovery.command` 默认 `{{node}}`，表示复用运行守护进程的同一个 `node.exe`；参数支持 `{{generation}}` 与 `{{jobsFile}}` 占位符。若 JSON 有外层结构，必须明确填 `jobsArrayPath`；BTG 升级后 schema 改变，必须同步修改 `jobIdPath` 和 `statusPaths`。

恢复参数（`--project-id`、`--selected-date`）写在配置里，helper 会再次校验“目标仍是最新记录、无 active job、项目与日期一致”，只点击一次且必须观察到新 job ID 才以退出码 0 报告成功。

### 手动恢复最近抢票任务

helper 用 `bili-ticket-go-task-recovery-state.json` 防止对同一 job 重复点击：若上次对某 `sourceJobId` 的尝试 `phase` 不是 `verified`，helper 拒绝再次点击同一 job。这个保护在正常 generation 轮替里无害，但若想让同一 BTG generation 重新尝试恢复，需先清掉锁并触发新 generation：

```powershell
cd <守护目录>
Remove-Item .\bili-ticket-go-task-recovery-state.json -Force -ErrorAction SilentlyContinue
.\node.exe .\bili-ticket-go-task-auto-recovery.js restart
```

`restart` 让 BTG 进出一个新 generation，守护进程在新 generation Web readiness 确认后重跑一次 helper（`oncePerGeneration`）。成功后锁文件写回 `phase: verified` 和新 `newJobId`。

> `order_jobs.json` 只保留有限历史 job，BTG Web 页面的“最新任务”可能比磁盘文件更靠后。helper 以 `order_jobs.json` 为准做 active-job 预检，但点击恢复按钮用的是浏览器页面里的最新 job——两者偶尔不一致时以页面为准。

## 浏览器恢复 helper 细节

`bili-ticket-go-task-recover-latest.js` 用 headless Edge 的 CDP 协议（`--remote-debugging-port=0` 随机端口，读 `DevToolsActivePort` 文件获取）驱动：

1. 读 `data/web/session_token` 与 `data/web/order_jobs.json`，校验目标 job 仍是最新、无 active job、`can_execute` 为 true、项目 ID 与日期与配置一致。
2. 导航到 `http://127.0.0.1:18080/jobs`；若出现登录表单，把 token 作为 CDP 调用参数注入密码框并提交（token 仅作 `JSON.stringify` 后的 CDP 参数，从不打印）。
3. 查找标题/文本含「恢复这个任务 / Restart this job」的按钮；找不到则先点「重新载入 / Reload」重试。
4. 写恢复锁 `phase: clicking`，点击按钮，等待后重新读 `order_jobs.json` 校验是否产生新的 active job。
5. 产生新 job → `phase: verified` + `newJobId`，退出码 0；否则 `phase: unverified` + 页面尾部快照，退出码 1。

临时 profile 目录在 `os.tmpdir()` 下按 PID 生成，finally 块清理（Edge 仍占用文件时不因清理失败中断成功恢复）。

## 安装器注意

- **必须用 elevated 会话运行**：注册 S4U/`AtStartup` 触发器需要管理员权限。非 elevated 会话会在注册阶段报“拒绝访问”。
- **首选 Interactive**：让守护进程在用户桌面会话以可见控制台窗口运行，配合 `consoleTee` 实时回显 BTG 输出。代价是必须有人登录，会话注销即停止——**关闭桌面控制台窗口会杀死守护进程与 BTG 整棵进程树**（`0xC000013A`）。S4U fallback 不依赖登录、开机即跑、session 0 不可见，仅作保底。
- **PowerShell 5.1 兼容**：安装器在 `Set-StrictMode -Version Latest` 下不能用 `$var = if (...) { ... } else { ... }` 的 if-as-expression，也不能用 `Split-Path -LiteralPath X -Leaf/-Parent`——两者在 Windows PowerShell 5.1 下触发 ParameterBinder bug，误报 `AmbiguousParameterSet` 并中止。已改用普通 if/else + `[System.IO.Path]::GetFileName/GetDirectoryName`，对 PS 5.1 和 PS 7 都安全。
- **升级保护**：检测到运行中的守护进程时先 `stop` 并等待 named pipe 释放；脚本/配置 SHA256 不匹配则拒绝接管，避免模糊升级。

## 依赖

- 仅 Node.js 内置模块（`fs`/`path`/`os`/`net`/`http`/`https`/`crypto`/`child_process`/`string_decoder`），无需 `npm install`。
- 恢复 helper 需 Node.js 22+（全局 `WebSocket`）+ Microsoft Edge（CDP 驱动）。
- BTG 本体（`btg-windows-amd64-dynamic.exe` 及 `data/`、`log/`、`model/`）由用户自行部署。

## Git 提交规范

提交信息格式如下，汉字与英文/数字之间需空一格：

```
【模块】功能 / 更改概述

- 更改项 1
- 更改项 2
```

- 【】内为模块名称，非单一模块修改时写【框架】，多模块用、分隔
- 【】后为具体功能或配置名，体现变更上下文
- `/` 后为完整更改描述，应包含“改了什么”的完整信息
- 标题后务必空一行
- 每项以 `-` 开头

## 文档同步

- 每次修改功能、配置、架构后，必须同步更新 CLAUDE.md 中对应内容。
- 尤其是新增/修改配置项、安全边界、监控判据、恢复逻辑等，确保 CLAUDE.md 与代码一致。
- 每次修改功能、配置、架构后，必须同步更新 CHANGELOG.md。

## 更新日志

请参阅 [CHANGELOG.md](CHANGELOG.md)

CHANGELOG 层级结构：`#` 版本号 > `##` 日期 > `###` 模块 > `####` 分类（新增/修复/变更）
