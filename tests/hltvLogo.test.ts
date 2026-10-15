import { describe, expect, it } from 'vitest';
import { pickLargestSrcset, parseTeamLinks } from '../src/clipper/hltvLogo.js';

describe('pickLargestSrcset', () => {
  it('pega a maior largura (w)', () => {
    expect(
      pickLargestSrcset(
        'https://img/a.png?ixlib&w=50&s=1 50w, https://img/a.png?ixlib&w=200&s=2 200w',
        'fallback',
      ),
    ).toContain('w=200');
  });

  it('descritor x vale mais que w pequeno', () => {
    expect(pickLargestSrcset('a.png 100w, b.png 2x', 'fallback')).toBe('b.png');
  });

  it('srcset vazio/inválido devolve o fallback', () => {
    expect(pickLargestSrcset('', 'fallback')).toBe('fallback');
    expect(pickLargestSrcset('sem-descritor', 'fallback')).toBe('fallback');
  });
});

describe('parseTeamLinks', () => {
  it('extrai id/slug únicos de /team/', () => {
    expect(
      parseTeamLinks('<a href="/team/11861/aurora">A</a><a href="/team/11861/aurora">dup</a>'),
    ).toEqual([{ id: '11861', slug: 'aurora' }]);
  });

  it('sem times retorna vazio', () => {
    expect(parseTeamLinks('<p>nada</p>')).toEqual([]);
  });
});
