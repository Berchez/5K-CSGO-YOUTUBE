/**
 * Âncoras do clipe: do relógio do JOGO (placar do HLTV) para a timeline
 * do VÍDEO gravado (mtime dos segmentos).
 *
 * Três relógios convivem:
 * - JOGO:   quando o kill aconteceu de verdade;
 * - PLACAR: quando o HLTV mostrou o kill (JOGO + SCOREBOARD_DELAY_MS) e
 *           quando publicou o placar final do round (JOGO + CLIP_SCORE_DELAY_MS);
 * - VÍDEO:  quando o material gravado foi escrito (JOGO + CLIP_STREAM_LATENCY_MS).
 *
 * As âncoras abaixo são todas no relógio do VÍDEO (é o que o corte
 * compara com o mtime dos segmentos). Puro/testável: o handleAce só
 * monta o input e aplica o resultado.
 */

/**
 * Âncora de fim do clipe (wall ms): volta ao fechamento REAL do round
 * (detecção − lag do placar), soma a latência da stream gravada (o
 * instante do round na timeline do VÍDEO) e anda AFTER_CLOSE — mirando
 * ~5s antes da ação do round seguinte (win panel + freeze ≈ 13s). Em
 * timeout/pausa o gap estica e a margem só cresce (nunca sangra p/ o
 * próximo round). Puro/testável.
 *
 * `roundScoreDelayMs` é o atraso com que o placar publica o PLACAR
 * FINAL do round (CLIP_SCORE_DELAY_MS) — não o atraso por kill
 * (SCOREBOARD_DELAY_MS, que ancora o INÍCIO).
 */
export function computeAceEndMs(
  detectionWallMs: number,
  roundScoreDelayMs: number,
  afterCloseSec: number,
  streamLatencyMs = 0,
): number {
  return (
    detectionWallMs -
    roundScoreDelayMs +
    streamLatencyMs +
    afterCloseSec * 1000
  );
}

/**
 * Offset entre o relógio do PLACAR (do kill) e o relógio do VÍDEO
 * gravado (ms). O `at` da kill é o instante da OBSERVAÇÃO no placar; no
 * vídeo o kill aparece (latência da stream − atraso do placar) depois.
 * É o valor que alinha os timestamps da descrição com a tela.
 */
export function killVideoOffsetMs(
  streamLatencyMs: number,
  scoreboardDelayMs: number,
): number {
  return streamLatencyMs - scoreboardDelayMs;
}

export interface ClipAnchorsInput {
  /** Início do ace no relógio do PLACAR (1ª kill − compensação). */
  aceStartedAtMs?: number;
  /** Latência da stream gravada (ms) — o valor efetivo do canal. */
  streamLatencyMs: number;
  /** Atraso do placar por kill (ms). */
  scoreboardDelayMs: number;
  /** Atraso do placar para publicar o placar final do round (ms). */
  scoreDelayMs: number;
  /** Margem depois do fechamento do round (s). */
  endAfterCloseSec: number;
  /** Cauda extra quando o fim é ESTIMADO (s) — ver CLIP_END_TAIL_SEC. */
  endTailSec: number;
  /** Contexto antes da 1ª kill (s). */
  contextSec: number;
  /**
   * Margem extra antes da 1ª kill (s). O erro de latência é assimétrico:
   * com a latência real MENOR que a configurada o clipe começa depois da
   * 1ª kill (ela fica fora — o pior defeito); com a latência real maior
   * o clipe só abre mais cedo (material extra do round anterior). A
   * margem paga o erro pelo lado barato.
   */
  startMarginSec?: number;
  /** Instante em que o ace foi detectado (wall). */
  aceDetectedAtMs: number;
  /** Virada do placar vista NO VÍDEO (ms) — âncora exata, quando existe. */
  scoreboardEndMs?: number | null;
  /** A âncora do vídeo foi aplicada (modo 'auto' + OCR achou a virada). */
  syncApplied: boolean;
  /** O OCR foi tentado (modo 'auto' e recorder disponível). */
  syncScanned: boolean;
}

export interface ClipAnchors {
  /** 1ª kill na timeline do vídeo (undefined = sem âncora). */
  videoStartMs?: number;
  /** Início estimado do clipe (timeline do vídeo). */
  estimatedClipStartMs?: number;
  /** Fim do clipe (timeline do vídeo). */
  endMs: number;
  /** O fim veio do OCR do vídeo (âncora exata). */
  usedScoreboardEnd: boolean;
  /** O fim foi estimado (sem âncora do OCR). */
  usedEstimatedEnd: boolean;
  /** O OCR tentou e não achou a virada (espera extra pelo material). */
  usedFallback: boolean;
  /** Offset entre o relógio do PLACAR e o do VÍDEO (timestamps da descrição). */
  killVideoOffsetMs: number;
}

/**
 * Calcula as âncoras do clipe.
 *
 * O fim tem dois caminhos:
 * - OCR achou a virada do placar no vídeo → âncora EXATA (o instante da
 *   virada + a margem de fechamento). Sem erro de latência.
 * - OCR não achou (ou desligado) → fim ESTIMADO a partir do placar
 *   (detecção − atraso do placar + latência). Aqui a latência é uma
 *   ESTIMATIVA: se a stream real atrasar mais que o configurado, o
 *   corte fecha antes do round. Por isso a cauda extra
 *   (CLIP_END_TAIL_SEC) entra no fim estimado — erro de latência é
 *   assimétrico: clipe curto perde a última kill, clipe longo só pesa.
 */
export function computeClipAnchors(input: ClipAnchorsInput): ClipAnchors {
  const videoStartMs =
    input.aceStartedAtMs != null
      ? input.aceStartedAtMs + input.streamLatencyMs
      : undefined;
  const startContextSec = input.contextSec + (input.startMarginSec ?? 0);
  const estimatedClipStartMs =
    videoStartMs != null ? videoStartMs - startContextSec * 1000 : undefined;
  const killVideoOffset = killVideoOffsetMs(
    input.streamLatencyMs,
    input.scoreboardDelayMs,
  );
  const usedScoreboardEnd = input.syncApplied && input.scoreboardEndMs != null;
  const endMs = usedScoreboardEnd
    ? (input.scoreboardEndMs as number) + input.endAfterCloseSec * 1000
    : computeAceEndMs(
        input.aceDetectedAtMs,
        input.scoreDelayMs,
        input.endAfterCloseSec,
        input.streamLatencyMs,
      ) + input.endTailSec * 1000;
  return {
    videoStartMs,
    estimatedClipStartMs,
    endMs,
    usedScoreboardEnd,
    usedEstimatedEnd: !usedScoreboardEnd,
    usedFallback: !usedScoreboardEnd && input.syncScanned,
    killVideoOffsetMs: killVideoOffset,
  };
}
