import { describe, expect, it } from 'vitest';
import { psLiteral } from '../src/notify.js';

describe('psLiteral (texto p/ string de PowerShell entre aspas simples)', () => {
  it('dobra as aspas simples (escape do PowerShell)', () => {
    expect(psLiteral("it's", 60)).toBe("it''s");
  });

  it('corta ANTES de escapar (nunca deixa aspa desbalanceada)', () => {
    // Escapar antes de cortar deixaria "a'" (uma aspa só) — a string do
    // PowerShell fecharia ali e o resto viraria código.
    const out = psLiteral("a'bcdefgh", 2);
    expect(out).toBe("a''");
    expect((out.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it('achata quebras de linha e remove control chars', () => {
    expect(psLiteral('linha1\nlinha2', 60)).toBe('linha1 linha2');
    expect(psLiteral('a\u0000b\u001fc', 60)).toBe('a b c');
  });

  it('corta no limite (o texto vem do DOM/Playwright)', () => {
    expect(psLiteral('abcdefghij', 4)).toBe('abcd');
    expect(psLiteral('abcdefghij', 0)).toBe('');
  });
});
