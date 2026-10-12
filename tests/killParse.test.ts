import { describe, expect, it } from 'vitest';
import { parseKillList } from '../src/detector/killParse.js';

describe('parseKillList', () => {
  it('parseia killer>vítima:arma:mods', () => {
    const kills = parseKillList(
      'donk>kyousuke:ak47:hs, donk>NiKo:ak47:flash=chopper, donk>?:awp',
      9,
      'anubis',
    );
    expect(kills).toHaveLength(3);
    expect(kills[0]).toMatchObject({
      killer: 'donk',
      victim: 'kyousuke',
      weapon: 'ak47',
      headshot: true,
      round: 9,
      map: 'anubis',
    });
    expect(kills[1].flashAssistBy).toBe('chopper');
    expect(kills[2].victim).toBe('');
    expect(kills[2].weapon).toBe('awp');
  });

  it('suporta assist, noscope, wallbang e smoke', () => {
    const [k] = parseKillList('m0NESY>a:deagle:ns+wb+smoke+assist=NiKo', 1, 'mirage');
    expect(k).toMatchObject({
      noscope: true,
      wallbang: true,
      throughSmoke: true,
      assistBy: 'NiKo',
    });
  });

  it('rejeita formato inválido e mod desconhecido', () => {
    expect(() => parseKillList('sem-seta', 1, 'm')).toThrow(/falta '>'/);
    expect(() => parseKillList('a>b:ak47:voar', 1, 'm')).toThrow(/desconhecido/);
    expect(parseKillList('   ', 1, 'm')).toEqual([]);
  });
});
