import { describe, expect, it } from 'vitest';
import {
  buildRoundSummary,
  describeAce,
  detectAceInRound,
  detectMultiKill,
  isRoundMarker,
  killLabel,
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

describe('detectMultiKill', () => {
  it('detecta 3k/4k/5k (mínimo configurável)', () => {
    const three = ['a', 'a', 'a'].map((p) => k(p));
    expect(detectMultiKill(three, 3)?.player).toBe('a');
    expect(detectMultiKill(three, 3)?.kills).toHaveLength(3);
    expect(detectMultiKill(three, 4)).toBeNull();
    const four = [...three, k('a')];
    expect(detectMultiKill(four)?.player).toBe('a');
    expect(detectMultiKill(four)?.kills).toHaveLength(4);
  });

  it('pega o maior multikill do round (5k vence 3k)', () => {
    const kills = ['a', 'a', 'a', 'b', 'b', 'b', 'b', 'b'].map((p) => k(p));
    const m = detectMultiKill(kills);
    expect(m?.player).toBe('b');
    expect(m?.kills).toHaveLength(5);
  });

  it('desempate: quem chegou primeiro ao mínimo', () => {
    const kills = ['a', 'b', 'a', 'b', 'a', 'b'].map((p) => k(p));
    expect(detectMultiKill(kills)?.player).toBe('a');
  });

  it('ignora markers e retorna null abaixo do mínimo', () => {
    expect(detectMultiKill([k('T'), k('a'), k('a')])).toBeNull();
    expect(detectMultiKill([])).toBeNull();
  });
});

describe('killLabel', () => {
  it('ACE p/ 5+, 4K/3K abaixo disso', () => {
    expect(killLabel(5)).toBe('ACE');
    expect(killLabel(9)).toBe('ACE');
    expect(killLabel(4)).toBe('4K');
    expect(killLabel(3)).toBe('3K');
  });
});

describe('RoundTracker', () => {
  it('acumula e fecha round com ace', () => {
    const t = new RoundTracker('anubis', 5);
    for (let i = 0; i < 5; i++) t.addKill('m0NESY', `victim${i}`);
    expect(t.pending).toBe(5);
    const { player, kills } = t.closeRound();
    expect(player).toBe('m0NESY');
    expect(kills).toHaveLength(5);
    expect(t.pending).toBe(0);
  });

  it('fecha round com 3k (mínimo default) e só os kills do autor', () => {
    const t = new RoundTracker('mirage', 3);
    t.addKill('x', 'a');
    t.addKill('y', 'b');
    t.addKill('x', 'c');
    t.addKill('x', 'd');
    const { player, kills } = t.closeRound();
    expect(player).toBe('x');
    expect(kills.map((kk) => kk.victim)).toEqual(['a', 'c', 'd']);
  });

  it('dedup: polling repetido não infla a contagem', () => {
    const t = new RoundTracker();
    for (let i = 0; i < 4; i++) {
      t.addKill('donk', 'a');
      t.addKill('donk', 'b');
      t.addKill('donk', 'c');
    }
    expect(t.pending).toBe(3);
    const { player, kills } = t.closeRound();
    expect(player).toBe('donk');
    expect(kills).toHaveLength(3);
  });

  it('sem multikill: player null e kills vazio', () => {
    const t = new RoundTracker();
    t.addKill('a', 'x');
    t.addKill('b', 'y');
    const { player, kills } = t.closeRound();
    expect(player).toBeNull();
    expect(kills).toHaveLength(0);
  });

  it('syncBaseline: diferenciais do placar viram kills sintetizados', () => {
    const t = new RoundTracker('inferno', 7);
    // ancora sem spike (placar acumulado do mapa até aqui)
    t.syncBaseline([
      { name: 'rain', kills: 10 },
      { name: 'device', kills: 8 },
    ]);
    expect(t.pending).toBe(0);
    // mesmo placar de novo: nada duplica
    t.syncBaseline([
      { name: 'rain', kills: 10 },
      { name: 'device', kills: 8 },
    ]);
    expect(t.pending).toBe(0);
    // +3 kills do rain: 3k sintetizado (vítima desconhecida)
    t.syncBaseline([
      { name: 'rain', kills: 13 },
      { name: 'device', kills: 8 },
    ]);
    expect(t.pending).toBe(3);
    const { player, kills } = t.closeRound();
    expect(player).toBe('rain');
    expect(kills).toHaveLength(3);
    expect(kills.every((kk) => kk.victim === '')).toBe(true);
    expect(kills[0].at).toBeLessThanOrEqual(kills[2].at!);
  });

  it('syncBaseline: nome novo ancora sem spike falso', () => {
    const t = new RoundTracker();
    t.syncBaseline([{ name: 'novato', kills: 7 }]);
    expect(t.pending).toBe(0);
    t.syncBaseline([{ name: 'novato', kills: 8 }]);
    expect(t.pending).toBe(1);
  });

  it('syncBaseline: coluna D (deaths) alimenta as vítimas dos kills', () => {
    const t = new RoundTracker('inferno', 7);
    t.syncBaseline([
      { name: 'rain', kills: 10, deaths: 2 },
      { name: 'vA', kills: 3, deaths: 5 },
      { name: 'vB', kills: 1, deaths: 7 },
      { name: 'vC', kills: 0, deaths: 9 },
    ]);
    expect(t.pending).toBe(0);
    // rain +3 kills no mesmo poll em que vA/vB/vC somam +1 death cada
    t.syncBaseline([
      { name: 'rain', kills: 13, deaths: 2 },
      { name: 'vA', kills: 3, deaths: 6 },
      { name: 'vB', kills: 1, deaths: 8 },
      { name: 'vC', kills: 0, deaths: 10 },
    ]);
    const { player, kills } = t.closeRound();
    expect(player).toBe('rain');
    expect(kills.map((k) => k.victim)).toEqual(['vA', 'vB', 'vC']);
  });

  it('syncBaseline: morte extra (bomba) não rouba vítima; kill sem morte fica "?"', () => {
    const t = new RoundTracker();
    t.syncBaseline([{ name: 'x', kills: 0, deaths: 0 }, { name: 'a', kills: 0, deaths: 0 }]);
    // x +2 kills; só 1 death nova (a) — 2ª vítima desconhecida
    t.syncBaseline([{ name: 'x', kills: 2, deaths: 0 }, { name: 'a', kills: 0, deaths: 1 }]);
    const { kills } = t.closeRound(2);
    expect(kills[0].victim).toBe('a');
    expect(kills[1].victim).toBe('');
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
    t.addKill('donk', 'm0NESY', { weapon: 'usp-s' });
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
    t.addKill('donk', 'c');
    const { kills } = t.closeRound();
    expect(kills[0].at).toBeGreaterThanOrEqual(before);
    expect(kills[1].at).toBeGreaterThanOrEqual(kills[0].at!);
    expect(kills[2].at).toBeGreaterThanOrEqual(kills[1].at!);
  });
});

describe('armas', () => {  it('normWeapon canoniza', () => {
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

  it('describeAce adapta selo e contagem p/ 4k', () => {
    const four = rich.slice(0, 4);
    const s = buildRoundSummary('flameZ', 'Vitality', 'MOUZ', four);
    const txt = describeAce(s, 'ESL Pro League Season 24');
    expect(txt.split('\n')[0]).toContain('4K! flameZ (Vitality) fez 4K contra MOUZ');
    expect(txt).toContain('Arma principal: AWP (3/4 kills)');
    expect(txt).not.toContain('5K');
  });
});
