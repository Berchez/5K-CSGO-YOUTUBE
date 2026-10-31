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
  /**
   * Latência da stream gravada (ms) — o valor efetivo do canal
   * (configurado). É o FALLBACK: quando não há medição, é ele quem
   * manda nas âncoras.
   */
  streamLatencyMs: number;
  /**
   * Latência (ms) a aplicar no INÍCIO do clipe e nos timestamps das
   * kills. Vem da medição por round (OCR do placar): a amostra que
   * estava em vigor no instante do evento. Ausente = usa
   * `streamLatencyMs`.
   */
  startLatencyMs?: number;
  /**
   * Latência (ms) a aplicar no FIM ESTIMADO (quando o OCR do vídeo não
   * achou a virada do placar). Ausente = usa `streamLatencyMs`.
   */
  endLatencyMs?: number;
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
  /**
   * Instante no vídeo da ÚLTIMA kill do ace (killfeed). Piso do fim: a
   * última kill tem que estar no clipe mesmo quando a âncora do placar
   * falhou (sem transição) ou leu o placar de outro round.
   *
   * CONTRATO: só pode vir preenchido quando é de fato a última kill do
   * round (offset corroborado e TODAS as kills lidas). Com uma kill só
   * lida (o caso `first-kill-only`) isto seria a PRIMEIRA kill e o piso
   * ficaria cedo demais — o chamador passa `null` e vale o estimado.
   */
  lastKillVideoMs?: number | null;
  /**
   * `at` da última kill no placar do HLTV (relógio do jogo + poll).
   * Base do piso SEMPRE presente: `at − atraso + latência + cauda`
   * estima a posição da última kill quando o killfeed não mediu — sem
   * ele o corte replay-aware (`auto`) podia fechar o clipe no MEIO do
   * ace (transição quieto→ativo intra-round detectada antes das kills,
   * caso r8 do 2399756).
   */
  lastKillAtMs?: number | null;
  /**
   * Fim do round no relógio do JOGO (timer do HLTV, ms). O vídeo gravado
   * é sempre POSTERIOR ao jogo (latência ≥ 0): uma virada lida antes
   * disso é leitura errada (2399756: o OCR leu placar trocado e "datou"
   * o fim 11s antes do round fechar).
   */
  gameRoundEndedAtMs?: number | null;
  /**
   * De onde veio `gameRoundEndedAtMs`: timer real do HLTV ou a
   * estimativa (detecção − CLIP_SCORE_DELAY_MS). A estimativa carrega o
   * erro do atraso de publicação do placar (± o próprio scoreDelay):
   * a tolerância da checagem tem que crescer junto, senão uma virada
   * GENUÍNA é rejeitada.
   */
  gameEndReference?: 'timer-hltv' | 'estimada';
  /** A âncora do vídeo foi aplicada (modo 'auto' + OCR achou a virada). */
  syncApplied: boolean;
  /** O OCR foi tentado (modo 'auto' e recorder disponível). */
  syncScanned: boolean;
  /**
   * Tolerância (s) entre o fim visto no OCR e o fim ESTIMADO. Acima
   * disto o OCR leu o placar de um round POSTERIOR (overlay ilegível na
   * tela de fim/replay) e a âncora é descartada. 0/ausente = sem clamp.
   */
  endPlausibilitySec?: number;
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
  /** O OCR achou uma virada, mas ELA foi rejeitada por implausível. */
  ocrEndRejected: boolean;
  /** O fim foi estimado (sem âncora do OCR). */
  usedEstimatedEnd: boolean;
  /** O OCR tentou e não achou a virada (espera extra pelo material). */
  usedFallback: boolean;
  /**
   * O que puxou o fim para cima (piso aplicado): 'last-kill' (a última
   * kill do ace) ou 'min-duration' (duração mínima). Null = o fim não
   * foi alterado pelo piso.
   */
  endPinnedBy: 'last-kill' | 'min-duration' | null;
  /**
   * Piso efetivo do fim (ms) — o MENOR fim aceitável. É o que o corte
   * replay-aware não pode atravessar: cortar antes daqui tiraria a
   * última kill (ou o próprio fim de round) do clipe. Null = sem piso.
   */
  endFloorMs: number | null;
  /** Offset entre o relógio do PLACAR e o do VÍDEO (timestamps da descrição). */
  killVideoOffsetMs: number;
  /** Latência (ms) aplicada no início (e nos timestamps). */
  startLatencyMs: number;
  /** Latência (ms) aplicada no fim estimado. */
  endLatencyMs: number;
}

/**
 * Duração mínima do clipe (s) medida da 1ª kill. Abaixo disso as âncoras
 * estão incoerentes (o fim caiu antes da própria ação do round —
 * "render vazio" com 4,1s no 2399756 quando a âncora do placar leu
 * round errado).
 */
export const MIN_CLIP_DURATION_SEC = 10;

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
  // Latência do INÍCIO e a do FIM ESTIMADO podem ser diferentes: a
  // primeira é a medida do regime em vigor na 1ª kill, a segunda é a
  // estimativa conservadora do fim (o fim exato vem do OCR do vídeo).
  const startLatencyMs = input.startLatencyMs ?? input.streamLatencyMs;
  const endLatencyMs = input.endLatencyMs ?? input.streamLatencyMs;
  const videoStartMs =
    input.aceStartedAtMs != null
      ? input.aceStartedAtMs + startLatencyMs
      : undefined;
  const startContextSec = input.contextSec + (input.startMarginSec ?? 0);
  const estimatedClipStartMs =
    videoStartMs != null ? videoStartMs - startContextSec * 1000 : undefined;
  const killVideoOffset = killVideoOffsetMs(startLatencyMs, input.scoreboardDelayMs);
  const estimatedEndMs =
    computeAceEndMs(
      input.aceDetectedAtMs,
      input.scoreDelayMs,
      input.endAfterCloseSec,
      endLatencyMs,
    ) +
    input.endTailSec * 1000;
  /**
   * Sanidade do fim do OCR (F2b): quando o overlay do placar fica
   * ilegível na tela de fim de round/replay, o primeiro frame legível
   * com o placar NOVO é o início do round seguinte (medido: +84,6s no
   * caso 2399753_Dust2_r18_iM). Se a virada lida está MUITO depois do
   * fim estimado, o que foi lido não é o fim deste round.
   *
   * A assimetria é intencional: um OCR mais CEDO que a estimativa é
   * aceito (a estimativa é conservadora e erra para o lado longo); só o
   * atraso absurdo é rejeitado. O outro lado (cedo DEMAIS) é checado
   * contra o fim do round no relógio do JOGO — ver abaixo.
   */
  const endPlausibilityMs = Math.max(0, input.endPlausibilitySec ?? 0) * 1000;
  const ocrEndMs = input.scoreboardEndMs ?? null;
  /**
   * Sanidade do fim do OCR, nos DOIS lados:
   *
   * - Tarde demais (F2b): o overlay ficou ilegível na tela de fim de
   *   round/replay e o primeiro frame legível com o placar NOVO é o
   *   início do round seguinte (medido: +84,6s no caso
   *   2399753_Dust2_r18_iM). A assimetria clássica continua: um OCR mais
   *   CEDO que a estimativa é aceito (a estimativa é conservadora e erra
   *   para o lado longo).
   * - Cedo DEMAIS: a virada lida é anterior ao fechamento do round no
   *   relógio do JOGO — impossível, porque o vídeo está sempre atrasado.
   *   É o OCR lendo placar de round errado (2399756: fim "medido" 11s
   *   antes do round fechar → clipe de 4,1s ou render vazio). A
   *   tolerância é o atraso do placar: o "Round over" do HLTV é
   *   OBSERVAÇÃO (o poll atrasa), então uma virada genuína pode aparecer
   *   no vídeo até ~um poll antes do instante registrado. Sem o timer do
   *   HLTV o fim é a ESTIMATIVA (detecção − CLIP_SCORE_DELAY_MS), que
   *   erra pelo menos o quanto o atraso real de publicação do placar
   *   diferir do configurado — a tolerância soma o scoreDelay.
   */
  const gameEndToleranceMs =
    Math.max(0, input.scoreboardDelayMs) +
    (input.gameEndReference === 'estimada' ? Math.max(0, input.scoreDelayMs) : 0);
  const ocrEndAfterGameRound =
    input.gameRoundEndedAtMs == null ||
    ocrEndMs == null ||
    ocrEndMs >= input.gameRoundEndedAtMs - gameEndToleranceMs;
  const ocrEndRejected =
    (ocrEndMs != null && endPlausibilityMs > 0 && ocrEndMs > estimatedEndMs + endPlausibilityMs) ||
    (ocrEndMs != null && !ocrEndAfterGameRound);
  const usedScoreboardEnd =
    input.syncApplied && ocrEndMs != null && !ocrEndRejected;
  const endMs = usedScoreboardEnd
    ? ocrEndMs + input.endAfterCloseSec * 1000
    : estimatedEndMs;
  /**
   * Piso do fim — o MENOR fim aceitável, sempre presente:
   *
   * 1. a última kill MEDIDA pelo killfeed (exata, quando existe);
   * 2. a última kill ESTIMADA (`at − atraso + latência + cauda`) — é o
   *    piso que vale quando o killfeed não rodou (placar confiante): sem
   *    ele o corte replay-aware podia fechar no meio do ace (r8);
   * 3. a virada GENUÍNA do placar no vídeo — o round termina DEPOIS da
   *    última kill, então cortar antes dela corta o próprio round;
   * 4. a duração mínima (fim antes da própria ação do round).
   *
   * O `endFloorMs` vai para o corte replay-aware: o corte pode encurtar
   * a cauda (win panel + freeze), nunca abaixo do piso.
   */
  const tailMs = Math.max(0, input.endTailSec) * 1000;
  const lastKillFloorMs =
    input.lastKillVideoMs != null ? input.lastKillVideoMs + tailMs : null;
  /**
   * Piso ESTIMADO da última kill. `endLatencyMs` é CONSERVADOR por
   * desenho (máximo da janela quando o round não teve medição), então o
   * piso não pode passar do fim GENUÍNO do round visto no vídeo: a
   * última kill é sempre anterior a ele. Sem o cap, o piso superestimado
   * virava barreira do corte replay-aware e devolvia dezenas de segundos
   * de cauda (o bug que o piso existe para evitar, ao contrário).
   *
   * Só vale quando o killfeed NÃO mediu a última kill: com a medição
   * exata (offset corroborado, todas as kills lidas) a estimativa é
   * redundante e chega a 20s+ depois — `endLatencyMs` é score→score e
   * carrega o atraso de publicação do placar, que não existe no instante
   * da kill (medido: 61,8s vs 45,2s reais no 2399756 r9).
   */
  const lastKillEstimateFloorMs =
    input.lastKillVideoMs == null &&
    input.lastKillAtMs != null &&
    Number.isFinite(input.lastKillAtMs)
      ? Math.min(
          input.lastKillAtMs - input.scoreboardDelayMs + endLatencyMs + tailMs,
          usedScoreboardEnd && ocrEndMs != null ? ocrEndMs + tailMs : Number.POSITIVE_INFINITY,
        )
      : null;
  const ocrEndFloorMs = usedScoreboardEnd ? ocrEndMs : null;
  const minDurationFloorMs =
    videoStartMs != null ? videoStartMs + MIN_CLIP_DURATION_SEC * 1000 : null;
  const floorCandidates = [
    lastKillFloorMs,
    lastKillEstimateFloorMs,
    ocrEndFloorMs,
    minDurationFloorMs,
  ].filter((value): value is number => value != null);
  const endFloorMs = floorCandidates.length > 0 ? Math.max(...floorCandidates) : null;
  let finalEndMs = endMs;
  let endPinnedBy: ClipAnchors['endPinnedBy'] = null;
  if (endFloorMs != null && endFloorMs > finalEndMs) {
    finalEndMs = endFloorMs;
    endPinnedBy =
      endFloorMs === minDurationFloorMs
        ? 'min-duration'
        : endFloorMs === lastKillFloorMs || endFloorMs === lastKillEstimateFloorMs
          ? 'last-kill'
          : null;
  }
  return {
    videoStartMs,
    estimatedClipStartMs,
    endMs: finalEndMs,
    usedScoreboardEnd,
    ocrEndRejected,
    usedEstimatedEnd: !usedScoreboardEnd,
    usedFallback: !usedScoreboardEnd && input.syncScanned,
    endPinnedBy,
    endFloorMs,
    killVideoOffsetMs: killVideoOffset,
    startLatencyMs,
    endLatencyMs,
  };
}
