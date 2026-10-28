/**
 * Sono do loop de poll: deadline, wake da watchlist e piso entre polls.
 *
 * O poll adaptativo pode dormir 30min; salvar a watchlist precisa ter
 * efeito rápido (hot-reload). Mas cada toque de arquivo (autosave do
 * editor, OneDrive, antivírus) não pode virar um page-load do HLTV a
 * cada 2s. Aqui as duas regras convivem:
 *
 * - a mudança da watchlist antecipa o próximo poll, mas nunca antes de
 *   um intervalo base após o poll anterior (debounce);
 * - o deadline é recalculado a cada wake, então uma salva só dispara
 *   UM poll (o último toque redefine a hora);
 * - nenhum "flag sujo" consegue zerar a espera: o poll que lançou
 *   exceção não vira hot-loop (o sleep sempre espera até o deadline).
 *
 * A versão da watchlist é um contador monotônico: ela NUNCA volta a 0.
 * Por isso o sleep compara com a versão JÁ CONSUMIDA por um poll
 * (seenVersion): uma mudança antiga que o poll anterior já aplicou não
 * pode continuar antecipando o deadline (senão o backoff de 30min
 * vira poll a cada 45s para sempre).
 */

/** Sinal da watchlist compartilhado entre o watcher e o loop de poll. */
export interface WatchlistSignal {
  /** Contador de mudanças observadas (nunca volta atrás). */
  version: number;
  /** Epoch ms da última mudança observada. */
  changedAt: number;
  /** Wake registrado pelo sleep em curso (null = ninguém dormindo). */
  wake: (() => void) | null;
}

export function createWatchlistSignal(): WatchlistSignal {
  return { version: 0, changedAt: 0, wake: null };
}

/** Registra uma mudança da watchlist e acorda o sleep em curso. */
export function notifyWatchlistChanged(signal: WatchlistSignal, at = Date.now()): void {
  signal.version += 1;
  signal.changedAt = at;
  const wake = signal.wake;
  signal.wake = null;
  wake?.();
}

/**
 * Quiet period após uma mudança da watchlist: salvas seguidas (autosave,
 * OneDrive) viram um único poll. O piso entre polls (um intervalo base
 * após o poll anterior) é o que limita a taxa de page-load do HLTV.
 */
export const POLL_WATCHLIST_DEBOUNCE_MS = 5_000;

export interface PollSleepDeadlineInput {
  now: number;
  /** Deadline normal (fim do poll + intervalo decidido). */
  targetAt: number;
  signal: WatchlistSignal;
  /**
   * Versão da watchlist já consumida por um poll. Mudanças com versão
   * MAIOR que esta ainda não foram aplicadas → antecipam o poll.
   */
  seenVersion: number;
  /** Início do último poll (base do piso entre polls). */
  lastPollAt: number;
  baseIntervalMs: number;
}

/**
 * Deadline absoluto do próximo poll (epoch ms).
 *
 * Sem mudança nova (version <= seenVersion): o deadline normal (fim do
 * poll + delay). O piso "último poll + 1 intervalo base" NÃO entra aqui:
 * ele existe para debounce do wake da watchlist, e aplicá-lo no deadline
 * normal atropelava o "near-match" (o poll acabava depois do início da
 * partida, que é justamente o que o near-match promete evitar).
 *
 * Com mudança nova: antecipa para "mudança + quiet period", mas nunca
 * antes do piso "último poll + 1 intervalo base" (debounce) — assim uma
 * salva não gera um poll por segundo. O deadline nunca passa do normal
 * (targetAt).
 */
export function pollSleepDeadline(input: PollSleepDeadlineInput): number {
  const base = Math.max(1000, Math.floor(input.baseIntervalMs));
  const minGapAt = input.lastPollAt + base;
  if (input.signal.version <= input.seenVersion) return input.targetAt;
  const wakeAt = Math.min(
    input.targetAt,
    input.signal.changedAt + POLL_WATCHLIST_DEBOUNCE_MS,
  );
  return Math.max(minGapAt, wakeAt);
}

export interface PollSleepInput {
  /** Deadline normal (fim do poll + intervalo decidido). */
  targetAt: number;
  signal: WatchlistSignal;
  /** Versão da watchlist já consumida pelo poll que acabou de rodar. */
  seenVersion: number;
  /** Início do último poll (base do piso entre polls). */
  lastPollAt: number;
  baseIntervalMs: number;
  /** Interrompe a espera quando o bot está encerrando. */
  shouldStop?: () => boolean;
}

export interface PollSleepDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Fatia máxima de cada timer: timers de 30min dependem do relógio e não
   * reagem a um `stopping` no meio do caminho. Dormir em fatias de 30s
   * mantém o encerramento rápido e o deadline honesto.
   */
  sliceMs?: number;
  /** Chamado quando o sleep foi interrompido por uma mudança. */
  onWake?: () => void;
}

/** Dorme até o deadline, woken por mudança da watchlist. */
export async function sleepUntilPoll(
  input: PollSleepInput,
  deps: PollSleepDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const slice = Math.max(1000, deps.sliceMs ?? 30_000);

  for (;;) {
    if (input.shouldStop?.()) return;
    const deadline = pollSleepDeadline({
      now: now(),
      targetAt: input.targetAt,
      signal: input.signal,
      seenVersion: input.seenVersion,
      lastPollAt: input.lastPollAt,
      baseIntervalMs: input.baseIntervalMs,
    });
    const remaining = deadline - now();
    if (remaining <= 0) return;

    const version = input.signal.version;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimer(timer);
        if (input.signal.wake === finish) input.signal.wake = null;
        resolve();
      };
      const timer = setTimer(finish, Math.min(remaining, slice));
      input.signal.wake = finish;
      // Corrida: a mudança pode ter caído entre o deadline e o registro
      // do wake — o versionei detecta e encerra a espera na hora.
      if (input.signal.version !== version) finish();
    });
    if (input.signal.version !== version) deps.onWake?.();
  }
}
