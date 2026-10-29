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
 * segmento, >0 indica drift crescente (áudio se adiantando cada vez
 * mais), ~0 indica offset constante (desalinhamento fixo na abertura).
 */
export function slopePerStep(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = (n - 1) / 2;
  const my = xs.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    // num = Σ(x−mx)(y−my); den = Σ(x−mx)² (variância de x).
    // den NÃO pode ser o numerador: com os dois iguais a inclinação
    // sairia 1 em qualquer série (bug que fazia o drift sempre ≈ 1).
    num += (i - mx) * (xs[i] - my);
    den += (i - mx) * (i - mx);
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Offset de abertura entre as trilhas (s): início do vídeo menos
 * início do áudio. É a métrica que mostra skew: num buffer de captura
 * ÚNICA (muxed) o offset vem da fonte, não de feeds separados — a
 * série temporal (mediana + drift) é a evidência de que a fonte
 * entrega áudio e vídeo alinhados.
 */
export function startDeltaSec(videoPts: number[], audioPts: number[]): number {
  if (videoPts.length === 0 || audioPts.length === 0) return NaN;
  const v0 = Math.min(...videoPts);
  const a0 = Math.min(...audioPts);
  if (!Number.isFinite(v0) || !Number.isFinite(a0)) return NaN;
  return Math.round((v0 - a0) * 1000) / 1000;
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
    execFileSync(exe, ['-version'], { stdio: 'ignore', windowsHide: true });
    return exe;
  } catch {
    return null;
  }
}

/**
 * Duração de CONTEÚDO de uma trilha a partir dos PTS (puro/testável):
 * span menos os SALTOS (gaps > jumpMinSec — restart de transcode muda a
 * era dos PTS; starvation tem gaps de segundos e NÃO é salto).
 */
export function trackContentSec(pts: number[], jumpMinSec = 30): number {
  if (pts.length < 2) return 0;
  const s = [...pts].sort((a, b) => a - b);
  let span = s[s.length - 1] - s[0];
  let jumps = 0;
  for (let i = 1; i < s.length; i++) {
    const g = s[i] - s[i - 1];
    if (g > jumpMinSec) jumps += g;
  }
  const c = span - jumps;
  return Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * Duração REAL do concat (s), medida no CONTEÚDO dos pacotes de cada
 * arquivo — soma dos conteúdos por arquivo, imune a saltos de PTS.
 *
 * Por que existe: o trim precisa saber onde o conteúdo começa na linha do
 * tempo (firstSegStart = mtime do último − duração). O legado assumia
 * n × slot (mquia com segmento faminto: 1 arquivo cobre MINUTOS → clipe
 * gigante); a 1ª versão deste probe usava span de PTS + birthtime, mas o
 * buffer é CIRCULAR — os nomes seg_*.ts são reescritos a cada janela e o
 * NTFS preserva o birthtime ORIGINAL da sessão: em sessões longas o wall
 * vinha inflado pela idade da sessão (780s p/ 60s reais) → trim além do
 * conteúdo → render VAZIO de ~256B (bug real: 2399080 r8/r9).
 *
 * Método atual: por arquivo, conteúdo da trilha = span − Σ saltos(>30s);
 * conteúdo do arquivo = max(vídeo, áudio) (áudio contínuo é o melhor
 * relógio em vídeo faminto). Confiabilidade: cruzamento com a SEQUÊNCIA
 * de mtimes ((últ.−1º)+slot) — verdadeira p/ arquivos cortados, ao
 * contrário do birthtime. Arquivo único: sem cruzamento possível, o
 * conteúdo é a única estimativa (e é boa).
 *
 * ATENÇÃO: medir nos arquivos ORIGINAIS do buffer (mtimes vivos). O
 * handleAce mede nos originais e passa o resultado ao buildClip.
 */
export interface ConcatSpan {
  /** Duração do conteúdo (s) — span de PTS corrigido por saltos. */
  spanSec: number;
  reliable: boolean;
  /** Wall via sequência de mtimes ((últ.−1º)+slot); null se ilegível. */
  wallSec: number | null;
  /** Span de PTS BRUTO (sem correção) — forense de saltos no log. */
  rawSpanSec?: number;
}

export async function probeConcatSpan(
  files: string[],
  ffprobeBinNullable: string | null,
  segmentTimeSec: number,
): Promise<ConcatSpan | null> {
  if (!ffprobeBinNullable || files.length === 0) return null;
  // Narrowing de const não atravessa closures no TS: fixa o tipo.
  const ffprobeBin: string = ffprobeBinNullable;
  try {
    const CONCURRENCY = 4;
    const pkts: Array<{ video: number[]; audio: number[] } | null> = new Array(files.length).fill(null);
    let next = 0;
    async function worker(): Promise<void> {
      while (next < files.length) {
        const i = next++;
        pkts[i] = await probeSegmentPackets(files[i], ffprobeBin);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
    if (!pkts[0]) return null;
    let contentSec = 0;
    for (const p of pkts) {
      if (!p) continue;
      const c = Math.max(trackContentSec(p.video), trackContentSec(p.audio));
      contentSec += c;
    }
    contentSec = Math.round(contentSec * 100) / 100;
    if (!(contentSec > 1)) return null;
    // Span bruto (forense): 1º PTS do 1º ao último PTS do último.
    let rawSpanSec: number | undefined;
    const firstP = pkts[0];
    const lastP = pkts[files.length - 1];
    if (firstP && lastP) {
      const all = [...firstP.video, ...firstP.audio, ...lastP.video, ...lastP.audio];
      if (all.length > 0) {
        const raw = Math.max(...all) - Math.min(...all);
        if (Number.isFinite(raw) && raw > 0) rawSpanSec = Math.round(raw * 100) / 100;
      }
    }
    // Wall pela SEQUÊNCIA de mtimes: mtime de arquivo cortado ≈ fim do seu
    // conteúdo — imune à reescrita circular (birthtime não é).
    let wallSec: number | null = null;
    try {
      const stFirst = fs.statSync(files[0]);
      const stLast = fs.statSync(files[files.length - 1]);
      const w = (stLast.mtimeMs - stFirst.mtimeMs) / 1000 + segmentTimeSec;
      if (Number.isFinite(w) && w > 0) wallSec = Math.round(w * 100) / 100;
    } catch {
      wallSec = null;
    }
    // Confiável por construção p/ arquivo único (sem cruzamento possível);
    // p/ múltiplos, o cruzamento com a sequência de mtimes decide.
    const reliable =
      files.length === 1
        ? true
        : wallSec != null && Math.abs(contentSec - wallSec) <= Math.max(15, 0.5 * wallSec);
    return { spanSec: contentSec, reliable, wallSec, ...(rawSpanSec != null ? { rawSpanSec } : {}) };
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
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
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
