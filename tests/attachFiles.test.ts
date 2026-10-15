import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { dedupeFiles, matchesAny, FAIL_PATTERNS } from '../src/clipper/attachFiles.js';

describe('dedupeFiles', () => {
  it('remove duplicados por caminho absoluto', () => {
    const a = path.join('refs', 'a.png');
    const { unique, dupes } = dedupeFiles([a, path.join('refs', 'b.png'), a]);
    expect(unique).toHaveLength(2);
    expect(dupes).toEqual([a]);
  });

  it('lista sem dupes passa intacta', () => {
    const { unique, dupes } = dedupeFiles(['x.png']);
    expect(unique).toEqual([path.resolve('x.png')]);
    expect(dupes).toEqual([]);
  });
});

describe('matchesAny (falha de upload)', () => {
  it('casa PT e EN', () => {
    expect(matchesAny('Falha no upload', FAIL_PATTERNS)).toBeTruthy();
    expect(matchesAny('Upload failed, retry', FAIL_PATTERNS)).toBeTruthy();
    expect(matchesAny('tudo certo, 3 anexos', FAIL_PATTERNS)).toBeNull();
  });
});
