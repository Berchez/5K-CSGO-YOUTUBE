import { describe, expect, it } from 'vitest';
import { boolEnv, parseStreamOffsets, resolveStaticOffset } from '../src/config.js';

describe('boolEnv', () => {
  it('aceita 1/true/yes/on como ligado', () => {
    expect(boolEnv('1', false)).toBe(true);
    expect(boolEnv('true', false)).toBe(true);
    expect(boolEnv('TRUE', false)).toBe(true);
    expect(boolEnv(' yes ', false)).toBe(true);
    expect(boolEnv('on', false)).toBe(true);
  });

  it('aceita 0/false/no/off como desligado', () => {
    expect(boolEnv('0', true)).toBe(false);
    expect(boolEnv('false', true)).toBe(false);
    expect(boolEnv('OFF', true)).toBe(false);
  });

  it('vazio ou valor desconhecido usa o default', () => {
    expect(boolEnv(undefined, true)).toBe(true);
    expect(boolEnv('', true)).toBe(true);
    expect(boolEnv('   ', false)).toBe(false);
    expect(boolEnv('talvez', true)).toBe(true);
  });
});

describe('resolveStaticOffset (match > stream > global)', () => {
  it('0/desligado: ms sempre 0 (regra indica o escopo que decidiu)', () => {
    expect(resolveStaticOffset(0, '', '2399233')).toEqual({ ms: 0, rule: 'off' });
    expect(resolveStaticOffset(0, '2399233', '2399233')).toEqual({ ms: 0, rule: 'match' });
    expect(resolveStaticOffset(-5, '', '2399233')).toEqual({ ms: 0, rule: 'off' });
    expect(resolveStaticOffset(Number.NaN, '', '2399233')).toEqual({ ms: 0, rule: 'off' });
  });

  it('escopo vazio + offset = global (legado)', () => {
    expect(resolveStaticOffset(2000, '', '2399233')).toEqual({ ms: 2000, rule: 'global' });
    expect(resolveStaticOffset(2000, '   ', '2399535')).toEqual({ ms: 2000, rule: 'global' });
  });

  it('escopo por partida tem precedência', () => {
    expect(resolveStaticOffset(2000, '2399233', '2399233')).toEqual({ ms: 2000, rule: 'match' });
    expect(resolveStaticOffset(2000, '2399233', '2399535')).toEqual({ ms: 0, rule: 'off' });
    expect(resolveStaticOffset(2000, '2399204, 2399233', '2399204')).toEqual({ ms: 2000, rule: 'match' });
  });

  it('não confunde prefixo (239923 vs 2399233)', () => {
    expect(resolveStaticOffset(2000, '239923', '2399233')).toEqual({ ms: 0, rule: 'off' });
  });

  it('por stream: canal calibrado aplica, resto não', () => {
    const map = parseStreamOffsets('ESL TV=2000,Gaules=0');
    expect(resolveStaticOffset(0, '', '2399233', map, 'ESL TV')).toEqual({ ms: 2000, rule: 'stream' });
    expect(resolveStaticOffset(0, '', '2399535', map, 'dfragtv')).toEqual({ ms: 0, rule: 'off' });
    expect(resolveStaticOffset(0, '', 'x', map, 'Gaules')).toEqual({ ms: 0, rule: 'stream' });
  });

  it('match vence stream', () => {
    const map = parseStreamOffsets('ESL TV=2000');
    expect(resolveStaticOffset(1500, '2399233', '2399233', map, 'ESL TV')).toEqual({ ms: 1500, rule: 'match' });
    expect(resolveStaticOffset(1500, 'outra', '2399233', map, 'ESL TV')).toEqual({ ms: 0, rule: 'off' });
  });
});

describe('parseStreamOffsets', () => {
  it('parses pares e ignora inválidos', () => {
    const m = parseStreamOffsets('ESL TV=2000, Gaules=0,ruim,semvalor=,alto=99999,neg=-5');
    expect(m.get('ESL TV')).toBe(2000);
    expect(m.get('Gaules')).toBe(0);
    expect(m.has('ruim')).toBe(false);
    expect(m.has('semvalor')).toBe(false);
    expect(m.has('alto')).toBe(false);
    expect(m.has('neg')).toBe(false);
    expect(m.size).toBe(2);
  });

  it('vazio = mapa vazio', () => {
    expect(parseStreamOffsets('').size).toBe(0);
    expect(parseStreamOffsets('   ').size).toBe(0);
  });
});
