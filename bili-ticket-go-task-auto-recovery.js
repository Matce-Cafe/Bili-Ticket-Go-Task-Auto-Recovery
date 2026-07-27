#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const SUPERVISOR_DIR = path.resolve(__dirname);
const APP_DIR = path.basename(SUPERVISOR_DIR).toLowerCase() === 'bili-ticket-go-task-auto-recovery'
  ? path.resolve(SUPERVISOR_DIR, '..')
  : SUPERVISOR_DIR;
const CONFIG_PATH = path.join(SUPERVISOR_DIR, 'bili-ticket-go-task-auto-recovery.config.json');
const INSTANCE_KEY = crypto
  .createHash('sha256')
  .update(process.platform === 'win32' ? APP_DIR.toLowerCase() : APP_DIR)
  .digest('hex')
  .slice(0, 16);
const IPC_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\bili-ticket-go-task-auto-recovery-${INSTANCE_KEY}`
  : path.join(os.tmpdir(), `bili-ticket-go-task-auto-recovery-${INSTANCE_KEY}.sock`);

// 控制台彩色日志，风格参考 Google-AI-Mode-Adapter：[Tag] 前缀按级别着色，正文保持纯文本。
// 仅 live 控制台着色；事件日志（jsonl）与 BTG/helper 日志文件保持纯文本，不混入 ANSI 码。
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};
const LEVEL_COLOR = {
  info: ANSI.cyan,
  success: ANSI.green,
  warn: ANSI.yellow,
  error: ANSI.red,
};
// 遵循 NO_COLOR 约定；仅在 stdout 是真 TTY 时着色（重定向/管道/session 0 自动降级为纯文本）。
const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI_STRIP_RE = /\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(value) {
  return typeof value === 'string' ? value.replace(ANSI_STRIP_RE, '') : value;
}
function consoleTimePrefix(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
  };
}

class DailyFile {
  constructor(directory, prefix, suffix) {
    this.directory = directory;
    this.prefix = prefix;
    this.suffix = suffix;
    this.warned = false;
    fs.mkdirSync(directory, { recursive: true });
  }

  write(value) {
    try {
      const filename = `${this.prefix}-${localDay()}.${this.suffix}`;
      fs.appendFileSync(path.join(this.directory, filename), value);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`Cannot write supervisor log: ${error.message}\n`);
      }
    }
  }
}

class Logger {
  constructor(directory) {
    this.events = new DailyFile(directory, 'supervisor', 'jsonl');
    this.stdout = new DailyFile(directory, 'btg', 'stdout.log');
    this.stderr = new DailyFile(directory, 'btg', 'stderr.log');
    this.recoveryStdout = new DailyFile(directory, 'job-recovery', 'stdout.log');
    this.recoveryStderr = new DailyFile(directory, 'job-recovery', 'stderr.log');
  }

  event(type, fields = {}) {
    this.events.write(`${JSON.stringify({
      time: new Date().toISOString(),
      type,
      ...fields,
    })}\n`);
  }
}

// 把字节流按 \n 切分成完整行，回调逐行返回（保留最后一行不完整片段等待后续数据）。
class LineDecoder {
  constructor() { this.buffer = ''; }

  feed(chunk, onLine) {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function resolveInside(baseDir, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be relative to ${baseDir}`);
  }
  const resolved = path.resolve(baseDir, value);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${baseDir}`);
  }
  return resolved;
}

function resolveInsideApp(value, label) {
  return resolveInside(APP_DIR, value, label);
}

function resolveInsideSupervisor(value, label) {
  return resolveInside(SUPERVISOR_DIR, value, label);
}

function integerInRange(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${CONFIG_PATH}: ${error.message}`);
  }
  requireObject(raw, 'configuration');

  if (typeof raw.acceptTerms !== 'boolean') {
    throw new Error('acceptTerms must be explicitly true or false');
  }
  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('args must be an array of strings');
  }
  for (const requiredArgument of ['-web', '-no-browser']) {
    if (!raw.args.includes(requiredArgument)) {
      throw new Error(`args must include ${requiredArgument}`);
    }
  }
  if (!Array.isArray(raw.termsPromptPatterns) || raw.termsPromptPatterns.length === 0) {
    throw new Error('termsPromptPatterns must contain at least one strong prompt pattern');
  }
  const termsPromptPatterns = raw.termsPromptPatterns.map((source, index) => {
    if (typeof source !== 'string' || !source) {
      throw new Error(`termsPromptPatterns[${index}] must be a non-empty string`);
    }
    try {
      return new RegExp(source, 'isu');
    } catch (error) {
      throw new Error(`termsPromptPatterns[${index}] is invalid: ${error.message}`);
    }
  });

  const supervisorHealth = requireObject(raw.supervisorHealth, 'supervisorHealth');
  if (supervisorHealth.host !== '127.0.0.1') {
    throw new Error('supervisorHealth.host must be 127.0.0.1');
  }
  const btgHealth = requireObject(raw.btgHealth, 'btgHealth');
  const restart = requireObject(raw.restart, 'restart');
  const duplicateCheck = requireObject(raw.duplicateCheck, 'duplicateCheck');
  const taskRecovery = requireObject(raw.taskRecovery, 'taskRecovery');
  const jobRecovery = requireObject(raw.jobRecovery, 'jobRecovery');

  if (!Array.isArray(jobRecovery.args)
      || jobRecovery.args.some((argument) => typeof argument !== 'string')) {
    throw new Error('jobRecovery.args must be an array of strings');
  }
  if (!Array.isArray(jobRecovery.requiredFiles)
      || jobRecovery.requiredFiles.some((filename) => typeof filename !== 'string')) {
    throw new Error('jobRecovery.requiredFiles must be an array of relative paths');
  }
  if (!Array.isArray(jobRecovery.statusPaths)
      || jobRecovery.statusPaths.length === 0
      || jobRecovery.statusPaths.some((field) => typeof field !== 'string' || !field)) {
    throw new Error('jobRecovery.statusPaths must contain one or more field paths');
  }
  if (!Array.isArray(jobRecovery.inactiveStatuses)
      || jobRecovery.inactiveStatuses.length === 0) {
    throw new Error('jobRecovery.inactiveStatuses must explicitly list terminal statuses');
  }

  const config = {
    executablePath: resolveInsideApp(raw.executable, 'executable'),
    args: raw.args.slice(),
    acceptTerms: raw.acceptTerms,
    consoleTee: raw.consoleTee === true,
    termsPromptPatterns,
    termsPromptPatternSources: raw.termsPromptPatterns.slice(),
    logDirectory: resolveInsideSupervisor(raw.logDirectory || 'bili-ticket-go-task-auto-recovery-logs', 'logDirectory'),
    supervisorHealth: {
      host: supervisorHealth.host,
      port: integerInRange(supervisorHealth.port, 'supervisorHealth.port', 1, 65535),
    },
    btgHealth: {
      url: String(btgHealth.url || ''),
      intervalMs: integerInRange(btgHealth.intervalMs, 'btgHealth.intervalMs', 1000, 60000),
      timeoutMs: integerInRange(btgHealth.timeoutMs, 'btgHealth.timeoutMs', 500, 30000),
      startupGraceMs: integerInRange(
        btgHealth.startupGraceMs,
        'btgHealth.startupGraceMs',
        1000,
        300000,
      ),
      failureThreshold: integerInRange(
        btgHealth.failureThreshold,
        'btgHealth.failureThreshold',
        1,
        100,
      ),
      restartManagedOnFailure: btgHealth.restartManagedOnFailure === true,
      acceptedStatusMin: integerInRange(
        btgHealth.acceptedStatusMin,
        'btgHealth.acceptedStatusMin',
        100,
        599,
      ),
      acceptedStatusMax: integerInRange(
        btgHealth.acceptedStatusMax,
        'btgHealth.acceptedStatusMax',
        100,
        599,
      ),
    },
    restart: {
      initialDelayMs: integerInRange(restart.initialDelayMs, 'restart.initialDelayMs', 1000, 60000),
      maxDelayMs: integerInRange(restart.maxDelayMs, 'restart.maxDelayMs', 1000, 60000),
      resetAfterMs: integerInRange(restart.resetAfterMs, 'restart.resetAfterMs', 1000, 86400000),
    },
    duplicateCheck: {
      enabled: duplicateCheck.enabled !== false,
      pollIntervalMs: integerInRange(
        duplicateCheck.pollIntervalMs,
        'duplicateCheck.pollIntervalMs',
        1000,
        60000,
      ),
      queryTimeoutMs: integerInRange(
        duplicateCheck.queryTimeoutMs,
        'duplicateCheck.queryTimeoutMs',
        1000,
        30000,
      ),
    },
    shutdownGraceMs: integerInRange(raw.shutdownGraceMs, 'shutdownGraceMs', 1000, 60000),
    taskRecovery: {
      enabled: taskRecovery.enabled === true,
      endpointVerified: taskRecovery.endpointVerified === true,
      verifiedEndpoint: typeof taskRecovery.verifiedEndpoint === 'string'
        ? taskRecovery.verifiedEndpoint.trim()
        : '',
      allowNonLoopbackEndpoint: taskRecovery.allowNonLoopbackEndpoint === true,
      method: String(taskRecovery.method || 'POST').toUpperCase(),
      headers: taskRecovery.headers && typeof taskRecovery.headers === 'object'
        ? { ...taskRecovery.headers }
        : {},
      bodyTemplate: Object.prototype.hasOwnProperty.call(taskRecovery, 'bodyTemplate')
        ? taskRecovery.bodyTemplate
        : null,
      jobsFilePath: resolveInsideApp(
        taskRecovery.jobsFile || 'data/web/order_jobs.json',
        'taskRecovery.jobsFile',
      ),
      jobsArrayPath: typeof taskRecovery.jobsArrayPath === 'string'
        ? taskRecovery.jobsArrayPath
        : '',
      jobIdPath: typeof taskRecovery.jobIdPath === 'string'
        ? taskRecovery.jobIdPath
        : 'id',
      statusPath: typeof taskRecovery.statusPath === 'string'
        ? taskRecovery.statusPath
        : 'status',
      allowedStatuses: Array.isArray(taskRecovery.allowedStatuses)
        ? taskRecovery.allowedStatuses.map(String)
        : [],
      timestampPaths: Array.isArray(taskRecovery.timestampPaths)
        ? taskRecovery.timestampPaths.map(String)
        : ['updated_at', 'created_at'],
      delayMs: integerInRange(taskRecovery.delayMs, 'taskRecovery.delayMs', 0, 60000),
      timeoutMs: integerInRange(taskRecovery.timeoutMs, 'taskRecovery.timeoutMs', 1000, 60000),
      oncePerSupervisorRun: taskRecovery.oncePerSupervisorRun !== false,
    },
    jobRecovery: {
      enabled: jobRecovery.enabled === true,
      command: jobRecovery.command === '{{node}}'
        ? process.execPath
        : resolveInsideApp(jobRecovery.command, 'jobRecovery.command'),
      configuredCommand: jobRecovery.command,
      args: jobRecovery.args.slice(),
      requiredFilePaths: jobRecovery.requiredFiles.map((filename, index) => resolveInsideSupervisor(
        filename,
        `jobRecovery.requiredFiles[${index}]`,
      )),
      jobsFilePath: resolveInsideApp(
        jobRecovery.jobsFile || 'data/web/order_jobs.json',
        'jobRecovery.jobsFile',
      ),
      jobsArrayPath: typeof jobRecovery.jobsArrayPath === 'string'
        ? jobRecovery.jobsArrayPath
        : '',
      jobIdPath: typeof jobRecovery.jobIdPath === 'string'
        ? jobRecovery.jobIdPath
        : 'id',
      statusPaths: jobRecovery.statusPaths.slice(),
      inactiveStatuses: jobRecovery.inactiveStatuses.map((status) => String(status).trim().toLowerCase()),
      readyDelayMs: integerInRange(
        jobRecovery.readyDelayMs,
        'jobRecovery.readyDelayMs',
        0,
        60000,
      ),
      timeoutMs: integerInRange(jobRecovery.timeoutMs, 'jobRecovery.timeoutMs', 1000, 600000),
      precheckRetryCount: integerInRange(
        jobRecovery.precheckRetryCount,
        'jobRecovery.precheckRetryCount',
        1,
        30,
      ),
      precheckRetryDelayMs: integerInRange(
        jobRecovery.precheckRetryDelayMs,
        'jobRecovery.precheckRetryDelayMs',
        250,
        30000,
      ),
      oncePerGeneration: jobRecovery.oncePerGeneration === true,
    },
  };

  if (config.restart.initialDelayMs > config.restart.maxDelayMs) {
    throw new Error('restart.initialDelayMs cannot exceed restart.maxDelayMs');
  }
  let btgHealthUrl;
  try {
    btgHealthUrl = new URL(config.btgHealth.url);
  } catch (error) {
    throw new Error(`btgHealth.url is invalid: ${error.message}`);
  }
  if (!['http:', 'https:'].includes(btgHealthUrl.protocol)
      || !isLoopbackHostname(btgHealthUrl.hostname)) {
    throw new Error('btgHealth.url must be an HTTP(S) loopback URL');
  }
  const btgHealthPort = Number(btgHealthUrl.port || (btgHealthUrl.protocol === 'https:' ? 443 : 80));
  if (config.supervisorHealth.port === btgHealthPort
      && config.supervisorHealth.host === '127.0.0.1') {
    throw new Error('supervisorHealth must not bind the BTG Web port');
  }
  if (config.btgHealth.acceptedStatusMin > config.btgHealth.acceptedStatusMax) {
    throw new Error('btgHealth.acceptedStatusMin cannot exceed acceptedStatusMax');
  }
  if (!/^[A-Z]+$/.test(config.taskRecovery.method)) {
    throw new Error('taskRecovery.method is invalid');
  }
  if (config.taskRecovery.enabled
      && (!config.taskRecovery.endpointVerified || !config.taskRecovery.verifiedEndpoint)) {
    throw new Error(
      'taskRecovery.enabled requires endpointVerified=true and a non-empty verifiedEndpoint',
    );
  }
  if (config.taskRecovery.enabled && config.jobRecovery.enabled) {
    throw new Error('taskRecovery and jobRecovery cannot be enabled at the same time');
  }
  if (config.jobRecovery.enabled && !config.jobRecovery.oncePerGeneration) {
    throw new Error('jobRecovery.oncePerGeneration must be true when job recovery is enabled');
  }
  return config;
}

function getByPath(value, dottedPath) {
  if (!dottedPath) return value;
  return dottedPath.split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 100000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function extractJobs(document, jobsArrayPath) {
  let candidates;
  if (jobsArrayPath) {
    candidates = getByPath(document, jobsArrayPath);
  } else if (Array.isArray(document)) {
    candidates = document;
  } else if (document && typeof document === 'object') {
    for (const key of ['jobs', 'order_jobs', 'data']) {
      if (Array.isArray(document[key])) {
        candidates = document[key];
        break;
      }
    }
  }

  if (!Array.isArray(candidates)) {
    throw new Error(
      'Jobs JSON does not contain an array; configure taskRecovery.jobsArrayPath explicitly',
    );
  }
  const malformedIndex = candidates.findIndex(
    (item) => !item || typeof item !== 'object' || Array.isArray(item),
  );
  if (malformedIndex >= 0) {
    throw new Error(`Jobs JSON contains a malformed item at index ${malformedIndex}`);
  }
  return candidates;
}

function selectLatestJob(document, recoveryConfig) {
  const jobs = extractJobs(document, recoveryConfig.jobsArrayPath);
  if (jobs.length === 0) throw new Error('Jobs JSON contains no job objects');

  let selected = null;
  jobs.forEach((job, index) => {
    let timestamp = Number.NEGATIVE_INFINITY;
    for (const field of recoveryConfig.timestampPaths) {
      timestamp = Math.max(timestamp, parseTimestamp(getByPath(job, field)));
    }
    const score = Number.isFinite(timestamp) ? timestamp : index;
    if (!selected || score >= selected.score) selected = { job, score, index, timestamp };
  });
  return selected;
}

function findActiveJobs(document, recoveryConfig) {
  const jobs = extractJobs(document, recoveryConfig.jobsArrayPath);
  const inactive = new Set(recoveryConfig.inactiveStatuses);
  const active = [];
  for (const job of jobs) {
    const statusValues = recoveryConfig.statusPaths.map((field) => ({
      field,
      value: getByPath(job, field),
    }));
    const missingStatusPaths = statusValues
      .filter(({ value }) => value === undefined || value === null || String(value).trim() === '')
      .map(({ field }) => field);
    const statuses = statusValues
      .filter(({ field }) => !missingStatusPaths.includes(field))
      .map(({ value }) => String(value).trim().toLowerCase());
    const isProvablyInactive = missingStatusPaths.length === 0
      && statuses.every((status) => inactive.has(status));
    if (!isProvablyInactive) {
      const jobId = getByPath(job, recoveryConfig.jobIdPath);
      active.push({
        jobId: jobId === undefined || jobId === null ? null : String(jobId),
        statuses,
        missingStatusPaths,
        reason: missingStatusPaths.length > 0
          ? 'missing-or-empty-required-status'
          : 'non-terminal-or-unknown-status',
      });
    }
  }
  return { total: jobs.length, active };
}

function renderHookArgument(value, context) {
  return String(value)
    .replace(/\{\{generation\}\}/g, String(context.generation))
    .replace(/\{\{jobsFile\}\}/g, context.jobsFilePath);
}

function renderTemplate(value, context) {
  if (value === '{{jobId}}') return context.jobId;
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplate(item, context)]),
    );
  }
  if (typeof value === 'string') {
    return value
      .replace(/\{\{jobIdUrl\}\}/g, encodeURIComponent(String(context.jobId)))
      .replace(/\{\{jobId\}\}/g, String(context.jobId));
  }
  return value;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function callRecoveryEndpoint(recoveryConfig, context) {
  return new Promise((resolve, reject) => {
    let endpoint;
    try {
      endpoint = new URL(renderTemplate(recoveryConfig.verifiedEndpoint, context));
    } catch (error) {
      reject(new Error(`Invalid verifiedEndpoint: ${error.message}`));
      return;
    }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      reject(new Error('verifiedEndpoint must use HTTP or HTTPS'));
      return;
    }
    if (!recoveryConfig.allowNonLoopbackEndpoint && !isLoopbackHostname(endpoint.hostname)) {
      reject(new Error('Non-loopback recovery endpoint is blocked by configuration'));
      return;
    }
    if (endpoint.username || endpoint.password) {
      reject(new Error('Credentials in verifiedEndpoint are not allowed; use configured headers'));
      return;
    }

    let body = null;
    const headers = Object.fromEntries(
      Object.entries(recoveryConfig.headers).map(([key, value]) => [key, String(value)]),
    );
    if (recoveryConfig.bodyTemplate !== null) {
      const rendered = renderTemplate(recoveryConfig.bodyTemplate, context);
      body = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = typeof rendered === 'string'
          ? 'text/plain; charset=utf-8'
          : 'application/json; charset=utf-8';
      }
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const transport = endpoint.protocol === 'https:' ? https : http;
    const request = transport.request(endpoint, {
      method: recoveryConfig.method,
      headers,
    }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) request.destroy(new Error('Recovery response exceeded 64 KiB'));
      });
      response.on('end', () => {
        const result = { statusCode: response.statusCode, responseBytes: bytes };
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(result);
        else reject(Object.assign(
          new Error(`Recovery endpoint returned HTTP ${response.statusCode}`),
          { result },
        ));
      });
    });
    request.setTimeout(recoveryConfig.timeoutMs, () => {
      request.destroy(new Error(`Recovery request timed out after ${recoveryConfig.timeoutMs} ms`));
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function probeHttpEndpoint(healthConfig) {
  return new Promise((resolve, reject) => {
    let endpoint;
    try {
      endpoint = new URL(healthConfig.url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = endpoint.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const request = transport.get(endpoint, {
      headers: {
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.1',
        'User-Agent': 'bili-ticket-go-task-auto-recovery-health/1.0',
      },
    }, (response) => {
      response.resume();
      response.once('end', () => {
        const result = {
          statusCode: response.statusCode,
          latencyMs: Date.now() - startedAt,
        };
        if (response.statusCode >= healthConfig.acceptedStatusMin
            && response.statusCode <= healthConfig.acceptedStatusMax) {
          resolve(result);
        } else {
          reject(Object.assign(
            new Error(`BTG readiness returned HTTP ${String(response.statusCode)}`),
            { result },
          ));
        }
      });
    });
    request.setTimeout(healthConfig.timeoutMs, () => {
      request.destroy(new Error(`BTG readiness timed out after ${healthConfig.timeoutMs} ms`));
    });
    request.once('error', reject);
  });
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function execFilePromise(filename, args, options) {
  return new Promise((resolve, reject) => {
    execFile(filename, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function findMatchingProcesses(executablePath, timeoutMs) {
  if (process.platform !== 'win32') return [];
  const filename = path.basename(executablePath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = $utf8',
    '$OutputEncoding = $utf8',
    `$name = ${powershellSingleQuoted(filename)}`,
    "$filter = 'Name = \"' + $name.Replace('\"', '\"\"') + '\"'",
    '$items = @(Get-CimInstance Win32_Process -Filter $filter | Select-Object ProcessId,ExecutablePath,CommandLine)',
    "if ($items.Count -eq 0) { Write-Output '[]' } else { $items | ConvertTo-Json -Compress }",
  ].join('\r\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = await execFilePromise('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  const text = result.stdout.trim();
  const parsed = text ? JSON.parse(text) : [];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const normalizedTarget = path.resolve(executablePath).toLowerCase();
  return records.filter((record) => {
    if (!record.ExecutablePath) return true;
    return path.resolve(record.ExecutablePath).toLowerCase() === normalizedTarget;
  }).map((record) => ({
    pid: Number(record.ProcessId),
    executablePath: record.ExecutablePath || null,
    pathWasInaccessible: !record.ExecutablePath,
  }));
}

function exitCodeHex(code) {
  if (!Number.isInteger(code)) return null;
  return `0x${(code >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
}

class Supervisor {
  constructor(config) {
    this.config = config;
    this.logger = new Logger(config.logDirectory);
    this.scriptSha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(__filename))
      .digest('hex');
    this.configSha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(CONFIG_PATH))
      .digest('hex');
    this.startedAt = Date.now();
    this.state = 'initializing';
    this.child = null;
    this.generation = 0;
    this.childGeneration = null;
    this.childStartedAt = null;
    this.childSpawnedAt = null;
    this.externalProcesses = [];
    this.backoffAttempt = 0;
    this.nextRestartAt = null;
    this.lastExit = null;
    this.lastError = null;
    this.termsAnsweredThisLaunch = false;
    this.promptBuffers = { stdout: '', stderr: '' };
    this.restartTimer = null;
    this.externalPollTimer = null;
    this.recoveryTimer = null;
    this.jobRecoveryTimer = null;
    this.jobRecoveryTimeoutTimer = null;
    this.jobRecoveryForceTimer = null;
    this.jobRecoveryChild = null;
    this.jobRecoveryChildGeneration = null;
    this.jobRecoveryCancellationReason = null;
    this.jobRecoveryAttemptedGenerations = new Set();
    this.jobRecoveryPrecheckAttempts = new Map();
    this.recoveryDrainTimer = null;
    this.btgHealthTimer = null;
    this.btgHealthMonitorKey = null;
    this.btgHealthProbeInFlight = false;
    this.btgHealthContext = null;
    this.healthRestartRequested = false;
    this.btgReadiness = {
      url: config.btgHealth.url,
      ready: false,
      mode: 'inactive',
      consecutiveFailures: 0,
      lastCheckAt: null,
      lastSuccessAt: null,
      lastFailure: null,
      lastStatusCode: null,
      lastLatencyMs: null,
    };
    this.forceKillTimer = null;
    this.checkingForDuplicates = false;
    this.restartRequested = false;
    this.stopping = false;
    this.shutdownPromise = null;
    this.recoveryAttempted = false;
    this.recovery = { state: config.taskRecovery.enabled ? 'pending' : 'disabled' };
    this.jobRecovery = { state: config.jobRecovery.enabled ? 'pending' : 'disabled' };
    this.ipcServer = null;
    this.healthServer = null;
  }

  teeToConsole(chunk) {
    if (!this.config.consoleTee) return;
    try { process.stdout.write(chunk); } catch (_) { /* no attached console, e.g. session 0 */ }
  }

  // 打印一行带时间戳、彩色 [Tag] 前缀的生命周期摘要到 live 控制台。
  // tag      — 标签文本，如 BTG / Recovery / Supervisor
  // level    — info | success | warn | error
  // message  — 纯文本正文（不含 ANSI 码）
  consoleLine(message) { return this.logLine('Supervisor', 'info', message); }

  logLine(tag, level, message) {
    if (!this.config.consoleTee) return;
    const color = LEVEL_COLOR[level] || ANSI.cyan;
    const time = consoleTimePrefix();
    try {
      if (COLOR_ENABLED) {
        process.stdout.write(
          `${ANSI.dim}${time}${ANSI.reset} ${color}[${tag}]${ANSI.reset} ${message}\n`,
        );
      } else {
        process.stdout.write(`${time} [${tag}] ${message}\n`);
      }
    } catch (_) { /* no attached console, e.g. session 0 */ }
  }

  // 解析 helper 的一行 stdout/stderr（JSON 记录或纯文本），着色打印到 live 控制台。
  // helper 输出的 JSON 记录含义见 bili-ticket-go-task-recover-latest.js。
  printRecoveryLine(line, streamName) {
    if (!this.config.consoleTee) return;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      this.logLine('Recovery', streamName === 'stderr' ? 'warn' : 'info', stripAnsi(line));
      return;
    }
    if (parsed.skipped) {
      const reason = parsed.reason || 'skipped';
      if (reason === 'an active job already exists') {
        this.logLine('Recovery', 'success', `已有活跃任务，跳过恢复（activeJobId=${parsed.activeJobId ?? '未知'}）`);
      } else {
        this.logLine('Recovery', 'warn', String(parsed.message || reason));
      }
      return;
    }
    if (parsed.restartVerified) {
      this.logLine('Recovery', 'success',
        `恢复成功 — ${parsed.sourceJobId} → ${parsed.newJobId}（状态 ${parsed.status ?? '未知'}，项目 ${parsed.projectId ?? '未知'}，日期 ${parsed.selectedDate ?? '未知'}）`);
      return;
    }
    if (parsed.restartClick) {
      const click = parsed.restartClick;
      this.logLine('Recovery', click.clicked ? 'info' : 'warn',
        `点击恢复按钮 — ${click.clicked ? '已点击' : `未点击：${click.reason || '未知'}`}${click.clicked ? `（按钮 ${click.title || '无标题'}）` : ''}`);
      return;
    }
    if (parsed.href !== undefined && parsed.sourceJobId) {
      // helper 启动阶段的探针报告：认证状态 + 恢复按钮数量
      const auth = parsed.authenticated ? '已登录' : '未登录';
      this.logLine('Recovery', 'info', `页面就绪 — ${parsed.href}（${auth}，恢复按钮 ${parsed.restartButtonCount ?? 0} 个，目标 job ${parsed.sourceJobId}）`);
      return;
    }
    // 兜底：完整 JSON 纯文本打印（用于诊断报告等大对象）。
    this.logLine('Recovery', streamName === 'stderr' ? 'warn' : 'info', stripAnsi(JSON.stringify(parsed)));
  }

  status() {
    const now = Date.now();
    const appActive = Boolean(this.child && this.child.exitCode === null)
      || this.externalProcesses.length > 0;
    return {
      ok: true,
      running: true,
      healthy: appActive && this.btgReadiness.ready,
      supervisor: {
        pid: process.pid,
        state: this.state,
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeMs: now - this.startedAt,
        ipc: IPC_PATH,
        scriptSha256: this.scriptSha256,
        configSha256: this.configSha256,
      },
      app: {
        executable: this.config.executablePath,
        args: this.config.args,
        managedPid: this.child && this.child.exitCode === null ? this.child.pid : null,
        generation: this.childGeneration,
        externalProcesses: this.externalProcesses,
        childStartedAt: this.childStartedAt
          ? new Date(this.childStartedAt).toISOString()
          : null,
        childRuntimeMs: this.childStartedAt ? now - this.childStartedAt : null,
        termsAcceptanceConfigured: this.config.acceptTerms,
        termsAnsweredThisLaunch: this.termsAnsweredThisLaunch,
      },
      restart: {
        backoffAttempt: this.backoffAttempt,
        nextRestartAt: this.nextRestartAt ? new Date(this.nextRestartAt).toISOString() : null,
        lastExit: this.lastExit,
      },
      recovery: {
        browserHook: this.jobRecovery,
        directEndpoint: this.recovery,
      },
      btgReadiness: this.btgReadiness,
      lastError: this.lastError,
      supervisorHealthUrl:
        `http://${this.config.supervisorHealth.host}:${this.config.supervisorHealth.port}/health`,
    };
  }

  async listenIpc() {
    this.ipcServer = net.createServer((socket) => this.handleIpcSocket(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.ipcServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.ipcServer.off('error', onError);
        this.ipcServer.on('error', (error) => {
          this.lastError = serializeError(error);
          this.logger.event('ipc-server-error', { error: serializeError(error) });
        });
        resolve();
      };
      this.ipcServer.once('error', onError);
      this.ipcServer.once('listening', onListening);
      this.ipcServer.listen(IPC_PATH);
    });
  }

  handleIpcSocket(socket) {
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 65536) {
        socket.end(`${JSON.stringify({ ok: false, error: 'IPC request too large' })}\n`);
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      let request;
      try {
        request = JSON.parse(input.slice(0, newline));
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: `Invalid JSON: ${error.message}` })}\n`);
        return;
      }
      this.handleIpcRequest(request).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      }).catch((error) => {
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      });
    });
    socket.on('error', () => {});
  }

  async handleIpcRequest(request) {
    const command = request && request.command;
    if (command === 'status') return this.status();
    if (command === 'stop') {
      const response = { ok: true, accepted: true, message: 'Supervisor stop requested' };
      setTimeout(() => this.shutdown('ipc-stop'), 50).unref();
      return response;
    }
    if (command === 'restart') return this.requestRestart();
    return { ok: false, error: `Unknown command: ${String(command)}` };
  }

  async listenHealth() {
    this.healthServer = http.createServer((request, response) => {
      const urlPath = String(request.url || '').split('?')[0];
      if (request.method !== 'GET' || !['/', '/health'].includes(urlPath)) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(`${JSON.stringify({ ok: false, error: 'Not found' })}\n`);
        return;
      }
      const status = this.status();
      response.writeHead(status.healthy ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(`${JSON.stringify(status)}\n`);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.healthServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.healthServer.off('error', onError);
        this.healthServer.on('error', (error) => {
          this.lastError = serializeError(error);
          this.logger.event('health-server-error', { error: serializeError(error) });
        });
        resolve();
      };
      this.healthServer.once('error', onError);
      this.healthServer.once('listening', onListening);
      this.healthServer.listen(
        this.config.supervisorHealth.port,
        this.config.supervisorHealth.host,
      );
    });
  }

  async start() {
    if (!fs.existsSync(this.config.executablePath)) {
      throw new Error(`BTG executable does not exist: ${this.config.executablePath}`);
    }
    this.logger.event('supervisor-started', {
      pid: process.pid,
      scriptSha256: this.scriptSha256,
      configSha256: this.configSha256,
      appDir: APP_DIR,
      supervisorDir: SUPERVISOR_DIR,
      executable: this.config.executablePath,
      args: this.config.args,
      acceptTerms: this.config.acceptTerms,
      supervisorHealthUrl:
        `http://${this.config.supervisorHealth.host}:${this.config.supervisorHealth.port}/health`,
      btgReadinessUrl: this.config.btgHealth.url,
      recoveryEnabled: this.config.taskRecovery.enabled,
      jobRecoveryEnabled: this.config.jobRecovery.enabled,
    });
    this.logLine('Supervisor', 'info', `Bili-Ticket-Go-Task-Auto-Recovery 守护进程启动 — PID ${process.pid}，监控 ${path.basename(this.config.executablePath)}`);
    await this.checkThenStart();
  }

  startBtgHealthMonitor(key, mode, generation = null, btgChild = null) {
    if (this.stopping || !key) return;
    if (this.btgHealthMonitorKey === key && this.btgHealthContext) return;
    this.stopBtgHealthMonitor('monitor-replaced');
    this.btgHealthMonitorKey = key;
    this.btgHealthContext = {
      key,
      mode,
      generation,
      btgChild,
      startedAt: Date.now(),
    };
    this.btgReadiness = {
      url: this.config.btgHealth.url,
      ready: false,
      mode,
      generation,
      consecutiveFailures: 0,
      lastCheckAt: null,
      lastSuccessAt: null,
      lastFailure: null,
      lastStatusCode: null,
      lastLatencyMs: null,
    };
    this.logger.event('btg-health-monitor-started', {
      key,
      mode,
      generation,
      url: this.config.btgHealth.url,
    });
    this.btgHealthTimer = setTimeout(
      () => this.runBtgHealthProbe(key),
      this.config.btgHealth.intervalMs,
    );
    setImmediate(() => this.runBtgHealthProbe(key));
  }

  stopBtgHealthMonitor(reason) {
    clearTimeout(this.btgHealthTimer);
    this.btgHealthTimer = null;
    const previousKey = this.btgHealthMonitorKey;
    this.btgHealthMonitorKey = null;
    this.btgHealthContext = null;
    this.healthRestartRequested = false;
    if (previousKey) {
      this.logger.event('btg-health-monitor-stopped', { key: previousKey, reason });
    }
    this.btgReadiness = {
      ...this.btgReadiness,
      ready: false,
      mode: 'inactive',
      generation: null,
    };
  }

  scheduleNextBtgHealthProbe(key) {
    if (this.stopping || this.btgHealthMonitorKey !== key) return;
    clearTimeout(this.btgHealthTimer);
    this.btgHealthTimer = setTimeout(
      () => this.runBtgHealthProbe(key),
      this.config.btgHealth.intervalMs,
    );
  }

  async runBtgHealthProbe(key) {
    if (this.stopping || this.btgHealthMonitorKey !== key || this.btgHealthProbeInFlight) return;
    const context = this.btgHealthContext;
    if (!context || context.key !== key) return;
    this.btgHealthProbeInFlight = true;
    const wasReady = this.btgReadiness.ready;
    try {
      const result = await probeHttpEndpoint(this.config.btgHealth);
      if (this.stopping || this.btgHealthMonitorKey !== key) return;
      this.btgReadiness = {
        ...this.btgReadiness,
        ready: true,
        consecutiveFailures: 0,
        lastCheckAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastFailure: null,
        lastStatusCode: result.statusCode,
        lastLatencyMs: result.latencyMs,
      };
      this.healthRestartRequested = false;
      if (!wasReady) {
        this.logger.event('btg-became-ready', {
          key,
          mode: context.mode,
          generation: context.generation,
          ...result,
        });
        this.logLine('Bili-Ticket-Go', 'success', `Web 就绪 — HTTP ${result.statusCode}，延迟 ${result.latencyMs}ms`);
      }
      if (context.mode === 'managed'
          && this.child === context.btgChild
          && this.childGeneration === context.generation) {
        this.scheduleRecovery();
        this.scheduleJobRecovery(context.generation, context.btgChild);
      }
    } catch (error) {
      if (this.stopping || this.btgHealthMonitorKey !== key) return;
      const failures = this.btgReadiness.consecutiveFailures + 1;
      this.btgReadiness = {
        ...this.btgReadiness,
        ready: false,
        consecutiveFailures: failures,
        lastCheckAt: new Date().toISOString(),
        lastFailure: serializeError(error),
        lastStatusCode: error.result ? error.result.statusCode : null,
        lastLatencyMs: error.result ? error.result.latencyMs : null,
      };
      const pastStartupGrace = Date.now() - context.startedAt >= this.config.btgHealth.startupGraceMs;
      if (failures === 1 || failures === this.config.btgHealth.failureThreshold) {
        this.logger.event('btg-health-check-failed', {
          key,
          mode: context.mode,
          generation: context.generation,
          consecutiveFailures: failures,
          pastStartupGrace,
          error: serializeError(error),
        });
      }
      if (pastStartupGrace && failures >= this.config.btgHealth.failureThreshold) {
        if (context.mode === 'managed'
            && this.config.btgHealth.restartManagedOnFailure
            && this.child === context.btgChild
            && !this.healthRestartRequested) {
          this.healthRestartRequested = true;
          this.logger.event('btg-unhealthy-restart-requested', {
            generation: context.generation,
            consecutiveFailures: failures,
          });
          this.logLine('Bili-Ticket-Go', 'warn', `健康探测连续失败 ${failures} 次，请求重启 managed 进程`);
          this.terminateManagedChild('btg-health-failure');
        } else if (context.mode === 'external'
            && failures % this.config.btgHealth.failureThreshold === 0) {
          this.logger.event('external-btg-unhealthy-not-terminated', {
            consecutiveFailures: failures,
            processes: this.externalProcesses,
          });
        }
      }
    } finally {
      this.btgHealthProbeInFlight = false;
      this.scheduleNextBtgHealthProbe(key);
    }
  }

  scheduleExternalPoll() {
    if (this.stopping) return;
    clearTimeout(this.externalPollTimer);
    this.externalPollTimer = setTimeout(
      () => this.checkThenStart(),
      this.config.duplicateCheck.pollIntervalMs,
    );
  }

  async checkThenStart() {
    if (this.stopping || this.child || this.checkingForDuplicates) return;
    if (this.jobRecoveryChild) {
      this.state = 'waiting-for-old-recovery-helper-exit';
      if (this.jobRecoveryChild.exitCode === null) {
        this.terminateJobRecoveryHook('btg-generation-ended', true);
      }
      if (!this.recoveryDrainTimer) {
        this.recoveryDrainTimer = setTimeout(() => {
          this.recoveryDrainTimer = null;
          this.checkThenStart();
        }, 1000);
      }
      return;
    }
    clearTimeout(this.externalPollTimer);
    this.externalPollTimer = null;
    this.checkingForDuplicates = true;
    this.state = 'checking-for-existing-process';
    try {
      const matches = this.config.duplicateCheck.enabled
        ? await findMatchingProcesses(
          this.config.executablePath,
          this.config.duplicateCheck.queryTimeoutMs,
        )
        : [];
      if (this.stopping) return;
      if (matches.length > 0) {
        const changed = JSON.stringify(matches) !== JSON.stringify(this.externalProcesses);
        this.externalProcesses = matches;
        this.state = 'monitoring-external-process';
        if (changed) this.logger.event('existing-btg-process-detected', { processes: matches });
        if (changed) this.logLine('Bili-Ticket-Go', 'warn', `检测到外部进程 ${matches.map((p) => `PID ${p.pid}`).join(', ')}，仅监控不接管，退出后自动拉起`);
        const externalKey = `external:${matches.map((processInfo) => processInfo.pid).sort().join(',')}`;
        this.startBtgHealthMonitor(externalKey, 'external');
        this.scheduleExternalPoll();
        return;
      }
      if (this.externalProcesses.length > 0) {
        this.logger.event('existing-btg-process-ended', { processes: this.externalProcesses });
      }
      this.externalProcesses = [];
      this.stopBtgHealthMonitor('no-external-btg-process');
      this.spawnManagedProcess();
    } catch (error) {
      this.lastError = serializeError(error);
      this.state = 'duplicate-check-failed';
      this.logger.event('duplicate-check-failed', {
        error: serializeError(error),
        action: 'fail-closed-and-retry',
      });
      this.scheduleExternalPoll();
    } finally {
      this.checkingForDuplicates = false;
    }
  }

  spawnManagedProcess() {
    if (this.stopping || this.child) return;
    this.state = 'starting-btg';
    this.nextRestartAt = null;
    this.termsAnsweredThisLaunch = false;
    this.promptBuffers = { stdout: '', stderr: '' };
    if (!this.config.taskRecovery.oncePerSupervisorRun) {
      this.recoveryAttempted = false;
      this.recovery = { state: this.config.taskRecovery.enabled ? 'pending' : 'disabled' };
    }

    let child;
    try {
      child = spawn(this.config.executablePath, this.config.args, {
        cwd: APP_DIR,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.handleSpawnFailure(error);
      return;
    }

    const generation = ++this.generation;
    this.child = child;
    this.childGeneration = generation;
    this.childSpawnedAt = Date.now();
    this.childStartedAt = this.childSpawnedAt;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    child.stdout.on('data', (chunk) => {
      this.logger.stdout.write(chunk);
      this.teeToConsole(chunk);
      this.inspectPrompt(stdoutDecoder.write(chunk), 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      this.logger.stderr.write(chunk);
      this.teeToConsole(chunk);
      this.inspectPrompt(stderrDecoder.write(chunk), 'stderr');
    });
    child.once('spawn', () => {
      if (this.child !== child) return;
      this.state = 'btg-running';
      this.childStartedAt = Date.now();
      this.logger.event('btg-started', {
        pid: child.pid,
        generation,
        executable: this.config.executablePath,
        args: this.config.args,
      });
      this.logLine('Bili-Ticket-Go', 'info', `已启动 — PID ${child.pid}，generation ${generation}`);
      this.startBtgHealthMonitor(`managed:${generation}`, 'managed', generation, child);
    });
    child.once('error', (error) => {
      this.lastError = serializeError(error);
      this.logger.event('btg-process-error', { pid: child.pid || null, error: serializeError(error) });
    });
    child.once('close', (code, signal) => {
      this.inspectPrompt(stdoutDecoder.end(), 'stdout');
      this.inspectPrompt(stderrDecoder.end(), 'stderr');
      this.handleChildClose(child, code, signal);
    });
  }

  inspectPrompt(text, streamName) {
    if (!text || !this.child || this.termsAnsweredThisLaunch) return;
    const previous = this.promptBuffers[streamName] || '';
    this.promptBuffers[streamName] = `${previous}${text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')}`
      .slice(-32768);
    const matchedIndex = this.config.termsPromptPatterns.findIndex(
      (pattern) => pattern.test(this.promptBuffers[streamName]),
    );
    if (matchedIndex < 0) return;
    if (this.config.acceptTerms !== true) {
      this.logger.event('terms-prompt-detected-not-accepted', {
        patternIndex: matchedIndex,
        stream: streamName,
        action: 'stdin-left-open-without-answer',
      });
      return;
    }
    if (!this.child.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.logger.event('terms-prompt-detected-stdin-unavailable', { patternIndex: matchedIndex });
      return;
    }
    this.termsAnsweredThisLaunch = true;
    this.child.stdin.write('Y\r\n', (error) => {
      if (error) {
        this.lastError = serializeError(error);
        this.logger.event('terms-answer-write-failed', { error: serializeError(error) });
      } else {
        this.logger.event('terms-prompt-accepted', { patternIndex: matchedIndex, stream: streamName });
      }
    });
  }

  handleSpawnFailure(error) {
    this.child = null;
    this.lastError = serializeError(error);
    this.logger.event('btg-spawn-threw', { error: serializeError(error) });
    this.scheduleRestart(0, 'spawn-threw');
  }

  handleChildClose(child, code, signal) {
    if (this.child !== child) return;
    clearTimeout(this.forceKillTimer);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.jobRecoveryTimer);
    this.forceKillTimer = null;
    this.recoveryTimer = null;
    this.jobRecoveryTimer = null;
    const endedAt = Date.now();
    const runtimeMs = this.childStartedAt ? endedAt - this.childStartedAt : 0;
    const generation = this.childGeneration;
    this.stopBtgHealthMonitor('managed-btg-exited');
    this.terminateJobRecoveryHook('btg-generation-ended', true);
    this.child = null;
    this.childGeneration = null;
    this.childStartedAt = null;
    this.lastExit = {
      time: new Date(endedAt).toISOString(),
      code,
      codeHex: exitCodeHex(code),
      signal,
      runtimeMs,
      generation,
    };
    this.logger.event('btg-exited', this.lastExit);
    this.logLine('Bili-Ticket-Go', 'warn', `已退出 — code=${code}${signal ? ` signal=${signal}` : ''}（${exitCodeHex(code)}），generation ${generation}`);
    if (this.stopping) {
      this.state = 'stopping';
      return;
    }
    if (this.restartRequested) {
      this.restartRequested = false;
      this.backoffAttempt = 0;
      this.scheduleRestart(0, 'manual-restart');
      return;
    }
    this.scheduleRestart(runtimeMs, 'process-exit');
  }

  scheduleRestart(runtimeMs, reason) {
    if (this.stopping) return;
    if (runtimeMs >= this.config.restart.resetAfterMs) this.backoffAttempt = 0;
    const delayMs = Math.min(
      this.config.restart.initialDelayMs * (2 ** this.backoffAttempt),
      this.config.restart.maxDelayMs,
    );
    this.backoffAttempt += 1;
    this.state = 'restart-backoff';
    this.nextRestartAt = Date.now() + delayMs;
    this.logger.event('btg-restart-scheduled', {
      reason,
      delayMs,
      attempt: this.backoffAttempt,
      nextRestartAt: new Date(this.nextRestartAt).toISOString(),
    });
    this.logLine('Bili-Ticket-Go', 'warn', `${delayMs}ms 后重启（第 ${this.backoffAttempt} 次尝试，原因 ${reason}）`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.nextRestartAt = null;
      this.checkThenStart();
    }, delayMs);
  }

  scheduleRecovery() {
    const recoveryConfig = this.config.taskRecovery;
    if (!recoveryConfig.enabled || this.recoveryAttempted || this.stopping || this.recoveryTimer) return;
    this.recovery = {
      state: 'scheduled',
      scheduledAt: new Date().toISOString(),
      delayMs: recoveryConfig.delayMs,
    };
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => this.attemptRecovery(), recoveryConfig.delayMs);
  }

  async attemptRecovery() {
    this.recoveryTimer = null;
    if (this.stopping || !this.child || this.child.exitCode !== null || this.recoveryAttempted) return;
    const recoveryConfig = this.config.taskRecovery;
    this.recoveryAttempted = true;
    this.recovery = { state: 'reading-jobs', attemptedAt: new Date().toISOString() };
    try {
      if (!recoveryConfig.endpointVerified || !recoveryConfig.verifiedEndpoint) {
        throw new Error('Recovery endpoint is not explicitly configured and verified');
      }
      const document = JSON.parse(fs.readFileSync(recoveryConfig.jobsFilePath, 'utf8'));
      const selected = selectLatestJob(document, recoveryConfig);
      const jobId = getByPath(selected.job, recoveryConfig.jobIdPath);
      if (jobId === undefined || jobId === null || String(jobId).trim() === '') {
        throw new Error(`Latest job has no value at jobIdPath=${recoveryConfig.jobIdPath}`);
      }
      const status = getByPath(selected.job, recoveryConfig.statusPath);
      if (recoveryConfig.allowedStatuses.length > 0
          && !recoveryConfig.allowedStatuses.includes(String(status))) {
        throw new Error(
          `Latest job status ${String(status)} is not in taskRecovery.allowedStatuses`,
        );
      }
      this.recovery = {
        state: 'requesting',
        attemptedAt: new Date().toISOString(),
        jobId: String(jobId),
        jobStatus: status === undefined ? null : String(status),
        selectedTimestamp: Number.isFinite(selected.timestamp)
          ? new Date(selected.timestamp).toISOString()
          : null,
      };
      this.logger.event('task-recovery-selected', this.recovery);
      const result = await callRecoveryEndpoint(recoveryConfig, { jobId, job: selected.job });
      this.recovery = {
        ...this.recovery,
        state: 'succeeded',
        completedAt: new Date().toISOString(),
        ...result,
      };
      this.logger.event('task-recovery-succeeded', this.recovery);
    } catch (error) {
      this.recovery = {
        ...this.recovery,
        state: 'failed',
        completedAt: new Date().toISOString(),
        error: serializeError(error),
      };
      this.lastError = serializeError(error);
      this.logger.event('task-recovery-failed', this.recovery);
    }
  }

  scheduleJobRecovery(generation, btgChild) {
    const recoveryConfig = this.config.jobRecovery;
    if (!recoveryConfig.enabled || this.stopping) return;
    if (this.jobRecoveryAttemptedGenerations.has(generation)) return;
    if (this.jobRecoveryTimer
        && this.jobRecovery.generation === generation) return;
    this.jobRecovery = {
      state: 'waiting-for-btg-readiness',
      generation,
      scheduledAt: new Date().toISOString(),
      readyDelayMs: recoveryConfig.readyDelayMs,
    };
    clearTimeout(this.jobRecoveryTimer);
    this.jobRecoveryTimer = setTimeout(
      () => this.attemptJobRecovery(generation, btgChild),
      recoveryConfig.readyDelayMs,
    );
  }

  async attemptJobRecovery(generation, btgChild) {
    this.jobRecoveryTimer = null;
    if (this.stopping || this.child !== btgChild || btgChild.exitCode !== null) return;
    if (this.childGeneration !== generation
        || this.jobRecoveryAttemptedGenerations.has(generation)) return;
    const recoveryConfig = this.config.jobRecovery;
    const precheckAttempt = (this.jobRecoveryPrecheckAttempts.get(generation) || 0) + 1;
    this.jobRecoveryPrecheckAttempts.set(generation, precheckAttempt);
    this.jobRecovery = {
      state: 'checking-active-jobs',
      generation,
      precheckAttempt,
      attemptedAt: new Date().toISOString(),
    };

    try {
      for (const requiredFile of recoveryConfig.requiredFilePaths) {
        if (!fs.existsSync(requiredFile) || !fs.statSync(requiredFile).isFile()) {
          throw new Error(`Required recovery helper file does not exist: ${requiredFile}`);
        }
      }
      if (!fs.existsSync(recoveryConfig.command)) {
        throw new Error(`Recovery command does not exist: ${recoveryConfig.command}`);
      }
      const document = JSON.parse(fs.readFileSync(recoveryConfig.jobsFilePath, 'utf8'));
      const check = findActiveJobs(document, recoveryConfig);
      if (check.active.length > 0) {
        this.jobRecoveryAttemptedGenerations.add(generation);
        this.jobRecovery = {
          ...this.jobRecovery,
          state: 'skipped-active-job',
          checkedJobs: check.total,
          activeJobs: check.active,
          completedAt: new Date().toISOString(),
        };
        this.logger.event('job-recovery-skipped-active-job', this.jobRecovery);
        return;
      }

      const args = recoveryConfig.args.map((argument) => renderHookArgument(argument, {
        generation,
        jobsFilePath: recoveryConfig.jobsFilePath,
      }));
      this.jobRecovery = {
        ...this.jobRecovery,
        state: 'starting-helper',
        checkedJobs: check.total,
        command: recoveryConfig.command,
        args,
      };
      this.jobRecoveryAttemptedGenerations.add(generation);
      this.logger.event('job-recovery-helper-starting', this.jobRecovery);
      this.spawnJobRecoveryHook(generation, recoveryConfig, args);
    } catch (error) {
      if (precheckAttempt < recoveryConfig.precheckRetryCount
          && !this.stopping
          && this.child === btgChild
          && this.childGeneration === generation
          && btgChild.exitCode === null) {
        this.jobRecovery = {
          ...this.jobRecovery,
          state: 'precheck-retry-wait',
          nextAttempt: precheckAttempt + 1,
          retryDelayMs: recoveryConfig.precheckRetryDelayMs,
          error: serializeError(error),
        };
        this.logger.event('job-recovery-precheck-retry-scheduled', this.jobRecovery);
        this.jobRecoveryTimer = setTimeout(
          () => this.attemptJobRecovery(generation, btgChild),
          recoveryConfig.precheckRetryDelayMs,
        );
        return;
      }
      this.jobRecoveryAttemptedGenerations.add(generation);
      this.jobRecovery = {
        ...this.jobRecovery,
        state: 'failed-before-helper',
        completedAt: new Date().toISOString(),
        error: serializeError(error),
      };
      this.lastError = serializeError(error);
      this.logger.event('job-recovery-precheck-failed', this.jobRecovery);
    }
  }

  spawnJobRecoveryHook(generation, recoveryConfig, args) {
    if (this.jobRecoveryChild) {
      const error = new Error(
        `Recovery helper from generation ${String(this.jobRecoveryChildGeneration)} is still running`,
      );
      this.jobRecovery = {
        ...this.jobRecovery,
        state: 'blocked-by-older-helper',
        completedAt: new Date().toISOString(),
        error: serializeError(error),
      };
      this.lastError = serializeError(error);
      this.logger.event('job-recovery-helper-overlap-blocked', this.jobRecovery);
      return;
    }
    let helper;
    try {
      helper = spawn(recoveryConfig.command, args, {
        cwd: SUPERVISOR_DIR,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BTG_SUPERVISOR_GENERATION: String(generation),
          BTG_ORDER_JOBS_FILE: recoveryConfig.jobsFilePath,
          BTG_SUPERVISOR_HEALTH_URL:
            `http://${this.config.supervisorHealth.host}:${this.config.supervisorHealth.port}/health`,
          BTG_WEB_URL: this.config.btgHealth.url,
        },
      });
    } catch (error) {
      this.jobRecovery = {
        ...this.jobRecovery,
        state: 'helper-spawn-failed',
        completedAt: new Date().toISOString(),
        error: serializeError(error),
      };
      this.lastError = serializeError(error);
      this.logger.event('job-recovery-helper-spawn-threw', this.jobRecovery);
      return;
    }

    const startedAt = Date.now();
    this.jobRecoveryChild = helper;
    this.jobRecoveryChildGeneration = generation;
    this.jobRecoveryCancellationReason = null;
    // helper 的 stdout 全是 JSON.stringify 单行结构化记录。supervisor 负责解析：
    // 日志文件落纯文本（不含 ANSI 码），live 控制台按记录类型着色打印。
    const stdoutDecoder = new LineDecoder();
    const stderrDecoder = new LineDecoder();
    helper.stdout.on('data', (chunk) => {
      this.logger.recoveryStdout.write(chunk);
      stdoutDecoder.feed(chunk, (line) => this.printRecoveryLine(line, 'stdout'));
    });
    helper.stderr.on('data', (chunk) => {
      this.logger.recoveryStderr.write(chunk);
      stderrDecoder.feed(chunk, (line) => this.printRecoveryLine(line, 'stderr'));
    });
    helper.once('spawn', () => {
      if (this.jobRecoveryChild !== helper) return;
      this.jobRecovery = {
        ...this.jobRecovery,
        state: 'helper-running',
        helperPid: helper.pid,
        startedAt: new Date(startedAt).toISOString(),
      };
      this.logger.event('job-recovery-helper-started', this.jobRecovery);
      this.logLine('Recovery', 'info', `helper 已启动 — PID ${helper.pid}，generation ${generation}`);
    });
    helper.once('error', (error) => {
      if (this.jobRecoveryChild !== helper) return;
      this.lastError = serializeError(error);
      this.logger.event('job-recovery-helper-process-error', {
        generation,
        helperPid: helper.pid || null,
        error: serializeError(error),
      });
    });
    helper.once('close', (code, signal) => {
      if (this.jobRecoveryChild !== helper) return;
      clearTimeout(this.jobRecoveryTimeoutTimer);
      clearTimeout(this.jobRecoveryForceTimer);
      this.jobRecoveryTimeoutTimer = null;
      this.jobRecoveryForceTimer = null;
      this.jobRecoveryChild = null;
      this.jobRecoveryChildGeneration = null;
      clearTimeout(this.recoveryDrainTimer);
      this.recoveryDrainTimer = null;
      const cancellationReason = this.jobRecoveryCancellationReason;
      this.jobRecoveryCancellationReason = null;
      const result = {
        generation,
        helperPid: helper.pid || null,
        code,
        codeHex: exitCodeHex(code),
        signal,
        runtimeMs: Date.now() - startedAt,
        cancellationReason,
      };
      this.jobRecovery = {
        ...this.jobRecovery,
        state: cancellationReason
          ? 'helper-cancelled'
          : (code === 0 ? 'succeeded' : 'helper-failed'),
        completedAt: new Date().toISOString(),
        ...result,
      };
      if (!cancellationReason && code !== 0) {
        this.lastError = serializeError(
          Object.assign(new Error(`Recovery helper exited with code ${String(code)}`), { code }),
        );
      }
      this.logger.event('job-recovery-helper-exited', this.jobRecovery);
      const level = cancellationReason ? 'warn' : (code === 0 ? 'success' : 'error');
      const detail = cancellationReason ? `（${cancellationReason}）` : (code === 0 ? ' OK' : '');
      this.logLine('Recovery', level, `helper 已退出 — code=${code}${detail}，generation ${generation}`);
      if (!this.stopping && !this.child) setImmediate(() => this.checkThenStart());
    });
    this.jobRecoveryTimeoutTimer = setTimeout(() => {
      if (this.jobRecoveryChild !== helper) return;
      this.logger.event('job-recovery-helper-timeout', {
        generation,
        helperPid: helper.pid,
        timeoutMs: recoveryConfig.timeoutMs,
      });
      this.terminateJobRecoveryHook('timeout', true);
    }, recoveryConfig.timeoutMs);
  }

  terminateJobRecoveryHook(reason, forceTree = false) {
    const helper = this.jobRecoveryChild;
    if (!helper || helper.exitCode !== null) return;
    clearTimeout(this.jobRecoveryTimeoutTimer);
    this.jobRecoveryTimeoutTimer = null;
    this.jobRecoveryCancellationReason = reason;
    this.logger.event('job-recovery-helper-termination-requested', {
      generation: this.jobRecoveryChildGeneration,
      helperPid: helper.pid,
      reason,
      forceTree,
    });
    const force = () => {
      if (this.jobRecoveryChild !== helper || helper.exitCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(helper.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', (error) => {
          this.logger.event('job-recovery-helper-force-kill-failed', {
            helperPid: helper.pid,
            error: serializeError(error),
          });
          try { helper.kill(); } catch (_) { /* best effort */ }
        });
        const killerTimeout = setTimeout(() => {
          this.logger.event('job-recovery-taskkill-timeout', { helperPid: helper.pid });
          try { killer.kill(); } catch (_) { /* best effort */ }
          try { helper.kill(); } catch (_) { /* best effort */ }
        }, 5000);
        killer.once('close', (code, signal) => {
          clearTimeout(killerTimeout);
          this.logger.event('job-recovery-taskkill-exited', {
            helperPid: helper.pid,
            code,
            signal,
          });
          if (code !== 0 && this.jobRecoveryChild === helper && helper.exitCode === null) {
            try { helper.kill(); } catch (_) { /* best effort */ }
          }
        });
      } else {
        try { helper.kill('SIGKILL'); } catch (_) { /* best effort */ }
      }
    };
    if (forceTree) {
      force();
      return;
    }
    try { helper.kill('SIGTERM'); } catch (_) { /* force timer below */ }
    clearTimeout(this.jobRecoveryForceTimer);
    this.jobRecoveryForceTimer = setTimeout(force, 3000);
  }

  async requestRestart() {
    if (this.stopping) return { ok: false, error: 'Supervisor is stopping' };
    if (!this.child && this.externalProcesses.length > 0) {
      return {
        ok: false,
        error: 'BTG is an external process; refusing to terminate a process not started by this supervisor',
        processes: this.externalProcesses,
      };
    }
    clearTimeout(this.restartTimer);
    clearTimeout(this.externalPollTimer);
    this.restartTimer = null;
    this.externalPollTimer = null;
    this.nextRestartAt = null;
    this.backoffAttempt = 0;
    if (this.child) {
      this.restartRequested = true;
      this.terminateManagedChild('manual-restart');
    } else {
      this.restartRequested = false;
      setImmediate(() => this.checkThenStart());
    }
    return { ok: true, accepted: true, message: 'BTG restart requested' };
  }

  terminateManagedChild(reason) {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.logger.event('btg-termination-requested', { pid: child.pid, reason });
    if (process.platform === 'win32') {
      const gracefulKiller = spawn('taskkill.exe', ['/PID', String(child.pid), '/T'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      gracefulKiller.on('error', (error) => {
        this.logger.event('btg-graceful-termination-failed', { error: serializeError(error) });
      });
      gracefulKiller.on('close', (code, signal) => {
        if (code !== 0 && this.child === child && child.exitCode === null) {
          this.logger.event('btg-graceful-taskkill-nonzero', { code, signal, pid: child.pid });
        }
      });
    } else {
      try {
        child.kill('SIGTERM');
      } catch (error) {
        this.logger.event('btg-graceful-termination-failed', { error: serializeError(error) });
      }
    }
    clearTimeout(this.forceKillTimer);
    this.forceKillTimer = setTimeout(() => {
      if (this.child !== child || child.exitCode !== null) return;
      this.logger.event('btg-force-termination-requested', { pid: child.pid, reason });
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', (error) => {
          this.logger.event('btg-force-termination-failed', { error: serializeError(error) });
        });
      } else {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          this.logger.event('btg-force-termination-failed', { error: serializeError(error) });
        }
      }
    }, this.config.shutdownGraceMs);
  }

  async shutdown(reason) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  async performShutdown(reason) {
    this.stopping = true;
    this.state = 'stopping';
    clearTimeout(this.restartTimer);
    clearTimeout(this.externalPollTimer);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.jobRecoveryTimer);
    clearTimeout(this.jobRecoveryTimeoutTimer);
    clearTimeout(this.recoveryDrainTimer);
    this.stopBtgHealthMonitor('supervisor-stopping');
    this.logger.event('supervisor-stopping', { reason });
    const recoveryHelper = this.jobRecoveryChild;
    if (recoveryHelper && recoveryHelper.exitCode === null) {
      this.terminateJobRecoveryHook(reason, true);
    }
    const child = this.child;
    if (child && child.exitCode === null) {
      this.terminateManagedChild(reason);
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, this.config.shutdownGraceMs + 3000)),
      ]);
    }
    if (recoveryHelper && recoveryHelper.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => recoveryHelper.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    await Promise.all([closeServer(this.healthServer), closeServer(this.ipcServer)]);
    if (process.platform !== 'win32' && fs.existsSync(IPC_PATH)) {
      try { fs.unlinkSync(IPC_PATH); } catch (_) { /* best effort */ }
    }
    this.state = 'stopped';
    this.logger.event('supervisor-stopped', { reason });
    process.exitCode = 0;
  }
}

function sendIpcCommand(command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(IPC_PATH);
    let settled = false;
    let input = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error('Supervisor IPC request timed out')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(input.slice(0, newline)));
      } catch (error) {
        finish(new Error(`Invalid supervisor IPC response: ${error.message}`));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(new Error('Supervisor IPC connection closed without a response'));
    });
  });
}

async function runCommand(command) {
  try {
    const result = await sendIpcCommand(command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      running: false,
      command,
      error: error.message,
    }, null, 2)}\n`);
    return 3;
  }
}

async function runSupervisor() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    return 1;
  }
  const supervisor = new Supervisor(config);
  try {
    await supervisor.listenIpc();
  } catch (error) {
    try {
      const existing = await sendIpcCommand('status');
      process.stdout.write(`${JSON.stringify({
        ok: true,
        message: 'Supervisor is already running',
        status: existing,
      }, null, 2)}\n`);
      return 0;
    } catch (_) {
      process.stderr.write(`Cannot acquire supervisor named pipe ${IPC_PATH}: ${error.message}\n`);
      return 1;
    }
  }

  try {
    await supervisor.listenHealth();
    await supervisor.start();
  } catch (error) {
    supervisor.logger.event('supervisor-start-failed', { error: serializeError(error) });
    process.stderr.write(`Supervisor startup failed: ${error.message}\n`);
    await supervisor.shutdown('startup-failed');
    return 1;
  }

  process.once('SIGINT', () => supervisor.shutdown('SIGINT'));
  process.once('SIGTERM', () => supervisor.shutdown('SIGTERM'));
  process.once('uncaughtException', (error) => {
    supervisor.logger.event('uncaught-exception', { error: serializeError(error) });
    supervisor.shutdown('uncaught-exception').finally(() => process.exit(1));
  });
  process.once('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    supervisor.logger.event('unhandled-rejection', { error: serializeError(error) });
    supervisor.shutdown('unhandled-rejection').finally(() => process.exit(1));
  });
  return 0;
}

async function main() {
  const command = String(process.argv[2] || 'run').toLowerCase();
  if (['status', 'stop', 'restart'].includes(command)) return runCommand(command);
  if (!['run', 'start'].includes(command)) {
    process.stderr.write(
      'Usage: node bili-ticket-go-task-auto-recovery.js [run|status|stop|restart]\n',
    );
    return 64;
  }
  return runSupervisor();
}

main().then((code) => {
  if (Number.isInteger(code) && code !== 0) process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
