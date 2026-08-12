# 更新日志

CHANGELOG 层级结构：`#` 版本号 > `##` 日期 > `###` 模块 > `####` 分类（新增/修复/变更）。

# 1.2.1

## 2026-08-12

### 框架

#### 变更
- 仓库自有脚本、配置模板、启动入口及运行时状态/日志名称统一为大驼峰横杠式，并同步更新全部代码、配置和文档引用
- 主入口改为 `Bili-Ticket-Go-Task-Auto-Recovery.js`，配置改为 `Bili-Ticket-Go-Task-Auto-Recovery-Config.json`，恢复 helper 改为 `Bili-Ticket-Go-Task-Recover-Latest.js`
- 启动入口改为 `Start.bat`，恢复状态和日志目录分别改为 `Bili-Ticket-Go-Task-Recovery-State.json` 与 `Bili-Ticket-Go-Task-Auto-Recovery-Logs`
- 每日日志文件统一为 `Bili-Ticket-Go-YYYY-MM-DD-Stdout.log`、`Job-Recovery-YYYY-MM-DD-Stdout.log` 和 `Supervisor-YYYY-MM-DD-Events.jsonl` 等大驼峰横杠名称

# 1.2.0

## 2026-07-28

控制台日志彩色化，桌面窗口里 BTG 起停、Web 就绪、恢复 helper 进度一眼可辨。日志文件保持纯文本不受影响。

### 守护进程

#### 新增
- 彩色控制台日志：新增 `ANSI` 颜色常量、`LEVEL_COLOR` 级别映射、`logLine(tag, level, message)`，关键节点摘要改为 `HH:MM:SS [Tag] 消息` 格式，`[Tag]` 按级别着色（cyan=info、green=success、yellow=warn、red=error），时间戳 dim。风格参考 Google-AI-Mode-Adapter 的 `[Adapter]`/`[AI]` 彩色标签
- `LineDecoder` 字节流切行器：把 helper 的 stdout/stderr 按换行切成完整行逐行回调
- `printRecoveryLine`：解析 helper 输出的每行 JSON 记录（`skipped` 无任务/已有活跃任务、`restartClick` 点击结果、`restartVerified` 恢复成功、页面探针等），翻译成带级别颜色的 `[Recovery]` 摘要

#### 变更
- 关键节点摘要标签从内嵌英文 `[BTG]/[Recovery]` 改为结构化 `[Bili-Ticket-Go]/[Recovery]/[Supervisor]` Tag + 中文正文，例如 `[Bili-Ticket-Go] 已启动 — PID 67890，generation 7`、`[Recovery] 恢复成功 — job_000102 → job_000103（状态 queued…）`
- 恢复 helper 的 stdout/stderr 不再原样 tee：日志文件 `Job-Recovery-*-Stdout.log / Job-Recovery-*-Stderr.log` 仍落 helper 原始输出，live 控制台改为经 `printRecoveryLine` 解析后的彩色摘要（BTG 自由文本输出仍原样 tee，不做解析）
- 仅在 `process.stdout.isTTY` 为真且未设 `NO_COLOR` 时着色；重定向/管道/session 0 自动降级为纯文本，设 `NO_COLOR=1` 可强制关闭

# 1.1.0

## 2026-07-27

上手门槛大幅降低：双击 `Start.bat` 即开始守护，无需装计划任务、无需手填项目参数，helper 自动识别任务。

### 启动入口

#### 新增
- `Start.bat` 一键启动入口：双击即开始守护，切到自身目录，优先用同目录便携 `node.exe`、回退 PATH 中的 `node`，运行 `Bili-Ticket-Go-Task-Auto-Recovery.js run`；找不到 Node 时友好提示
- BTG 已运行则监控不接管，BTG 未运行则自动启动并恢复最新任务，控制台窗口实时回显 BTG 输出与生命周期事件

### 浏览器恢复 helper

#### 变更
- 任务自动识别：helper 不再要求配置 `--project-id` / `--selected-date`，自动取 BTG 当前正在运行或历史最新运行的任务，移除项目/日期校验与过去日期校验
- `order_jobs.json` 不存在或为空时退出码 0 并打印友好提示（「请先在 BTG Web 创建任务」），守护进程不报错，下一代 BTG 启动后重试；原来直接抛 `No job history is available`
- 已有活跃任务时退出码 0 跳过恢复（helper 职责是保证存在活跃任务），原来抛 `Refusing restart`；输出 `skipped:true` 便于守护进程识别

### 配置

#### 变更
- `Bili-Ticket-Go-Task-Auto-Recovery-Config-Example.json` 移除 `--project-id` 与 `--selected-date` 两个 args，开箱即用

### 安装器

#### 移除
- 移除 `install-bili-ticket-go-task-auto-recovery.ps1` 计划任务安装器：双击 `Start.bat` 取代安装器成为主入口，不再需要 elevated 会话注册计划任务。需要开机自启/断开 RDP 不死的用户可自行用 `schtasks` 注册任务调用入口

# 1.0.0

## 2026-07-27

首个开源版本。Bili-Ticket-Go 守护进程从私有服务器仓库拆分独立，MIT 协议公开。

### 守护进程

#### 新增
- 守护进程主程序 `Bili-Ticket-Go-Task-Auto-Recovery.js`：保活 BTG 子进程、健康监控、退避重启、调用恢复 helper。仅使用 Node.js 内置模块，无需 `npm install`
- BTG 始终通过 `spawn(..., { shell: false, cwd: <BTG 应用目录> })` 启动，启动参数来自配置且必须包含 `-web` 和 `-no-browser`
- `consoleTee: true` 时把 BTG 子进程 stdout/stderr 原样 tee 到守护进程 stdout，并在 BTG 启动/退出/重启、Web 就绪、恢复 helper 起停、外部进程接管、健康失败重启等关键节点打印带时间戳摘要
- 异常退出后退避序列 1/2/4/8/16/32/60s，最长 60s；连续运行 5 分钟（`resetAfterMs`）后下一次退出从 1s 重新计数
- named pipe 单实例：管道名由 BTG 应用目录哈希生成，同一应用目录只能运行一个守护进程
- 每次启动 BTG 前用 `Win32_Process` 核对完整 EXE 路径；发现手工启动的同路径进程时只轮询、不开第二份、不终止，外部进程结束后才接管
- 健康端点 `http://127.0.0.1:18081/health` 只监听回环，HTTP 200=健康/503=不健康，JSON 提供 `btgReadiness`、`app.generation`、`restart.lastExit`、`recovery.browserHook.state` 等排障字段
- `stop` 只终止守护进程自己启动的 BTG；`restart` 若检测到外部进程会拒绝操作，避免误杀手工任务

#### 修复
- 计划任务从 S4U 默认改为 Interactive 优先（用户登录触发、桌面可见控制台窗口），S4U 降级为 fallback，使 `consoleTee` 实时回显能在桌面窗口看到
- 安装器 `install-bili-ticket-go-task-auto-recovery.ps1` 在 Windows PowerShell 5.1 + `Set-StrictMode -Version Latest` 下的 `AmbiguousParameterSet` 误报：if-as-expression 改普通 if/else，`Split-Path -Leaf/-Parent` 改 `[System.IO.Path]::GetFileName/GetDirectoryName`，对 PS 5.1 和 PS 7 都安全

### 浏览器恢复 helper

#### 新增
- `Bili-Ticket-Go-Task-Recover-Latest.js`：用 Edge CDP 驱动 headless Edge 点击 BTG Web 的「恢复这个任务」按钮，并校验确实产生了新的 active job
- 登录态检测：BTG Web 出现登录表单时，读取 `data/web/session_token` 并通过 CDP 注入密码框提交登录；token 仅作为 CDP 调用参数传入，从不打印
- 每一代 BTG 进程 Web 就绪后最多调用一次 helper（`oncePerGeneration`）；helper 超时、非零退出或被取消都落事件日志，不在同一代自动重放
- BTG 退出时正在运行的 helper 及其 Edge 子进程树被终止，避免脱离守护；新 generation 等旧 helper 进程树确认退出后才启动，避免两代 helper 重叠点击
- 恢复锁文件 `Bili-Ticket-Go-Task-Recovery-State.json` 防止对同一 `sourceJobId` 重复点击：上次尝试 `phase` 非 `verified` 时拒绝再次点击同一 job
- 校验目标仍是最新记录、无 active job、项目 ID 与目标日期与配置一致，且只点击一次、必须观察到新 job ID 才以退出码 0 报告成功

### 安装器

#### 新增
- `install-bili-ticket-go-task-auto-recovery.ps1`：注册 Windows 计划任务，依次尝试 Interactive + LogonTrigger、S4U + Startup/LogonTrigger、S4U + LogonTrigger
- 安装前校验：必填文件存在、配置 JSON 合法、`jobRecovery.enabled` 时 Node.js ≥ 22 且 helper 在场、`node --check` 语法检查、脚本与配置 SHA256 用于后续升级校验
- 升级保护：检测到运行中的守护进程时先 `stop` 并等待 named pipe 释放，未释放则拒绝模糊升级；文件 hash 不匹配则拒绝接管
- 立即启动任务并通过 named pipe 验证期望的守护进程实例与 BTG Web 就绪

### 配置

#### 新增
- `Bili-Ticket-Go-Task-Auto-Recovery-Config-Example.json` 配置模板：BTG 启动参数、健康端口、退避策略、任务恢复参数。实际配置文件 `.config.json` 不提交，含蹲票项目参数，由用户在 BTG Web 创建任务后自行填写
- 路径防穿越：`executable`、`logDirectory`、`jobsFile` 等相对路径校验不得逃逸出 BTG 应用目录或守护目录
- `acceptTerms` 必须显式布尔；`supervisorHealth.host` 必须为 `127.0.0.1`

### 文档

#### 新增
- README、CLAUDE.md、CHANGELOG.md、LICENSE（MIT）
- CLAUDE.md 记录架构、安全边界、监控判据表、事件日志关键类型、任务恢复原理、手动清锁重试步骤
