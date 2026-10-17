import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KillEvent } from '../types.js';
import { resolveFfprobeBin } from './segmentProbe.js';

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 1;
const EARLY_TOLERANCE_MS = 15_000;
const CONSISTENCY_TOLERANCE_MS = 2_500;
const MAX_MEDIAN_DEVIATION_MS = 1_500;
const MIN_ALLOWED_OFFSET_MS = -5_000;
type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

export interface KillfeedObservation {
  killIndex: number;
  streamAtMs: number;
}

export interface StreamSyncEstimate {
  offsetMs: number | null;
  matchedKills: number;
  totalKills: number;
  medianDeviationMs: number | null;
  reason: 'confident' | 'insufficient-matches' | 'inconsistent-offsets' | 'no-timestamped-kills';
}

export interface StreamSyncScanOptions {
  kills: KillEvent[];
  scoreboardDelayMs: number;
  maxLagSec: number;
  segmentTimeSec: number;
  listSegments: () => string[];
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function estimateStreamOffset(
  kills: KillEvent[],
  observations: KillfeedObservation[],
  scoreboardDelayMs: number,
  maxLagSec: number,
): StreamSyncEstimate {
  const timestamped = kills
    .map((kill, killIndex) => ({ kill, killIndex }))
    .filter(({ kill }) => Number.isFinite(kill.at));
  if (timestamped.length === 0) {
    return {
      offsetMs: null,
      matchedKills: 0,
      totalKills: 0,
      medianDeviationMs: null,
      reason: 'no-timestamped-kills',
    };
  }

  const earliestObservationByKill = new Map<number, number>();
  for (const observation of observations) {
    const current = earliestObservationByKill.get(observation.killIndex);
    if (current == null || observation.streamAtMs < current) {
      earliestObservationByKill.set(observation.killIndex, observation.streamAtMs);
    }
  }
  const candidates = [...earliestObservationByKill]
    .map(([killIndex, streamAtMs]) => {
      const kill = kills[killIndex];
      if (!kill || !Number.isFinite(kill.at) || !Number.isFinite(streamAtMs)) return null;
      const offsetMs = streamAtMs - (kill.at! - scoreboardDelayMs);
      if (offsetMs < MIN_ALLOWED_OFFSET_MS || offsetMs > maxLagSec * 1000) return null;
      return { killIndex, offsetMs };
    })
    .filter((candidate): candidate is { killIndex: number; offsetMs: number } => candidate !== null);

  const minimumMatches = Math.min(
    timestamped.length,
    Math.max(3, Math.ceil(timestamped.length * 0.6)),
  );
  let best: Array<{ killIndex: number; offsetMs: number }> = [];
  for (const candidate of candidates) {
    const cluster = candidates
      .filter((item) => Math.abs(item.offsetMs - candidate.offsetMs) <= CONSISTENCY_TOLERANCE_MS)
      .sort((a, b) => Math.abs(a.offsetMs - candidate.offsetMs) - Math.abs(b.offsetMs - candidate.offsetMs));
    if (cluster.length > best.length) best = cluster;
  }

  const observedKillCount = new Set(candidates.map((candidate) => candidate.killIndex)).size;
  const matchedKills = best.length;
  if (matchedKills < minimumMatches) {
    return {
      offsetMs: null,
      matchedKills: observedKillCount,
      totalKills: timestamped.length,
      medianDeviationMs: null,
      reason: observedKillCount < minimumMatches ? 'insufficient-matches' : 'inconsistent-offsets',
    };
  }

  const offsetMs = median(best.map((item) => item.offsetMs));
  const medianDeviationMs = median(best.map((item) => Math.abs(item.offsetMs - offsetMs)));
  if (medianDeviationMs > MAX_MEDIAN_DEVIATION_MS) {
    return {
      offsetMs: null,
      matchedKills,
      totalKills: timestamped.length,
      medianDeviationMs,
      reason: 'inconsistent-offsets',
    };
  }
  return {
    offsetMs: Math.round(offsetMs),
    matchedKills,
    totalKills: timestamped.length,
    medianDeviationMs: Math.round(medianDeviationMs),
    reason: 'confident',
  };
}

function normalizeNickname(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function containsNickname(tokens: string[], nickname: string): boolean {
  const parts = normalizeNickname(nickname);
  if (parts.length === 0) return false;
  for (let start = 0; start < tokens.length; start++) {
    let candidate = '';
    for (let end = start; end < Math.min(tokens.length, start + 4); end++) {
      candidate += tokens[end];
      if (candidate === parts.join('')) return true;
      if (candidate.length >= parts.join('').length) break;
    }
  }
  return false;
}

export function matchKillfeedText(text: string, kills: KillEvent[]): number[] {
  const tokens = normalizeNickname(text);
  return kills.flatMap((kill, index) => {
    const killer = normalizeNickname(kill.killer).join('');
    const victim = normalizeNickname(kill.victim).join('');
    return killer.length >= 3 && victim.length >= 3 &&
      containsNickname(tokens, kill.killer) && containsNickname(tokens, kill.victim)
      ? [index]
      : [];
  });
}

function ffmpegPath(): string {
  const local = path.resolve('.tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return fs.existsSync(local) ? local : 'ffmpeg';
}

async function probeDuration(file: string, ffprobe: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { timeout: 15_000, windowsHide: true },
  );
  const durationSec = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`duração inválida no segmento ${path.basename(file)}`);
  }
  return durationSec;
}

async function scanSegment(
  file: string,
  durationSec: number,
  directory: string,
  ffmpeg: string,
  worker: OcrWorker,
  sharp: typeof import('sharp').default,
  kills: KillEvent[],
  segmentEndMs: number,
): Promise<KillfeedObservation[]> {
  const framesDir = path.join(directory, `${path.basename(file, path.extname(file))}-${Math.round(segmentEndMs)}`);
  fs.mkdirSync(framesDir, { recursive: true });
  await execFileAsync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      file,
      '-vf',
      'fps=1,crop=iw*0.30:ih*0.25:iw*0.70:ih*0.05',
      path.join(framesDir, 'frame_%04d.png'),
    ],
    { timeout: Math.max(30_000, Math.ceil(durationSec * 10_000)), windowsHide: true },
  );

  const frames = fs.readdirSync(framesDir).filter((name) => name.endsWith('.png')).sort();
  const observations: KillfeedObservation[] = [];
  const segmentStartMs = segmentEndMs - durationSec * 1000;
  for (let i = 0; i < frames.length; i++) {
    const image = await sharp(path.join(framesDir, frames[i]))
      .resize({ width: 2400 })
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
    const { data } = await worker.recognize(image);
    const streamAtMs = segmentStartMs + (i * 1000) / SAMPLE_RATE;
    for (const killIndex of matchKillfeedText(String(data.text ?? ''), kills)) {
      observations.push({ killIndex, streamAtMs });
    }
  }
  return observations;
}

export async function scanKillfeedForStreamOffset(
  options: StreamSyncScanOptions,
): Promise<StreamSyncEstimate> {
  const { kills, scoreboardDelayMs, maxLagSec, segmentTimeSec, listSegments } = options;
  const timestamped = kills.filter((kill) => Number.isFinite(kill.at));
  if (timestamped.length === 0) {
    return estimateStreamOffset(kills, [], scoreboardDelayMs, maxLagSec);
  }

  const targetTimes = timestamped.map((kill) => kill.at! - scoreboardDelayMs);
  const firstTargetMs = Math.min(...targetTimes);
  const lastTargetMs = Math.max(...targetTimes);
  const scanStartMs = firstTargetMs - EARLY_TOLERANCE_MS;
  const scanEndMs = lastTargetMs + maxLagSec * 1000;
  const deadlineMs = scanEndMs + segmentTimeSec * 1000 + 10_000;
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) throw new Error('ffprobe indisponível para calibragem OCR');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-stream-sync-'));
  const seen = new Set<string>();
  const observations: KillfeedObservation[] = [];
  let worker: OcrWorker | null = null;

  try {
    const { default: sharp } = await import('sharp');
    const { createWorker, PSM } = await import('tesseract.js');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const ffmpeg = ffmpegPath();

    while (!options.shouldStop?.() && Date.now() <= deadlineMs) {
      const listed = listSegments();
      const stableSegments = listed.length > 1 ? listed.slice(0, -1) : [];
      for (const file of stableSegments) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const key = `${file}:${stat.size}:${stat.mtimeMs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (stat.mtimeMs < scanStartMs) continue;

        const durationSec = await probeDuration(file, ffprobe);
        const segmentStartMs = stat.mtimeMs - durationSec * 1000;
        if (segmentStartMs > scanEndMs) continue;
        if (stat.mtimeMs < scanStartMs || segmentStartMs > scanEndMs) continue;

        observations.push(
          ...(await scanSegment(file, durationSec, dir, ffmpeg, worker, sharp, kills, stat.mtimeMs)),
        );
        const estimate = estimateStreamOffset(kills, observations, scoreboardDelayMs, maxLagSec);
        if (estimate.reason === 'confident') return estimate;
      }

      const newestStable = stableSegments.at(-1);
      const newestEndMs = newestStable ? fs.statSync(newestStable).mtimeMs : 0;
      if (newestEndMs >= scanEndMs) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2000));
    }
    return estimateStreamOffset(kills, observations, scoreboardDelayMs, maxLagSec);
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
