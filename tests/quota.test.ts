import { describe, expect, it } from 'vitest';
import { UPLOAD_CALLS_PER_VIDEO, quotaDecision } from '../src/uploader/quota.js';

describe('quotaDecision (cota do YouTube)', () => {
  it('libera o upload enquanto cabe na cota', () => {
    const decision = quotaDecision({ used: 0, limit: 10_000 });
    expect(decision.allowed).toBe(true);
    expect(decision.uploads).toBe(UPLOAD_CALLS_PER_VIDEO);
  });

  it('libera o ÚLTIMO upload que cabe (o limite é inclusivo)', () => {
    const decision = quotaDecision({
      used: 100 - UPLOAD_CALLS_PER_VIDEO,
      limit: 100,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.uploads).toBe(100);
  });

  it('bloqueia quando o upload passa do limite', () => {
    const decision = quotaDecision({ used: 100, limit: 100 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/limite|uploads/i);
  });

  it('respeita o teto configurável (cota ampliada do projeto)', () => {
    const decision = quotaDecision({ used: 140, limit: 1_000 });
    expect(decision.allowed).toBe(true);
  });

  it('preserva duas vagas para uploads manuais', () => {
    expect(quotaDecision({ used: 97, limit: 100, reservedUploads: 2 }).allowed).toBe(true);
    expect(quotaDecision({ used: 98, limit: 100, reservedUploads: 2 }).allowed).toBe(false);
  });

  it('nunca devolve consumo negativo', () => {
    const decision = quotaDecision({ used: -5, limit: 10_000 });
    expect(decision.used).toBe(0);
    expect(decision.allowed).toBe(true);
  });

  it('cada videos.insert consome uma chamada do bucket de uploads', () => {
    expect(UPLOAD_CALLS_PER_VIDEO).toBe(1);
  });
});
