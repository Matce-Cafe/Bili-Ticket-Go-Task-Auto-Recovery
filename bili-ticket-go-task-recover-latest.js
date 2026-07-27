'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const supervisorDir = path.resolve(__dirname);
const appDir = path.basename(supervisorDir).toLowerCase() === 'bili-ticket-go-task-auto-recovery'
  ? path.resolve(supervisorDir, '..')
  : supervisorDir;
const tokenPath = path.join(appDir, 'data', 'web', 'session_token');
const targetSelector = process.argv[2] || 'latest';
const restartLatest = process.argv.includes('--restart-latest');
const profileDir = path.join(os.tmpdir(), `btg-cdp-${process.pid}-${Date.now()}`);
const jobsPath = path.join(appDir, 'data', 'web', 'order_jobs.json');
const recoveryStatePath = path.join(supervisorDir, 'bili-ticket-go-task-recovery-state.json');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 没有可恢复任务时打印友好提示并以退出码 0 结束（守护进程据此知道无需操作、下一代重试）。
function reportNoTask(message) {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: 'no task to recover', message })}\n`);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('Session token is empty');
  const activeStates = new Set(['queued', 'running', 'starting', 'waiting_start']);
  // 自动识别 BTG 当前正在运行或历史最新运行的任务：order_jobs.json 不存在或为空时，
  // 友好提示用户先去 BTG Web 创建任务，退出码 0（守护进程不报错，下一代 BTG 起来后重试）。
  let histories;
  try {
    histories = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  } catch {
    reportNoTask('BTG 还没有任何蹲票任务记录（order_jobs.json 不存在），请先在 BTG Web 创建任务，守护进程会在下一次 BTG 启动后自动恢复。');
    return;
  }
  if (!Array.isArray(histories) || histories.length === 0) {
    reportNoTask('BTG 还没有任何蹲票任务记录，请先在 BTG Web 创建任务，守护进程会在下一次 BTG 启动后自动恢复。');
    return;
  }
  const activeBefore = histories.filter((item) => activeStates.has(String(item?.job?.status || item?.snapshot?.state || '').toLowerCase()));
  // 已有活跃任务时无需恢复，视为成功（helper 的职责就是保证存在活跃蹲票任务）。
  if (restartLatest && activeBefore.length > 0) {
    process.stdout.write(`${JSON.stringify({
      skipped: true,
      reason: 'an active job already exists',
      activeJobId: activeBefore[0]?.job?.id,
    })}\n`);
    return;
  }
  const sorted = [...histories].sort((a, b) => {
    const aTime = Date.parse(a?.snapshot?.updated_at || a?.job?.created_at || '') || 0;
    const bTime = Date.parse(b?.snapshot?.updated_at || b?.job?.created_at || '') || 0;
    return bTime - aTime;
  });
  const targetJobId = targetSelector === 'latest' ? String(sorted[0]?.job?.id || '') : targetSelector;
  const candidate = sorted.find((item) => item?.job?.id === targetJobId);
  if (!candidate) throw new Error(`Target job was not found: ${targetJobId}`);
  if (sorted[0]?.job?.id !== targetJobId) throw new Error(`Target is no longer the latest job: ${targetJobId}`);
  if (restartLatest && candidate?.preview?.can_execute !== true) throw new Error('Target job is not executable');
  const selectedDate = String(candidate?.restart_draft?.selected_date || '');
  const projectId = String(candidate?.job?.project_id || '');
  fs.mkdirSync(profileDir, { recursive: true });

  const edge = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-features=msEdgeFirstRunExperience',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });

  let ws;
  let nextId = 1;
  const pending = new Map();
  try {
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const portText = await waitFor(() => {
      try { return fs.readFileSync(portFile, 'utf8'); } catch { return ''; }
    }, 15000, 'Edge DevTools port');
    const [port] = portText.trim().split(/\r?\n/);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('No Edge page target found');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });

    function cdp(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
      }
      return result.result.value;
    }

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Page.navigate', { url: 'http://127.0.0.1:18080/jobs' });
    await delay(5000);

    const loginVisible = await evaluate(`Boolean(document.querySelector('form.login-form input[type="password"]'))`);
    if (loginVisible) {
      // Pass the token as a CDP call argument encoded by JSON.stringify. Never print it.
      const tokenLiteral = JSON.stringify(token);
      await evaluate(`(() => {
        const input = document.querySelector('form.login-form input[type="password"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${tokenLiteral});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('form.login-form').requestSubmit();
        return true;
      })()`);
      await delay(8000);
    }

    const report = await evaluate(`(() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button')].map((button, index) => ({
        index,
        text: clean(button.textContent).slice(0, 120),
        title: clean(button.title).slice(0, 120),
        disabled: button.disabled,
        context: clean(button.closest('tr,li,.job-card,.panel,.card,section,div')?.textContent).slice(0, 400)
      })).filter((button) => /恢复|重启|restart/i.test(button.text + ' ' + button.title + ' ' + button.context));
      return {
        href: location.href,
        title: document.title,
        authenticated: !Boolean(document.querySelector('form.login-form')),
        targetJobPresent: document.body.innerText.includes(${JSON.stringify(targetJobId)}),
        bodyText: clean(document.body.innerText).slice(0, 5000),
        restartButtons: buttons
      };
    })()`);
    if (restartLatest) {
      process.stdout.write(`${JSON.stringify({
        href: report.href,
        authenticated: report.authenticated,
        sourceJobId: targetJobId,
        restartButtonCount: report.restartButtons.length
      })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }

    if (restartLatest) {
      let previousAttempt = null;
      try { previousAttempt = JSON.parse(fs.readFileSync(recoveryStatePath, 'utf8')); } catch {}
      if (previousAttempt?.sourceJobId === targetJobId && previousAttempt?.phase !== 'verified') {
        throw new Error(`A prior unverified restart attempt exists for ${targetJobId}; refusing to click twice`);
      }
      let restartCount = await evaluate(`(() => [...document.querySelectorAll('button')].filter((button) =>
        /恢复这个任务|Restart this job/i.test(String(button.title || '') + ' ' + String(button.textContent || ''))
      ).length)()`);
      if (restartCount === 0) {
        const reloaded = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((item) =>
            /重新载入|Reload/i.test(String(item.title || '') + ' ' + String(item.textContent || ''))
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`);
        if (reloaded) await delay(8000);
        restartCount = await evaluate(`(() => [...document.querySelectorAll('button')].filter((button) =>
          /恢复这个任务|Restart this job/i.test(String(button.title || '') + ' ' + String(button.textContent || ''))
        ).length)()`);
      }
      if (restartCount === 0) throw new Error('No restart button is available after reloading jobs');

      const attempt = {
        sourceJobId: targetJobId,
        phase: 'clicking',
        attemptedAt: new Date().toISOString(),
        projectId,
        selectedDate
      };
      fs.writeFileSync(recoveryStatePath, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8');

      const clickResult = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')].filter((button) =>
          /恢复这个任务|Restart this job/i.test(String(button.title || '') + ' ' + String(button.textContent || ''))
        );
        if (!buttons.length) return { clicked: false, reason: 'no restart button' };
        const button = buttons[0];
        if (button.disabled) return { clicked: false, reason: 'latest restart button is disabled' };
        button.click();
        return { clicked: true, title: button.title || '', index: [...document.querySelectorAll('button')].indexOf(button) };
      })()`);
      process.stdout.write(`${JSON.stringify({ restartClick: clickResult, sourceJobId: targetJobId })}\n`);
      if (!clickResult.clicked) {
        attempt.phase = 'not_clicked';
        fs.writeFileSync(recoveryStatePath, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8');
        throw new Error(clickResult.reason || 'Restart click was not performed');
      }
      await delay(12000);

      const after = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
      const newActive = [...after]
        .filter((item) => activeStates.has(String(item?.job?.status || item?.snapshot?.state || '').toLowerCase()))
        .filter((item) => String(item?.job?.project_id || '') === String(candidate?.job?.project_id || ''))
        .sort((a, b) => (Date.parse(b?.job?.created_at || '') || 0) - (Date.parse(a?.job?.created_at || '') || 0))[0];
      if (!newActive || newActive?.job?.id === targetJobId) {
        const pageAfter = await evaluate(`(() => ({ href: location.href, body: String(document.body.innerText || '').replace(/\\s+/g, ' ').slice(-2500) }))()`);
        attempt.phase = 'unverified';
        attempt.pageAfter = pageAfter.body;
        fs.writeFileSync(recoveryStatePath, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8');
        throw new Error('Restart click did not produce a new active job');
      }
      attempt.phase = 'verified';
      attempt.newJobId = newActive.job.id;
      attempt.verifiedAt = new Date().toISOString();
      fs.writeFileSync(recoveryStatePath, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8');
      process.stdout.write(`${JSON.stringify({
        restartVerified: true,
        sourceJobId: targetJobId,
        newJobId: newActive.job.id,
        status: newActive.job.status,
        state: newActive.snapshot?.state,
        phase: newActive.snapshot?.phase,
        projectId: newActive.job.project_id,
        selectedDate: newActive.restart_draft?.selected_date
      }, null, 2)}\n`);
    }
    await cdp('Browser.close').catch(() => {});
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(); } catch (_) {}
    }
    if (edge && !edge.killed) {
      try { edge.kill(); } catch (_) {}
    }
    await delay(500);
    try {
      const full = path.resolve(profileDir);
      const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
      if (full.startsWith(tempRoot)) {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
    } catch (_) {
      // Edge sometimes still holds files; do not fail a successful recovery for cleanup.
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
