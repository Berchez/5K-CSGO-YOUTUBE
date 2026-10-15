import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** Gap intra-trilha acima disto = stall/congelamento (s). */
export const STALL_GAP_SEC = 1.0;
/** Taxa média abaixo disto (pacotes/s) = trilha faminta (input travado). */
export const STARVED_RATE_PER_SEC = 5;
/** Span acima de max(JUMP_SPAN_MIN_SEC, slot × JUMP_SPAN_MULT) = salto de PTS. */
export const JUMP_SPAN_MIN_SEC = 60;
export const JUMP_SPAN_MULT = 6;

export interface SegmentAvIssue {
  file: string;
  /** Segundos de CONTEÚDO (span de PTS, sem decode) por trilha. */
  videoSec: number;
  audioSec: number;
  /** Offset de abertura: início do vídeo menos início do áudio (s). */
  startDeltaSec: number;
  kind: 'mismatch' | 'short' | 'unreadable' | 'stall' | 'pts-jump' | 'starved';
  /** Pacotes por trilha (vídeo faminto = stall de rede/transcode). */
  videoCount?: number;
  audioCount?: number;
  /** Maior gap intra-trilha (s): >1s = imagem congelada com áudio andando. */
  videoGapMaxSec?: number;
  audioGapMaxSec?: number;
}

export interface TrackTimes {
  count: number;
  spanSec: number;
  gapMaxSec: number;
  firstSec: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estatísticas de uma trilha a partir dos PTS dos pacotes (puros/testáveis).
 * Aceita array fora de ordem (ordena cópia) — a ordem de demux não é
 * cronológica.
 */
export function analyzeTrackTimes(times: number[]): TrackTimes {
  if (times.length === 0) return { count: 0, spanSec: NaN, gapMaxSec: NaN, firstSec: NaN };
  const sorted = [...times].sort((a, b) => a - b);
  let gapMax = 0;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    if (g > gapMax) gapMax = g;
  }
  return {
    count: sorted.length,
    spanSec: sorted[sorted.length - 1] - sorted[0],
    gapMaxSec: gapMax,
    firstSec: sorted[0],
  };
}

export type SegmentAvVerdict = Omit<SegmentAvIssue, 'file'>;

/**
 * Classifica um segmento a partir dos PTS por trilha (puro/testável).
 * Prioridade: unreadable → starved → pts-jump → stall → mismatch → short.
 * Starved antes do resto: 120 frames num span de 145s não é "desalinhado",
 * é input de vídeo colapsado (o corte do segmento nem acontece por falta
 * de keyframe) — o headline tem que dizer isso.
 */
export function classifySegmentAv(
  videoPts: number[],
  audioPts: number[],
  segmentTimeSec: number,
): SegmentAvVerdict | null {
  const v = analyzeTrackTimes(videoPts);
  const a = analyzeTrackTimes(audioPts);
  if (v.count < 2 || a.count < 2) {
    return {
      videoSec: v.spanSec, audioSec: a.spanSec, startDeltaSec: 0,
      kind: 'unreadable', videoCount: v.count, audioCount: a.count,
    };
  }
  const base = {
    videoSec: r2(v.spanSec),
    audioSec: r2(a.spanSec),
    startDeltaSec: r2(v.firstSec - a.firstSec),
    videoCount: v.count,
    audioCount: a.count,
    videoGapMaxSec: r2(v.gapMaxSec),
    audioGapMaxSec: r2(a.gapMaxSec),
  };
  const jumpSpanSec = Math.max(JUMP_SPAN_MIN_SEC, segmentTimeSec * JUMP_SPAN_MULT);
  // Densidade FORA do maior buraco: salto de PTS com taxa saudável não é
  // starvation (os pacotes existem, só mudaram de era); taxa colapsada
  // mesmo ignorando o buraco = input travado de verdade.
  const density = (t: TrackTimes): number => {
    const live = t.spanSec - t.gapMaxSec;
    return live > 0 ? t.count / live : Infinity;
  };
  if (Math.min(density(v), density(a)) < STARVED_RATE_PER_SEC) {
    return { ...base, kind: 'starved' };
  }
  if (Math.max(v.spanSec, a.spanSec) > jumpSpanSec) {
    return { ...base, kind: 'pts-jump' };
  }
  if (Math.max(v.gapMaxSec, a.gapMaxSec) > STALL_GAP_SEC) {
    return { ...base, kind: 'stall' };
  }
  if (Math.abs(v.spanSec - a.spanSec) > 0.5) {
    return { ...base, kind: 'mismatch' };
  }
  if (Math.abs(v.firstSec - a.firstSec) > 0.5) {
    return { ...base, kind: 'mismatch' };
  }
  if (Math.min(v.spanSec, a.spanSec) < segmentTimeSec - 2) {
    return { ...base, kind: 'short' };
  }
  return null;
}

/**
 * Mediana (série temporal de startDelta). NaN se vazia.
 */
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Inclinação da série por passo (regressão linear): em startDelta por
 * segmento, >0 indica drift crescente (áudio se adiantando cada vez mais),
 * ~0 indica offset constante (desalinhamento fixo na abertura).
 */
export function slopePerStep(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = (n - 1) / 2;
  const my = xs.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (xs[i] - my);
    den += (i - mx) * (i - mx);
  }
  return den === 0 ? 0 : num / den;
}

/**
 * ffprobe p/ inspeção de pacotes: vendored em .tools/ (extraído do
 * ffmpeg.zip) ou PATH. Null se ausente — chamadores pulam a inspeção.
 */
export function resolveFfprobeBin(): string | null {
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  try {
    const vendored = path.join(path.resolve('.tools'), exe);
    if (fs.existsSync(vendored)) return vendored;
  } catch {
    // segue p/ PATH
  }
  try {
    execFileSync(exe, ['-version'], { stdio: 'ignore' });
    return exe;
  } catch {
    return null;
  }
}

/**
 * Span REAL do concat (primeiro PTS do 1º arquivo ao último PTS do último).
 * Só os endpoints importam — o meio não altera o span. Sem decodificar.
 *
 * Por que existe: o trim assumia `mtime − slot` como início de cada
 * arquivo. Quando o segmento nunca corta (input faminto, sem keyframes),
 * um único .ts cobre MINUTOS — e a conta legada ancora o trim horas fora
 * do lugar, renderizando o arquivo inteiro (clipe de 7min/1GB).
 *
 * Confiabilidade: cruza o span de PTS com o wall-clock do filesystem
 * (birthtime do 1º → mtime do último). Descontinuidade de PTS entre
 * arquivos infla o span sem passar wall time — reliable=false e o
 * chamador usa o cálculo legado (n × slot).
 *
 * ATENÇÃO: medir nos arquivos ORIGINAIS do buffer. Cópias (snapshot)
 * preservam mtime mas ganham birthtime novo — a checagem perde o sentido.
 * O handleAce mede nos originais e passa o span pronto ao buildClip.
 */
export interface ConcatSpan {
  spanSec: number;
  reliable: boolean;
}

export async function probeConcatSpan(
  files: string[],
  ffprobeBin: string | null,
  segmentTimeSec: number,
): Promise<ConcatSpan | null> {
  if (!ffprobeBin || files.length === 0) return null;
  try {
    const first = await probeSegmentPackets(files[0], ffprobeBin);
    if (!first || first.video.length + first.audio.length < 2) return null;
    const last = files.length > 1
      ? await probeSegmentPackets(files[files.length - 1], ffprobeBin)
      : first;
    if (!last || last.video.length + last.audio.length < 2) return null;
    const start = Math.min(...first.video, ...first.audio);
    const end = Math.max(...last.video, ...last.audio);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const spanSec = Math.round((end - start) * 100) / 100;
    // Wall-clock coberto pelos arquivos: birthtime (criação ≈ início da
    // escrita) do 1º → mtime (fechamento) do último. Sem birthtime (FS sem
    // suporte), assume o legado (mtime − slot) só p/ o 1º arquivo.
    const stFirst = fs.statSync(files[0]);
    const stLast = fs.statSync(files[files.length - 1]);
    const wallStartMs = stFirst.birthtimeMs > 0
      ? stFirst.birthtimeMs
      : stFirst.mtimeMs - segmentTimeSec * 1000;
    const wallSec = (stLast.mtimeMs - wallStartMs) / 1000;
    const tolSec = Math.max(5, segmentTimeSec * 1.5);
    return { spanSec, reliable: Math.abs(spanSec - wallSec) <= tolSec };
  } catch {
    return null;
  }
}

/**
 * Lê os PTS dos pacotes de um segmento SEM decodificar (só cabeçalhos,
 * ~1-2s por segmento de 10s). Null quando o ffprobe falha ou o arquivo
 * não tem pacotes A/V legíveis.
 */
export async function probeSegmentPackets(
  file: string,
  ffprobeBin: string,
): Promise<{ video: number[]; audio: number[] } | null> {
  try {
    const out = await execFileAsync(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time', '-of', 'csv', file],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    ).then((r) => String(r.stdout ?? ''));
    const video: number[] = [];
    const audio: number[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^packet,([^,]+),([-\d.eE+]+)/);
      if (!m) continue;
      const pts = Number.parseFloat(m[2]);
      if (!Number.isFinite(pts)) continue;
      if (m[1] === 'video') video.push(pts);
      else if (m[1] === 'audio') audio.push(pts);
    }
    if (video.length === 0 && audio.length === 0) return null;
    return { video, audio };
  } catch {
    return null;
  }
}

/**
 * Inspeciona um segmento (probe + classificação). Best-effort: null quando
 * o ffprobe está ausente ou o arquivo não é legível p/ inspeção.
 */
export async function inspectSegmentAv(
  file: string,
  ffprobeBin: string | null,
  segmentTimeSec: number,
): Promise<SegmentAvIssue | null> {
  if (!ffprobeBin) return null;
  const packets = await probeSegmentPackets(file, ffprobeBin);
  if (!packets) return null;
  const verdict = classifySegmentAv(packets.video, packets.audio, segmentTimeSec);
  if (!verdict) return null;
  return { file: path.basename(file), ...verdict };
}
