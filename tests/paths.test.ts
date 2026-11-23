import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath, resolveWatchlistFilePath } from '../src/paths.js';

describe('resolveWatchlistFilePath', () => {
  it('resolve um caminho relativo a partir da raiz do repo', () => {
    expect(resolveWatchlistFilePath('./data/watchlist.json')).toBe(
      repoPath('data', 'watchlist.json'),
    );
  });

  it('preserva um caminho absoluto sem prefixar a raiz do repo', () => {
    const absolute = path.join(path.parse(process.cwd()).root, 'temp', 'watchlist.json');
    expect(resolveWatchlistFilePath(absolute)).toBe(path.normalize(absolute));
  });

  it('usa a watchlist padrão quando o valor está ausente ou vazio', () => {
    const expected = repoPath('data', 'watchlist.json');
    expect(resolveWatchlistFilePath()).toBe(expected);
    expect(resolveWatchlistFilePath('  ')).toBe(expected);
  });
});
