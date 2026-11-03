import type { KillEvent } from '../types.js';

/**
 * AUDITORIA DA JANELA DO CLIPE (lógica pura).
 *
 * O defeito que mais aparece (e que já voltou várias vezes) é a JANELA
 * errada: o clipe abre depois da 1ª kill, fecha antes da última, ou
 * abre no REPLAY do round em vez do round ao vivo.
 *
 * Este módulo é a regra de negócio — pura e testada. A MEDIÇÃO (OCR do
 * MP4 renderizado) está em `clipWindowOcr.ts`.
 *
 * As invariantes (o "contrato" da janela):
 *
 * - o clipe contém a 1ª kill do ace;
 * - o clipe contém a última kill do ace;
 * - o clipe NÃO abre depois do fim do round no vídeo (se o round já
 *   acabou, o material é replay — o ace não pode mais estar no clipe);
 * - a lista de kills é de UM round só;
 * - (quando o round ao vivo não está no material) o clipe é MARCADO
 *   como replay — último recurso, nunca o padrão.
 */

/** Teto default do spread entre a 1ª e a última kill (ms). */
export const DEFAULT_KILLS_SPREAD_MAX_MS = 120_000;
/** Teto default do GAP entre duas kills consecutivas (ms). */
export const DEFAULT_KILLS_GAP_MAX_MS = 90_000;
/** Tolerância default para "a âncora é posterior ao fim do round" (ms). */
export const DEFAULT_REPLAY_TOLERANCE_MS = 5_000;
/** Folga default para o material do round ao vivo estar no buffer (ms). */
export const DEFAULT_LIVE_MATERIAL_SLACK_MS = 20_000;

/** Violação detectida na janela do clipe. */
export type ClipWindowViolation =
  | 'abre-depois-da-1a-kill'
  | 'fecha-antes-da-ultima-kill'
  | 'abre-depois-do-fim-do-round'
  | 'kills-de-rounds-diferentes'
  | 'gap-enorme-entre-kills'
  | 'ancora-do-killfeed-possivel-replay'
  | 'material-ao-vivo-fora-do-buffer';

/**
 * O que fazer com o clipe.
 *
 * `discard` = não publicar (o clipe não contém o ace ao vivo);
 * `replay-only` = publicar MARCADO (o round ao vivo não estava no
 * material — último recurso).
 */
export type ClipWindowAction = 'ok' | 'discard' | 'replay-only';

export interface ClipWindowInput {
  /** Kills do ace (`at` = instante do poll do HLTV, não o do kill). */
  kills: KillEvent[];
  /** Início real do clipe (epoch ms) — o sidecar. */
  clipStartMs?: number | null;
  /** Duração real do clipe (s) — o sidecar. */
  clipDurationSec?: number | null;
  /** Latência APLICADA na abertura (ms). */
  startLatencyMs?: number | null;
  /** Latência ESTIMADA (antes do teto) (ms). */
  estimatedStartLatencyMs?: number | null;
  /** Latência APLICADA no fim (ms). */
  endLatencyMs?: number | null;
  /** Atraso do placar do HLTV (ms): o `at` da kill é o POLL. */
  scoreboardDelayMs?: number | null;
  /** Fonte da latência (config/killfeed/prior/current/...). */
  latencySource?: string | null;
  /** Âncora do killfeed: instante no VÍDEO da 1ª kill. */
  killfeedFirstKillVideoMs?: number | null;
  /** Motivo da medição do killfeed (confident/first-kill-only/...). */
  killfeedReason?: string | null;
  /** Fim do round no VÍDEO (epoch ms) — medido e CONFIÁVEL. */
  roundEndVideoMs?: number | null;
  /** Início do material mais antigo disponível (epoch ms). */
  bufferOldestMs?: number | null;
  /** Teto do spread das kills (ms). */
  killsSpreadMaxMs?: number;
  /** Teto do GAP entre kills consecutivas (ms). */
  killsGapMaxMs?: number;
  /** Tolerância da guarda de replay (ms). */
  replayToleranceMs?: number;
  /** Folga para considerar o round ao vivo dentro do material (ms). */
  liveMaterialSlackMs?: number;
  /**
   * O clipe abre DENTRO de um replay? (medição do MP4 renderizado:
   * o banner "REPLAY" na tela nos primeiros segundos).
   */
  opensInsideReplay?: boolean | null;
}

export interface ClipWindowVerdict {
  /** Decisão: publicar, descartar ou publicar marcado como replay. */
  action: ClipWindowAction;
  /** Violações encontradas (códigos curtos, para log e sidecar). */
  violations: ClipWindowViolation[];
  /** Spread entre a 1ª e a última kill observada (ms). */
  killsSpreadMs: number | null;
  /** Maior intervalo entre duas kills consecutivas (ms). */
  killsMaxGapMs: number | null;
  /** Posição esperada da 1ª kill no vídeo (epoch ms). */
  expectedFirstKillVideoMs: number | null;
  /** Posição esperada da última kill no vídeo (epoch ms). */
  expectedLastKillVideoMs: number | null;
  /** A janela do clipe contém a 1ª kill (pela posição estimada)? */
  coversFirstKill: boolean | null;
  /** A janela do clipe contém a última kill (pela posição estimada)? */
  coversLastKill: boolean | null;
  /** O clipe abre depois do fim do round no vídeo? */
  startsAfterRoundEnd: boolean | null;
  /** A âncora do killfeed parece ser a do REPLAY? */
  anchorLooksLikeReplay: boolean | null;
  /** O material do round AO VIVO estava disponível? */
  liveMaterialAvailable: boolean | null;
}

/** Instantes observados das kills (ordenados), sem os indefinidos. */
export function killTimesMs(kills: KillEvent[]): number[] {
  return kills
    .map((kill) => kill.at)
    .filter((at): at is number => Number.isFinite(at))
    .sort((a, b) => a - b);
}

/** Spread entre a 1ª e a última kill observada (ms). */
export function killSpreadMs(kills: KillEvent[]): number | null {
  const times = killTimesMs(kills);
  if (times.length < 2) return null;
  return times[times.length - 1] - times[0];
}

/** Maior intervalo entre duas kills consecutivas (ms). */
export function killMaxGapMs(kills: KillEvent[]): number | null {
  const times = killTimesMs(kills);
  if (times.length < 2) return null;
  let max = 0;
  for (let i = 1; i < times.length; i++) max = Math.max(max, times[i] - times[i - 1]);
  return max;
}

/** A lista traz kills de rounds DIFERENTES? (o `round` é do tracker) */
export function distinctKillRounds(kills: KillEvent[]): number[] {
  const rounds = new Set<number>();
  for (const kill of kills) {
    if (Number.isFinite(kill.round)) rounds.add(kill.round);
  }
  return [...rounds].sort((a, b) => a - b);
}

/**
 * A lista de kills é SUSPEITA (mistura rounds)?
 *
 * Três sinais, do mais forte para o mais fraco:
 *
 * 1. **Rounds diferentes** no próprio evento (`KillEvent.round`): sinal
 *    direto do tracker — não há como um ace ter kills de dois rounds.
 * 2. **Gap enorme** entre kills consecutivas: dentro de um round o
 *    intervalo é de poucos segundos a ~1min; o caso
 *    2399858_Ancient_r6_kyousuke tinha 3s e depois 114s (3 kills de um
 *    round, 2 de outro) — a lista atravessa a partida.
 * 3. **Spread total** grande: a soma dos intervalos.
 *
 * O `at` do HLTV é o instante do POLL (atrasa 5..16s por kill) e um
 * round lento (post-plant/retake) pode passar de 60s entre a 1ª e a 5ª
 * kill — por isso o spread sozinho NÃO descarta, e os limites são
 * folgados.
 *
 * Puro/testável.
 */
export function suspectKillsSpread(
  kills: KillEvent[],
  limits: { spreadMaxMs?: number; gapMaxMs?: number } = {},
): {
  suspect: boolean;
  warning: boolean;
  spreadMs: number | null;
  maxGapMs: number | null;
  reason?: string;
} {
  const spreadMax = limits.spreadMaxMs ?? DEFAULT_KILLS_SPREAD_MAX_MS;
  const gapMax = limits.gapMaxMs ?? DEFAULT_KILLS_GAP_MAX_MS;
  const spread = killSpreadMs(kills);
  const maxGap = killMaxGapMs(kills);
  const rounds = distinctKillRounds(kills);

  if (rounds.length > 1) {
    return {
      suspect: true,
      warning: false,
      spreadMs: spread,
      maxGapMs: maxGap,
      reason: `kills de rounds diferentes (${rounds.join(', ')})`,
    };
  }
  if (maxGap != null && maxGap > gapMax) {
    return {
      suspect: true,
      warning: false,
      spreadMs: spread,
      maxGapMs: maxGap,
      reason: `kills de rounds diferentes (intervalo de ${Math.round(maxGap / 1000)}s entre kills consecutivas > ${Math.round(gapMax / 1000)}s)`,
    };
  }
  if (spread != null && spread > spreadMax) {
    return {
      suspect: true,
      warning: false,
      spreadMs: spread,
      maxGapMs: maxGap,
      reason: `kills de rounds diferentes (dispersão de ${Math.round(spread / 1000)}s > ${Math.round(spreadMax / 1000)}s)`,
    };
  }
  /**
   * Faixa de ATENÇÃO: acima do limite "gosto" de um ace legítimo (round
   * lento) mas abaixo da evidência de mistura. Não descarta — só avisa
   * e fica registrado no sidecar.
   */
  const warning =
    (maxGap != null && maxGap > gapMax * 0.6) || (spread != null && spread > spreadMax * 0.6);
  return { suspect: false, warning, spreadMs: spread, maxGapMs: maxGap };
}

/**
 * O fim do round medido no vídeo pode ser usado como EVIDÊNCIA?
 *
 * Só o motivo `confident` (o placar do vídeo mostrou a virada com o
 * placar ANTES e DEPOIS legíveis) é medição de verdade:
 *
 * - `after-only`: o placar ANTES não estava legível — a virada é a
 *   única evidência e pode ser de outro round;
 * - `gap-inferred`: o fim foi INFERIDO (o overlay ficou ilegível e a
 *   virada só apareceu no round seguinte) — é um limite INFERIOR, não
 *   o fim real;
 * - `no-transition`/`no-scoreboard`: não há leitura.
 *
 * E um fim REJEITADO pelos anchors (implausível: cedo demais ou tarde
 * demais) também não serve — o `ocrEndRejected` marca exatamente isso.
 *
 * Puro/testável.
 */
export function trustedRoundEndVideoMs(input: {
  reason?: string | null;
  roundEndAt?: string | number | null;
  ocrEndRejected?: boolean | null;
}): number | null {
  if (input.reason !== 'confident') return null;
  if (input.ocrEndRejected === true) return null;
  const raw = input.roundEndAt;
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Confere as invariantes da janela do clipe. Puro.
 *
 * A decisão é deliberadamente conservadora: só DESCARTA com evidência
 * forte (a lista de kills é de rounds diferentes, ou o clipe abre depois
 * do fim do round MEDIDO no vídeo com o material ao vivo disponível).
 * Estimativa ruidosa vira aviso, não descarte.
 */
export function auditClipWindow(input: ClipWindowInput): ClipWindowVerdict {
  const times = killTimesMs(input.kills);
  const spread = killSpreadMs(input.kills);
  const maxGap = killMaxGapMs(input.kills);
  const spreadMax = input.killsSpreadMaxMs ?? DEFAULT_KILLS_SPREAD_MAX_MS;
  const gapMax = input.killsGapMaxMs ?? DEFAULT_KILLS_GAP_MAX_MS;
  const replayTol = input.replayToleranceMs ?? DEFAULT_REPLAY_TOLERANCE_MS;
  const liveSlack = input.liveMaterialSlackMs ?? DEFAULT_LIVE_MATERIAL_SLACK_MS;
  const startLatency = input.startLatencyMs ?? input.estimatedStartLatencyMs ?? null;
  const endLatency = input.endLatencyMs ?? input.startLatencyMs ?? null;
  /**
   * O `at` da kill é o instante do POLL do HLTV: o kill aconteceu
   * `scoreboardDelayMs` ANTES. A posição esperada no vídeo é
   * (at − atraso) + latência — sem o desconto, a expectativa erra
   * para o lado tarde e a invariante "contém a 1ª kill" fica inútil.
   */
  const scoreboardDelay = input.scoreboardDelayMs ?? 0;

  const expectedFirst =
    times.length > 0 && startLatency != null
      ? times[0] - scoreboardDelay + startLatency
      : null;
  const expectedLast =
    times.length > 0 && endLatency != null
      ? times[times.length - 1] - scoreboardDelay + endLatency
      : null;

  const clipStart = input.clipStartMs ?? null;
  const clipEnd =
    clipStart != null && Number.isFinite(input.clipDurationSec ?? NaN)
      ? clipStart + (input.clipDurationSec ?? 0) * 1000
      : null;

  const violations: ClipWindowViolation[] = [];

  const coversFirstKill =
    clipStart != null && expectedFirst != null ? clipStart <= expectedFirst : null;
  if (coversFirstKill === false) violations.push('abre-depois-da-1a-kill');

  const coversLastKill = clipEnd != null && expectedLast != null ? clipEnd >= expectedLast : null;
  if (coversLastKill === false) violations.push('fecha-antes-da-ultima-kill');

  const startsAfterRoundEnd =
    clipStart != null && input.roundEndVideoMs != null
      ? clipStart > input.roundEndVideoMs + replayTol
      : null;
  if (startsAfterRoundEnd === true) violations.push('abre-depois-do-fim-do-round');

  const killsMixedRounds =
    distinctKillRounds(input.kills).length > 1 ||
    (maxGap != null && maxGap > gapMax) ||
    (spread != null && spread > spreadMax);
  if (distinctKillRounds(input.kills).length > 1) violations.push('kills-de-rounds-diferentes');
  else if (maxGap != null && maxGap > gapMax) violations.push('gap-enorme-entre-kills');
  else if (spread != null && spread > spreadMax) violations.push('kills-de-rounds-diferentes');

  // O material do round AO VIVO estava no buffer? (a posição esperada da
  // 1ª kill é anterior ao material mais antigo => não estava)
  const liveMaterialAvailable =
    expectedFirst != null && input.bufferOldestMs != null
      ? input.bufferOldestMs <= expectedFirst + liveSlack
      : null;
  if (liveMaterialAvailable === false) violations.push('material-ao-vivo-fora-do-buffer');

  // A âncora do killfeed é posterior ao fim do round no vídeo? (aí é o
  // replay — a linha do killfeed aparece DE NOVO no replay do round)
  const anchorLooksLikeReplay =
    input.killfeedFirstKillVideoMs != null && input.roundEndVideoMs != null
      ? input.killfeedFirstKillVideoMs > input.roundEndVideoMs + replayTol
      : null;
  if (anchorLooksLikeReplay === true) violations.push('ancora-do-killfeed-possivel-replay');

  let action: ClipWindowAction = 'ok';
  if (killsMixedRounds) {
    // Evidência forte: a lista de kills não é de um round só — qualquer
    // janela derivada dela mistura rounds (o caso 2399858_Ancient_r6).
    action = 'discard';
  } else if (input.opensInsideReplay === true) {
    // MEDIÇÃO do MP4 renderizado: o clipe começa DENTRO de um replay
    // (o banner "REPLAY" na tela nos primeiros segundos). O ace ao
    // vivo não pode estar ali.
    action = liveMaterialAvailable === false ? 'replay-only' : 'discard';
  } else if (startsAfterRoundEnd === true && liveMaterialAvailable !== false) {
    // O round já tinha acabado no vídeo e o material ao vivo existia:
    // o clipe só pode mostrar o replay — não contém o ace.
    action = 'discard';
  } else if (liveMaterialAvailable === false) {
    // O round ao vivo não estava no material: o replay é o último
    // recurso (ace sem material ao vivo) — publica marcado.
    action = 'replay-only';
  }

  return {
    action,
    violations,
    killsSpreadMs: spread,
    killsMaxGapMs: maxGap,
    expectedFirstKillVideoMs: expectedFirst,
    expectedLastKillVideoMs: expectedLast,
    coversFirstKill,
    coversLastKill,
    startsAfterRoundEnd,
    anchorLooksLikeReplay,
    liveMaterialAvailable,
  };
}
