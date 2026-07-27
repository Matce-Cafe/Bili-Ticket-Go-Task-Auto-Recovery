# Bili-Ticket-Go-Task-Auto-Recovery

[Bili-Ticket-Go](https://github.com/konaxia548/bili-ticket-go)（BTG）的 Windows 守护进程：保持 BTG 运行、监控健康、异常退避重启，并自动恢复最近一次抢票任务。

> BTG 本体不包含在本仓库内。本仓库只提供守护脚本、配置、浏览器恢复 helper 和一键启动入口。

## 它解决什么问题

BTG 以 `btg-windows-amd64-dynamic.exe -web -no-browser` 长期运行蹲票，但会偶发崩溃退出（包括 native 访问违例 `0xC0000005`）、被误关，或因抢票任务进入失败/停止态而停止监控。本守护进程：

- **保活**：BTG 进程退出后按 1/2/4/8/16/32/60s 退避自动重启，连续运行 5 分钟后退出码计数归零。
- **健康监控**：主动探测 BTG Web（`:18080`），把自身与 BTG 的状态汇总到 `http://127.0.0.1:18081/health`，作为唯一监控入口。
- **任务自动恢复**：每一代 BTG 子进程 Web 就绪后，调用浏览器 helper 自动识别最新任务并通过 Edge CDP 点击「恢复这个任务」，校验确实产生了新的 active job。
- **自动识别任务**：无需手填项目 ID 与目标日期，helper 自动取 BTG 当前正在运行或历史最新运行的任务；没有任何任务时友好提示去 BTG Web 创建。
- **安全边界**：`spawn(shell:false)` 启动 BTG、路径防穿越、named pipe 单实例、`acceptTerms` 显式布尔、外部手工启动的同路径进程只监控不接管。

## 快速开始

### 前置要求

- Windows 10/11 x64
- [Bili-Ticket-Go](https://github.com/konaxia548/bili-ticket-go) 本体（`btg-windows-amd64-dynamic.exe` 及 `data/`、`log/`、`model/`）放在某个 BTG 应用目录，例如 `C:\Apps\Bili-Ticket-Go\`
- Microsoft Edge（恢复 helper 通过 CDP 驱动 Edge 点击恢复按钮）
- Node.js 22 或更新版本。把便携版 `node.exe` 放进守护目录即可，`start.bat` 会优先用它；找不到则回退到 PATH 中的 `node`。

### 目录布局

```
<BTG 应用目录>\              # 例如 C:\Apps\Bili-Ticket-Go\
  btg-windows-amd64-dynamic.exe
  data\
  log\
  model\
  Bili-Ticket-Go-Task-Auto-Recovery\   # 本仓库内容放这里
    node.exe
    start.bat                          # 双击启动入口
    bili-ticket-go-task-auto-recovery.js
    bili-ticket-go-task-auto-recovery.config.json   # 从 .example.json 复制（可不改）
    bili-ticket-go-task-recover-latest.js
    bili-ticket-go-task-auto-recovery-logs\          # 运行时生成
```

### 1. 开始守护

把本仓库内容放到 BTG 应用目录下的 `Bili-Ticket-Go-Task-Auto-Recovery\` 子目录，**双击 `start.bat`** 即可：

- **BTG 已运行** → 守护进程只监控不接管，BTG 退出后自动拉起并恢复最新任务。
- **BTG 未运行** → 守护进程自动启动 BTG，Web 就绪后自动恢复最新一条任务的执行。
- **BTG 还没有任何任务** → helper 友好提示「请先在 BTG Web 创建任务」，退出码 0 不报错，下一代 BTG 启动后会重试。

控制台窗口会实时回显 BTG 输出（如「库存检测仍不可售，继续监控」）和关键生命周期事件。**关闭窗口即停止守护**。

> 守护进程只使用 Node.js 内置模块，无需 `npm install`。

### 2. 配置（可选）

默认配置开箱即用，多数情况无需修改。如需调整，从模板复制一份：

```powershell
Copy-Item .\bili-ticket-go-task-auto-recovery.config.example.json .\bili-ticket-go-task-auto-recovery.config.json
```

可调项：健康端口、退避策略、探测间隔、日志目录等。任务恢复的 project-id 与 selected-date **无需填写**——helper 自动从 BTG 任务记录识别。

### 3. 常用命令

```powershell
cd C:\Apps\Bili-Ticket-Go\Bili-Ticket-Go-Task-Auto-Recovery
.\node.exe .\bili-ticket-go-task-auto-recovery.js status    # 查看
.\node.exe .\bili-ticket-go-task-auto-recovery.js restart   # 重启 BTG（不重载配置）
.\node.exe .\bili-ticket-go-task-auto-recovery.js stop      # 停止
Invoke-RestMethod http://127.0.0.1:18081/health             # 健康
```

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `start.bat` | 一键启动入口，双击即开始守护（优先用同目录 `node.exe`，回退 PATH） |
| `bili-ticket-go-task-auto-recovery.js` | 守护进程主程序：保活 + 健康监控 + 退避重启 + 调用恢复 helper |
| `bili-ticket-go-task-auto-recovery.config.example.json` | 配置模板，开箱即用，复制为 `.config.json` 后按需修改 |
| `bili-ticket-go-task-recover-latest.js` | 浏览器恢复 helper：自动识别最新任务，用 Edge CDP 点击「恢复这个任务」并校验新 job |

详细架构、安全边界、监控判据、任务恢复原理请参阅 [CLAUDE.md](CLAUDE.md)。

## 监控

`http://127.0.0.1:18081/health` 是唯一监控入口，只监听回环，外部监控需从服务器本机访问（SSH 进来 curl，或本机监控代理）。HTTP 状态码即信号：**200 = 健康，503 = 不健康**。

```bash
# SSH 进来 curl，非 200 即告警
curl -sf http://127.0.0.1:18081/health >/dev/null || echo DOWN
```

> 不要直接探测 `:18080`（BTG Web）——它只反映 Web 层，不反映守护逻辑（退避、外部进程接管、恢复 helper 状态）。一律走 `:18081/health`。

## 更新日志

请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
