import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoundTracker } from '../src/detector/aceDetector.js';
import type { ScorebotKill } from '../src/detector/scorebotLog.js';

const feed = (over: Partial<ScorebotKill> = {}): ScorebotKill => ({
  eventId: null,
  killer: 'kyousuke',
  victim: 'HeavyGod',
  weapon: 'glock',
  headshot: true,
  map: 'anubis',
  round: 13,
  replay: false,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('telemetria do killfeed', () => {
  it('a contagem do round sai com o closeRound', () => {
    const tracker = new RoundTracker('Anubis', 13);
    for (const victim of ['r1nkle', 'NertZ', 'huNter-', 'HeavyGod', 'MATYS']) {
      tracker.noteFeedKill(feed({ victim, eventId: victim }));
      tracker.addKill('kyousuke', victim);
    }
    const closed = tracker.closeRound(3);
    expect(closed.killfeed.total).toBe(5);
    expect(closed.killfeed.paired).toBe(5);
    expect(closed.killfeed.feedKills).toBe(5);
    expect(closed.killfeed.eventIds).toContain('HeavyGod');
  });

  it('a telemetria mostra quanto do round NÃO foi completado', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.addKill('kyousuke', 'HeavyGod');
    tracker.addKill('kyousuke', 'MATYS');
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', eventId: '1' }));
    const closed = tracker.closeRound(1);
    expect(closed.killfeed.total).toBe(2);
    expect(closed.killfeed.paired).toBe(1);
    expect(closed.killfeed.feedKills).toBe(1);
  });

  it('um round novo começa com a contagem zerada', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.addKill('kyousuke', 'HeavyGod');
    tracker.closeRound(1);
    tracker.setContext('Anubis', 14);
    tracker.addKill('kyousuke', 'TeSeS');
    const closed = tracker.closeRound(1);
    expect(closed.killfeed.total).toBe(1);
    expect(closed.killfeed.paired).toBe(0);
  });
});

describe('drift de round entre o killfeed e o placar', () => {
  it('kill do round PASSADO (feed atrás do placar) é contada como drift', () => {
    // O round do feed é contado por `RoundStart` e o do placar é
    // `ct+t+1`: quando divergem, a kill é descartada — sem o contador,
    // o detalhe que faltou parecia um bug do killfeed.
    const tracker = new RoundTracker('Anubis', 13);
    tracker.addKill('kyousuke', 'HeavyGod');
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', round: 12 }));
    const closed = tracker.closeRound(1);
    expect(closed.killfeed.roundDrift).toBe(1);
    expect(closed.killfeed.paired).toBe(0);
    expect(tracker.lastDrift()).toEqual({
      feedRound: 12,
      placarRound: 13,
      killer: 'kyousuke',
    });
  });

  it('kill do round FUTURO (feed à frente do placar) fica na fila e conta o drift', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', round: 14 }));
    const closed = tracker.closeRound(1);
    expect(closed.killfeed.roundDrift).toBe(1);
    expect(tracker.lastDrift()?.feedRound).toBe(14);
  });

  it('kill do MESMO round não conta drift', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.addKill('kyousuke', 'HeavyGod');
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', round: 13 }));
    const closed = tracker.closeRound(1);
    expect(closed.killfeed.roundDrift ?? 0).toBe(0);
    expect(closed.killfeed.paired).toBe(1);
  });
});

describe('enriquecimento tardio (round já fechado)', () => {
  it('a killfeed que chega depois do fechamento completa a kill', () => {
    const tracker = new RoundTracker('Anubis', 13, { lateEnrichMs: 60_000 });
    tracker.addKill('kyousuke', 'HeavyGod');
    const closed = tracker.closeRound(1);
    expect(closed.killfeed.paired).toBe(0);
    expect(closed.kills[0].weapon).toBeUndefined();

    tracker.noteFeedKill(feed({ eventId: '1' }));

    // O sidecar é escrito minutos depois: as MESMAS kills (e a mesma
    // telemetria) já carregam o detalhe.
    expect(closed.kills[0].weapon).toBe('glock');
    expect(closed.kills[0].headshot).toBe(true);
    expect(closed.killfeed.paired).toBe(1);
    expect(closed.killfeed.eventIds).toEqual(['1']);
  });

  it('corrige a vítima quando o placar errou (par exato)', () => {
    const tracker = new RoundTracker('Anubis', 13, { lateEnrichMs: 60_000 });
    tracker.addKill('kyousuke', 'TeSeS');
    const closed = tracker.closeRound(1);
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', eventId: '1' }));
    expect(closed.kills[0].victim).toBe('HeavyGod');
  });

  it('a carência expira: depois dela o killfeed tardio é ignorado', () => {
    vi.useFakeTimers();
    const tracker = new RoundTracker('Anubis', 13, { lateEnrichMs: 60_000 });
    tracker.addKill('kyousuke', 'HeavyGod');
    const closed = tracker.closeRound(1);
    vi.advanceTimersByTime(61_000);
    tracker.noteFeedKill(feed({ eventId: '1' }));
    expect(closed.kills[0].weapon).toBeUndefined();
    expect(closed.killfeed.paired).toBe(0);
  });

  it('o killfeed de outro round não entra no round fechado', () => {
    const tracker = new RoundTracker('Anubis', 13, { lateEnrichMs: 60_000 });
    tracker.addKill('kyousuke', 'HeavyGod');
    const closed = tracker.closeRound(1);
    tracker.noteFeedKill(feed({ round: 12, eventId: '1' }));
    expect(closed.kills[0].weapon).toBeUndefined();
  });

  it('o killfeed de outro mapa não entra no round fechado', () => {
    const tracker = new RoundTracker('Anubis', 13, { lateEnrichMs: 60_000 });
    tracker.addKill('kyousuke', 'HeavyGod');
    const closed = tracker.closeRound(1);
    tracker.noteFeedKill(feed({ map: 'mirage', eventId: '1' }));
    expect(closed.kills[0].weapon).toBeUndefined();
  });

  it('descartar o round pendente mata o enriquecimento tardio', () => {
    const tracker = new RoundTracker('Anubis', 13, { lateEnrichMs: 60_000 });
    tracker.addKill('kyousuke', 'HeavyGod');
    const closed = tracker.closeRound(1);
    tracker.discardPending();
    tracker.noteFeedKill(feed({ eventId: '1' }));
    expect(closed.kills[0].weapon).toBeUndefined();
  });
});
