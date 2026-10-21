import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFfmpegBin } from './clipBuilder.js';
import { resolveFfprobeBin } from './segmentProbe.js';

const execFileAsync = promisify(execFile);
const SAMPLE_FPS = 1;
const MIN_STABLE_FRAMES = 2;
const DEFAULT_CROP = '0.30:0.03:0.40:0.10';
type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

export interface ScoreboardScore {
  left: number;
  right: number;
}

export interface ParsedScoreboard {
  score: ScoreboardScore;
  timerSec: number | null;
  round: number | null;
}

export interface ScoreboardObservation extends ParsedScoreboard {
  streamAtMs: number;
}

export interface ScoreTransition {
  streamAtMs: number;
  before: string | null;
  after: string;
  marker: 'score' | 'round';
  reason: 'confident' | 'after-only';
}

export interface RoundEndEstimate {
  roundEndMs: number | null;
  scoreBefore: string | null;
  scoreAfter: string | null;
  marker: 'score' | 'round' | null;
  reason: 'confident' | 'after-only' | 'no-transition' | 'no-scoreboard';
}

export interface RoundEndScanOptions {
  expectedBefore?: string | null;
  expectedAfter?: string | null;
  expectedRound?: number | null;
  maxLagSec: number;
  segmentTimeSec: number;
  scanFromMs: number;
  listSegments: () => string[];
  crop?: string;
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
}

export interface ScoreboardCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function parseScoreboardCrop(value?: string): ScoreboardCrop {
  const parts = (value ?? '').split(':').map(Number);
  if (
    parts.length === 4 &&
    parts.every(Number.isFinite) &&
    parts[0] >= 0 &&
    parts[1] >= 0 &&
    parts[2] > 0 &&
    parts[3] > 0 &&
    parts[0] + parts[2] <= 1 &&
    parts[1] + parts[3] <= 1
  ) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  const [x, y, w, h] = DEFAULT_CROP.split(':').map(Number);
  return { x, y, w, h };
}

export function parseScoreboardText(text: string): ParsedScoreboard | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const roundMatch = normalized.match(/\bROUND\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/i);
  const round = roundMatch ? Number(roundMatch[1]) : null;
  const cleaned = normalized.replace(/(\d{1,2})\s*[-.]\s*(\d{2})\b/g, '$1:$2');
  const match = cleaned.match(/(\d{1,2})\s+(\d{1,2})\s*:\s*(\d{2})\s+(\d{1,2})/);
  let parts: [string, string, string, string];
  if (match) {
    parts = [match[1], match[2], match[3], match[4]];
  } else {
    const compact = cleaned.match(/(\d{1,2})\s+([0-5]\d{2})\s+(\d{1,2})/);
    if (!compact) return null;
    parts = [compact[1], compact[2].slice(0, 1), compact[2].slice(1), compact[3]];
  }
  const left = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  const right = Number(parts[3]);
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(right) ||
    left < 0 ||
    left > 20 ||
    right < 0 ||
    right > 20 ||
    minutes < 0 ||
    minutes > 5 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null;
  }
  return { score: { left, right }, timerSec: minutes * 60 + seconds, round };
}

export function parseScorePair(value?: string | null): ScoreboardScore | null {
  const match = (value ?? '').match(/^\s*(\d{1,2})\s*[-:]\s*(\d{1,2})\s*$/);
  if (!match) return null;
  return { left: Number(match[1]), right: Number(match[2]) };
}

export function scoreKey(score: ScoreboardScore): string {
  return [score.left, score.right].sort((a, b) => a - b).join('-');
}

export function formatScore(score: ScoreboardScore): string {
  return `${score.left}-${score.right}`;
}

export function findScoreTransition(
  observations: ScoreboardObservation[],
  expectedBefore?: string | null,
  expectedAfter?: string | null,
  minStable = MIN_STABLE_FRAMES,
): ScoreTransition | null {
  const sorted = [...observations].sort((a, b) => a.streamAtMs - b.streamAtMs);
  const afterPair = parseScorePair(expectedAfter);
  const beforePair = parseScorePair(expectedBefore);
  if (afterPair) {
    const afterKey = scoreKey(afterPair);
    const beforeKey = beforePair ? scoreKey(beforePair) : null;
    for (let i = 0; i < sorted.length; i++) {
      if (scoreKey(sorted[i].score) !== afterKey) continue;
      let stable = 1;
      for (let j = i + 1; j < sorted.length && stable < minStable; j++) {
        if (scoreKey(sorted[j].score) === afterKey) stable++;
        else break;
      }
      if (stable < minStable) continue;
      let before: ScoreboardObservation | null = null;
      if (beforeKey) {
        for (let j = i - 1; j >= 0; j--) {
          if (scoreKey(sorted[j].score) === beforeKey) {
            before = sorted[j];
            break;
          }
        }
      }
      return {
        streamAtMs: sorted[i].streamAtMs,
        before: before ? formatScore(before.score) : null,
        after: formatScore(sorted[i].score),
        marker: 'score',
        reason: before ? 'confident' : 'after-only',
      };
    }
    return null;
  }

  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    const after = sorted[i];
    const beforeKey = scoreKey(before.score);
    const afterKey = scoreKey(after.score);
    if (beforeKey === afterKey) continue;
    if (before.score.left + before.score.right + 1 !== after.score.left + after.score.right) continue;
    let stable = 1;
    for (let j = i + 1; j < sorted.length && stable < minStable; j++) {
      if (scoreKey(sorted[j].score) === afterKey) stable++;
      else break;
    }
    if (stable < minStable) continue;
    return {
      streamAtMs: after.streamAtMs,
      before: formatScore(before.score),
      after: formatScore(after.score),
      marker: 'score',
      reason: 'confident',
    };
  }
  return null;
}

export function findRoundTransition(
  observations: ScoreboardObservation[],
  expectedRound?: number | null,
  minStable = MIN_STABLE_FRAMES,
): ScoreTransition | null {
  if (expectedRound == null) return null;
  const target = expectedRound + 1;
  const sorted = [...observations].sort((a, b) => a.streamAtMs - b.streamAtMs);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].round !== target) continue;
    let stable = 1;
    for (let j = i + 1; j < sorted.length && stable < minStable; j++) {
      if (sorted[j].round === target) stable++;
      else break;
    }
    if (stable < minStable) continue;
    let before: ScoreboardObservation | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].round === expectedRound) {
        before = sorted[j];
        break;
      }
    }
    return {
      streamAtMs: sorted[i].streamAtMs,
      before: before ? formatScore(before.score) : null,
      after: formatScore(sorted[i].score),
      marker: 'round',
      reason: before ? 'confident' : 'after-only',
    };
  }
  return null;
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

interface ScanSegmentArgs {
  file: string;
  durationSec: number;
  framesRoot: string;
  ffmpeg: string;
  worker: OcrWorker;
  sharp: typeof import('sharp').default;
  crop: ScoreboardCrop;
  minStreamAtMs: number;
  segmentEndMs: number;
}

async function scanSegment(args: ScanSegmentArgs): Promise<ScoreboardObservation[]> {
  const { file, durationSec, framesRoot, ffmpeg, worker, sharp, crop, minStreamAtMs, segmentEndMs } =
    args;
  const framesDir = path.join(
    framesRoot,
    `${path.basename(file, path.extname(file))}-${Math.round(segmentEndMs)}`,
  );
  fs.mkdirSync(framesDir, { recursive: true });
  const filter = [
    `fps=${SAMPLE_FPS}`,
    `crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`,
  ].join(',');
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
      filter,
      path.join(framesDir, 'frame_%04d.png'),
    ],
    { timeout: Math.max(30_000, Math.ceil(durationSec * 10_000)), windowsHide: true },
  );

  const frames = fs.readdirSync(framesDir).filter((name) => name.endsWith('.png')).sort();
  const observations: ScoreboardObservation[] = [];
  const segmentStartMs = segmentEndMs - durationSec * 1000;
  for (let i = 0; i < frames.length; i++) {
    const streamAtMs = segmentStartMs + (i * 1000) / SAMPLE_FPS;
    if (streamAtMs < minStreamAtMs) continue;
    const image = await sharp(path.join(framesDir, frames[i]))
      .resize({ width: 2400 })
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
    const { data } = await worker.recognize(image);
    const parsed = parseScoreboardText(String(data.text ?? ''));
    if (parsed) {
      observations.push({ ...parsed, streamAtMs });
    }
  }
  return observations;
}

export async function scanRoundEndForScoreboard(
  options: RoundEndScanOptions,
): Promise<RoundEndEstimate> {
  const empty = (reason: RoundEndEstimate['reason']): RoundEndEstimate => ({
    roundEndMs: null,
    scoreBefore: null,
    scoreAfter: null,
    marker: null,
    reason,
  });
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) throw new Error('ffprobe indisponível para calibragem do placar');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-scoreboard-sync-'));
  const seen = new Set<string>();
  const observations: ScoreboardObservation[] = [];
  const crop = parseScoreboardCrop(options.crop);
  const deadlineMs = Date.now() + Math.max(
    60_000,
    options.maxLagSec * 1000 + options.segmentTimeSec * 1000 + 20_000,
  );
  let worker: OcrWorker | null = null;

  try {
    const { default: sharp } = await import('sharp');
    const { createWorker, PSM } = await import('tesseract.js');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, user_defined_dpi: '70' });
    const ffmpeg = resolveFfmpegBin();

    const transition = (): ScoreTransition | null =>
      findScoreTransition(observations, options.expectedBefore, options.expectedAfter) ??
      findRoundTransition(observations, options.expectedRound);

    while (!options.shouldStop?.() && Date.now() <= deadlineMs) {
      const listed = options.listSegments();
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
        if (stat.mtimeMs < options.scanFromMs) continue;

        let durationSec: number;
        try {
          durationSec = await probeDuration(file, ffprobe);
        } catch {
          continue;
        }
        const segmentStartMs = stat.mtimeMs - durationSec * 1000;
        if (segmentStartMs > deadlineMs) continue;

        try {
          observations.push(
            ...(await scanSegment({
              file,
              durationSec,
              framesRoot: dir,
              ffmpeg,
              worker,
              sharp,
              crop,
              minStreamAtMs: options.scanFromMs,
              segmentEndMs: stat.mtimeMs,
            })),
          );
        } catch {
          continue;
        }
        const found = transition();
        if (found) {
          return {
            roundEndMs: found.streamAtMs,
            scoreBefore: found.before,
            scoreAfter: found.after,
            marker: found.marker,
            reason: found.reason,
          };
        }
      }

      const newestStable = stableSegments.at(-1);
      let newestEndMs = 0;
      if (newestStable) {
        try {
          newestEndMs = fs.statSync(newestStable).mtimeMs;
        } catch {
          newestEndMs = 0;
        }
      }
      if (newestEndMs >= deadlineMs) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2000));
    }

    const found = transition();
    if (found) {
      return {
        roundEndMs: found.streamAtMs,
        scoreBefore: found.before,
        scoreAfter: found.after,
        marker: found.marker,
        reason: found.reason,
      };
    }
    return empty(observations.length === 0 ? 'no-scoreboard' : 'no-transition');
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
