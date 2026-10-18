import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KillEvent } from '../types.js';
import { resolveFfmpegBin } from './clipBuilder.js';
import { resolveFfprobeBin } from './segmentProbe.js';

const execFileAsync = promisify(execFile);
/** Frames extraídos por segundo de vídeo (fps do filtro + passo do OCR). */
const SAMPLE_FPS = 1;
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

/** Kill observada no killfeed com o offset candidato que ela implica. */
interface OffsetCandidate {
  killIndex: number;
  offsetMs: number;
}

/**
 * Maior agrupamento de candidatos mutuamente consistentes (voto por maioria:
 * kills mal lidas/isoladas ficam fora). A ordem interna não importa — só o
 * tamanho e o conjunto alimentam a mediana.
 */
function largestConsistentCluster(candidates: OffsetCandidate[]): OffsetCandidate[] {
  let best: OffsetCandidate[] = [];
  for (const candidate of candidates) {
    const cluster = candidates.filter(
      (item) => Math.abs(item.offsetMs - candidate.offsetMs) <= CONSISTENCY_TOLERANCE_MS,
    );
    if (cluster.length > best.length) best = cluster;
  }
  return best;
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
    .map(([killIndex, streamAtMs]): OffsetCandidate | null => {
      const kill = kills[killIndex];
      if (!kill || !Number.isFinite(kill.at) || !Number.isFinite(streamAtMs)) return null;
      const offsetMs = streamAtMs - (kill.at! - scoreboardDelayMs);
      if (offsetMs < MIN_ALLOWED_OFFSET_MS || offsetMs > maxLagSec * 1000) return null;
      return { killIndex, offsetMs };
    })
    .filter((candidate): candidate is OffsetCandidate => candidate !== null);

  const minimumMatches = Math.min(
    timestamped.length,
    Math.max(3, Math.ceil(timestamped.length * 0.6)),
  );
  const best = largestConsistentCluster(candidates);

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

/** Minúsculo sem pontuação: "Player-A" → "playera". */
function normalizeNickname(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Tokens do texto OCR (o killfeed pode quebrar um nick em pedaços). */
function textTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True se o nick aparece no texto, inclusive reconstruído por até 4 tokens
 * adjacentes — o OCR às vezes separa "N Q Z" de "nqz".
 */
function containsNickname(tokens: string[], nickname: string): boolean {
  const target = normalizeNickname(nickname);
  if (target.length === 0) return false;
  for (let start = 0; start < tokens.length; start++) {
    let candidate = '';
    for (let end = start; end < Math.min(tokens.length, start + 4); end++) {
      candidate += tokens[end];
      if (candidate === target) return true;
      if (candidate.length >= target.length) break;
    }
  }
  return false;
}

/** Índices das kills cujo killer E victim aparecem no texto lido pelo OCR. */
export function matchKillfeedText(text: string, kills: KillEvent[]): number[] {
  const tokens = textTokens(text);
  return kills.flatMap((kill, index) =>
    normalizeNickname(kill.killer).length >= 3 &&
    normalizeNickname(kill.victim).length >= 3 &&
    containsNickname(tokens, kill.killer) &&
    containsNickname(tokens, kill.victim)
      ? [index]
      : [],
  );
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
  /** Diretório-pai dos frames temporários do segmento. */
  framesRoot: string;
  ffmpeg: string;
  worker: OcrWorker;
  sharp: typeof import('sharp').default;
  kills: KillEvent[];
  /** Instante (epoch ms) em que o segmento terminou de ser gravado. */
  segmentEndMs: number;
}

async function scanSegment(args: ScanSegmentArgs): Promise<KillfeedObservation[]> {
  const { file, durationSec, framesRoot, ffmpeg, worker, sharp, kills, segmentEndMs } = args;
  const framesDir = path.join(
    framesRoot,
    `${path.basename(file, path.extname(file))}-${Math.round(segmentEndMs)}`,
  );
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
      // Região superior direita, onde o killfeed do CS2 é desenhado.
      '-vf',
      `fps=${SAMPLE_FPS},crop=iw*0.30:ih*0.25:iw*0.70:ih*0.05`,
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
    const streamAtMs = segmentStartMs + (i * 1000) / SAMPLE_FPS;
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
    const ffmpeg = resolveFfmpegBin();

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
        // Antes da janela de interesse: pula sem gastar ffprobe/OCR.
        if (stat.mtimeMs < scanStartMs) continue;

        const durationSec = await probeDuration(file, ffprobe);
        const segmentStartMs = stat.mtimeMs - durationSec * 1000;
        if (segmentStartMs > scanEndMs) continue;

        observations.push(
          ...(await scanSegment({
            file,
            durationSec,
            framesRoot: dir,
            ffmpeg,
            worker,
            sharp,
            kills,
            segmentEndMs: stat.mtimeMs,
          })),
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
