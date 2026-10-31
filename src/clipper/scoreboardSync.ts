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
  reason: 'confident' | 'after-only' | 'gap-inferred';
  /**
   * Instante do primeiro frame legível do placar NOVO (o "after"). Em
   * `gap-inferred` ele é DEPOIS do fim real: o overlay ficou ilegível
   * durante a tela de fim de round/replay e só voltou no round seguinte.
   */
  afterAtMs?: number;
}

export interface RoundEndEstimate {
  roundEndMs: number | null;
  scoreBefore: string | null;
  scoreAfter: string | null;
  marker: 'score' | 'round' | null;
  reason: 'confident' | 'after-only' | 'gap-inferred' | 'no-transition' | 'no-scoreboard';
  /** Crop do placar que produziu a leitura (null = nenhum leu). */
  crop?: string | null;
  /** Instante do primeiro frame legível do placar novo (diagnóstico). */
  afterAtMs?: number | null;
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
  /**
   * Crops alternativos tentados quando o principal não produz leitura
   * útil (o overlay do placar fica em outro lugar em alguns canais).
   * O crop que funciona é devolvido em `crop` para ser memorizado.
   */
  crops?: string[];
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
  /**
   * Descarta o segmento mais novo da lista (ainda sendo escrito pelo
   * recorder). Default true; quando a lista vem do freezer (arquivos já
   * fechados), não há o que descartar.
   */
  skipNewest?: boolean;
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

/** O texto do crop é um x:y:w:h válido? (para validar config/env). */
export function isValidCrop(value: string): boolean {
  const parts = value.split(':').map(Number);
  return (
    parts.length === 4 &&
    parts.every(Number.isFinite) &&
    parts[0] >= 0 &&
    parts[1] >= 0 &&
    parts[2] > 0 &&
    parts[3] > 0 &&
    parts[0] + parts[2] <= 1 &&
    parts[1] + parts[3] <= 1
  );
}

/**
 * Mapa de crop por CANAL: JSON {"gaules": "0.02:0.02:0.30:0.14"}.
 * Chave em minúsculas (o nome do canal varia de caixa); crop inválido
 * é ignorado (o canal cai no crop global).
 */
export function parseCropMap(raw: string | undefined): Record<string, string> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const name = key.trim().toLowerCase();
    if (!name || typeof value !== 'string') continue;
    const crop = value.trim();
    if (!isValidCrop(crop)) continue;
    out[name] = crop;
  }
  return out;
}

/**
 * Lista de crops alternativos ("x:y:w:h,x:y:w:h"): os válidos entram,
 * na ordem. Inválidos são ignorados (não derrubam a lista inteira).
 */
export function parseCropList(raw: string | undefined): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  const out: string[] = [];
  for (const piece of text.split(',')) {
    const crop = piece.trim();
    if (!crop) continue;
    if (!isValidCrop(crop)) continue;
    if (!out.includes(crop)) out.push(crop);
  }
  return out;
}

/**
 * Crop CONFIGURADO para o canal: nome exato primeiro, depois o nome
 * configurado que é PREFIXO do canal real ("gaules" casa "gaules 2").
 * Null quando o canal não tem entrada.
 */
export function configuredCropForStream(
  byStream: Record<string, string>,
  streamName?: string,
): string | null {
  const name = (streamName ?? '').trim().toLowerCase();
  if (!name || !byStream) return null;
  const exact = byStream[name];
  if (typeof exact === 'string') return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(byStream)) {
    if (!key || !name.startsWith(key)) continue;
    if (!bestKey || key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? byStream[bestKey] : null;
}

/**
 * Lista de crops candidatos do canal: o configurado (manual), o
 * memorizado (o que funcionou no último round) e o global — na ordem
 * em que devem ser tentados.
 */
export function cropCandidatesForStream(params: {
  globalCrop: string;
  byStream: Record<string, string>;
  streamName?: string;
  remembered?: string | null;
  fallbacks?: string[];
}): string[] {
  const out: string[] = [];
  const push = (crop: string | null | undefined): void => {
    if (!crop) return;
    const trimmed = crop.trim();
    if (!isValidCrop(trimmed)) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };
  push(configuredCropForStream(params.byStream, params.streamName));
  push(params.remembered);
  push(params.globalCrop);
  for (const fallback of params.fallbacks ?? []) push(fallback);
  return out;
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

/**
 * Gap mínimo (ms) entre o último frame com o placar "before" e o primeiro
 * com o "after" para o fim ser inferido: acima disto o "after" legível é
 * do round SEGUINTE (o overlay some na tela de fim de round/replay).
 */
export const GAP_INFERENCE_MIN_MS = 20_000;
/**
 * Folga somada ao último frame "before" quando o fim é inferido: a tela
 * de fim de round entra logo depois do último frame legível do placar.
 */
export const GAP_INFERENCE_ALLOWANCE_MS = 3_000;

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
      const afterAtMs = sorted[i].streamAtMs;
      /**
       * O placar "after" só ficou legível no frame `afterAtMs` — mas o
       * round pode ter fechado muito antes: na tela de fim de round e no
       * replay o overlay some, e o primeiro frame legível com o placar
       * novo é o do INÍCIO DO ROUND SEGUINTE (medido: +84,6s no caso
       * 2399753_Dust2_r18_iM). Quando existe um gap longo entre o último
       * "before" e o "after", o fim real fica no início do gap (o último
       * frame em que o placar do round ainda estava na tela) — datar o
       * fim no fim do gap produzia clipes de 180s com ~70s de cauda.
       */
      if (before != null && afterAtMs - before.streamAtMs > GAP_INFERENCE_MIN_MS) {
        return {
          streamAtMs: Math.min(
            before.streamAtMs + GAP_INFERENCE_ALLOWANCE_MS,
            afterAtMs - 1_000,
          ),
          before: formatScore(before.score),
          after: formatScore(sorted[i].score),
          marker: 'score',
          reason: 'gap-inferred',
          afterAtMs,
        };
      }
      return {
        streamAtMs: afterAtMs,
        before: before ? formatScore(before.score) : null,
        after: formatScore(sorted[i].score),
        marker: 'score',
        reason: before ? 'confident' : 'after-only',
        afterAtMs,
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
  /** Fim do orçamento da varredura (ms) — aborta crops/frames. */
  deadlineMs: number;
}

/** Candidate de crop: o texto original (para o log) e o corte efetivo. */
interface CropCandidate {
  raw: string;
  crop: ScoreboardCrop;
}

async function scanSegmentWithCrop(
  args: ScanSegmentArgs & { cropRaw: string },
): Promise<ScoreboardObservation[]> {
  const {
    file,
    durationSec,
    framesRoot,
    ffmpeg,
    worker,
    sharp,
    crop,
    minStreamAtMs,
    segmentEndMs,
    deadlineMs,
  } = args;
  const framesDir = path.join(
    framesRoot,
    `${path.basename(file, path.extname(file))}-${Math.round(segmentEndMs)}-${args.cropRaw.replace(/[^0-9.]/g, '_')}`,
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
    if (Date.now() > deadlineMs) break;
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

/**
 * Lê o segmento com o crop principal; se a leitura não for útil (não
 * achou o placar esperado), tenta os crops alternativos.
 *
 * O custo do fallback é pago só quando o crop principal falha — e o crop
 * que funciona é devolvido para ser memorizado pelo canal.
 */
async function scanSegment(
  args: Omit<ScanSegmentArgs, 'crop'> & {
    crops: CropCandidate[];
    isUseful: (observations: ScoreboardObservation[]) => boolean;
  },
): Promise<{ observations: ScoreboardObservation[]; crop: string | null }> {
  const merged: ScoreboardObservation[] = [];
  let usedCrop: string | null = null;
  for (const candidate of args.crops) {
    if (Date.now() > args.deadlineMs) break;
    try {
      const observations = await scanSegmentWithCrop({
        ...args,
        crop: candidate.crop,
        cropRaw: candidate.raw,
      });
      merged.push(...observations);
      // Só memoriza o crop que LEU algo: um crop que não produziu
      // nenhuma observação não pode virar o principal do canal.
      if (observations.length > 0) usedCrop = candidate.raw;
      if (args.isUseful(merged)) break;
    } catch {
      continue;
    }
  }
  return { observations: merged, crop: usedCrop };
}

export async function scanRoundEndForScoreboard(
  options: RoundEndScanOptions,
): Promise<RoundEndEstimate> {
  const empty = (reason: RoundEndEstimate['reason'], crop: string | null = null): RoundEndEstimate => ({
    roundEndMs: null,
    scoreBefore: null,
    scoreAfter: null,
    marker: null,
    reason,
    crop,
    afterAtMs: null,
  });
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) throw new Error('ffprobe indisponível para calibragem do placar');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-scoreboard-sync-'));
  const seen = new Set<string>();
  const observations: ScoreboardObservation[] = [];
  const cropCandidates: CropCandidate[] = [];
  for (const raw of [options.crop ?? DEFAULT_CROP, ...(options.crops ?? [])]) {
    if (!isValidCrop(raw)) continue;
    if (cropCandidates.some((candidate) => candidate.raw === raw)) continue;
    cropCandidates.push({ raw, crop: parseScoreboardCrop(raw) });
  }
  if (cropCandidates.length === 0) {
    cropCandidates.push({ raw: DEFAULT_CROP, crop: parseScoreboardCrop(DEFAULT_CROP) });
  }
  const deadlineMs = Date.now() + Math.max(
    60_000,
    options.maxLagSec * 1000 + options.segmentTimeSec * 1000 + 20_000,
  );
  let worker: OcrWorker | null = null;
  /** Crop que produziu a última leitura (para o log/sidecar). */
  let cropUsed: string | null = null;

  try {
    const { default: sharp } = await import('sharp');
    const { createWorker, PSM } = await import('tesseract.js');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, user_defined_dpi: '70' });
    const ffmpeg = resolveFfmpegBin();

    const transition = (): ScoreTransition | null =>
      findScoreTransition(observations, options.expectedBefore, options.expectedAfter) ??
      findRoundTransition(observations, options.expectedRound);

    /**
     * A leitura é útil? O placar esperado (placar final do round) já
     * apareceu em alguma frame? Sem isso, um crop que lê lixo impede os
     * crops alternativos de serem tentados.
     */
    const hasExpectedScore = (list: ScoreboardObservation[]): boolean => {
      const after = parseScorePair(options.expectedAfter);
      if (after) {
        const key = scoreKey(after);
        if (list.some((observation) => scoreKey(observation.score) === key)) return true;
      }
      const before = parseScorePair(options.expectedBefore);
      if (before) {
        const key = scoreKey(before);
        if (list.some((observation) => scoreKey(observation.score) === key)) return true;
      }
      return list.length > 0 && !after && !before;
    };
    const isUseful = (list: ScoreboardObservation[]): boolean =>
      hasExpectedScore([...observations, ...list]);

    while (!options.shouldStop?.() && Date.now() <= deadlineMs) {
      const listed = options.listSegments();
      const stableSegments =
        (options.skipNewest ?? true) && listed.length > 1 ? listed.slice(0, -1) : listed;
      for (const file of stableSegments) {
        if (Date.now() > deadlineMs) break;
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
          const scanned = await scanSegment({
            file,
            durationSec,
            framesRoot: dir,
            ffmpeg,
            worker,
            sharp,
            crops: cropCandidates,
            minStreamAtMs: options.scanFromMs,
            segmentEndMs: stat.mtimeMs,
            deadlineMs,
            isUseful,
          });
          observations.push(...scanned.observations);
          if (scanned.crop) cropUsed = scanned.crop;
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
            crop: cropUsed,
            afterAtMs: found.afterAtMs ?? null,
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
        crop: cropUsed,
        afterAtMs: found.afterAtMs ?? null,
      };
    }
    return empty(observations.length === 0 ? 'no-scoreboard' : 'no-transition', cropUsed);
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
