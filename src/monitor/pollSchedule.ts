/**
 * Agendamento adaptativo do poll do listing.
 *
 * Sem isso o bot abre a página do HLTV a cada POLL_INTERVAL_MS mesmo
 * quando a próxima partida elegível está a 8h de distância. A regra é
 * "espere metade do tempo que falta" até um piso perto do horário, onde
 * o poll volta ao intervalo base para não perder o começo da partida.
 */

/** Janela final: dentro dela o poll volta ao intervalo base. */
export const POLL_NEAR_MATCH_MS = 30 * 60_000;
/** Teto da espera entre checagens (mesmo com a próxima partida a 24h+). */
export const POLL_MAX_BACKOFF_MS = 4 * 60 * 60_000;
/**
 * Grace de adiamento: uma partida cujo horário já passou continua no
 * intervalo base por este tempo (HLTV costuma atrasar o início).
 */
export const POLL_START_GRACE_MS = 60 * 60_000;
/** Sem nenhuma partida elegível no listing: volta a checar em 30min. */
export const POLL_NO_NEXT_MATCH_MS = 30 * 60_000;

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
}

/**
 * Quanto tempo dormir até a próxima checagem do listing.
 * - 8h de distância → 4h; 4h → 2h; 2h → 1h; 1h → 30min.
 * - Dentro de 30min do horário (ou até 60min depois dele) → intervalo base.
 * - Sem próxima partida → 30min.
 */
export function nextPollDelayMs(input: PollScheduleInput): number {
  const base = Math.max(1000, Math.floor(input.baseIntervalMs));
  if (input.forceBase) return base;
  if (input.nextMatchAt === null) return Math.max(base, POLL_NO_NEXT_MATCH_MS);

  const remaining = input.nextMatchAt - input.now;
  if (remaining <= 0) {
    // Horário já passou: a partida pode estar atrasada — insiste até a grace.
    if (remaining >= -POLL_START_GRACE_MS) return base;
    return Math.max(base, POLL_NO_NEXT_MATCH_MS);
  }
  if (remaining <= POLL_NEAR_MATCH_MS) {
    // Perto do horário: não passa do início (nem do intervalo base).
    return Math.max(1000, Math.min(base, remaining));
  }
  const half = Math.floor(remaining / 2);
  return Math.max(base, Math.min(POLL_MAX_BACKOFF_MS, half));
}
