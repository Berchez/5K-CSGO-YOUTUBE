import { describe, expect, it } from 'vitest';
import { computeAceEndMs, computeClipAnchors, killVideoOffsetMs } from '../src/clipper/clipAnchors.js';

const T = 1_700_000_000_000;

function anchors(overrides: Partial<Parameters<typeof computeClipAnchors>[0]> = {}) {
  return computeClipAnchors({
    aceStartedAtMs: T,
    streamLatencyMs: 25_000,
    scoreboardDelayMs: 5_000,
    scoreDelayMs: 20_000,
    endAfterCloseSec: 8,
    endTailSec: 8,
    contextSec: 10,
    aceDetectedAtMs: T + 60_000,
    scoreboardEndMs: null,
    syncApplied: false,
    syncScanned: true,
    ...overrides,
  });
}

describe('computeClipAnchors (placar → timeline do vídeo)', () => {
  it('converte a âncora do placar para a timeline do vídeo', () => {
    const a = anchors();
    expect(a.videoStartMs).toBe(T + 25_000);
    expect(a.estimatedClipStartMs).toBe(T + 25_000 - 10_000);
    // O offset dos timestamps: latência da stream − atraso do placar.
    expect(a.killVideoOffsetMs).toBe(20_000);
  });

  it('sem âncora de início não inventa clipStart', () => {
    const a = anchors({ aceStartedAtMs: undefined });
    expect(a.videoStartMs).toBeUndefined();
    expect(a.estimatedClipStartMs).toBeUndefined();
  });

  it('a margem do início abre o corte antes (erro de latência assimétrico)', () => {
    const semMargem = anchors({ contextSec: 10, startMarginSec: 0 });
    const comMargem = anchors({ contextSec: 10, startMarginSec: 5 });
    expect(semMargem.estimatedClipStartMs).toBe(T + 15_000);
    expect(comMargem.estimatedClipStartMs).toBe(T + 10_000);
  });

  it('fim ancorado no vídeo: instante do OCR + margem de fechamento', () => {
    const a = anchors({ scoreboardEndMs: T + 200_000, syncApplied: true });
    expect(a.usedScoreboardEnd).toBe(true);
    expect(a.usedEstimatedEnd).toBe(false);
    expect(a.usedFallback).toBe(false);
    expect(a.endMs).toBe(T + 208_000);
  });

  it('fim estimado: detecção − atraso do placar + latência + cauda', () => {
    const a = anchors();
    expect(a.usedScoreboardEnd).toBe(false);
    expect(a.usedEstimatedEnd).toBe(true);
    expect(a.usedFallback).toBe(true);
    // 60.000 − 20.000 + 25.000 + 8.000 (fechamento) + 8.000 (cauda)
    expect(a.endMs).toBe(T + 81_000);
  });

  it('a cauda protege o fim estimado (latência subestimada não corta a última kill)', () => {
    const semCauda = anchors({ endTailSec: 0 });
    const comCauda = anchors({ endTailSec: 8 });
    expect(comCauda.endMs - semCauda.endMs).toBe(8_000);
  });

  it('sem OCR (sync desligado) o fim continua estimado, mas sem espera extra', () => {
    const a = anchors({ syncScanned: false });
    expect(a.usedEstimatedEnd).toBe(true);
    expect(a.usedFallback).toBe(false);
  });
});

describe('computeAceEndMs', () => {
  it('mantém a fórmula histórica (detecção − placar + latência + fechamento)', () => {
    expect(computeAceEndMs(T + 15_000, 10_000, 8)).toBe(T + 13_000);
    expect(computeAceEndMs(T + 15_000, 10_000, 8, 25_000)).toBe(T + 38_000);
  });
});

describe('killVideoOffsetMs', () => {
  it('é a latência da stream menos o atraso do placar', () => {
    expect(killVideoOffsetMs(25_000, 5_000)).toBe(20_000);
    expect(killVideoOffsetMs(20_000, 5_000)).toBe(15_000);
  });
});

describe('computeClipAnchors (latência adaptativa por âncora)', () => {
  it('usa a latência do INÍCIO para abrir o corte e a do FIM para fechar', () => {
    const a = anchors({ startLatencyMs: 40_000, endLatencyMs: 70_000 });
    expect(a.videoStartMs).toBe(T + 40_000);
    expect(a.killVideoOffsetMs).toBe(35_000);
    // Fim estimado: 60.000 − 20.000 + 70.000 + 8.000 + 8.000
    expect(a.endMs).toBe(T + 126_000);
    expect(a.startLatencyMs).toBe(40_000);
    expect(a.endLatencyMs).toBe(70_000);
  });

  it('sem latência específica, cai na latência da stream', () => {
    const a = anchors();
    expect(a.startLatencyMs).toBe(25_000);
    expect(a.endLatencyMs).toBe(25_000);
  });
});
