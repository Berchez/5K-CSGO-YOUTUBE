import { describe, expect, it } from 'vitest';
import {
  FEMININE_MAP_NAMES,
  fixMapPrepositions,
  mapWithArticle,
} from '../src/clipper/copyRules.js';

describe('copyRules (texto de cara)', () => {
  it('corrige "no Dust2" para "na Dust2"', () => {
    expect(fixMapPrepositions('4K NO DUST2')).toBe('4K NA DUST2');
    expect(fixMapPrepositions('4K no Dust2')).toBe('4K na Dust2');
  });

  it('mantém a capitalização da frase', () => {
    expect(fixMapPrepositions('No Dust2 é fácil')).toBe('Na Dust2 é fácil');
  });

  it('é idempotente', () => {
    const once = fixMapPrepositions('4K no Dust2');
    expect(fixMapPrepositions(once)).toBe(once);
  });

  it('não mexe em "no mapa Dust2" (o artigo é do mapa)', () => {
    expect(fixMapPrepositions('4K no mapa Dust2')).toBe('4K no mapa Dust2');
  });

  it('não mexe nos outros mapas (a lista é explícita)', () => {
    expect(fixMapPrepositions('4K no Inferno')).toBe('4K no Inferno');
    expect(fixMapPrepositions('4K no Ancient')).toBe('4K no Ancient');
  });

  it('corrige "no Mirage" para "na Mirage"', () => {
    expect(fixMapPrepositions('4K no Mirage')).toBe('4K na Mirage');
    expect(fixMapPrepositions('4K NO MIRAGE')).toBe('4K NA MIRAGE');
  });

  it('aceita o nome alternativo "Dust II"', () => {
    expect(fixMapPrepositions('4K no Dust II')).toBe('4K na Dust II');
  });

  it('a lista de mapas femininos é Dust2 e Mirage', () => {
    expect([...FEMININE_MAP_NAMES]).toEqual(['dust2', 'dust ii', 'dust 2', 'mirage']);
  });

  it('aceita o nome com espaço ("Dust 2")', () => {
    expect(fixMapPrepositions('4K no Dust 2')).toBe('4K na Dust 2');
    expect(mapWithArticle('Dust 2')).toBe('na Dust 2');
  });

  it('corrige os outros artigos do mapa feminino', () => {
    // O Dust2 é feminino na copy: todo artigo masculino antes dele
    // vira o feminino.
    expect(fixMapPrepositions('dominou do Dust2')).toBe('dominou da Dust2');
    expect(fixMapPrepositions('dominou o Dust2')).toBe('dominou a Dust2');
    expect(fixMapPrepositions('passou pelo Dust2')).toBe('passou pela Dust2');
    expect(fixMapPrepositions('entrou num Dust2')).toBe('entrou numa Dust2');
    expect(fixMapPrepositions('chegou ao Dust2')).toBe('chegou à Dust2');
  });

  it('mantém a caixa do artigo nos outros artigos', () => {
    expect(fixMapPrepositions('DO DUST2')).toBe('DA DUST2');
    expect(fixMapPrepositions('Do Dust2')).toBe('Da Dust2');
    expect(fixMapPrepositions('PELO DUST2')).toBe('PELA DUST2');
    expect(fixMapPrepositions('Pelo Dust2')).toBe('Pela Dust2');
    expect(fixMapPrepositions('NUM DUST2')).toBe('NUMA DUST2');
    expect(fixMapPrepositions('Num Dust2')).toBe('Numa Dust2');
    expect(fixMapPrepositions('AO DUST2')).toBe('À DUST2');
    expect(fixMapPrepositions('Ao Dust2')).toBe('À Dust2');
  });

  it('não mexe no artigo de "mapa" com os outros artigos', () => {
    expect(fixMapPrepositions('no mapa Dust2')).toBe('no mapa Dust2');
    expect(fixMapPrepositions('do mapa Dust2')).toBe('do mapa Dust2');
    expect(fixMapPrepositions('pelo mapa Dust2')).toBe('pelo mapa Dust2');
    expect(fixMapPrepositions('num mapa Dust2')).toBe('num mapa Dust2');
    expect(fixMapPrepositions('ao mapa Dust2')).toBe('ao mapa Dust2');
  });

  it('não confunde palavra que contém o artigo', () => {
    expect(fixMapPrepositions('no硝 Dust2')).toBe('no硝 Dust2');
    expect(fixMapPrepositions('ouro Dust2')).toBe('ouro Dust2');
    expect(fixMapPrepositions('dominado Dust2')).toBe('dominado Dust2');
  });

  it('escolhe o artigo do mapa ("na Dust2", "na Mirage", "no Inferno")', () => {
    expect(mapWithArticle('Dust2')).toBe('na Dust2');
    expect(mapWithArticle('Dust II')).toBe('na Dust II');
    expect(mapWithArticle('Inferno')).toBe('no Inferno');
    expect(mapWithArticle('Mirage')).toBe('na Mirage');
  });

  it('não inventa artigo para mapa vazio', () => {
    expect(mapWithArticle('')).toBe('');
    expect(mapWithArticle('   ')).toBe('');
  });
});
