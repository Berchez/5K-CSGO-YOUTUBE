import { describe, expect, it } from 'vitest';
import { median, slopePerStep, startDeltaSec } from '../src/clipper/segmentProbe.js';

describe('median', () => {
  it('mediana de série ímpar e par', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('série vazia = NaN', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('slopePerStep (inclinação da série por segmento)', () => {
  it('inclinação 2 (serie que sobe 2 por passo)', () => {
    // [0,1,2,3] tem inclinação 1 e PASSARIA mesmo com o bug do
    // denominador: o teste precisa de uma inclinação ≠ 1.
    expect(slopePerStep([0, 2, 4, 6])).toBeCloseTo(2);
  });

  it('inclinação 0 (série constante)', () => {
    expect(slopePerStep([5, 5, 5, 5])).toBe(0);
  });

  it('inclinação negativa (série caindo)', () => {
    expect(slopePerStep([6, 4, 2, 0])).toBeCloseTo(-2);
  });

  it('série curta demais = 0', () => {
    expect(slopePerStep([1, 2])).toBe(0);
    expect(slopePerStep([])).toBe(0);
  });

  it('não devolve sempre 1 (o bug do denominador)', () => {
    const xs = [0.1, 0.4, 0.2, 0.9, 0.3];
    expect(slopePerStep(xs)).not.toBe(1);
  });
});

describe('startDeltaSec (offset de abertura A/V)', () => {
  it('vídeo começa depois do áudio = offset positivo', () => {
    expect(startDeltaSec([10, 20, 30], [8, 18, 28])).toBeCloseTo(2);
  });

  it('sem áudio ou sem vídeo = NaN', () => {
    expect(Number.isNaN(startDeltaSec([], [1, 2]))).toBe(true);
    expect(Number.isNaN(startDeltaSec([1, 2], []))).toBe(true);
  });
});
