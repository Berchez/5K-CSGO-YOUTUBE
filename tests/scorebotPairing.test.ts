import { describe, expect, it } from 'vitest';
import { RoundTracker } from '../src/detector/aceDetector.js';
import type { ScorebotKill } from '../src/detector/scorebotLog.js';

/** Kill do killfeed do scorebot. */
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

/** Kills do round, na ordem em que o placar as sintetizou. */
function roundKills(tracker: RoundTracker): ReturnType<RoundTracker['closeRound']>['kills'] {
  return tracker.closeRound(1).kills;
}

describe('RoundTracker + killfeed do scorebot', () => {
  it('completa a kill do placar com arma, headshot e assistência', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.noteFeedKill(feed({ assistBy: 'm0NESY' }));
    tracker.addKill('kyousuke', 'HeavyGod', { atSource: 'placar' });
    const [kill] = roundKills(tracker);
    expect(kill).toMatchObject({
      killer: 'kyousuke',
      victim: 'HeavyGod',
      weapon: 'glock',
      headshot: true,
      assistBy: 'm0NESY',
      atSource: 'placar',
    });
  });

  it('corrige a vítima trocada pelo placar (pareamento por ordem)', () => {
    const tracker = new RoundTracker('Anubis', 13);
    // Placar casou a coluna D por ordem e gravou TeSeS; o killfeed diz
    // HeavyGod (quem o kyousuke realmente matou).
    tracker.noteFeedKill(feed({ victim: 'r1nkle', eventId: '1' }));
    tracker.noteFeedKill(feed({ victim: 'NertZ', eventId: '2' }));
    tracker.noteFeedKill(feed({ victim: 'huNter-', eventId: '3' }));
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', eventId: '4' }));
    for (const victim of ['r1nkle', 'NertZ', 'huNter-', 'TeSeS']) {
      tracker.addKill('kyousuke', victim);
    }
    const kills = roundKills(tracker);
    expect(kills.map((k) => k.victim)).toEqual(['r1nkle', 'NertZ', 'huNter-', 'HeavyGod']);
  });

  it('prefere a vítima exata antes de consumir a fila por ordem', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.noteFeedKill(feed({ victim: 'r1nkle', eventId: '1' }));
    tracker.noteFeedKill(feed({ victim: 'MATYS', eventId: '2' }));
    tracker.addKill('kyousuke', 'MATYS');
    const [kill] = roundKills(tracker);
    expect(kill.victim).toBe('MATYS');
    expect(kill.headshot).toBe(true);
  });

  it('enriquece quando o killfeed chega DEPOIS da kill do placar', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.addKill('kyousuke', 'HeavyGod', { atSource: 'placar' });
    tracker.noteFeedKill(feed({ victim: 'HeavyGod' }));
    const [kill] = roundKills(tracker);
    expect(kill).toMatchObject({ weapon: 'glock', headshot: true, victim: 'HeavyGod' });
  });

  it('não pareia backlog do replay quando o tracking entrou no meio do round', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.markJoinedBlind();
    tracker.noteFeedKill(feed({ replay: true, eventId: '1' }));
    tracker.addKill('kyousuke', 'HeavyGod');
    const [kill] = roundKills(tracker);
    expect(kill.victim).toBe('HeavyGod');
    expect(kill.weapon).toBeUndefined();
  });

  it('ignora killfeed de outro mapa', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.noteFeedKill(feed({ map: 'mirage' }));
    tracker.addKill('kyousuke', 'HeavyGod');
    const [kill] = roundKills(tracker);
    expect(kill.weapon).toBeUndefined();
  });

  it('aceita o killfeed quando o placar ainda está no mapa placeholder', () => {
    const tracker = new RoundTracker('map1', 13);
    tracker.noteFeedKill(feed());
    tracker.addKill('kyousuke', 'HeavyGod');
    const [kill] = roundKills(tracker);
    expect(kill.weapon).toBe('glock');
  });

  it('descarta o killfeed do round anterior na virada', () => {
    const tracker = new RoundTracker('Anubis', 13);
    tracker.noteFeedKill(feed({ round: 13, eventId: '1' }));
    tracker.setContext('Anubis', 14);
    tracker.addKill('kyousuke', 'HeavyGod');
    const [kill] = roundKills(tracker);
    expect(kill.weapon).toBeUndefined();
  });

  it('mantém a contagem do round (enriquecer não duplica)', () => {
    const tracker = new RoundTracker('Anubis', 13);
    for (let i = 0; i < 5; i++) {
      tracker.noteFeedKill(feed({ victim: `v${i}`, eventId: String(i) }));
      tracker.addKill('kyousuke', `v${i}`);
    }
    const kills = roundKills(tracker);
    expect(kills).toHaveLength(5);
    expect(kills.every((k) => k.weapon === 'glock')).toBe(true);
  });

  it('pareia o killfeed sem round (round 0 = desconhecido) com o round atual', () => {
    const tracker = new RoundTracker('Anubis', 13);
    // Kill live sem `RoundStart`: o round do feed é 0 (desconhecido).
    tracker.noteFeedKill(feed({ round: 0, victim: 'HeavyGod' }));
    tracker.addKill('kyousuke', 'HeavyGod');
    const [kill] = roundKills(tracker);
    expect(kill.weapon).toBe('glock');
  });

  it('não pareia killfeed de OUTRO round (passado ou futuro)', () => {
    const tracker = new RoundTracker('Anubis', 13);
    // Round passado: sem par (o placar já contou).
    tracker.noteFeedKill(feed({ round: 12, victim: 'HeavyGod', eventId: '1' }));
    tracker.addKill('kyousuke', 'HeavyGod');
    let [kill] = roundKills(tracker);
    expect(kill.weapon).toBeUndefined();

    // Round futuro: fica na fila, não rouba a kill do round atual.
    const tracker2 = new RoundTracker('Anubis', 13);
    tracker2.noteFeedKill(feed({ round: 14, victim: 'HeavyGod', eventId: '2' }));
    tracker2.addKill('kyousuke', 'HeavyGod');
    [kill] = roundKills(tracker2);
    expect(kill.weapon).toBeUndefined();
  });

  it('corrige a vítima quando o killfeed chega depois (round aberto)', () => {
    const tracker = new RoundTracker('Anubis', 13);
    // O placar criou a kill com a vítima ERRADA (coluna D por ordem).
    tracker.addKill('kyousuke', 'TeSeS', { atSource: 'placar' });
    // O killfeed chega depois e diz a vítima certa.
    tracker.noteFeedKill(feed({ victim: 'HeavyGod', eventId: '9' }));
    const [kill] = roundKills(tracker);
    expect(kill.victim).toBe('HeavyGod');
    expect(kill.weapon).toBe('glock');
  });

  it('a telemetria conta o round inteiro (paired e total no mesmo universo)', () => {
    const tracker = new RoundTracker('Anubis', 13);
    // Kill de OUTRO jogador (o placar conta todas as kills do round).
    tracker.noteFeedKill(feed({ killer: 'r1nkle', victim: 'v1', eventId: '1' }));
    tracker.addKill('r1nkle', 'v1');
    tracker.noteFeedKill(feed({ killer: 'kyousuke', victim: 'HeavyGod', eventId: '2' }));
    tracker.addKill('kyousuke', 'HeavyGod');
    const { killfeed } = tracker.closeRound(1);
    expect(killfeed.paired).toBe(2);
    expect(killfeed.total).toBe(2);
    expect(killfeed.feedKills).toBe(2);
  });
});
