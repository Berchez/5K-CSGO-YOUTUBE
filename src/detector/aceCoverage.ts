import type { KillEvent } from '../types.js';

export interface AceCoverage {
  discard: boolean;
  killsInBuffer: number;
  totalKills: number;
  truncatedStart: boolean;
  /** A 1ª kill do ace está no material gravado. */
  firstKillInBuffer: boolean;
  /**
   * Motivo do descarte:
   * - 'no-kills': nenhuma kill no buffer (fantasma);
   * - 'first-kill-missing': a 1ª kill precede o material (strict, com
   *   posição exata do killfeed ou régua conservadora).
   */
  discardReason: 'none' | 'no-kills' | 'first-kill-missing';
}

/**
 * Cobertura do ace no buffer de vídeo.
 *
 * Regra base: descarta só quando NÃO existe footage de nenhuma kill
 * observada (evento fantasma: stats de outra época, ou recorder que
 * começou depois do ace).
 *
 * Cobertura ESTRITA (CLIP_COVERAGE_STRICT, default): descarta quando a
 * 1ª kill NÃO está no material — mas só com EVIDÊNCIA FORTE:
 * - a posição EXATA da 1ª kill no vídeo (killfeed), fora do buffer; ou
 * - uma régua de latência CONFIÁVEL (teto conservador — a posição mais
 *   tarde possível — ou medida dentro do vídeo).
 *
 * "O OCR varreu e não leu o nome" NÃO é ausência: nomes truncados são
 * comuns (khaN→haN, KaiR0N-→KaiRON-) e esse descarte destruiu 3 aces
 * bons do 2399756 com apenas 1 kill casada.
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
  /** Descarta quando a 1ª kill não está no material (com evidência). */
  strict?: boolean;
  /**
   * Posição EXATA da 1ª kill na timeline do vídeo (killfeed, ms). Com
   * ela o strict descarta mesmo sem régua confiável — é medição, não
   * estimativa.
   */
  firstKillVideoMsTrusted?: number | null;
  /**
   * A régua de latência prova AUSÊNCIA: true quando é o teto
   * conservador (o maior valor plausível — se nem ele alcança o buffer,
   * nenhuma latência menor alcança) ou quando vem de medição dentro do
   * vídeo. Régua não medida (config menor que a latência real) subestima
   * a posição e destruiria aces bons.
   */
  rulerTrusted?: boolean;
}): AceCoverage {
  const { kills, anchorMs, oldestSegmentStartMs, streamLatencyMs, scoreboardDelayMs } = params;
  const totalKills = kills.length;
  if (oldestSegmentStartMs == null) {
    return {
      discard: false,
      killsInBuffer: 0,
      totalKills,
      truncatedStart: false,
      firstKillInBuffer: false,
      discardReason: 'none',
    };
  }
  const latency = Math.max(0, Math.round(streamLatencyMs ?? 0));
  const scoreboardDelay = Math.max(0, Math.round(scoreboardDelayMs ?? 0));
  const videoMs = (kill: KillEvent): number | null =>
    Number.isFinite(kill.at) ? (kill.at as number) - scoreboardDelay + latency : null;
  const killsInBuffer = kills.filter((kill) => {
    const at = videoMs(kill);
    return at != null && at >= oldestSegmentStartMs;
  }).length;
  const first = kills.reduce<KillEvent | null>(
    (best, kill) =>
      Number.isFinite(kill.at) && (best == null || (kill.at as number) < (best.at as number))
        ? kill
        : best,
    null,
  );
  const firstAt = first != null ? videoMs(first) : null;
  const firstAtTrusted =
    params.firstKillVideoMsTrusted != null && Number.isFinite(params.firstKillVideoMsTrusted)
      ? params.firstKillVideoMsTrusted
      : null;
  /**
   * A 1ª kill no buffer: com posição EXATA do killfeed vale a medição;
   * sem ela, a régua (estimativa).
   */
  const firstKillInBuffer =
    firstAtTrusted != null
      ? firstAtTrusted >= oldestSegmentStartMs
      : firstAt != null && firstAt >= oldestSegmentStartMs;
  const truncatedStart = anchorMs != null && anchorMs < oldestSegmentStartMs;
  const strict = params.strict === true;
  /**
   * Regras da cobertura estrita, em ordem de força da evidência:
   * 1) a posição EXATA da 1ª kill (killfeed) precede o material;
   * 2) a régua CONFIÁVEL (teto conservador ou medida) diz que a 1ª kill
   *    precede o material.
   */
  let discardReason: AceCoverage['discardReason'] = 'none';
  if (killsInBuffer === 0) discardReason = 'no-kills';
  else if (strict && firstAtTrusted != null && firstAtTrusted < oldestSegmentStartMs) {
    discardReason = 'first-kill-missing';
  } else if (strict && params.rulerTrusted === true && firstAt != null && !firstKillInBuffer) {
    discardReason = 'first-kill-missing';
  }
  return {
    discard: discardReason !== 'none',
    killsInBuffer,
    totalKills,
    truncatedStart,
    firstKillInBuffer,
    discardReason,
  };
}
