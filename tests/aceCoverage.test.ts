import { describe, expect, it } from 'vitest';
import { evaluateAceCoverage } from '../src/detector/aceCoverage.js';
import type { KillEvent } from '../src/types.js';

function kill(at: number): KillEvent {
  return { killer: 'jcobbb', victim: '', round: 5, map: 'Nuke', at };
}

describe('evaluateAceCoverage (footage do ace no buffer)', () => {
  it('mantém o ace quando pelo menos uma kill está no buffer', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000), kill(200_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.killsInBuffer).toBe(1);
    expect(coverage.truncatedStart).toBe(true);
  });

  it('descarta o evento quando nenhuma kill está no buffer (fantasma)', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000), kill(2_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(true);
    expect(coverage.killsInBuffer).toBe(0);
  });

  it('round longo: âncora fora do buffer, mas com kills no buffer = não descarta', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(190_000), kill(195_000), kill(200_000), kill(205_000)],
      anchorMs: 100_000,
      oldestSegmentStartMs: 150_000,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.killsInBuffer).toBe(4);
    expect(coverage.truncatedStart).toBe(true);
  });

  it('sem segmentos não descarta (o chamador decide o resto)', () => {
    const coverage = evaluateAceCoverage({
      kills: [kill(1_000)],
      anchorMs: 1_000,
      oldestSegmentStartMs: null,
    });
    expect(coverage.discard).toBe(false);
    expect(coverage.killsInBuffer).toBe(0);
  });
});
