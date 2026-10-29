/**
 * Agendamento adaptativo do poll do listing.
 *
 * Sem isso o bot abre a página do HLTV a cada POLL_INTERVAL_MS mesmo
 * quando a próxima partida elegível está a 8h de distância. A regra é
 * "espere metade do tempo que falta" até um piso perto do horário, onde
 * o poll volta ao intervalo base para não perder o começo da partida.
 *
 * O backoff é uma PREVISÃO: horário muda, partida entra no listing,
 * extração quebra. Por isso o teto é curto (30min) e toda falha de
 * extração cai no intervalo base (fail-open) em vez de dormir.
 */

/** Janela final: dentro dela o poll volta ao intervalo base. */
export const POLL_NEAR_MATCH_MS = 30 * 60_000;
/**
 * Teto da espera entre checagens (mesmo com a próxima partida a 24h+).
 * Curto de propósito: a agenda é previsão e uma partida elegível nova
 * (ou que só passou no filtro) só aparece na próxima checagem.
 */
export const POLL_MAX_BACKOFF_MS = 30 * 60_000;
/**
 * Grace de adiamento: uma partida cujo horário já passou continua no
 * intervalo base por este tempo (HLTV costuma atrasar o início).
 */
export const POLL_START_GRACE_MS = 60 * 60_000;
/**
 * Sem nenhuma partida elegível no listing: volta a checar em 15min.
 * (A agenda é confiável — o filtro é que não deixou ninguém elegível.)
 */
export const POLL_NO_NEXT_MATCH_MS = 15 * 60_000;
/**
 * Piso do near-match: o "near-match" acorda o bot perto do horário da
 * partida, mas nunca pode virar hot-loop (cada poll abre a página do
 * HLTV e o Cloudflare barra quem martela). O intervalo base tem piso
 * próprio no config (POLL_INTERVAL_MS >= 5s).
 */
export const POLL_MIN_DELAY_MS = 10_000;

/** Motivos que obrigam o intervalo base (o poll não pode adiar). */
export type PollForceReason =
  | 'live'
  | 'recording'
  | 'tracker'
  | 'pending-clip'
  | 'deferred-cleanup'
  | 'blocked'
  | 'listing-degraded'
  | 'watchlist'
  | 'watchlist-stale';

/** Motivo final da espera (vai para o log). */
export type PollDelayReason =
  | PollForceReason
  | 'adaptive-off'
  | 'schedule-unreliable'
  | 'near-match'
  | 'delayed-start'
  | 'no-next-match'
  | 'backoff';

export interface PollScheduleInput {
  /** Epoch ms do instante da decisão. */
  now: number;
  /** Epoch ms do início da próxima partida elegível (null = nenhuma). */
  nextMatchAt: number | null;
  /** Intervalo base (POLL_INTERVAL_MS). */
  baseIntervalMs: number;
  /**
   * Situação que exige o intervalo base: live elegível, gravação/tracker
   * ativo, clipe pendente, listing bloqueado ou watchlist alterada.
   */
  forceBase: boolean;
  /**
   * A agenda extraída do listing é confiável? false = nenhum card futuro
   * encontrado (DOM mudou / extração falhou) → fail-open: intervalo base.
   */
  scheduleReliable?: boolean;
  /** Backoff adaptativo desligado (POLL_ADAPTIVE=false) → sempre base. */
  adaptive?: boolean;
}

export interface PollDecisionInput {
  now: number;
  nextMatchAt: number | null;
  baseIntervalMs: number;
  /** Motivos que exigem o intervalo base (o primeiro vira o log). */
  forceReasons: PollForceReason[];
  /** A agenda do listing é confiável? */
  scheduleReliable: boolean;
  /** Backoff adaptativo ligado? */
  adaptive: boolean;
}

/** Estado do bot que decide o próximo intervalo (contagens do poll). */
export interface PollRuntimeState {
  /** Lives elegíveis vistas no poll. */
  liveMatches: number;
  /** Recorders de stream ativos. */
  recorders: number;
  /** Trackers de ace ativos. */
  trackers: number;
  /** Clipes em construção. */
  pendingClips: number;
  /** Buffers adiados (limpeza pendente). */
  deferredCleanup: number;
  /** Listing bloqueado pelo Cloudflare. */
  blocked: boolean;
  /**
   * Listing degradado (algum card live quebrou): a lista pode estar
   * incompleta → o poll precisa repetir logo (intervalo base).
   */
  listingDegraded?: boolean;
  /** A watchlist mudou durante o poll. */
  watchlistChanged: boolean;
  /** A watchlist ausente, segurando a última versão boa. */
  watchlistStale: boolean;
}

/**
 * Motivos que obrigam o intervalo base, em ordem de prioridade (o
 * primeiro vira o motivo do log). Puro/testável: o loop só monta o
 * estado e o agendamento decide o tempo.
 */
export function pollForceReasons(state: PollRuntimeState): PollForceReason[] {
  const reasons: PollForceReason[] = [];
  if (state.liveMatches > 0) reasons.push('live');
  if (state.recorders > 0) reasons.push('recording');
  if (state.trackers > 0) reasons.push('tracker');
  if (state.pendingClips > 0) reasons.push('pending-clip');
  if (state.deferredCleanup > 0) reasons.push('deferred-cleanup');
  if (state.blocked) reasons.push('blocked');
  if (state.listingDegraded) reasons.push('listing-degraded');
  if (state.watchlistChanged) reasons.push('watchlist');
  if (state.watchlistStale) reasons.push('watchlist-stale');
  return reasons;
}

export interface PollDecision {
  /** Quanto tempo dormir até a próxima checagem. */
  delayMs: number;
  /** Por que esse tempo (log de debug do agendamento). */
  reason: PollDelayReason;
}

/**
 * Quanto tempo dormir até a próxima checagem do listing.
 * - 1h de distância → 30min (teto); 40min → 20min; 20min → intervalo base.
 * - Dentro de 30min do horário (ou até 60min depois dele) → intervalo base.
 * - Sem próxima partida elegível → 15min.
 * - Agenda não confiável (nenhum card futuro) → intervalo base (fail-open).
 */
export function computePollDecision(input: PollDecisionInput): PollDecision {
  const base = Math.max(1000, Math.floor(input.baseIntervalMs));
  if (!input.adaptive) return { delayMs: base, reason: 'adaptive-off' };
  const force = input.forceReasons[0];
  if (force) return { delayMs: base, reason: force };
  if (!input.scheduleReliable) {
    return { delayMs: base, reason: 'schedule-unreliable' };
  }
  if (input.nextMatchAt === null) {
    return { delayMs: Math.max(base, POLL_NO_NEXT_MATCH_MS), reason: 'no-next-match' };
  }

  const remaining = input.nextMatchAt - input.now;
  if (remaining <= 0) {
    // Horário já passou: a partida pode estar atrasada — insiste até a grace.
    if (remaining >= -POLL_START_GRACE_MS) return { delayMs: base, reason: 'delayed-start' };
    return { delayMs: Math.max(base, POLL_NO_NEXT_MATCH_MS), reason: 'no-next-match' };
  }
  if (remaining <= POLL_NEAR_MATCH_MS) {
    // Perto do horário: não passa do início (nem do intervalo base),
    // mas nunca abaixo do piso absoluto (hot-loop contra o Cloudflare).
    return {
      delayMs: Math.max(POLL_MIN_DELAY_MS, Math.min(base, remaining)),
      reason: 'near-match',
    };
  }
  const half = Math.floor(remaining / 2);
  return {
    delayMs: Math.max(base, Math.min(POLL_MAX_BACKOFF_MS, half)),
    reason: 'backoff',
  };
}

/** Atalho booleano: mesmo cálculo, sem o motivo. */
export function nextPollDelayMs(input: PollScheduleInput): number {
  return computePollDecision({
    now: input.now,
    nextMatchAt: input.nextMatchAt,
    baseIntervalMs: input.baseIntervalMs,
    forceReasons: input.forceBase ? ['live'] : [],
    scheduleReliable: input.scheduleReliable ?? true,
    adaptive: input.adaptive ?? true,
  }).delayMs;
}
