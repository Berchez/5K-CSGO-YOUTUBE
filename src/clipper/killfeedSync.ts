import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KillEvent } from '../types.js';
import { resolveFfprobeBin } from './segmentProbe.js';
import { resolveFfmpegBin } from './clipBuilder.js';

const execFileAsync = promisify(execFile);

/** Frequência de amostragem do killfeed (fps). */
const SAMPLE_RATE = 1;
/** Tolerância ANTES da 1ª kill estimada (ms): o killfeed aparece na hora. */
const EARLY_TOLERANCE_MS = 15_000;
/** Tolerância DEPOIS da última kill estimada (ms). */
const LATE_TOLERANCE_MS = 15_000;
/** Duas medições do mesmo kill podem diferir até isto (ms). */
const CONSISTENCY_TOLERANCE_MS = 2_500;
/** Dispersão máxima da mediana (ms) para aceitar o conjunto. */
const MAX_MEDIAN_DEVIATION_MS = 1_500;
/** Offset negativo além disso = casou o frame errado. */
const MIN_ALLOWED_OFFSET_MS = -5_000;

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

/** Uma leitura do killfeed: casa com a kill de índice `killIndex`. */
export interface KillfeedObservation {
  killIndex: number;
  streamAtMs: number;
}

/** Resultado da calibração pelo killfeed. */
export interface KillfeedSyncResult {
  /**
   * Offset entre o relógio do PLACAR (do kill) e o do VÍDEO (ms):
   * `videoTime − (kill.at − atraso do placar)`. Com ele, o instante do
   * kill no vídeo é (kill.at − atraso + offset).
   */
  offsetMs: number | null;
  /**
   * Instante no VÍDEO da 1ª kill do evento (ms) — âncora do início.
   * Quando o OCR casou a 1ª kill, é o instante OBSERVADO dela; quando
   * não casou (feed rápido, nome cortado), é DERIVADO do offset
   * consistente: `(1ª kill.at − atraso do placar) + offset`. Nunca é o
   * instante da 1ª kill CASADA (que poderia ser a 2ª/3ª kill).
   */
  firstKillVideoMs: number | null;
  /** O OCR reconheceu a 1ª kill (false = âncora derivada do offset). */
  firstKillMatched: boolean;
  /**
   * Offset dos timestamps da descrição (ms): `videoTime − kill.at`.
   * É o que alinha a marca de tempo da kill com a tela.
   */
  killVideoOffsetMs: number | null;
  matchedKills: number;
  totalKills: number;
  medianDeviationMs: number | null;
  reason:
    | 'confident'
    | 'insufficient-matches'
    | 'inconsistent-offsets'
    | 'no-timestamped-kills'
    | 'no-killfeed';
  /** Crop do killfeed que produziu as leituras. */
  crop?: string | null;
}

/** Opções da varredura do killfeed. */
export interface KillfeedScanOptions {
  kills: KillEvent[];
  /** Atraso do placar por kill (ms). */
  scoreboardDelayMs: number;
  /**
   * Latência estimada (ms): converte o relógio do placar no relógio do
   * vídeo para saber QUAL segmento varrer. É só uma dica — o resultado
   * é medido, não derivado dela.
   */
  latencyHintMs: number;
  /**
   * Latência MÁXIMA plausível (ms): o killfeed é acionado justamente
   * quando o regime pode ter mudado, então a janela vai da latência do
   * início até este valor. Sem ele, a janela usa só o hint (comportamento
   * antigo) — e perderia o kill quando a latência tivesse subido.
   */
  latencyMaxMs?: number;
  /** Duração do segmento (s). */
  segmentTimeSec: number;
  /** Segmentos disponíveis (ordenados por mtime). */
  listSegments: () => string[];
  /** Crops tentados, em ordem (o primeiro é o principal). */
  crops: string[];
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Janela da timeline do VÍDEO a varrer (ms), a partir da FAIXA de
 * latências plausíveis.
 *
 * A janela tem que cobrir as kills quando a latência MUDOU: o killfeed é
 * acionado pelo salto do PDT ou pela troca de regime, exatamente os
 * casos em que o hint antigo está errado. Usar só o hint perderia o
 * killfeed (e a única medição DENTRO do vídeo) justo quando ele é
 * necessário. As tolerâncias cobrem a amostragem de 1fps e o jitter do
 * killfeed. Puro/testável.
 */
export function killfeedScanWindowMs(params: {
  kills: KillEvent[];
  scoreboardDelayMs: number;
  latencyHintMs: number;
  latencyMaxMs?: number;
  earlyToleranceMs?: number;
  lateToleranceMs?: number;
}): { startMs: number; endMs: number } | null {
  const times = params.kills
    .filter((kill) => Number.isFinite(kill.at))
    .map((kill) => kill.at! - params.scoreboardDelayMs);
  if (times.length === 0) return null;
  const minLatency = Math.max(
    0,
    Math.min(params.latencyHintMs, params.latencyMaxMs ?? params.latencyHintMs),
  );
  const maxLatency = Math.max(
    params.latencyHintMs,
    params.latencyMaxMs ?? params.latencyHintMs,
  );
  return {
    startMs:
      Math.min(...times) +
      minLatency -
      (params.earlyToleranceMs ?? EARLY_TOLERANCE_MS),
    endMs:
      Math.max(...times) +
      maxLatency +
      (params.lateToleranceMs ?? LATE_TOLERANCE_MS),
  };
}

/**
 * Estima o offset placar→vídeo a partir das leituras do killfeed.
 *
 * O killfeed é o ÚNICO sinal que dá o instante do kill DENTRO do vídeo
 * (o placar do HLTV só diz QUANDO ele mostrou). Cada leitura casa
 * killer+vítima e devolve o instante no vídeo; o offset é a mediana das
 * leituras que concordam entre si (cluster) — assim uma leitura errada
 * (nome parecido) não contaminou o conjunto.
 */
export function estimateStreamOffset(
  kills: KillEvent[],
  observations: KillfeedObservation[],
  scoreboardDelayMs: number,
  maxLagSec: number,
): {
  offsetMs: number | null;
  matchedKills: number;
  totalKills: number;
  medianDeviationMs: number | null;
  reason: KillfeedSyncResult['reason'];
  firstKillVideoMs: number | null;
  firstKillMatched: boolean;
} {
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
      firstKillVideoMs: null,
      firstKillMatched: false,
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
      return { killIndex, offsetMs, streamAtMs };
    })
    .filter((candidate): candidate is { killIndex: number; offsetMs: number; streamAtMs: number } => candidate !== null);

  const minimumMatches = Math.min(
    timestamped.length,
    Math.max(3, Math.ceil(timestamped.length * 0.6)),
  );
  let best: Array<{ killIndex: number; offsetMs: number; streamAtMs: number }> = [];
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
      firstKillVideoMs: null,
      firstKillMatched: false,
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
      firstKillVideoMs: null,
      firstKillMatched: false,
    };
  }
  /**
   * Âncora da 1ª kill: o offset vale para QUALQUER kill do round (é a
   * diferença entre os relógios). Aplicá-lo ao `at` da 1ª kill
   * reconstrói o instante dela no vídeo mesmo quando o OCR não leu o
   * nome dela — o caso em que usar a 1ª kill CASADA começaria o clipe
   * na 2ª/3ª kill. O `min` com as leituras reais só pode antecipar.
   */
  const firstTimestamped = timestamped[0];
  const firstKillMatched = best.some(
    (item) => item.killIndex === firstTimestamped.killIndex,
  );
  const derivedFirstKillMs =
    firstTimestamped.kill.at! - scoreboardDelayMs + offsetMs;
  return {
    offsetMs: Math.round(offsetMs),
    matchedKills,
    totalKills: timestamped.length,
    medianDeviationMs: Math.round(medianDeviationMs),
    reason: 'confident',
    firstKillVideoMs: Math.min(
      Math.round(derivedFirstKillMs),
      ...best.map((item) => item.streamAtMs),
    ),
    firstKillMatched,
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

/** Quais kills (índice) o texto do killfeed casa? */
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

interface CropCandidate {
  raw: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseCrop(raw: string): CropCandidate | null {
  const parts = raw.split(':').map(Number);
  if (
    parts.length !== 4 ||
    !parts.every(Number.isFinite) ||
    parts[0] < 0 ||
    parts[1] < 0 ||
    parts[2] <= 0 ||
    parts[3] <= 0 ||
    parts[0] + parts[2] > 1 ||
    parts[1] + parts[3] > 1
  ) {
    return null;
  }
  return { raw, x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Varre um segmento procurando o killfeed. Tenta o crop principal; se
 * não casar nenhuma kill, tenta os alternativos (o killfeed fica em
 * cantos diferentes conforme o canal).
 */
async function scanSegment(
  file: string,
  durationSec: number,
  directory: string,
  ffmpeg: string,
  worker: OcrWorker,
  sharp: typeof import('sharp').default,
  kills: KillEvent[],
  segmentEndMs: number,
  crops: CropCandidate[],
  abort?: () => boolean,
): Promise<{ observations: KillfeedObservation[]; crop: string | null }> {
  const observations: KillfeedObservation[] = [];
  let usedCrop: string | null = null;
  for (const crop of crops) {
    if (abort?.()) break;
    const framesDir = path.join(
      directory,
      `${path.basename(file, path.extname(file))}-${Math.round(segmentEndMs)}-${crop.raw.replace(/[^0-9.]/g, '_')}`,
    );
    fs.mkdirSync(framesDir, { recursive: true });
    try {
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
          `fps=${SAMPLE_RATE},crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`,
          path.join(framesDir, 'frame_%04d.png'),
        ],
        { timeout: Math.max(30_000, Math.ceil(durationSec * 10_000)), windowsHide: true },
      );
    } catch {
      continue;
    }
    const frames = fs.readdirSync(framesDir).filter((name) => name.endsWith('.png')).sort();
    const segmentStartMs = segmentEndMs - durationSec * 1000;
    let matched = 0;
    for (let i = 0; i < frames.length; i++) {
      if (abort?.()) break;
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
        matched++;
      }
    }
    if (matched > 0) {
      usedCrop = crop.raw;
      break;
    }
  }
  return { observations, crop: usedCrop };
}

/**
 * Procura as kills do ace no KILLFEED do vídeo.
 *
 * Quando o placar do vídeo não pôde ser lido (ou o round trocou de
 * regime de latência), esta é a segunda medição: ela dá o instante do
 * kill DENTRO do vídeo, que não depende de nenhuma latência estimada.
 *
 * A janela varrida é calculada com a latência SUGERIDA (só para saber
 * qual segmento olhar) — o resultado é medido.
 */
export async function scanKillfeedForLatency(
  options: KillfeedScanOptions,
): Promise<KillfeedSyncResult> {
  const {
    kills,
    scoreboardDelayMs,
    latencyHintMs,
    latencyMaxMs,
    segmentTimeSec,
    listSegments,
    crops,
  } = options;
  const timestamped = kills.filter((kill) => Number.isFinite(kill.at));
  const cropCandidates = crops
    .map((raw) => parseCrop(raw))
    .filter((crop): crop is CropCandidate => crop !== null);
  if (timestamped.length === 0 || cropCandidates.length === 0) {
    return {
      ...estimateStreamOffset(kills, [], scoreboardDelayMs, 0),
      killVideoOffsetMs: null,
      crop: null,
    };
  }

  // Janela no relógio do VÍDEO: instante estimado das kills ± tolerância,
  // cobrindo a FAIXA de latências (o hint pode estar no regime antigo).
  const window = killfeedScanWindowMs({
    kills,
    scoreboardDelayMs,
    latencyHintMs,
    latencyMaxMs,
  });
  if (!window) {
    return {
      ...estimateStreamOffset(kills, [], scoreboardDelayMs, 0),
      killVideoOffsetMs: null,
      crop: null,
    };
  }
  const { startMs: scanStartMs, endMs: scanEndMs } = window;
  /**
   * Orçamento de espera: o material da janela precisa chegar ao buffer.
   * Sem prazo, uma stream que caiu (ou cujo buffer não avança mais)
   * deixaria o `handleAce` preso no OCR para sempre — o `shouldStop` só
   * cobre o shutdown do processo.
   */
  const scanDeadlineMs =
    Date.now() + Math.max(60_000, scanEndMs - Date.now() + segmentTimeSec * 1000 + 20_000);
  const aborted = (): boolean =>
    (options.shouldStop?.() ?? false) || Date.now() > scanDeadlineMs;
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) throw new Error('ffprobe indisponível para calibragem OCR');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-killfeed-sync-'));
  const seen = new Set<string>();
  const observations: KillfeedObservation[] = [];
  let worker: OcrWorker | null = null;
  let cropUsed: string | null = null;

  try {
    const { default: sharp } = await import('sharp');
    const { createWorker, PSM } = await import('tesseract.js');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const ffmpeg = resolveFfmpegBin();

    const estimate = (): KillfeedSyncResult => {
      const base = estimateStreamOffset(kills, observations, scoreboardDelayMs, 180);
      return {
        ...base,
        killVideoOffsetMs:
          base.offsetMs == null ? null : base.offsetMs - scoreboardDelayMs,
        crop: cropUsed,
      };
    };

    while (!aborted()) {
      const listed = listSegments();
      const stableSegments = listed.length > 1 ? listed.slice(0, -1) : [];
      for (const file of stableSegments) {
        if (aborted()) break;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const key = `${file}:${stat.size}:${stat.mtimeMs}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let durationSec: number;
        try {
          durationSec = await probeDuration(file, ffprobe);
        } catch {
          continue;
        }
        const segmentStartMs = stat.mtimeMs - durationSec * 1000;
        const segmentEndMs = stat.mtimeMs;
        if (segmentEndMs < scanStartMs || segmentStartMs > scanEndMs) continue;

        const scanned = await scanSegment(
          file,
          durationSec,
          dir,
          ffmpeg,
          worker,
          sharp,
          kills,
          segmentEndMs,
          cropCandidates,
          aborted,
        );
        observations.push(...scanned.observations);
        if (scanned.crop) cropUsed = scanned.crop;
        const result = estimate();
        if (result.reason === 'confident') return result;
      }
      // Terminou a varredura: o material disponível já cobre a janela
      // (ou não existe mais) — não fica esperando a partida inteira.
      const newest = stableSegments.at(-1);
      let newestEndMs = 0;
      if (newest) {
        try {
          newestEndMs = fs.statSync(newest).mtimeMs;
        } catch {
          newestEndMs = 0;
        }
      }
      if (newestEndMs >= scanEndMs || aborted()) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2000));
    }
    return estimate();
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
