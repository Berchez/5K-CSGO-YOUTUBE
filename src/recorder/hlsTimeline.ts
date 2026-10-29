import fs from 'node:fs';
import path from 'node:path';

/**
 * Timeline da playlist HLS: o instante de ORIGEM de cada segmento.
 *
 * A playlist HLS pode trazer `#EXT-X-PROGRAM-DATE-TIME` (PDT): o
 * instante em que o segmento foi produzido na origem. Isso é o
 * relógio do CONTEÚDO — e é a peça que faltava para detectar mudança
 * de atraso SEM OCR:
 *
 * - Segmentos normais: PDT avança o tempo do segmento (10s, 10s, 10s).
 * - A fonte "pula" (pausa do streamer, buffering, restart do
 *   transcode): o PDT do segmento seguinte AVANÇA MAIS que o conteúdo
 *   (o mesmo conteúdo, produzido depois) — o excedente é exatamente o
 *   aumento do atraso da stream.
 *
 * Exemplo: PDT 10:00:00, 10:00:10, 10:00:50 → 30s de salto = a
 * stream anda 30s atrás do jogo a partir dali.
 *
 * Sem PDT (fontes que não publicam), a função devolve vazio e o bot
 * continua funcionando só com o OCR.
 */

/** Um segmento da playlist com o instante de origem. */
export interface PlaylistSegment {
  /** Instante de origem (epoch ms) — null se a playlist não traz PDT. */
  pdtMs: number | null;
  /** Duração declarada do segmento (s). */
  durationSec: number;
  /** Houve `#EXT-X-DISCONTINUITY` antes deste segmento? */
  discontinuity: boolean;
  uri: string;
}

/** Uma mudança de atraso detectada na timeline de origem. */
export interface TimelineShift {
  /** Instante de origem (epoch ms) em que o salto apareceu. */
  atPdtMs: number;
  /** Quanto o relógio da origem andou a mais que o conteúdo (s). */
  shiftSec: number;
  /** Duração esperada do segmento (s) — a referência do salto. */
  expectedSec: number;
}

/** Segmento da playlist (parse puro/testável). */
export function parseHlsPlaylist(text: string): PlaylistSegment[] {
  const lines = text.split(/\r?\n/);
  const out: PlaylistSegment[] = [];
  let pendingPdtMs: number | null = null;
  let pendingDuration = 0;
  let pendingDiscontinuity = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const value = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
      const parsed = Date.parse(value);
      pendingPdtMs = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
      pendingDuration = Number.isFinite(value) ? value : 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    out.push({
      pdtMs: pendingPdtMs,
      durationSec: pendingDuration,
      discontinuity: pendingDiscontinuity,
      uri: line,
    });
    pendingPdtMs = null;
    pendingDuration = 0;
    pendingDiscontinuity = false;
  }
  return out;
}

/**
 * Salto do relógio de origem: quando o PDT avança mais que o conteúdo
 * que realmente foi entregue entre os dois segmentos com PDT, a stream
 * passou a entregar material mais antigo (aumentou o atraso).
 *
 * A referência é a SOMA das durações dos segmentos entre os dois PDTs
 * (não a duração do segmento atual): na playlist viva, um segmento
 * intermediário sem PDT faria a diferença de PDT parecer um salto
 * gigante se comparada a um único slot. A primeira entrada não conta
 * (não há referência antes dela). Puro/testável.
 */
export function findTimelineShifts(
  segments: PlaylistSegment[],
  expectedSec: number,
): TimelineShift[] {
  const out: TimelineShift[] = [];
  let previousPdtMs: number | null = null;
  /** Soma das durações desde o segmento com PDT anterior (exclusive). */
  let accumulatedSec = 0;
  let previousDurationSec = 0;
  for (const segment of segments) {
    const durationSec = segment.durationSec > 0 ? segment.durationSec : expectedSec;
    if (segment.pdtMs == null) {
      if (previousPdtMs != null) accumulatedSec += durationSec;
      continue;
    }
    if (previousPdtMs != null) {
      const deltaSec = (segment.pdtMs - previousPdtMs) / 1000;
      // O intervalo entre os dois inícios = duração do segmento
      // anterior + tudo que veio entre ele e o atual.
      const reference = previousDurationSec + accumulatedSec;
      // Tolerância: o segmento pode ter duração variável (keyframes).
      const shiftSec = deltaSec - reference;
      if (shiftSec > Math.max(1, reference * 0.5)) {
        out.push({
          // O salto aparece na ORIGEM no início do segmento atual.
          atPdtMs: segment.pdtMs,
          shiftSec: Math.round(shiftSec * 100) / 100,
          expectedSec: Math.round(reference * 100) / 100,
        });
      }
    }
    previousPdtMs = segment.pdtMs;
    previousDurationSec = durationSec;
    accumulatedSec = 0;
  }
  return out;
}

/**
 * Junta a leitura nova da playlist com os segmentos já vistos.
 *
 * A playlist VIVA tem janela deslizante: um salto que caia na borda da
 * janela sumiria (o segmento depois do salto viria "primeiro" na
 * leitura, sem o antecessor para comparar). Guardando os últimos
 * segmentos, o salto é detectado mesmo assim.
 */
export function mergePlaylistSegments(
  previous: PlaylistSegment[],
  next: PlaylistSegment[],
  keep = 40,
): PlaylistSegment[] {
  const seen = new Set(next.map((segment) => segment.uri));
  const stale = previous.filter((segment) => !seen.has(segment.uri)).slice(-10);
  return [...stale, ...next].slice(-keep);
}

/**
 * Offset entre o relógio de origem (PDT) e o relógio local (mtime):
 * uma aproximação pelo segmento local mais novo menos o PDT mais novo.
 */
export function originOffsetMs(
  pdtValues: number[],
  localNewestMtimeMs: number | null,
): number {
  if (pdtValues.length === 0 || localNewestMtimeMs == null) return 0;
  const newestPdt = pdtValues[pdtValues.length - 1];
  const offset = localNewestMtimeMs - newestPdt;
  return Number.isFinite(offset) ? offset : 0;
}

/** Soma dos saltos (ms) numa janela da timeline de origem. */
export function sumShifts(shifts: TimelineShift[], fromPdtMs?: number, toPdtMs?: number): number {
  let total = 0;
  for (const shift of shifts) {
    if (fromPdtMs != null && shift.atPdtMs < fromPdtMs) continue;
    if (toPdtMs != null && shift.atPdtMs > toPdtMs) continue;
    total += shift.shiftSec;
  }
  return Math.round(total * 1000);
}

/**
 * Lê a playlist pela URL (best-effort). Devolve null se a fonte não
 * responde ou não é uma playlist.
 */
export async function fetchPlaylist(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Descreve a timeline de origem de uma playlist (diagnóstico).
 * Usado pelo sync-report e pelo log do recorder.
 */
export function describePlaylist(text: string): {
  segmentos: number;
  comPdt: number;
  descontinuidades: number;
  primeiroPdt: string | null;
  ultimoPdt: string | null;
} {
  const segments = parseHlsPlaylist(text);
  const comPdt = segments.filter((segment) => segment.pdtMs != null).length;
  const comPdtValores = segments
    .map((segment) => segment.pdtMs)
    .filter((value): value is number => value != null);
  return {
    segmentos: segments.length,
    comPdt,
    descontinuidades: segments.filter((segment) => segment.discontinuity).length,
    primeiroPdt: comPdtValores.length > 0 ? new Date(comPdtValores[0]).toISOString() : null,
    ultimoPdt:
      comPdtValores.length > 0
        ? new Date(comPdtValores[comPdtValores.length - 1]).toISOString()
        : null,
  };
}

/** Caminho do arquivo temporário usado no diagnóstico (debug). */
export function tempPlaylistPath(name = 'playlist.m3u8'): string {
  return path.join(process.env.TEMP ?? '.', name);
}

/** Salva a playlist para inspeção (debug). */
export function savePlaylist(text: string, file = tempPlaylistPath()): string {
  fs.writeFileSync(file, text);
  return file;
}
