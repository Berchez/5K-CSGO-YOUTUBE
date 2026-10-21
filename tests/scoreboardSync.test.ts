import { describe, expect, it } from 'vitest';
import {
  findRoundTransition,
  findScoreTransition,
  parseScoreboardCrop,
  parseScoreboardText,
  scoreKey,
} from '../src/clipper/scoreboardSync.js';
import type { ScoreboardObservation } from '../src/clipper/scoreboardSync.js';

function obs(
  streamAtMs: number,
  left: number,
  right: number,
  round: number | null = null,
): ScoreboardObservation {
  return { streamAtMs, score: { left, right }, timerSec: 60, round };
}

describe('parseScoreboardText', () => {
  it('lê placar e timer reais do OCR', () => {
    expect(parseScoreboardText('HEROIC Ww 5 1:07 2 HYPERSPIRIT | ROUND 8/24')).toEqual({
      score: { left: 5, right: 2 },
      timerSec: 67,
      round: 8,
    });
  });

  it('aceita timer sem dois-pontos lido pelo Tesseract', () => {
    expect(parseScoreboardText('HEROIC Ww 5 107 2 HYPERSPIRIT')).toMatchObject({
      score: { left: 5, right: 2 },
      timerSec: 67,
    });
  });

  it('normaliza timer com hífen e ponto', () => {
    expect(parseScoreboardText('HEROIC Ww 5 1-05 2 HYPERSPIRIT ROUND 8/24')).toMatchObject({
      score: { left: 5, right: 2 },
      timerSec: 65,
      round: 8,
    });
    expect(parseScoreboardText('HEROIC WW 5 1.27 2 HYPERSPIRIT')).toMatchObject({
      score: { left: 5, right: 2 },
      timerSec: 87,
    });
  });

  it('aceita placar de dois dígitos', () => {
    expect(parseScoreboardText('HEROIC 12 1:02 13 HYPERSPIRIT')).toMatchObject({
      score: { left: 12, right: 13 },
      timerSec: 62,
    });
  });

  it('ignora texto sem placar dos dois lados', () => {
    expect(parseScoreboardText('HEROIC WH 1:23 2 4 HYPERSPIRT')).toBeNull();
    expect(parseScoreboardText('SUPERBET')).toBeNull();
  });
});

describe('findScoreTransition', () => {
  it('acha a virada esperada, ignorando leituras ruins antes', () => {
    const observations = [
      obs(1_000, 0, 2),
      obs(2_000, 5, 2),
      obs(3_000, 5, 2),
      obs(4_000, 6, 2),
      obs(5_000, 6, 2),
    ];
    expect(findScoreTransition(observations, '5-2', '6-2')).toMatchObject({
      streamAtMs: 4_000,
      before: '5-2',
      after: '6-2',
      marker: 'score',
      reason: 'confident',
    });
  });

  it('compara o par como conjunto (lado CT/T pode estar invertido)', () => {
    expect(
      findScoreTransition([obs(1_000, 2, 5), obs(2_000, 2, 6), obs(3_000, 2, 6)], '5-2', '6-2'),
    ).toMatchObject({ streamAtMs: 2_000, before: '2-5', after: '2-6' });
  });

  it('não aceita uma leitura isolada do placar novo', () => {
    expect(
      findScoreTransition([obs(1_000, 5, 2), obs(2_000, 6, 2), obs(3_000, 5, 2)], '5-2', '6-2'),
    ).toBeNull();
  });

  it('usa o primeiro frame novo quando o placar anterior ficou fora da janela', () => {
    expect(findScoreTransition([obs(1_000, 6, 2), obs(2_000, 6, 2)], '5-2', '6-2')).toMatchObject({
      streamAtMs: 1_000,
      before: null,
      after: '6-2',
      reason: 'after-only',
    });
  });
});

describe('findRoundTransition', () => {
  it('usa ROUND N+1 como fallback', () => {
    const observations = [
      obs(1_000, 5, 2, 8),
      obs(2_000, 6, 2, 9),
      obs(3_000, 6, 2, 9),
    ];
    expect(findRoundTransition(observations, 8)).toMatchObject({
      streamAtMs: 2_000,
      before: '5-2',
      after: '6-2',
      marker: 'round',
      reason: 'confident',
    });
  });
});

describe('scoreKey', () => {
  it('ordena o par independente do lado', () => {
    expect(scoreKey({ left: 2, right: 5 })).toBe('2-5');
    expect(scoreKey({ left: 5, right: 2 })).toBe('2-5');
  });
});

describe('parseScoreboardCrop', () => {
  it('aceita crop normalizado válido', () => {
    expect(parseScoreboardCrop('0.30:0.03:0.40:0.10')).toEqual({
      x: 0.3,
      y: 0.03,
      w: 0.4,
      h: 0.1,
    });
  });

  it('cai no default quando o crop é inválido', () => {
    expect(parseScoreboardCrop('0.7:0.1:0.5:0.2')).toEqual({
      x: 0.3,
      y: 0.03,
      w: 0.4,
      h: 0.1,
    });
    expect(parseScoreboardCrop('lixo')).toEqual({ x: 0.3, y: 0.03, w: 0.4, h: 0.1 });
  });
});
