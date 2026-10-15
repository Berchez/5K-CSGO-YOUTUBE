import { describe, expect, it } from 'vitest';
import { isFreeSpaceOk } from '../src/diskSpace.js';

describe('isFreeSpaceOk (trava anti-disco-cheio)', () => {
  const GB3 = 3 * 1024 ** 3;

  it('acima/igual ao mínimo: ok', () => {
    expect(isFreeSpaceOk(GB3, GB3)).toBe(true);
    expect(isFreeSpaceOk(GB3 + 1, GB3)).toBe(true);
    expect(isFreeSpaceOk(26 * 1024 ** 3, GB3)).toBe(true);
  });

  it('abaixo do mínimo: bloqueia', () => {
    expect(isFreeSpaceOk(GB3 - 1, GB3)).toBe(false);
    expect(isFreeSpaceOk(0, GB3)).toBe(false);
  });

  it('indeterminável (null): fail-open (não trava tudo por sonda falha)', () => {
    expect(isFreeSpaceOk(null, GB3)).toBe(true);
  });
});
