# Bili-Ticket-Go-Task-Auto-Recovery

[Bili-Ticket-Go](https://github.com/konaxia548/bili-ticket-go)（BTG）的 Windows 守护进程：保持 BTG 运行、监控健康、异常退避重启，并在每次重启后自动恢复最近一次抢票任务。

> BTG 本体不包含在本仓库内。本仓库只提供守护脚本、配置、浏览器恢复 helper 和 Windows 计划任务安装器。

## 它解决什么问题

BTG 以 `btg-windows-amd64-dynamic.exe -web -no-browser` 长期运行蹲票，但会偶发崩溃退出（包括 native 访问违例 `0xC0000005`）、被误关，或因抢票任务进入失败/停止态而停止监控。本守护进程：

- **保活**：BTG 进程退出后按 1/2/4/8/16/32/60s 退避自动重启，连续运行 5 分钟后退出码计数归零。
- **健康监控**：主动探测 BTG Web（`:18080`），把自身与 BTG 的状态汇总到 `http://127.0.0.1:18081/health`，作为唯一监控入口。
- **任务自动恢复**：每一代 BTG 子进程 Web 就绪后，调用浏览器 helper 通过 Edge CDP 点击「恢复这个任务」，并校验确实产生了新的 active job。
- **安全边界**：`spawn(shell:false)` 启动 BTG、路径防穿越、named pipe 单实例、`acceptTerms` 显式布尔、外部手工启动的同路径进程只监控不接管。

## 快速开始

### 前置要求

- Windows 10/11 x64
- [Bili-Ticket-Go](https://github.com/konaxia548/bili-ticket-go) 本体（`btg-windows-amd64-dynamic.exe` 及 `data/`、`log/`、`model/`）已放在某个 BTG 应用目录，例如 `C:\Apps\Bili-Ticket-Go\`
- Microsoft Edge（恢复 helper 通过 CDP 驱动 Edge 点击恢复按钮）
- Node.js 22 或更新版本（恢复 helper 使用全局 `WebSocket`）。把便携版 `node.exe` 放进守护目录即可，安装器会优先用它。

### 目录布局

```
<BTG 应用目录>\              # 例如 C:\Apps\Bili-Ticket-Go\
  btg-windows-amd64-dynamic.exe
  data\
  log\
  model\
  Bili-Ticket-Go-Task-Auto-Recovery\   # 本仓库内容放这里
    node.exe
    bili-ticket-go-task-auto-recovery.js
    bili-ticket-go-task-auto-recovery.config.json   # 从 .example.json 复制并改
    bili-ticket-go-task-recover-latest.js
    install-bili-ticket-go-task-auto-recovery.ps1
    bili-ticket-go-task-auto-recovery-logs\          # 运行时生成
```

### 1. 准备配置

复制配置模板，并在 BTG Web 里创建一个蹲票任务后，把项目 ID 与目标日期填进去：

```powershell
Copy-Item .\bili-ticket-go-task-auto-recovery.config.example.json .\bili-ticket-go-task-auto-recovery.config.json
```

需要修改的关键项（`jobRecovery.args`）：

| 参数 | 说明 |
| --- | --- |
| `--project-id=` | 抢票项目 ID，在 BTG Web 创建任务后从任务信息中获得 |
| `--selected-date=` | 目标日期，`YYYY-MM-DD`，与 BTG 任务里选择的开票日期一致 |

> 守护进程只使用 Node.js 内置模块，无需 `npm install`。

### 2. 安装并立即运行

安装器注册 Windows 计划任务 `Bili-Ticket-Go-Task-Auto-Recovery`，必须用 **elevated（管理员）** 会话运行（注册 S4U/`AtStartup` 触发器需要管理员权限）：

```powershell
Set-Location C:\Apps\Bili-Ticket-Go\Bili-Ticket-Go-Task-Auto-Recovery
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-bili-ticket-go-task-auto-recovery.ps1
```

安装器依次尝试：

1. **Interactive + 用户登录触发器**（首选）：守护进程在用户 RDP 桌面会话里以**可见控制台窗口**运行，配合 `consoleTee` 把 BTG 实时输出和关键生命周期事件回显到窗口。代价是必须有人登录，会话注销即停止。
2. **S4U + 开机/用户登录触发器**（fallback）：不依赖登录、开机即跑，但 session 0 不可见。
3. **S4U + 用户登录触发器**（fallback）：同上不可见。

安装器会立即启动任务并通过 named pipe 验证状态。卸载：

```powershell
.\install-bili-ticket-go-task-auto-recovery.ps1 -Uninstall
```

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
| `bili-ticket-go-task-auto-recovery.js` | 守护进程主程序：保活 + 健康监控 + 退避重启 + 调用恢复 helper |
| `bili-ticket-go-task-auto-recovery.config.example.json` | 配置模板（含示例值，复制为 `.config.json` 后改） |
| `bili-ticket-go-task-recover-latest.js` | 浏览器恢复 helper：用 Edge CDP 点击「恢复这个任务」并校验新 job |
| `install-bili-ticket-go-task-auto-recovery.ps1` | Windows 计划任务安装器（elevated 会话运行） |

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
