import { describe, expect, it } from 'vitest';
import { QUOTA_UNITS_PER_UPLOAD, quotaDecision } from '../src/uploader/quota.js';

describe('quotaDecision (cota do YouTube)', () => {
  it('libera o upload enquanto cabe na cota', () => {
    const decision = quotaDecision({ used: 0, limit: 10_000 });
    expect(decision.allowed).toBe(true);
    expect(decision.units).toBe(QUOTA_UNITS_PER_UPLOAD);
  });

  it('libera o ÚLTIMO upload que cabe (o limite é inclusivo)', () => {
    const decision = quotaDecision({
      used: 10_000 - QUOTA_UNITS_PER_UPLOAD,
      limit: 10_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.units).toBe(10_000);
  });

  it('bloqueia quando o upload passa do limite', () => {
    const decision = quotaDecision({ used: 10_000, limit: 10_000 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cota/i);
  });

  it('respeita o teto configurável (cota ampliada do projeto)', () => {
    const decision = quotaDecision({ used: 14_400, limit: 100_000 });
    expect(decision.allowed).toBe(true);
  });

  it('nunca devolve consumo negativo', () => {
    const decision = quotaDecision({ used: -5, limit: 10_000 });
    expect(decision.used).toBe(0);
    expect(decision.allowed).toBe(true);
  });

  it('o custo por upload é o do videos.insert (1600 units)', () => {
    expect(QUOTA_UNITS_PER_UPLOAD).toBe(1600);
  });
});
