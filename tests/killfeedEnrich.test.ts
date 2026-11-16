import { describe, expect, it } from 'vitest';
import {
  enrichKillsWithFeed,
  normalizePlayerName,
  pairKillsWithFeed,
  selectFeedKills,
} from '../src/detector/killfeedEnrich.js';
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

describe('pareamento com o killfeed', () => {
  it('compara nomes sem acento, caixa e espaço', () => {
    expect(normalizePlayerName('HeavyGod')).toBe('heavygod');
    expect(normalizePlayerName(' huNter- ')).toBe('hun ter-'.replace(' ', ''));
    expect(normalizePlayerName('M0NESY')).toBe('m0nesy');
  });

  it('casa 5×5 com as mesmas vítimas na ordem', () => {
    const side = ['r1nkle', 'NertZ', 'huNter-', 'HeavyGod', 'MATYS'].map((victim) => ({ victim }));
    const feedKills = side.map((k, i) => feed({ victim: k.victim, eventId: String(i) }));
    const pairs = pairKillsWithFeed(side, feedKills);
    expect(pairs).toHaveLength(5);
    expect(pairs.every((p) => p.sideIndex === p.feedIndex)).toBe(true);
  });

  it('casa pela vítima mesmo com UMA vítima errada no sidecar (caso real)', () => {
    // O placar pareou a 4ª kill com TeSeS (o HeavyGod tinha matado o
    // TeSeS um instante antes). As outras quatro victims são âncoras.
    const side = ['r1nkle', 'NertZ', 'huNter-', 'TeSeS', 'MATYS'].map((victim) => ({ victim }));
    const feedKills = [
      feed({ victim: 'r1nkle', eventId: '1' }),
      feed({ victim: 'NertZ', eventId: '2' }),
      feed({ victim: 'huNter-', eventId: '3' }),
      feed({ victim: 'HeavyGod', eventId: '4' }),
      feed({ victim: 'MATYS', eventId: '5' }),
    ];
    const pairs = pairKillsWithFeed(side, feedKills);
    expect(pairs).toEqual([
      { sideIndex: 0, feedIndex: 0 },
      { sideIndex: 1, feedIndex: 1 },
      { sideIndex: 2, feedIndex: 2 },
      { sideIndex: 3, feedIndex: 3 },
      { sideIndex: 4, feedIndex: 4 },
    ]);
  });

  it('não casa o que sobrou (nada é inventado)', () => {
    // O vão do sidecar (b, c) e o do feed (z) têm tamanhos diferentes:
    // casar "pela ordem" seria chute (o título sairia com a vítima
    // errada). Só a âncora 'a' casa.
    const side = ['a', 'b', 'c'].map((victim) => ({ victim }));
    const feedKills = [feed({ victim: 'a' }), feed({ victim: 'z' })];
    const pairs = pairKillsWithFeed(side, feedKills);
    expect(pairs).toEqual([{ sideIndex: 0, feedIndex: 0 }]);
  });

  it('vãos do MESMO tamanho casam pela ordem (a vítima errada é corrigida)', () => {
    const side = ['a', 'b'].map((victim) => ({ victim }));
    const feedKills = [feed({ victim: 'a' }), feed({ victim: 'z' })];
    const pairs = pairKillsWithFeed(side, feedKills);
    expect(pairs).toEqual([
      { sideIndex: 0, feedIndex: 0 },
      { sideIndex: 1, feedIndex: 1 },
    ]);
  });
});

describe('enriquecimento das kills', () => {
  it('corrige a vítima e completa arma/headshot/assistência', () => {
    const side = [
      { killer: 'kyousuke', victim: 'r1nkle', weapon: null, headshot: null },
      { killer: 'kyousuke', victim: 'NertZ', weapon: null, headshot: null },
      { killer: 'kyousuke', victim: 'huNter-', weapon: null, headshot: null },
      { killer: 'kyousuke', victim: 'TeSeS', weapon: null, headshot: null },
      { killer: 'kyousuke', victim: 'MATYS', weapon: null, headshot: null },
    ];
    const feedKills = [
      feed({ victim: 'r1nkle', eventId: '1' }),
      feed({ victim: 'NertZ', eventId: '2' }),
      feed({ victim: 'huNter-', eventId: '3', assistBy: 'm0NESY' }),
      feed({ victim: 'HeavyGod', eventId: '4' }),
      feed({ victim: 'MATYS', eventId: '5', assistBy: 'm0NESY' }),
    ];
    const result = enrichKillsWithFeed(side, feedKills);
    expect(result.kills.map((k) => k.victim)).toEqual([
      'r1nkle',
      'NertZ',
      'huNter-',
      'HeavyGod',
      'MATYS',
    ]);
    expect(result.kills.every((k) => k.weapon === 'glock')).toBe(true);
    expect(result.kills.every((k) => k.headshot === true)).toBe(true);
    expect(result.kills[2].assistBy).toBe('m0NESY');
    expect(result.kills[4].assistBy).toBe('m0NESY');
    expect(result.paired).toBe(5);
    expect(result.eventIds).toEqual(['1', '2', '3', '4', '5']);
    expect(result.changes.some((c) => c.field === 'victim' && c.to === 'HeavyGod')).toBe(true);
  });

  it('campo ausente no killfeed NÃO vira false (fica como está)', () => {
    const side = [{ killer: 'kyousuke', victim: 'HeavyGod', headshot: null, weapon: null }];
    const feedKills = [feed({ weapon: undefined, headshot: undefined })];
    const result = enrichKillsWithFeed(side, feedKills);
    expect(result.kills[0].headshot).toBeNull();
    expect(result.kills[0].weapon).toBeNull();
  });

  it('o headshot FALSO do killfeed é aplicado (ausência é diferente de false)', () => {
    const side = [{ killer: 'kyousuke', victim: 'HeavyGod', headshot: null }];
    const feedKills = [feed({ headshot: false })];
    const result = enrichKillsWithFeed(side, feedKills);
    expect(result.kills[0].headshot).toBe(false);
  });

  it('a arma do feed é NORMALIZADA (m4a1_silencer = m4a1silencer)', () => {
    const side = [{ killer: 'kyousuke', victim: 'HeavyGod', weapon: null, headshot: null }];
    const feedKills = [feed({ weapon: 'm4a1_silencer' })];
    const result = enrichKillsWithFeed(side, feedKills);
    expect(result.kills[0].weapon).toBe('m4a1silencer');
  });

  it('arma já canônica NÃO vira "mudança" (o enrich é idempotente)', () => {
    const side = [
      { killer: 'kyousuke', victim: 'HeavyGod', weapon: 'm4a1silencer', headshot: true },
    ];
    const feedKills = [feed({ weapon: 'm4a1_silencer', headshot: true })];
    const result = enrichKillsWithFeed(side, feedKills);
    expect(result.changes).toHaveLength(0);
  });

  it('arma DIFERENTE ainda vira mudança (o enrich não engolou o dado real)', () => {
    const side = [
      { killer: 'kyousuke', victim: 'HeavyGod', weapon: 'ak47', headshot: true },
    ];
    const feedKills = [feed({ weapon: 'awp', headshot: true })];
    const result = enrichKillsWithFeed(side, feedKills);
    expect(result.changes.some((c) => c.field === 'weapon' && c.to === 'awp')).toBe(true);
  });
});

describe('seleção das kills do feed', () => {
  const kills = [
    feed({ eventId: 'a', map: 'anubis', round: 13, killer: 'kyousuke' }),
    feed({ eventId: 'b', map: 'anubis', round: 14, killer: 'kyousuke' }),
    feed({ eventId: 'c', map: 'mirage', round: 13, killer: 'kyousuke' }),
    feed({ eventId: 'd', map: 'anubis', round: 13, killer: 'other' }),
  ];

  it('filtra por mapa, round e jogador', () => {
    const selected = selectFeedKills({ kills, map: 'anubis', round: 13, player: 'kyousuke' });
    expect(selected.map((k) => k.eventId)).toEqual(['a']);
  });

  it('o mapa do sidecar ("Anubis") casa com o do feed ("anubis")', () => {
    const selected = selectFeedKills({ kills, map: 'Anubis', round: 13, player: 'kyousuke' });
    expect(selected.map((k) => k.eventId)).toEqual(['a']);
  });

  it('a kill sem round (backlog) NÃO entra no backfill de um round', () => {
    const selected = selectFeedKills({
      kills: [feed({ eventId: 'x', round: 0 })],
      map: 'anubis',
      round: 13,
      player: 'kyousuke',
    });
    expect(selected).toHaveLength(0);
  });

  it('a kill sem mapa NÃO entra (o mapa é o filtro do round)', () => {
    const selected = selectFeedKills({
      kills: [feed({ eventId: 'x', map: '' })],
      map: 'anubis',
      round: 13,
      player: 'kyousuke',
    });
    expect(selected).toHaveLength(0);
  });
});
