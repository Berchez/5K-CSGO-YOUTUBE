import { describe, expect, it } from 'vitest';
import {
  createWatchlistSignal,
  notifyWatchlistChanged,
  pollSleepDeadline,
  POLL_WATCHLIST_DEBOUNCE_MS,
  sleepUntilPoll,
  type WatchlistSignal,
} from '../src/monitor/pollSleep.js';

const BASE = 45_000;

/** Relógio falso: controla `now` e os timers do sleep. */
class FakeClock {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Avança o relógio disparando os timers na ordem. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      // Deixa o código reagente (wake da watchlist) recalcular o deadline
      // antes de o relógio pular para o fim do avanço.
      await new Promise((r) => setImmediate(r));
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
    await new Promise((r) => setImmediate(r));
  }
}

describe('pollSleepDeadline', () => {
  it('sem mudança da watchlist usa o deadline normal', () => {
    const signal = createWatchlistSignal();
    expect(
      pollSleepDeadline({
        now: 0,
        targetAt: 30 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      }),
    ).toBe(30 * 60_000);
  });

  it('mudança antecipa, mas nunca antes do piso entre polls', () => {
    const signal = createWatchlistSignal();
    notifyWatchlistChanged(signal, 10_000);
    // Poll começou em 0, mudou em 10s: o poll novo não pode ser antes de
    // 45s (intervalo base após o poll anterior).
    expect(
      pollSleepDeadline({
        now: 10_000,
        targetAt: 30 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      }),
    ).toBe(BASE);
  });

  it('mudança durante uma espera longa antecipa o poll', () => {
    const signal = createWatchlistSignal();
    notifyWatchlistChanged(signal, 5 * 60_000);
    expect(
      pollSleepDeadline({
        now: 5 * 60_000,
        targetAt: 30 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      }),
    ).toBe(5 * 60_000 + POLL_WATCHLIST_DEBOUNCE_MS);
  });

  it('a mudança só antecipa o poll, nunca adia além do deadline normal', () => {
    const signal = createWatchlistSignal();
    notifyWatchlistChanged(signal, 20 * 60_000);
    expect(
      pollSleepDeadline({
        now: 20 * 60_000,
        targetAt: 21 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      }),
    ).toBe(20 * 60_000 + POLL_WATCHLIST_DEBOUNCE_MS);
  });

  it('mudança já consumida por um poll anterior NÃO antecipa (backoff vale)', () => {
    // Regressão: a versão é um contador e nunca volta a 0. Sem comparar
    // com a versão já vista, o deadline caía no piso (45s) para sempre
    // depois da 1ª edição da watchlist — o backoff de 30min morria.
    const signal = createWatchlistSignal();
    notifyWatchlistChanged(signal, 10_000);
    expect(
      pollSleepDeadline({
        now: 60_000,
        targetAt: 30 * 60_000,
        signal,
        seenVersion: signal.version,
        lastPollAt: 60_000,
        baseIntervalMs: BASE,
      }),
    ).toBe(30 * 60_000);
  });

  it('o deadline normal não é atropelado pelo piso (near-match)', () => {
    // O piso entre polls (lastPollAt + base) não pode empurrar o poll
    // para DEPOIS do horário da partida (o "near-match" promete não
    // passar do início).
    const signal = createWatchlistSignal();
    expect(
      pollSleepDeadline({
        now: 0,
        targetAt: 20_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      }),
    ).toBe(20_000);
  });
});

describe('sleepUntilPoll', () => {
  it('dorme até o deadline quando nada muda', async () => {
    const clock = new FakeClock();
    const signal = createWatchlistSignal();
    let finishedAt: number | null = null;
    const sleeping = sleepUntilPoll(
      {
        targetAt: 10 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      },
      { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    ).then(() => {
      finishedAt = clock.now;
    });

    await clock.advance(9 * 60_000);
    expect(finishedAt).toBe(null);
    await clock.advance(2 * 60_000);
    await sleeping;
    expect(finishedAt).toBe(10 * 60_000);
  });

  it('acorda com a mudança da watchlist e aplica logo depois dela', async () => {
    const clock = new FakeClock();
    const signal = createWatchlistSignal();
    let finishedAt: number | null = null;
    const sleeping = sleepUntilPoll(
      {
        targetAt: 30 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      },
      { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    ).then(() => {
      finishedAt = clock.now;
    });

    await clock.advance(60_000);
    notifyWatchlistChanged(signal, clock.now);
    await clock.advance(10_000);
    await sleeping;
    // 5s de quiet period depois da salva (e não os 30min do backoff).
    expect(finishedAt).toBe(60_000 + POLL_WATCHLIST_DEBOUNCE_MS);
  });

  it('várias mudanças viram um único poll (debounce)', async () => {
    const clock = new FakeClock();
    const signal = createWatchlistSignal();
    let finishedAt: number | null = null;
    const sleeping = sleepUntilPoll(
      {
        targetAt: 30 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      },
      { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    ).then(() => {
      finishedAt = clock.now;
    });

    // Salvas repetidas (autosave/OneDrive): cada uma reinicia o quiet
    // period, mas o piso entre polls mantém tudo em UM poll.
    for (let i = 0; i < 5; i++) {
      await clock.advance(2_000);
      notifyWatchlistChanged(signal, clock.now);
      await clock.advance(1_000);
    }
    await clock.advance(BASE);
    await sleeping;
    expect(finishedAt).toBe(BASE);
  });

  it('watchlist já suja não vira hot-loop quando o poll lançou exceção', async () => {
    // Cenário do review: o poll lançou antes de consumir a flag; o sleep
    // NÃO pode retornar imediatamente (loop sem espera, CPU em 100%).
    const clock = new FakeClock();
    const signal = createWatchlistSignal();
    notifyWatchlistChanged(signal, 0);
    let finishedAt: number | null = null;
    const sleeping = sleepUntilPoll(
      {
        targetAt: BASE,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      },
      { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    ).then(() => {
      finishedAt = clock.now;
    });

    await clock.advance(1_000);
    expect(finishedAt).toBe(null);
    await clock.advance(BASE);
    await sleeping;
    expect(finishedAt).toBe(BASE);
  });

  it('mudança já consumida por um poll anterior não antecipa o sleep', async () => {
    // Regressão do P0: a versão é monotônica. Se o sleep comparasse só
    // com "versão > 0", a 1ª edição da watchlist deixaria o bot pollando
    // a cada 45s para sempre (o backoff de 30min morria).
    const clock = new FakeClock();
    const signal = createWatchlistSignal();
    notifyWatchlistChanged(signal, 0);
    let finishedAt: number | null = null;
    const sleeping = sleepUntilPoll(
      {
        targetAt: 30 * 60_000,
        signal,
        seenVersion: signal.version,
        lastPollAt: 0,
        baseIntervalMs: BASE,
      },
      { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    ).then(() => {
      finishedAt = clock.now;
    });

    await clock.advance(BASE);
    expect(finishedAt).toBe(null);
    await clock.advance(30 * 60_000);
    await sleeping;
    expect(finishedAt).toBe(30 * 60_000);
  });

  it('para quando o bot está encerrando', async () => {
    const clock = new FakeClock();
    const signal: WatchlistSignal = createWatchlistSignal();
    let stopping = false;
    const sleeping = sleepUntilPoll(
      {
        targetAt: 30 * 60_000,
        signal,
        seenVersion: 0,
        lastPollAt: 0,
        baseIntervalMs: BASE,
        shouldStop: () => stopping,
      },
      { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    );
    stopping = true;
    await clock.advance(30_000);
    await sleeping;
    expect(clock.now).toBe(30_000);
  });
});
