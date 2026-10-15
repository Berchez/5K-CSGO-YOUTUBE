import { describe, expect, it } from 'vitest';
import { analyzeTrackTimes, classifySegmentAv } from '../src/clipper/segmentProbe.js';

/** PTS sintéticos: n pacotes espaçados de step a partir de start. */
function series(start: number, n: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

describe('analyzeTrackTimes (puro)', () => {
  it('vazio: count 0 e spans NaN', () => {
    const t = analyzeTrackTimes([]);
    expect(t.count).toBe(0);
    expect(t.spanSec).toBeNaN();
  });

  it('série regular 60fps/10s: span ~10s, gap ~16ms', () => {
    const t = analyzeTrackTimes(series(100, 600, 1 / 60));
    expect(t.count).toBe(600);
    expect(t.spanSec).toBeCloseTo(10, 1);
    expect(t.gapMaxSec).toBeCloseTo(1 / 60, 3);
    expect(t.firstSec).toBe(100);
  });

  it('ordena antes de medir (demux fora de ordem)', () => {
    const t = analyzeTrackTimes([3, 1, 2]);
    expect(t.spanSec).toBe(2);
    expect(t.gapMaxSec).toBe(1);
    expect(t.firstSec).toBe(1);
  });
});

describe('classifySegmentAv (puro)', () => {
  const SLOT = 10;

  it('trilhas saudáveis: null', () => {
    expect(
      classifySegmentAv(series(900, 600, 1 / 60), series(900, 469, 1 / 46.875), SLOT),
    ).toBeNull();
  });

  it('gap de 2.8s no vídeo: stall (caso real do seg_004)', () => {
    const video = [...series(1150, 30, 1 / 60), ...series(1150 + 0.5 + 2.8, 33, 1 / 60)];
    const audio = series(1150, 469, 1 / 46.875);
    const r = classifySegmentAv(video, audio, SLOT);
    expect(r?.kind).toBe('stall');
    expect(r?.videoGapMaxSec ?? 0).toBeGreaterThan(2.5);
    expect(r?.videoCount).toBe(63);
  });

  it('span de 17h no vídeo com taxa saudável: pts-jump (não starved)', () => {
    // Salto real: dois blocos densos em eras distantes (restart do transcode).
    // Densidade fora do buraco = 60fps → o problema é a descontinuidade.
    const block = (off: number) => series(off, 300, 1 / 60);
    const video = [...block(0), ...block(62007.42)];
    const audio = series(0, 469, 1 / 46.875);
    const r = classifySegmentAv(video, audio, SLOT);
    expect(r?.kind).toBe('pts-jump');
    expect(r?.videoSec ?? 0).toBeGreaterThan(60000);
  });

  it('120 frames em 145s de vídeo: starved (caso real do buffer 2399204)', () => {
    const video = series(0, 120, 145 / 120);
    const audio = series(0, 6800, 143 / 6800);
    const r = classifySegmentAv(video, audio, SLOT);
    expect(r?.kind).toBe('starved');
    expect(r?.videoCount).toBe(120);
  });

  it('áudio abrindo 2s depois: mismatch com startDelta ~2s', () => {
    const r = classifySegmentAv(series(902, 600, 1 / 60), series(900, 469, 1 / 46.875), SLOT);
    expect(r?.kind).toBe('mismatch');
    expect(Math.abs(r?.startDeltaSec ?? 0)).toBeGreaterThan(1.5);
  });

  it('segmento de abertura com ~2s de conteúdo: short', () => {
    const r = classifySegmentAv(series(0, 120, 1 / 60), series(0, 94, 1 / 46.875), SLOT);
    expect(r?.kind).toBe('short');
  });

  it('trilha ausente: unreadable', () => {
    const r = classifySegmentAv([], series(0, 94, 1 / 46.875), SLOT);
    expect(r?.kind).toBe('unreadable');
  });
});
