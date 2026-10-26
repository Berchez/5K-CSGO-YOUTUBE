import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_GROUPS,
  EDITABLE_FIELDS,
  panelConfigValues,
  readEnvFile,
  updateEnvFile,
  validateConfigPatch,
} from '../src/trayConfig.js';

const PANEL_VERSION = '1.0.0';
const DEFAULT_PORT = 38475;
const PORT_TRIES = 12;
const IDLE_MS = 30 * 60_000;

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
const LOGS_DIR = path.join(ROOT, 'logs');
const ENV_FILE = path.join(ROOT, '.env');
const BOT_STATUS_FILE = path.join(DATA_DIR, 'tray-status.json');
const PANEL_INFO_FILE = path.join(DATA_DIR, 'tray-panel.json');
const PANEL_LOG_FILE = path.join(LOGS_DIR, 'tray-panel.log');
const PANEL_HTML = path.join(ROOT, 'scripts', 'tray-panel.html');

interface PanelInfo {
  version: number;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

interface BotState {
  online: boolean;
  status: string;
  pid: number;
  restarts: number;
  uptimeMs: number | null;
  memoryBytes: number | null;
  error?: string;
}

let panelInfo: PanelInfo | null = null;
let lastActivity = Date.now();
let botCache: { at: number; value: BotState } | null = null;

function log(message: string): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(PANEL_LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.copyFileSync(tmp, filePath);
    fs.rmSync(tmp, { force: true });
  }
}

function tokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function headerToken(req: http.IncomingMessage, url: URL): string {
  const header = req.headers['x-tray-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token') ?? '';
}

function quotedCmdArg(value: string): string {
  return /[\s"]/g.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function runPm2(args: string[], timeout = 15_000): { ok: boolean; output: string; error?: string } {
  const command = ['pm2', ...args].map(quotedCmdArg).join(' ');
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) return { ok: false, output, error: result.error.message };
  if (result.status !== 0) return { ok: false, output, error: `pm2 saiu com código ${result.status}` };
  return { ok: true, output };
}

function getBotState(force = false): BotState {
  if (!force && botCache && Date.now() - botCache.at < 1500) return botCache.value;
  const result = runPm2(['jlist'], 10_000);
  if (!result.ok) {
    const value: BotState = {
      online: false,
      status: 'pm2-error',
      pid: 0,
      restarts: 0,
      uptimeMs: null,
      memoryBytes: null,
      error: result.error ?? result.output,
    };
    botCache = { at: Date.now(), value };
    return value;
  }
  try {
    const first = result.output.indexOf('[');
    const last = result.output.lastIndexOf(']');
    const list = JSON.parse(result.output.slice(first, last + 1)) as Array<{
      name?: string;
      pid?: number;
      pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number };
      monit?: { memory?: number };
    }>;
    const app = list.find((item) => item.name === '5k-bot');
    if (!app) {
      const value: BotState = {
        online: false,
        status: 'not-found',
        pid: 0,
        restarts: 0,
        uptimeMs: null,
        memoryBytes: null,
      };
      botCache = { at: Date.now(), value };
      return value;
    }
    const status = app.pm2_env?.status ?? 'unknown';
    const uptime = app.pm2_env?.pm_uptime;
    const online = status === 'online';
    const value: BotState = {
      online,
      status,
      pid: app.pid ?? 0,
      restarts: app.pm2_env?.restart_time ?? 0,
      uptimeMs: online && uptime ? Date.now() - uptime : null,
      memoryBytes: online ? (app.monit?.memory ?? null) : null,
    };
    botCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    const value: BotState = {
      online: false,
      status: 'pm2-parse-error',
      pid: 0,
      restarts: 0,
      uptimeMs: null,
      memoryBytes: null,
      error: String(e),
    };
    botCache = { at: Date.now(), value };
    return value;
  }
}

function pm2Action(action: 'start' | 'stop' | 'restart'): { ok: boolean; output: string; error?: string } {
  const args =
    action === 'restart'
      ? ['restart', '5k-bot', '--update-env']
      : action === 'start'
        ? ['start', '5k-bot']
        : ['stop', '5k-bot'];
  const result = runPm2(args);
  botCache = null;
  if (result.ok) {
    const save = runPm2(['save'], 10_000);
    if (!save.ok) log(`pm2 save falhou após ${action}: ${save.error ?? save.output}`);
  }
  return result;
}

function tailFile(filePath: string, maxBytes: number, maxLines: number): { lines: string[]; truncated: boolean } {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { lines: [], truncated: false };
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const all = buffer.toString('utf8').split(/\r?\n/);
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    return { lines: all.slice(-maxLines), truncated: start > 0 || all.length > maxLines };
  } catch {
    return { lines: [], truncated: false };
  }
}

function listClips(limit = 40): Array<{ name: string; relativePath: string; size: number; mtime: string }> {
  const out: Array<{ name: string; relativePath: string; size: number; mtime: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.build' || entry.name === 'refs') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.mp4')) continue;
      try {
        const stat = fs.statSync(full);
        out.push({
          name: entry.name,
          relativePath: path.relative(CLIPS_DIR, full).replace(/\\/g, '/'),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        // ignora arquivo removido durante a varredura
      }
    }
  };
  walk(CLIPS_DIR, 0);
  out.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return out.slice(0, limit);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, value: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(value),
  });
  res.end(value);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Corpo da requisição muito grande.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSON inválido.');
  }
}

function openFolder(target: string): void {
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function openNotepad(filePath: string): void {
  spawn('notepad.exe', [filePath], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function securityHeaders(res: http.ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: PANEL_VERSION,
      pid: process.pid,
      startedAt: panelInfo?.startedAt,
      port: panelInfo?.port,
    });
    return;
  }

  if (pathname === '/api/status') {
    const bot = getBotState();
    const status = readJson<unknown>(BOT_STATUS_FILE);
    sendJson(res, 200, {
      ok: true,
      panel: {
        version: PANEL_VERSION,
        pid: process.pid,
        startedAt: panelInfo?.startedAt,
        idleMs: IDLE_MS,
      },
      bot,
      status,
    });
    return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const env = readEnvFile(ENV_FILE);
      sendJson(res, 200, {
        ok: true,
        groups: CONFIG_GROUPS,
        fields: EDITABLE_FIELDS,
        values: panelConfigValues(env.values),
        envFile: '.env',
        backupFile: fs.existsSync(`${ENV_FILE}.bak`) ? '.env.bak' : null,
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
      return;
    }
    let body: { values?: Record<string, unknown>; restart?: boolean };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!body || typeof body !== 'object' || !body.values || typeof body.values !== 'object') {
      sendJson(res, 400, { ok: false, error: 'Envie { values: { CHAVE: "valor" } }.' });
      return;
    }
    const validation = validateConfigPatch(body.values);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, error: 'Configuração inválida.', errors: validation.errors });
      return;
    }
    const botBefore = getBotState(true);
    const update = updateEnvFile(ENV_FILE, validation.values);
    let restarted = false;
    let restartError: string | undefined;
    if (body.restart === true && botBefore.online) {
      const result = pm2Action('restart');
      restarted = result.ok;
      if (!result.ok) restartError = result.error ?? result.output;
    }
    log(`config salva (${update.changedKeys.join(', ')})${body.restart === true ? ' com restart solicitado' : ''}`);
    sendJson(res, 200, {
      ok: true,
      changed: update.changedKeys,
      backup: update.backupPath ? path.basename(update.backupPath) : null,
      restarted,
      restartError,
      botWasOnline: botBefore.online,
      restartRequired: true,
    });
    return;
  }

  if (pathname === '/api/action') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
      return;
    }
    let body: { action?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const action = body?.action;
    if (!action) {
      sendJson(res, 400, { ok: false, error: 'Ação ausente.' });
      return;
    }
    if (action === 'start' || action === 'stop' || action === 'restart') {
      const result = pm2Action(action);
      log(`ação ${action}: ${result.ok ? 'ok' : `falhou (${result.error ?? result.output})`}`);
      if (!result.ok) {
        sendJson(res, 500, { ok: false, error: result.error ?? result.output });
        return;
      }
      sendJson(res, 200, { ok: true, action, bot: getBotState(true) });
      return;
    }
    if (action === 'open-clips') {
      fs.mkdirSync(CLIPS_DIR, { recursive: true });
      openFolder(CLIPS_DIR);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'open-logs') {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      openFolder(LOGS_DIR);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'open-data') {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      openFolder(DATA_DIR);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'open-env') {
      if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, '', 'utf8');
      openNotepad(ENV_FILE);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 400, { ok: false, error: `Ação desconhecida: ${action}` });
    return;
  }

  if (pathname === '/api/logs') {
    const source = url.searchParams.get('source') === 'tray' ? 'tray' : 'bot';
    const requested = Number(url.searchParams.get('lines') ?? 240);
    const lines = Number.isFinite(requested) ? Math.min(1000, Math.max(20, Math.floor(requested))) : 240;
    const file = source === 'tray' ? path.join(LOGS_DIR, 'bot-tray.log') : path.join(LOGS_DIR, 'bot.log');
    const result = tailFile(file, 256 * 1024, lines);
    sendJson(res, 200, { ok: true, source, file: path.basename(file), ...result });
    return;
  }

  if (pathname === '/api/clips') {
    sendJson(res, 200, { ok: true, clips: listClips() });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Rota não encontrada.' });
}

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  lastActivity = Date.now();
  securityHeaders(res);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/favicon.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0b1220"/><text x="32" y="43" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="32" font-weight="700" fill="#f8fafc">5K</text><circle cx="51" cy="51" r="7" fill="#22c55e" stroke="#0b1220" stroke-width="3"/></svg>`;
    sendText(res, 200, svg, 'image/svg+xml; charset=utf-8');
    return;
  }

  const token = panelInfo?.token ?? '';
  const supplied = headerToken(req, url);
  if (!token || !supplied || !tokenEquals(token, supplied)) {
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 403, { ok: false, error: 'Token inválido.' });
    } else {
      sendText(res, 403, 'Token inválido. Abra o painel pelo ícone do 5K Bot.');
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(PANEL_HTML, 'utf8');
      sendText(res, 200, html, 'text/html; charset=utf-8');
    } catch {
      sendText(res, 500, 'Painel não encontrado (scripts/tray-panel.html).');
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      log(`erro na API ${url.pathname}: ${String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e) });
      else res.end();
    }
    return;
  }

  sendText(res, 404, 'Not found');
}

async function existingPanelHealthy(): Promise<boolean> {
  const info = readJson<PanelInfo>(PANEL_INFO_FILE);
  if (!info || !info.port || !info.token) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { 'x-tray-token': info.token },
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function listen(server: http.Server, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + PORT_TRIES; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`Nenhuma porta livre entre ${startPort} e ${startPort + PORT_TRIES - 1}.`);
}

function cleanupInfo(): void {
  const info = readJson<PanelInfo>(PANEL_INFO_FILE);
  if (info?.pid === process.pid) {
    try {
      fs.rmSync(PANEL_INFO_FILE, { force: true });
    } catch {
      // best-effort
    }
  }
}

async function main(): Promise<void> {
  if (await existingPanelHealthy()) {
    log('painel já está rodando; instância nova encerrada');
    process.exit(0);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const startedAt = new Date().toISOString();
  const server = http.createServer((req, res) => {
    void requestHandler(req, res).catch((e) => {
      log(`erro não tratado: ${String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e) });
      else res.end();
    });
  });

  const requestedPort = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) ?? DEFAULT_PORT);
  const port = await listen(server, Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT);
  panelInfo = { version: 1, pid: process.pid, port, token, startedAt };
  writeJsonAtomic(PANEL_INFO_FILE, panelInfo);
  log(`painel iniciado em http://127.0.0.1:${port} (pid ${process.pid})`);

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity < IDLE_MS) return;
    log('painel encerrado por inatividade');
    server.close(() => {
      cleanupInfo();
      process.exit(0);
    });
    setTimeout(() => {
      cleanupInfo();
      process.exit(0);
    }, 1500).unref();
  }, 60_000);
  idleTimer.unref();

  const shutdown = (): void => {
    log('painel encerrado');
    cleanupInfo();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', cleanupInfo);
}

main().catch((e) => {
  log(`falha ao iniciar painel: ${String(e)}`);
  cleanupInfo();
  process.exit(1);
});
