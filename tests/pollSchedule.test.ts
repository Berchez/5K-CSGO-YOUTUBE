import { describe, expect, it } from 'vitest';
import {
  nextPollDelayMs,
  POLL_MAX_BACKOFF_MS,
  POLL_NEAR_MATCH_MS,
  POLL_NO_NEXT_MATCH_MS,
  POLL_START_GRACE_MS,
} from '../src/monitor/pollSchedule.js';

const HOUR = 60 * 60_000;
const BASE = 45_000;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

function delay(nextMatchAt: number | null, forceBase = false, base = BASE): number {
  return nextPollDelayMs({ now: NOW, nextMatchAt, baseIntervalMs: base, forceBase });
}

describe('nextPollDelayMs', () => {
  it('espera metade do tempo restante', () => {
    expect(delay(NOW + 8 * HOUR)).toBe(4 * HOUR);
    expect(delay(NOW + 4 * HOUR)).toBe(2 * HOUR);
    expect(delay(NOW + 2 * HOUR)).toBe(HOUR);
    expect(delay(NOW + HOUR)).toBe(30 * 60_000);
  });

  it('limita a espera em 4h mesmo com a partida muito longe', () => {
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

  it('sem partida elegível volta em 30min', () => {
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
});
