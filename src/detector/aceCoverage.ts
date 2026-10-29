import type { KillEvent } from '../types.js';

export interface AceCoverage {
  discard: boolean;
  killsInBuffer: number;
  totalKills: number;
  truncatedStart: boolean;
}

/**
 * Cobertura do ace no buffer de vídeo.
 *
 * Descarta só quando NÃO existe footage de nenhuma kill observada (evento
 * fantasma: stats de outra época, ou recorder que começou depois do ace).
 * Se sobrou pelo menos uma kill no buffer, o clipe é produzido mesmo com a
 * âncora fora do buffer — sinalizado como truncatedStart, sem DELETE cego.
 *
 * Os dois lados são comparados na MESMA timeline (a do VÍDEO gravado):
 * - o `at` da kill é o instante da OBSERVAÇÃO no placar (relógio do jogo
 *   + atraso do placar);
 * - a posição da kill no vídeo = `at` − atraso do placar + latência da
 *   stream (é quando o material foi escrito);
 * - o buffer é a timeline do vídeo (mtime dos segmentos).
 * Sem `streamLatencyMs` a comparação erra pela latência inteira; sem
 * `scoreboardDelayMs` ela erra pelo atraso do placar (alguns segundos
 * permissivos demais — o ace parece ter footage que ainda não chegou).
 */
export function evaluateAceCoverage(params: {
  kills: KillEvent[];
  anchorMs?: number;
  oldestSegmentStartMs?: number | null;
  /** Atraso da stream gravada em relação ao relógio do jogo (ms). */
  streamLatencyMs?: number;
  /** Atraso do placar por kill (ms): o `at` é a observação, não o jogo. */
  scoreboardDelayMs?: number;
}): AceCoverage {
  const { kills, anchorMs, oldestSegmentStartMs, streamLatencyMs, scoreboardDelayMs } = params;
  const totalKills = kills.length;
  if (oldestSegmentStartMs == null) {
    return { discard: false, killsInBuffer: 0, totalKills, truncatedStart: false };
  }
  const latency = Math.max(0, Math.round(streamLatencyMs ?? 0));
  const scoreboardDelay = Math.max(0, Math.round(scoreboardDelayMs ?? 0));
  const killsInBuffer = kills.filter(
    (kill) => (kill.at ?? 0) - scoreboardDelay + latency >= oldestSegmentStartMs,
  ).length;
  const truncatedStart = anchorMs != null && anchorMs < oldestSegmentStartMs;
  return {
    discard: killsInBuffer === 0,
    killsInBuffer,
    totalKills,
    truncatedStart,
  };
}
