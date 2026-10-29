import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { repoPath } from './paths.js';

export type TrayPhase = 'starting' | 'monitoring' | 'recording' | 'stopping' | 'error';

export type TrayMatchState = 'recording' | 'tracking' | 'waiting' | 'no-stream';

export interface TrayStatusMatch {
  matchId: string;
  team1: string;
  team2: string;
  event: string;
  stars: number;
  minKills: number;
  matchPageUrl: string;
  state: TrayMatchState;
  stream?: {
    name: string;
    country?: string;
    viewers?: number;
  };
  recorder?: {
    recording: boolean;
  };
  tracker: boolean;
}

export interface TrayStatusClip {
  at: string;
  matchId: string;
  player: string;
  map: string;
  round: number;
  filePath: string;
  videoId?: string;
  uploaded: boolean;
  privacy: string;
}

export interface TrayStatusNextMatch {
  matchId: string;
  team1: string;
  team2: string;
  /** ISO do horário marcado no HLTV. */
  startsAt: string;
  watchlisted: boolean;
}

export interface TrayStatusConfig {
  minStars: number;
  minKills: number;
  minKillsNoStars: number;
  maxRecordings: number;
  upload: boolean;
  privacy: string;
  streamPreferredCountry: string;
  streamPreferredMinViewers: number;
  pollIntervalMs: number;
  thumbMode: string;
  diskMinFreeGb: number;
}

export interface TrayStatus {
  version: 1;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  phase: TrayPhase;
  lastPollAt: string | null;
  /** ISO da próxima checagem do listing (poll adaptativo). */
  nextPollAt: string | null;
  /** Próxima partida elegível (horário marcado no HLTV). */
  nextMatch: TrayStatusNextMatch | null;
  lastError: { at: string; message: string } | null;
  matches: TrayStatusMatch[];
  totals: {
    live: number;
    recording: number;
    trackers: number;
  };
  lastClip: TrayStatusClip | null;
  diskFreeGb: number | null;
  pendingClips: number;
  config: TrayStatusConfig;
}

export interface TrayStatusSnapshot {
  matches: TrayStatusMatch[];
  phase?: TrayPhase;
  lastPollAt?: string;
  lastError?: string | null;
  diskFreeGb?: number | null;
  pendingClips?: number;
}

const STATUS_PATH = repoPath('data', 'tray-status.json');
const HEARTBEAT_MS = 5_000;

let status: TrayStatus | null = null;
let statusPath = STATUS_PATH;
let heartbeatTimer: NodeJS.Timeout | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

export function summarizeTrayMatches(matches: TrayStatusMatch[]): TrayStatus['totals'] {
  return {
    live: matches.length,
    recording: matches.filter((m) => m.state === 'recording').length,
    trackers: matches.filter((m) => m.tracker).length,
  };
}

export function phaseForMatches(matches: TrayStatusMatch[]): TrayPhase {
  return summarizeTrayMatches(matches).recording > 0 ? 'recording' : 'monitoring';
}

function writeStatusTo(target: string): void {
  if (!status) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch {
      fs.copyFileSync(tmp, target);
      fs.rmSync(tmp, { force: true });
    }
  } catch {
    // O status é auxiliar: uma falha de I/O nunca deve derrubar o bot.
  }
}

export function initTrayStatus(cfg: AppConfig, customStatusPath?: string): void {
  statusPath = customStatusPath ? path.resolve(customStatusPath) : STATUS_PATH;
  const now = nowIso();
  status = {
    version: 1,
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    phase: 'starting',
    lastPollAt: null,
    nextPollAt: null,
    nextMatch: null,
    lastError: null,
    matches: [],
    totals: { live: 0, recording: 0, trackers: 0 },
    lastClip: null,
    diskFreeGb: null,
    pendingClips: 0,
    config: {
      minStars: cfg.MIN_STARS,
      minKills: cfg.MIN_KILLS,
      minKillsNoStars: cfg.MIN_KILLS_NO_STARS,
      maxRecordings: cfg.MAX_RECORDINGS,
      upload: cfg.YT_UPLOAD,
      privacy: cfg.YT_PRIVACY,
      streamPreferredCountry: cfg.STREAM_PREFERRED_COUNTRY,
      streamPreferredMinViewers: cfg.STREAM_PREFERRED_MIN_VIEWERS,
      pollIntervalMs: cfg.POLL_INTERVAL_MS,
      thumbMode: cfg.THUMB_MODE,
      diskMinFreeGb: cfg.DISK_MIN_FREE_GB,
    },
  };
  writeStatusTo(statusPath);
}

export function getTrayStatus(): TrayStatus | null {
  return status;
}

export function startTrayStatusHeartbeat(intervalMs = HEARTBEAT_MS): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!status) return;
    status.heartbeatAt = nowIso();
    writeStatusTo(statusPath);
  }, intervalMs);
  heartbeatTimer.unref();
}

export function patchTrayStatus(
  patch: Partial<Omit<TrayStatus, 'version' | 'pid' | 'startedAt' | 'config' | 'lastError'>> & {
    config?: Partial<TrayStatusConfig>;
    lastError?: string | null | TrayStatus['lastError'];
  },
): void {
  if (!status) return;
  const { config, lastError, ...rest } = patch;
  const now = nowIso();
  status = {
    ...status,
    ...rest,
    config: config ? { ...status.config, ...config } : status.config,
    heartbeatAt: now,
  };
  if (lastError !== undefined) {
    status.lastError =
      lastError === null
        ? null
        : typeof lastError === 'string'
          ? { at: now, message: lastError }
          : lastError;
  }
  writeStatusTo(statusPath);
}

export function publishTraySnapshot(snapshot: TrayStatusSnapshot): void {
  if (!status) return;
  const matches = snapshot.matches;
  status = {
    ...status,
    matches,
    totals: summarizeTrayMatches(matches),
    phase: status.phase === 'stopping' ? 'stopping' : snapshot.phase ?? phaseForMatches(matches),
    lastPollAt: snapshot.lastPollAt ?? status.lastPollAt,
    lastError:
      snapshot.lastError === undefined
        ? status.lastError
        : snapshot.lastError === null
          ? null
          : { at: nowIso(), message: snapshot.lastError },
    diskFreeGb: snapshot.diskFreeGb === undefined ? status.diskFreeGb : snapshot.diskFreeGb,
    pendingClips: snapshot.pendingClips ?? status.pendingClips,
    heartbeatAt: nowIso(),
  };
  writeStatusTo(statusPath);
}

export function setTrayStatusError(message: string): void {
  if (!status) return;
  status.lastError = { at: nowIso(), message };
  status.heartbeatAt = nowIso();
  writeStatusTo(statusPath);
}

export function setTrayStatusPhase(phase: TrayPhase): void {
  if (!status) return;
  status.phase = phase;
  status.heartbeatAt = nowIso();
  writeStatusTo(statusPath);
}

export function setTrayStatusClip(clip: TrayStatusClip): void {
  if (!status) return;
  status.lastClip = clip;
  status.heartbeatAt = nowIso();
  writeStatusTo(statusPath);
}

export function shutdownTrayStatus(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!status) return;
  status.phase = 'stopping';
  status.heartbeatAt = nowIso();
  writeStatusTo(statusPath);
}

/** Exportado para testes/CLI: caminho padrão do arquivo de status. */
export function trayStatusPath(): string {
  return STATUS_PATH;
}
