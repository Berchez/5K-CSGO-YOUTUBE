import { describe, expect, it } from 'vitest';
import {
  latencyMapProblem,
  observedLatencyMs,
  parseLatencyMap,
  resolveStreamLatencyMs,
  StreamLatencyTracker,
} from '../src/monitor/streamLatency.js';

describe('parseLatencyMap', () => {
  it('lê o JSON do mapa por canal', () => {
    expect(parseLatencyMap('{"Gaules": 22000, "ESL TV": 30000}')).toEqual({
      gaules: 22_000,
      'esl tv': 30_000,
    });
  });

  it('aceita número como string', () => {
    expect(parseLatencyMap('{"Gaules": "22000"}')).toEqual({ gaules: 22_000 });
  });

  it('ignora JSON inválido, arrays e valores fora da faixa', () => {
    expect(parseLatencyMap('não é json')).toEqual({});
    expect(parseLatencyMap('[1,2]')).toEqual({});
    expect(parseLatencyMap('{"a": -1}')).toEqual({});
    expect(parseLatencyMap('{"a": 999999}')).toEqual({});
    expect(parseLatencyMap('{"a": "abc"}')).toEqual({});
  });

  it('vazio quando não configurado', () => {
    expect(parseLatencyMap(undefined)).toEqual({});
    expect(parseLatencyMap('  ')).toEqual({});
  });
});

describe('resolveStreamLatencyMs', () => {
  const byStream = { gaules: 22_000, 'esl tv': 30_000 };

  it('usa o valor do canal quando existe', () => {
    expect(resolveStreamLatencyMs(25_000, byStream, 'Gaules')).toBe(22_000);
    expect(resolveStreamLatencyMs(25_000, byStream, 'ESL TV')).toBe(30_000);
  });

  it('casa canal com sufixo (prefixo do configurado no nome real)', () => {
    expect(resolveStreamLatencyMs(25_000, byStream, 'Gaules 2')).toBe(22_000);
  });

  it('não casa por "includes" genérico (tv não casa "ESL TV")', () => {
    // Com includes nos dois sentidos, "tv" casaria "ESL TV" e a ordem
    // de inserção do mapa decidiria o vencedor.
    const mapa = { tv: 9_000, 'esl tv': 30_000 };
    expect(resolveStreamLatencyMs(25_000, mapa, 'ESL TV')).toBe(30_000);
    expect(resolveStreamLatencyMs(25_000, { tv: 9_000 }, 'ESL TV')).toBe(25_000);
  });

  it('prefixo mais longo vence (Gaules 2 não cai no "gaules gaules")', () => {
    const mapa = { gaules: 20_000, 'gaules 2': 33_000 };
    expect(resolveStreamLatencyMs(25_000, mapa, 'Gaules 2')).toBe(33_000);
  });

  it('cai no global quando não há entrada para o canal', () => {
    expect(resolveStreamLatencyMs(25_000, byStream, 'IEM Katowice')).toBe(25_000);
    expect(resolveStreamLatencyMs(25_000, byStream, undefined)).toBe(25_000);
  });
});

describe('latencyMapProblem (aviso de mapa inválido)', () => {
  it('mapa vazio não é problema', () => {
    expect(latencyMapProblem(undefined)).toBeNull();
    expect(latencyMapProblem('  ')).toBeNull();
  });

  it('detecta JSON inválido, array e valores fora da faixa', () => {
    expect(latencyMapProblem('não é json')).toBe('JSON inválido');
    expect(latencyMapProblem('[1,2]')).toContain('objeto');
    expect(latencyMapProblem('{"a": -1}')).toContain('faixa');
    expect(latencyMapProblem('{}')).toContain('vazio');
  });

  it('mapa válido não gera aviso', () => {
    expect(latencyMapProblem('{"Gaules": 22000}')).toBeNull();
  });
});

describe('observedLatencyMs', () => {
  it('é a virada no vídeo menos o fechamento real do round', () => {
    // Round fechou (relógio do jogo) em T+40s; a virada apareceu no vídeo em T+62s.
    expect(observedLatencyMs(1_062_000, 1_060_000, 20_000)).toBe(22_000);
  });
});

describe('StreamLatencyTracker', () => {
  it('guarda as últimas 5 amostras por canal e devolve a mediana', () => {
    const tracker = new StreamLatencyTracker();
    [10_000, 20_000, 30_000, 40_000, 50_000, 60_000].forEach((ms) =>
      tracker.record('Gaules', ms),
    );
    expect(tracker.samplesCount('Gaules')).toBe(5);
    // Depois de 60.000 a janela é [20k,30k,40k,50k,60k] → mediana 40k.
    expect(tracker.median('Gaules')).toBe(40_000);
  });

  it('separa os canais e devolve null sem medição', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', 22_000);
    expect(tracker.median('gaules')).toBe(22_000);
    expect(tracker.median('ESL TV')).toBeNull();
    expect(tracker.median(undefined)).toBeNull();
  });

  it('ignora valores inválidos', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', Number.NaN);
    expect(tracker.samplesCount('Gaules')).toBe(0);
  });

  it('descarta amostras fora da faixa plausível (OCR casou o round errado)', () => {
    const tracker = new StreamLatencyTracker();
    tracker.record('Gaules', -5_000);
    tracker.record('Gaules', 300_000);
    expect(tracker.samplesCount('Gaules')).toBe(0);
    tracker.record('Gaules', 22_000);
    expect(tracker.median('Gaules')).toBe(22_000);
  });
});
