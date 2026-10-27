import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import {
  initTrayStatus,
  patchTrayStatus,
  phaseForMatches,
  publishTraySnapshot,
  setTrayStatusClip,
  shutdownTrayStatus,
  summarizeTrayMatches,
  type TrayStatus,
  type TrayStatusMatch,
} from '../src/trayStatus.js';

const tempDirs: string[] = [];

const cfg = {
  MIN_STARS: 2,
  MIN_KILLS: 5,
  MIN_KILLS_NO_STARS: 5,
  MAX_RECORDINGS: 4,
  YT_UPLOAD: true,
  YT_PRIVACY: 'unlisted',
  STREAM_PREFERRED_COUNTRY: 'BR',
  STREAM_PREFERRED_MIN_VIEWERS: 2000,
  POLL_INTERVAL_MS: 30_000,
  THUMB_MODE: 'ai',
  DISK_MIN_FREE_GB: 5,
} as AppConfig;

function makeMatch(overrides: Partial<TrayStatusMatch> = {}): TrayStatusMatch {
  return {
    matchId: '2399999',
    team1: 'FURIA',
    team2: 'MIBR',
    event: 'Test Cup',
    stars: 2,
    minKills: 5,
    matchPageUrl: 'https://www.hltv.org/matches/2399999/test',
    state: 'recording',
    tracker: true,
    stream: { name: 'ESL', country: 'BR', viewers: 12_000 },
    recorder: { separate: true, muxed: true },
    ...overrides,
  };
}

function statusFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '5k-tray-status-'));
  tempDirs.push(dir);
  return path.join(dir, 'tray-status.json');
}

function readStatus(file: string): TrayStatus {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TrayStatus;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('summarizeTrayMatches', () => {
  it('conta live, gravando e trackers', () => {
    const matches = [
      makeMatch(),
      makeMatch({ matchId: '2', state: 'tracking', tracker: false }),
      makeMatch({ matchId: '3', state: 'waiting', tracker: false }),
    ];
    expect(summarizeTrayMatches(matches)).toEqual({ live: 3, recording: 1, trackers: 1 });
  });

  it('detecta fase de gravação', () => {
    expect(phaseForMatches([makeMatch()])).toBe('recording');
    expect(phaseForMatches([makeMatch({ state: 'tracking', tracker: false })])).toBe('monitoring');
  });
});

describe('trayStatus writer', () => {
  it('inicializa com config e pid', () => {
    const file = statusFile();
    initTrayStatus(cfg, file);
    const status = readStatus(file);
    expect(status.version).toBe(1);
    expect(status.pid).toBe(process.pid);
    expect(status.phase).toBe('starting');
    expect(status.config.minStars).toBe(2);
    expect(status.config.streamPreferredCountry).toBe('BR');
    expect(status.totals).toEqual({ live: 0, recording: 0, trackers: 0 });
  });

  it('publica snapshot, erro e clip', () => {
    const file = statusFile();
    initTrayStatus(cfg, file);
    publishTraySnapshot({
      matches: [makeMatch(), makeMatch({ matchId: '2', state: 'waiting', tracker: false })],
      lastPollAt: '2026-10-25T12:00:00.000Z',
      diskFreeGb: 42.5,
      lastError: 'falha temporária',
      pendingClips: 2,
    });
    let status = readStatus(file);
    expect(status.phase).toBe('recording');
    expect(status.totals).toEqual({ live: 2, recording: 1, trackers: 1 });
    expect(status.pendingClips).toBe(2);
    expect(status.lastPollAt).toBe('2026-10-25T12:00:00.000Z');
    expect(status.lastError?.message).toBe('falha temporária');
    expect(status.diskFreeGb).toBe(42.5);

    publishTraySnapshot({
      matches: [makeMatch({ state: 'tracking', tracker: false })],
      lastError: null,
    });
    status = readStatus(file);
    expect(status.phase).toBe('monitoring');
    expect(status.lastError).toBeNull();

    setTrayStatusClip({
      at: '2026-10-25T12:01:00.000Z',
      matchId: '2399999',
      player: 'FalleN',
      map: 'Nuke',
      round: 1,
      filePath: 'data/clips/clip.mp4',
      uploaded: true,
      privacy: 'unlisted',
      videoId: 'abc123',
    });
    status = readStatus(file);
    expect(status.lastClip?.player).toBe('FalleN');
    expect(status.lastClip?.videoId).toBe('abc123');
  });

  it('patch de config e shutdown atualizam o arquivo', () => {
    const file = statusFile();
    initTrayStatus(cfg, file);
    patchTrayStatus({ config: { upload: false }, lastError: 'teste' });
    let status = readStatus(file);
    expect(status.config.upload).toBe(false);
    expect(status.lastError?.message).toBe('teste');

    patchTrayStatus({ lastError: null });
    status = readStatus(file);
    expect(status.lastError).toBeNull();

    shutdownTrayStatus();
    status = readStatus(file);
    expect(status.phase).toBe('stopping');
  });

  it('publish depois do shutdown não volta a fase para monitoring', () => {
    const file = statusFile();
    initTrayStatus(cfg, file);
    shutdownTrayStatus();
    publishTraySnapshot({ matches: [makeMatch()] });
    const status = readStatus(file);
    expect(status.phase).toBe('stopping');
  });

  it('guarda o próximo poll e a próxima partida', () => {
    const file = statusFile();
    initTrayStatus(cfg, file);
    let status = readStatus(file);
    expect(status.nextPollAt).toBeNull();
    expect(status.nextMatch).toBeNull();

    patchTrayStatus({
      nextPollAt: '2026-10-27T16:00:00.000Z',
      nextMatch: {
        matchId: '2399747',
        team1: 'Vitality',
        team2: 'Natus Vincere',
        startsAt: '2026-10-27T17:30:00.000Z',
        watchlisted: false,
      },
    });
    status = readStatus(file);
    expect(status.nextPollAt).toBe('2026-10-27T16:00:00.000Z');
    expect(status.nextMatch?.team1).toBe('Vitality');
    expect(status.nextMatch?.startsAt).toBe('2026-10-27T17:30:00.000Z');
  });
});
