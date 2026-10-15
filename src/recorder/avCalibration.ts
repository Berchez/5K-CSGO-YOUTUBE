import fs from 'node:fs';
import path from 'node:path';
import type { StaticOffsetRule } from '../config.js';

/**
 * Calibragem de offset A/V por canal (stream): o offset é sistemático por
 * pipeline de transmissão, mas MUDA a cada sessão (restart do transcode
 * re-rola o alinhamento — provado: r4 sync vs r12 +2s na mesma stream).
 * Por isso a calibragem vale para a sessão corrente, invalidada por
 * discontinuity: 1 julgamento humano por sessão, resto automático.
 */

export interface StreamCalibration {
  /** Ms de atraso no áudio. */
  offsetMs: number;
  /** Wall (epoch ms) da calibragem — vale enquanto sem restart desde então. */
  calibratedAt: number;
  /** Último restart do transcode observado no canal (era atual). */
  lastRestartAt?: number;
  /** Origem (ex: "fix20-Umar-r12", "variante"). */
  by?: string;
}

export type CalibrationStore = Record<string, StreamCalibration>;

export const DEFAULT_CALIBRATION_PATH = './data/av-calibration.json';

function readStore(file: string): CalibrationStore {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: CalibrationStore = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const ms = Number((v as { offsetMs?: unknown }).offsetMs);
      const at = Number((v as { calibratedAt?: unknown }).calibratedAt);
      if (!Number.isFinite(ms) || ms < 0 || ms > 8000) continue;
      if (!Number.isFinite(at) || at <= 0) continue;
      const rec: StreamCalibration = { offsetMs: Math.round(ms), calibratedAt: Math.round(at) };
      const lr = Number((v as { lastRestartAt?: unknown }).lastRestartAt);
      if (Number.isFinite(lr) && lr > 0) rec.lastRestartAt = Math.round(lr);
      const by = (v as { by?: unknown }).by;
      if (typeof by === 'string' && by) rec.by = by.slice(0, 80);
      out[k] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

/** Lê o store ({} se ausente/corrompido — nunca joga). */
export function loadCalibrations(file: string = DEFAULT_CALIBRATION_PATH): CalibrationStore {
  return readStore(file);
}

function writeStore(file: string, store: CalibrationStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

/** Grava/atualiza a calibragem do canal (best-effort, nunca joga). */
export function saveCalibration(
  streamName: string,
  offsetMs: number,
  opts: { by?: string; file?: string; at?: number } = {},
): CalibrationStore {
  const file = opts.file ?? DEFAULT_CALIBRATION_PATH;
  try {
    const store = readStore(file);
    store[streamName] = {
      offsetMs: Math.round(offsetMs),
      calibratedAt: opts.at ?? Date.now(),
      ...(opts.by ? { by: opts.by.slice(0, 80) } : {}),
    };
    writeStore(file, store);
    return store;
  } catch {
    return readStore(file);
  }
}

/** Remove a calibragem do canal. true se existia. */
export function clearCalibration(
  streamName: string,
  file: string = DEFAULT_CALIBRATION_PATH,
): boolean {
  try {
    const store = readStore(file);
    if (!(streamName in store)) return false;
    delete store[streamName];
    writeStore(file, store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Carimba restart do transcode no canal (era atual). Best-effort, nunca
 * joga. Chamado pelo recorder ao ver discontinuity — assim um SEGUNDO
 * recorder do mesmo canal (outra partida) invalida corretamente mesmo sem
 * ter observado o restart. Sem entrada calibrada, não há o que invalidar
 * (a calibragem futura cobre o passado) e nada é gravado.
 */
export function noteRestart(
  streamName: string,
  atMs: number = Date.now(),
  file: string = DEFAULT_CALIBRATION_PATH,
): void {
  try {
    if (!streamName || !Number.isFinite(atMs) || atMs <= 0) return;
    const store = readStore(file);
    const prev = store[streamName];
    if (!prev || atMs <= (prev.lastRestartAt ?? 0)) return;
    store[streamName] = { ...prev, lastRestartAt: Math.round(atMs) };
    writeStore(file, store);
  } catch {
    // best-effort
  }
}

export type SessionOffsetSource = 'none' | 'static' | 'calibrated';

export interface SessionOffsetResult {
  /** Ms a aplicar (0 = sem correção). */
  ms: number;
  source: SessionOffsetSource;
  /** Verdadeiro = calibragem possivelmente expirada — spot-check, não revisão. */
  unverified: boolean;
  reason: string;
}

/**
 * Decide a correção do clipe (puro/testável).
 * - Override manual (static > 0): aplica sempre; restart na janela só
 *   sinaliza (responsabilidade de quem setou).
 * - Calibragem do canal: vale se o recorder é da MESMA sessão (start <=
 *   calibratedAt) e sem restart na janela do clipe; senão 0 + flag.
 * - Sem nada: 0, sem flag (clipes bons nunca tocados, sem ruído).
 */
export function resolveSessionOffset(args: {
  staticMs: number;
  staticRule: StaticOffsetRule;
  calibration?: StreamCalibration;
  streamName?: string;
  sessionStartMs?: number;
  discontinuities?: number[];
  winStartMs?: number;
  winEndMs?: number;
}): SessionOffsetResult {
  const {
    staticMs,
    staticRule,
    calibration,
    streamName,
    sessionStartMs,
    discontinuities = [],
    winStartMs,
    winEndMs,
  } = args;
  if (staticMs > 0) {
    const restart = discontinuities.some(
      (t) => winStartMs != null && winEndMs != null && t >= winStartMs - 5000 && t <= winEndMs + 5000,
    );
    return {
      ms: staticMs,
      source: 'static',
      unverified: restart,
      reason: restart ? `override ${staticRule} + restart na janela` : `override ${staticRule}`,
    };
  }
  if (!calibration || !streamName) {
    return { ms: 0, source: 'none', unverified: false, reason: 'sem calibragem (default 0)' };
  }
  if (sessionStartMs == null || sessionStartMs > calibration.calibratedAt) {
    return { ms: 0, source: 'none', unverified: true, reason: 'nova sessão, recalibrar' };
  }
  if (winStartMs == null || winEndMs == null) {
    return { ms: 0, source: 'none', unverified: true, reason: 'sem âncora p/ verificar janela' };
  }
  // Restart DESDE a calibragem (não só na janela do clipe): o offset
  // re-rola a cada restart — mesmo um anterior à janela invalida.
  const stale = discontinuities.filter(
    (t) => t >= calibration.calibratedAt - 5000 && t <= winEndMs + 5000,
  );
  if (stale.length > 0) {
    const inWin = stale.filter((t) => t >= winStartMs - 5000).length;
    return {
      ms: 0,
      source: 'none',
      unverified: true,
      reason: inWin > 0 ? `restart na janela (${inWin}x)` : `restart desde a calibragem (${stale.length}x)`,
    };
  }
  return { ms: calibration.offsetMs, source: 'calibrated', unverified: false, reason: 'calibragem da sessão' };
}
