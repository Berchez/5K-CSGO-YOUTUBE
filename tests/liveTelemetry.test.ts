import { describe, expect, it } from 'vitest';
import { detectionEvents } from '../src/monitor/liveTelemetry.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

describe('detectionEvents', () => {
  it('mede a latência contra o horário previsto', () => {
    const known = new Map([['1', NOW - 120_000]]);
    const events = detectionEvents({
      liveMatchIds: ['1'],
      knownUpcoming: known,
      predictedMatchId: '1',
      now: NOW,
      seen: new Set(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ matchId: '1', latencyMs: 120_000, predicted: true });
  });

  it('sinaliza live que não estava na agenda (o backoff dormiu por cima)', () => {
    const events = detectionEvents({
      liveMatchIds: ['9'],
      knownUpcoming: new Map(),
      predictedMatchId: '1',
      now: NOW,
      seen: new Set(),
    });
    expect(events[0].latencyMs).toBeNull();
    expect(events[0].predicted).toBe(false);
  });

  it('não repete a mesma live nos polls seguintes', () => {
    const seen = new Set<string>();
    const input = {
      liveMatchIds: ['1'],
      knownUpcoming: new Map([['1', NOW]]),
      predictedMatchId: '1',
      now: NOW,
      seen,
    };
    expect(detectionEvents(input)).toHaveLength(1);
    expect(detectionEvents(input)).toHaveLength(0);
  });

  it('marca como prevista só a partida do topo', () => {
    const events = detectionEvents({
      liveMatchIds: ['1', '2'],
      knownUpcoming: new Map([
        ['1', NOW],
        ['2', NOW],
      ]),
      predictedMatchId: '1',
      now: NOW,
      seen: new Set(),
    });
    expect(events.find((e) => e.matchId === '1')?.predicted).toBe(true);
    expect(events.find((e) => e.matchId === '2')?.predicted).toBe(false);
  });
});
