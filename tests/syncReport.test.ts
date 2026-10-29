import { describe, expect, it } from 'vitest';
import { mergeMeasurements, normalizeStream } from '../scripts/sync-report.js';

describe('normalizeStream', () => {
  it('normaliza caixa e espaços (a chave do estado é minúscula)', () => {
    expect(normalizeStream(' Gaules ')).toBe('gaules');
    expect(normalizeStream('ESL TV')).toBe('esl tv');
    expect(normalizeStream('')).toBe('desconhecida');
    expect(normalizeStream('   ')).toBe('desconhecida');
  });
});

describe('mergeMeasurements', () => {
  const T = 1_700_000_000_000;

  it('junta log + estado normalizando o canal e sem duplicar a mesma medição', () => {
    const merged = mergeMeasurements(
      [{ at: T, stream: 'Gaules', latencyMs: 30_000, reference: 'timer-hltv' }],
      [
        // Mesma medição do log (o estado grava alguns segundos depois e a
        // chave é minúscula): não pode contar duas vezes.
        { at: T + 45_000, stream: 'gaules', latencyMs: 30_000 },
        { at: T + 200_000, stream: 'GAULES', latencyMs: 45_000 },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].origem).toBe('log');
    expect(merged[0].reference).toBe('timer-hltv');
    expect(merged[1].origem).toBe('estado');
    expect(merged[1].latencyMs).toBe(45_000);
    expect(merged.every((sample) => sample.stream === 'gaules')).toBe(true);
  });

  it('não deduplica medições diferentes (valor ou instante distante)', () => {
    const merged = mergeMeasurements(
      [{ at: T, stream: 'gaules', latencyMs: 30_000 }],
      [
        { at: T + 30_000, stream: 'gaules', latencyMs: 31_500 },
        { at: T + 40 * 60_000, stream: 'gaules', latencyMs: 30_000 },
      ],
    );
    expect(merged).toHaveLength(3);
  });

  it('sem log, o estado é a única fonte', () => {
    const merged = mergeMeasurements([], [{ at: T, stream: 'ESL TV', latencyMs: 25_000 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].stream).toBe('esl tv');
    expect(merged[0].origem).toBe('estado');
  });

  it('preserva a referência do fim do round vinda do estado', () => {
    const merged = mergeMeasurements(
      [],
      [{ at: T, stream: 'gaules', latencyMs: 30_000, reference: 'estimada' }],
    );
    expect(merged[0].reference).toBe('estimada');
  });
});
