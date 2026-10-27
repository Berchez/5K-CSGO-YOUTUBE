import { describe, expect, it } from 'vitest';
import {
  computePollDecision,
  nextPollDelayMs,
  pollForceReasons,
  POLL_MAX_BACKOFF_MS,
  POLL_NEAR_MATCH_MS,
  POLL_NO_NEXT_MATCH_MS,
  POLL_START_GRACE_MS,
  type PollForceReason,
} from '../src/monitor/pollSchedule.js';

const HOUR = 60 * 60_000;
const BASE = 45_000;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

function delay(nextMatchAt: number | null, forceBase = false, base = BASE): number {
  return nextPollDelayMs({ now: NOW, nextMatchAt, baseIntervalMs: base, forceBase });
}

function decision(
  nextMatchAt: number | null,
  overrides: {
    forceReasons?: PollForceReason[];
    scheduleReliable?: boolean;
    adaptive?: boolean;
    baseIntervalMs?: number;
  } = {},
) {
  return computePollDecision({
    now: NOW,
    nextMatchAt,
    baseIntervalMs: overrides.baseIntervalMs ?? BASE,
    forceReasons: overrides.forceReasons ?? [],
    scheduleReliable: overrides.scheduleReliable ?? true,
    adaptive: overrides.adaptive ?? true,
  });
}

describe('nextPollDelayMs', () => {
  it('espera metade do tempo restante', () => {
    expect(delay(NOW + 40 * 60_000)).toBe(20 * 60_000);
    expect(delay(NOW + 50 * 60_000)).toBe(25 * 60_000);
    expect(delay(NOW + HOUR)).toBe(30 * 60_000);
  });

  it('limita a espera em 30min mesmo com a partida muito longe', () => {
    expect(delay(NOW + 2 * HOUR)).toBe(POLL_MAX_BACKOFF_MS);
    expect(delay(NOW + 8 * HOUR)).toBe(POLL_MAX_BACKOFF_MS);
    expect(delay(NOW + 24 * HOUR)).toBe(POLL_MAX_BACKOFF_MS);
    expect(delay(NOW + 72 * HOUR)).toBe(POLL_MAX_BACKOFF_MS);
  });

  it('volta ao intervalo base nos últimos 30min', () => {
    expect(delay(NOW + POLL_NEAR_MATCH_MS)).toBe(BASE);
    expect(delay(NOW + 20 * 60_000)).toBe(BASE);
    expect(delay(NOW + 60_000)).toBe(BASE);
  });

  it('não passa do horário da partida quando o intervalo base é longo', () => {
    expect(delay(NOW + 5 * 60_000, false, 10 * 60_000)).toBe(5 * 60_000);
  });

  it('mantém o intervalo base enquanto a partida está atrasada (grace)', () => {
    expect(delay(NOW - 5 * 60_000)).toBe(BASE);
    expect(delay(NOW - (POLL_START_GRACE_MS - 1000))).toBe(BASE);
  });

  it('ignora partida atrasada fora da grace', () => {
    expect(delay(NOW - (POLL_START_GRACE_MS + 1000))).toBe(POLL_NO_NEXT_MATCH_MS);
  });

  it('sem partida elegível volta em 15min', () => {
    expect(delay(null)).toBe(POLL_NO_NEXT_MATCH_MS);
  });

  it('situação ativa (live, gravação, watchlist) força o intervalo base', () => {
    expect(delay(NOW + 8 * HOUR, true)).toBe(BASE);
    expect(delay(null, true)).toBe(BASE);
  });

  it('nunca devolve menos que o intervalo base', () => {
    expect(delay(NOW + 20 * 60_000, false, 10 * 60_000)).toBe(10 * 60_000);
    expect(delay(NOW + 10 * HOUR, false, 5 * 60_000)).toBe(POLL_MAX_BACKOFF_MS);
  });

  it('agenda não confiável (extração quebrada) volta ao intervalo base', () => {
    // Fail-open: sem card futuro no listing o bot NÃO pode dormir 15min.
    expect(nextPollDelayMs({
      now: NOW,
      nextMatchAt: null,
      baseIntervalMs: BASE,
      forceBase: false,
      scheduleReliable: false,
    })).toBe(BASE);
    // Mesmo com uma partida prevista no papel: a extração que falhou
    // invalida a previsão.
    expect(nextPollDelayMs({
      now: NOW,
      nextMatchAt: NOW + 8 * HOUR,
      baseIntervalMs: BASE,
      forceBase: false,
      scheduleReliable: false,
    })).toBe(BASE);
  });
});

describe('pollForceReasons', () => {
  const idle = {
    liveMatches: 0,
    recorders: 0,
    trackers: 0,
    pendingClips: 0,
    deferredCleanup: 0,
    blocked: false,
    watchlistChanged: false,
    watchlistStale: false,
  };

  it('sem nada ativo: nenhum motivo (o poll pode adiar)', () => {
    expect(pollForceReasons(idle)).toEqual([]);
  });

  it('cada estado ativo vira um motivo, na ordem de prioridade', () => {
    expect(
      pollForceReasons({
        ...idle,
        liveMatches: 2,
        recorders: 1,
        trackers: 1,
        pendingClips: 1,
        deferredCleanup: 1,
        blocked: true,
        watchlistChanged: true,
        watchlistStale: true,
      }),
    ).toEqual([
      'live',
      'recording',
      'tracker',
      'pending-clip',
      'deferred-cleanup',
      'blocked',
      'watchlist',
      'watchlist-stale',
    ]);
  });

  it('qualquer motivo trava o poll no intervalo base', () => {
    for (const reason of pollForceReasons({ ...idle, deferredCleanup: 1 })) {
      const d = computePollDecision({
        now: NOW,
        nextMatchAt: NOW + 8 * HOUR,
        baseIntervalMs: BASE,
        forceReasons: [reason],
        scheduleReliable: true,
        adaptive: true,
      });
      expect(d.delayMs).toBe(BASE);
    }
  });
});

describe('computePollDecision', () => {
  it('devolve o motivo de cada decisão', () => {
    expect(decision(NOW + 8 * HOUR).reason).toBe('backoff');
    expect(decision(NOW + 10 * 60_000).reason).toBe('near-match');
    expect(decision(NOW - 60_000).reason).toBe('delayed-start');
    expect(decision(null).reason).toBe('no-next-match');
    expect(decision(NOW + 8 * HOUR, { scheduleReliable: false }).reason).toBe(
      'schedule-unreliable',
    );
    expect(decision(NOW + 8 * HOUR, { adaptive: false }).reason).toBe('adaptive-off');
    expect(decision(NOW + 8 * HOUR, { forceReasons: ['recording'] }).reason).toBe('recording');
    expect(decision(NOW + 8 * HOUR, { forceReasons: ['live', 'recording'] }).reason).toBe('live');
  });

  it('POLL_ADAPTIVE=false desliga o backoff (kill switch)', () => {
    expect(decision(NOW + 8 * HOUR, { adaptive: false }).delayMs).toBe(BASE);
    expect(decision(null, { adaptive: false }).delayMs).toBe(BASE);
  });

  it('agenda não confiável nunca adia o poll', () => {
    expect(decision(NOW + 8 * HOUR, { scheduleReliable: false }).delayMs).toBe(BASE);
    expect(decision(null, { scheduleReliable: false }).delayMs).toBe(BASE);
  });

  it('motivo de força sempre usa o intervalo base', () => {
    for (const reason of [
      'live',
      'recording',
      'tracker',
      'pending-clip',
      'deferred-cleanup',
      'blocked',
      'watchlist',
      'watchlist-stale',
    ] as PollForceReason[]) {
      const d = decision(NOW + 8 * HOUR, { forceReasons: [reason] });
      expect(d.delayMs).toBe(BASE);
      expect(d.reason).toBe(reason);
    }
  });
});
