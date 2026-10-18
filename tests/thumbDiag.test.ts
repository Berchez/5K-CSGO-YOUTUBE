import { describe, expect, it } from 'vitest';
import {
  formatThumbDiagTable,
  isThumbLogLine,
  parseThumbLogLine,
  summarizeAttempts,
} from '../src/clipper/thumbDiag.js';

const NEW_OK =
  '{"level":30,"time":1792000000000,"provider":"chatgpt","windowMode":"minimized","outcome":"ok","failKind":null,"msg":"thumb IA: tentativa"}';
const NEW_FAIL =
  '{"level":40,"time":1792000001000,"provider":"chatgpt","windowMode":"minimized","outcome":"fail","failKind":"challenge","msg":"thumb IA: tentativa"}';
const LEGACY_OK = '{"level":30,"time":1791000000000,"provider":"grok","msg":"thumb IA via grok"}';
const LEGACY_FAIL =
  '{"level":40,"time":1791000001000,"provider":"chatgpt","err":"ChatGPT bloqueado pelo desafio Cloudflare mesmo após tentativas.","msg":"provider IA falhou, tentando próximo"}';
const NOISE = '{"level":30,"time":1791000002000,"msg":"live matches filtradas"}';
const NOT_JSON = 'bot iniciado (multikills 3k+ live)';

describe('parseThumbLogLine (nova + legada)', () => {
  it('linha nova com modo/causa explícitos', () => {
    expect(parseThumbLogLine(NEW_OK)).toMatchObject({
      provider: 'chatgpt',
      windowMode: 'minimized',
      outcome: 'ok',
      failKind: null,
    });
    expect(parseThumbLogLine(NEW_FAIL)).toMatchObject({
      provider: 'chatgpt',
      outcome: 'fail',
      failKind: 'challenge',
    });
  });

  it('legada: sucesso assume modo da época; falha reclassifica a causa', () => {
    expect(parseThumbLogLine(LEGACY_OK)).toMatchObject({
      provider: 'grok',
      windowMode: 'visible (legado)',
      outcome: 'ok',
    });
    expect(parseThumbLogLine(LEGACY_FAIL)).toMatchObject({
      provider: 'chatgpt',
      outcome: 'fail',
      failKind: 'challenge',
    });
  });

  it('ruído e não-JSON retornam null', () => {
    expect(parseThumbLogLine(NOISE)).toBeNull();
    expect(parseThumbLogLine(NOT_JSON)).toBeNull();
    expect(parseThumbLogLine('')).toBeNull();
  });
});

describe('isThumbLogLine (pré-filtro barato)', () => {
  it('aceita as três formas e rejeita ruído', () => {
    expect(isThumbLogLine(NEW_OK)).toBe(true);
    expect(isThumbLogLine(LEGACY_OK)).toBe(true);
    expect(isThumbLogLine(LEGACY_FAIL)).toBe(true);
    expect(isThumbLogLine(NOISE)).toBe(false);
    expect(isThumbLogLine(NOT_JSON)).toBe(false);
  });
});

describe('summarizeAttempts + formatThumbDiagTable', () => {
  it('agrega por provider|modo com ok% e causas', () => {
    const rows = [NEW_OK, NEW_FAIL, NEW_FAIL, LEGACY_OK, LEGACY_FAIL, NOISE]
      .map(parseThumbLogLine)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    expect(rows).toHaveLength(5);
    const s = summarizeAttempts(rows);
    expect(s['chatgpt | minimized']).toMatchObject({ attempts: 3, ok: 1 });
    expect(s['chatgpt | minimized'].failKinds).toEqual({ challenge: 2 });
    expect(s['grok | visible (legado)']).toMatchObject({ attempts: 1, ok: 1 });
    const table = formatThumbDiagTable(s);
    expect(table).toContain('provider');
    expect(table).toContain('chatgpt');
    expect(table).toContain('33%');
    expect(table).toContain('challenge=2');
  });

  it('vazio mostra marcador', () => {
    expect(formatThumbDiagTable({})).toContain('sem tentativas');
  });
});
