import { describe, expect, it } from 'vitest';
import {
  buildRoundSummary,
  describeAce,
  detectAceInRound,
  isRoundMarker,
  normWeapon,
  prettyWeapon,
  RoundTracker,
} from '../src/detector/aceDetector.js';
import type { KillEvent } from '../src/types.js';

const k = (killer: string, victim = 'v') => ({
  killer,
  victim,
  round: 1,
  map: 'mirage',
});

describe('detectAceInRound', () => {
  it('detecta 5 kills do mesmo player', () => {
    const kills = ['donk', 'donk', 'donk', 'donk', 'donk'].map((p) => k(p));
    expect(detectAceInRound(kills)).toBe('donk');
  });

  it('ignora case', () => {
    const kills = ['ZyWoo', 'zywoo', 'ZYWOO', 'ZywOo', 'zywoo'].map((p) => k(p));
    expect(detectAceInRound(kills)).toBe('ZyWoo');
  });

  it('rejeita 4k', () => {
    expect(detectAceInRound(['a', 'a', 'a', 'a'].map((p) => k(p)))).toBeNull();
  });

  it('rejeita 5 kills divididos', () => {
    const kills = ['a', 'a', 'a', 'a', 'b'].map((p) => k(p));
    expect(detectAceInRound(kills)).toBeNull();
  });

  it('ignora markers T/CT legados', () => {
    expect(isRoundMarker('T')).toBe(true);
    expect(isRoundMarker('CT')).toBe(true);
    expect(isRoundMarker('donk')).toBe(false);
  });
});

describe('RoundTracker', () => {
  it('acumula e fecha round com ace', () => {
    const t = new RoundTracker('anubis', 5);
    for (let i = 0; i < 5; i++) t.addKill('m0NESY', `victim${i}`);
    expect(t.pending).toBe(5);
    const { ace, kills } = t.closeRound();
    expect(ace).toBe('m0NESY');
    expect(kills).toHaveLength(5);
    expect(t.pending).toBe(0);
  });

  it('pula markers sem contar', () => {
    const t = new RoundTracker();
    t.addKill('T', '');
    t.addKill('s1mple', 'a');
    expect(t.pending).toBe(1);
  });

  it('guarda detalhe rico (arma, HS, assist)', () => {    const t = new RoundTracker('anubis', 9);
    t.addKill('donk', 'kyousuke', { weapon: 'AK-47', headshot: true });
    t.addKill('donk', 'NiKo', { weapon: 'ak47', assistBy: 'chopper' });
    const { kills } = t.closeRound();
    expect(kills[0].weapon).toBe('ak47');
    expect(kills[0].headshot).toBe(true);
    expect(kills[1].assistBy).toBe('chopper');
  });

  it('carimba wall-clock em cada kill (ancora do clipe)', () => {
    const before = Date.now();
    const t = new RoundTracker();
    t.addKill('donk', 'a');
    t.addKill('donk', 'b');
    const { kills } = t.closeRound();
    expect(kills[0].at).toBeGreaterThanOrEqual(before);
    expect(kills[1].at).toBeGreaterThanOrEqual(kills[0].at!);
  });
});

describe('armas', () => {
  it('normWeapon canoniza', () => {
    expect(normWeapon('AK-47')).toBe('ak47');
    expect(normWeapon('Desert Eagle')).toBe('deserteagle');
    expect(normWeapon(undefined)).toBe('');
  });

  it('prettyWeapon traduz', () => {
    expect(prettyWeapon('ak47')).toBe('AK-47');
    expect(prettyWeapon('awp')).toBe('AWP');
    expect(prettyWeapon('hegrenade')).toBe('HE Grenade');
  });
});

describe('buildRoundSummary + describeAce', () => {
  const rich: KillEvent[] = [
    { killer: 'm0NESY', victim: 'a', round: 7, map: 'mirage', weapon: 'awp', headshot: true },
    { killer: 'm0NESY', victim: 'b', round: 7, map: 'mirage', weapon: 'awp', headshot: true },
    { killer: 'm0NESY', victim: 'c', round: 7, map: 'mirage', weapon: 'awp', flashAssistBy: 'NiKo' },
    { killer: 'm0NESY', victim: 'd', round: 7, map: 'mirage', weapon: 'deagle', assistBy: 'chopper' },
    { killer: 'm0NESY', victim: 'e', round: 7, map: 'mirage', weapon: 'molotov' },
  ];

  it('resume armas, HS, assists, flashes e granadas', () => {
    const s = buildRoundSummary('m0NESY', 'Falcons', 'Spirit', rich);
    expect(s.mainWeapon).toBe('awp');
    expect(s.headshots).toBe(2);
    expect(s.victims).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.assists).toEqual([{ by: 'chopper', killIndex: 4 }]);
    expect(s.flashAssists).toEqual([{ by: 'NiKo', killIndex: 3 }]);
    expect(s.grenades).toEqual([{ player: 'm0NESY', kind: 'molotov' }]);
  });

  it('describeAce narra tudo em PT-BR', () => {
    const s = buildRoundSummary('m0NESY', 'Falcons', 'Spirit', rich);
    const txt = describeAce(s, 'ESL Pro League Season 24');
    expect(txt).toContain('ACE! m0NESY (Falcons) fez 5K contra Spirit');
    expect(txt).toContain('de AWP');
    expect(txt).toContain('(HS)');
    expect(txt).toContain('[assist: chopper]');
    expect(txt).toContain('[flash: NiKo]');
    expect(txt).toContain('Arma principal: AWP (3/5 kills)');
    expect(txt).toContain('Flashes decisivas de: NiKo');
    expect(txt).toContain('MOLOTOV');
  });

  it('describeAce funciona sem time (modo live)', () => {
    const s = buildRoundSummary('donk', '', 'Spirit vs Falcons', rich.slice(0, 5));
    expect(describeAce(s, 'EPL').split('\n')[0]).toContain(
      'ACE! donk fez 5K em Spirit vs Falcons',
    );
  });
});
