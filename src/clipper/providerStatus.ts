import fs from 'node:fs';
import path from 'node:path';

/**
 * Estado de login dos providers WEB (chatgpt/grok/gemini-web): sessões
 * expiram silenciosamente — o app carrega e o estouro vem TARDIO (composer
 * ausente, "pill não apareceu no upload"), classificado como falha genérica
 * e invisível a quem não lê log. Este store marca o provider como
 * loggedOut p/ (1) alertar ALTO uma única vez, (2) pular o provider nos
 * clipes seguintes (sem queimar browser/timeout) e (3) restaurar sozinho
 * quando o script de relogin rodar (ele limpa a flag ao final).
 *
 * Entrada no arquivo = deslogado; ausência = OK. Best-effort puro:
 * qualquer falha de I/O nunca derruba o pipeline.
 */

export const PROVIDER_STATUS_PATH = './data/provider-status.json';

export interface LoggedOutEntry {
  /** Wall (epoch ms) da detecção. */
  at: number;
  /** Trecho do erro que levou à marcação (forense). */
  reason: string;
}

export type LoggedOutMap = Record<string, LoggedOutEntry>;

/** Providers web com login manual — os únicos cuja sessão expira. */
export const WEB_LOGIN_PROVIDERS = new Set(['chatgpt', 'grok', 'gemini-web']);

const LOGIN_SCRIPTS: Record<string, string> = {
  chatgpt: 'npx tsx scripts/chatgpt-login.ts',
  grok: 'npx tsx scripts/grok-login.ts',
  'gemini-web': 'npx tsx scripts/gemini-login.ts',
};

/** Comando de relogin do provider (undefined se desconhecido). */
export function loginScriptFor(provider: string): string | undefined {
  return LOGIN_SCRIPTS[provider];
}

function readStore(file: string): LoggedOutMap {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: LoggedOutMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const at = Number((v as { at?: unknown }).at);
      const reason = (v as { reason?: unknown }).reason;
      if (!Number.isFinite(at) || at <= 0) continue;
      out[k] = {
        at: Math.round(at),
        reason: typeof reason === 'string' ? reason.slice(0, 300) : '',
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(file: string, map: LoggedOutMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, file);
}

/** Providers flagados como deslogados ({} se ausente/corrompido). */
export function loadLoggedOut(file: string = PROVIDER_STATUS_PATH): LoggedOutMap {
  return readStore(file);
}

/**
 * Marca provider como deslogado. Retorna true apenas na TRANSIÇÃO (novo) —
 * base do dedup do alerta: grita 1x, não a cada clipe.
 */
export function markLoggedOut(
  provider: string,
  reason: string,
  file: string = PROVIDER_STATUS_PATH,
): boolean {
  try {
    const store = readStore(file);
    const isNew = !(provider in store);
    store[provider] = { at: Date.now(), reason: reason.slice(0, 300) };
    writeStore(file, store);
    return isNew;
  } catch {
    return false;
  }
}

/**
 * Limpa a flag do provider (retorno true se existia). Chamada pelos scripts
 * de relogin ao final — o bot volta a usá-lo no próximo clipe, sem restart.
 */
export function clearLoggedOut(provider: string, file: string = PROVIDER_STATUS_PATH): boolean {
  try {
    const store = readStore(file);
    if (!(provider in store)) return false;
    delete store[provider];
    writeStore(file, store);
    return true;
  } catch {
    return false;
  }
}

/** Gate puro: provider está flagado no mapa carregado? */
export function isProviderLoggedOut(map: LoggedOutMap, provider: string): boolean {
  return provider in map;
}

/** Marcadores de erro de login (mensagens NEED_* + URLs de auth). */
const LOGIN_ERROR_PATTERNS: RegExp[] = [
  /sem login\. Rode uma vez/i,
  /login expirado/i,
  /auth\.openai\.com/i,
  /accounts\.x\.com/i,
  /accounts\.google\.com/i,
];

/**
 * O erro é de LOGIN EXPIRADO? Puro/testável — decide entre alertar+marcar
 * (login) e seguir como falha transitória (challenge, backend, timeout).
 */
export function isLoginError(errText: string): boolean {
  return LOGIN_ERROR_PATTERNS.some((p) => p.test(errText));
}
