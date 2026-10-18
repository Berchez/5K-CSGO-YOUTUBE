import { classifyThumbFailure } from './aiThumbnail.js';

/**
 * Diagnóstico "precisava estar visível?": lê o bot.log e tabula tentativas
 * de thumb IA por provider × modo de janela (Fase 2 do plano gaming).
 *
 * Duas fontes:
 * - 'thumb IA: tentativa' (nova): provider, windowMode, outcome, failKind.
 * - Legado: 'thumb IA via X' / 'fundo IA via X' (= ok) e 'provider IA
 *   falhou, tentando próximo' (= fail, causa reclassificada do err).
 *   Modo legado assumido: chatgpt/grok = 'visible (legado)' (era o default),
 *   gemini-web = 'headless', demais = 'api'.
 * Puro/testável — o script scripts/diag-thumbs.ts só faz I/O.
 */

export interface ThumbAttemptRow {
  time: number;
  provider: string;
  windowMode: string;
  outcome: 'ok' | 'fail';
  failKind: string | null;
}

function tryJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asTime(o: Record<string, unknown>): number {
  return typeof o.time === 'number' && Number.isFinite(o.time) ? o.time : 0;
}

/** Linha nova 'thumb IA: tentativa' (modo/resultado/causa explícitos). */
export function parseThumbAttemptLine(line: string): ThumbAttemptRow | null {
  const o = tryJson(line);
  if (!o || o.msg !== 'thumb IA: tentativa') return null;
  if (typeof o.provider !== 'string') return null;
  if (o.outcome !== 'ok' && o.outcome !== 'fail') return null;
  return {
    time: asTime(o),
    provider: o.provider,
    windowMode: typeof o.windowMode === 'string' ? o.windowMode : '?',
    outcome: o.outcome,
    failKind: typeof o.failKind === 'string' ? o.failKind : null,
  };
}

function legacyWindowMode(provider: string): string {
  if (provider === 'chatgpt' || provider === 'grok') return 'visible (legado)';
  if (provider === 'gemini-web') return 'headless';
  return 'api';
}

const LEGACY_OK = /^(thumb IA via|fundo IA via)\s+(\S+)/;

/** Linhas legadas (pré-tagging): sucesso e falha com causa reclassificada. */
export function parseLegacyThumbLine(line: string): ThumbAttemptRow | null {
  const o = tryJson(line);
  if (!o || typeof o.msg !== 'string') return null;
  const mOk = o.msg.match(LEGACY_OK);
  if (mOk) {
    return {
      time: asTime(o),
      provider: mOk[2],
      windowMode: legacyWindowMode(mOk[2]),
      outcome: 'ok',
      failKind: null,
    };
  }
  if (o.msg === 'provider IA falhou, tentando próximo' && typeof o.provider === 'string') {
    return {
      time: asTime(o),
      provider: o.provider,
      windowMode: legacyWindowMode(o.provider),
      outcome: 'fail',
      failKind: classifyThumbFailure(String(o.err ?? '')),
    };
  }
  return null;
}

/** Nova primeiro; legado como fallback. */
export function parseThumbLogLine(line: string): ThumbAttemptRow | null {
  return parseThumbAttemptLine(line) ?? parseLegacyThumbLine(line);
}

/**
 * Filtro barato (sem JSON.parse) p/ linhas candidatas a tentativa de thumb.
 * Fonte única da verdade: o script de diagnóstico usa isto para não repetir
 * os prefixos de mensagem (que já mudaram uma vez).
 */
export function isThumbLogLine(line: string): boolean {
  return (
    line.includes('thumb IA') ||
    line.includes('fundo IA via') ||
    line.includes('provider IA falhou')
  );
}

export interface ThumbDiagCell {
  attempts: number;
  ok: number;
  failKinds: Record<string, number>;
}

const KEY_SEP = ' | ';

/** Chave de agregação "provider | modo" (fonte única p/ summarize/format). */
function thumbDiagKey(provider: string, mode: string): string {
  return `${provider}${KEY_SEP}${mode}`;
}

/** Agrega por "provider | modo". */
export function summarizeAttempts(rows: ThumbAttemptRow[]): Record<string, ThumbDiagCell> {
  const out: Record<string, ThumbDiagCell> = {};
  for (const r of rows) {
    const key = thumbDiagKey(r.provider, r.windowMode);
    const cell = (out[key] ??= { attempts: 0, ok: 0, failKinds: {} });
    cell.attempts++;
    if (r.outcome === 'ok') {
      cell.ok++;
    } else if (r.failKind) {
      cell.failKinds[r.failKind] = (cell.failKinds[r.failKind] ?? 0) + 1;
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

/** Tabela texto p/ console (lida por humano, não por máquina). */
export function formatThumbDiagTable(summary: Record<string, ThumbDiagCell>): string {
  const keys = Object.keys(summary).sort();
  const lines = [
    `${pad('provider', 12)} ${pad('modo', 18)} ${pad('tent.', 6)} ${pad('ok%', 5)} causas de falha`,
    '-'.repeat(80),
  ];
  for (const k of keys) {
    const sep = k.indexOf(KEY_SEP);
    const provider = sep >= 0 ? k.slice(0, sep) : k;
    const mode = sep >= 0 ? k.slice(sep + KEY_SEP.length) : '';
    const c = summary[k];
    const pct = c.attempts > 0 ? `${Math.round((c.ok / c.attempts) * 100)}%` : '-';
    const kinds = Object.entries(c.failKinds)
      .sort((a, b) => b[1] - a[1])
      .map(([kk, v]) => `${kk}=${v}`)
      .join(' ');
    lines.push(
      `${pad(provider, 12)} ${pad(mode, 18)} ${pad(String(c.attempts), 6)} ${pad(pct, 5)} ${kinds || '-'}`,
    );
  }
  if (keys.length === 0) lines.push('(sem tentativas no período)');
  return lines.join('\n');
}
