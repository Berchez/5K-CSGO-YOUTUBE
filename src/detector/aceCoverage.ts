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
 */
export function evaluateAceCoverage(params: {
  kills: KillEvent[];
  anchorMs?: number;
  oldestSegmentStartMs?: number | null;
}): AceCoverage {
  const { kills, anchorMs, oldestSegmentStartMs } = params;
  const totalKills = kills.length;
  if (oldestSegmentStartMs == null) {
    return { discard: false, killsInBuffer: 0, totalKills, truncatedStart: false };
  }
  const killsInBuffer = kills.filter((kill) => (kill.at ?? 0) >= oldestSegmentStartMs).length;
  const truncatedStart = anchorMs != null && anchorMs < oldestSegmentStartMs;
  return {
    discard: killsInBuffer === 0,
    killsInBuffer,
    totalKills,
    truncatedStart,
  };
}
