import { describe, expect, it } from 'vitest';
import { capturePlan, isDiscontinuityLine } from '../src/recorder/streamRecorder.js';

describe('capturePlan', () => {
  it('usa só a fonte combinada (muxed) da stream', () => {
    expect(capturePlan()).toEqual({
      formats: ['best'],
      maps: ['0:v', '0:a'],
    });
  });

  it('aceita o seletor de formato da config (kill-switch da captura)', () => {
    expect(capturePlan('best[height<=1080]')).toEqual({
      formats: ['best[height<=1080]'],
      maps: ['0:v', '0:a'],
    });
  });

  it('formato vazio volta para o combinado padrão (um input c/ áudio e vídeo)', () => {
    expect(capturePlan('   ')).toEqual({
      formats: ['best'],
      maps: ['0:v', '0:a'],
    });
  });
});

describe('isDiscontinuityLine (restart do transcode)', () => {
  it('detecta as linhas reais do ffmpeg', () => {
    expect(isDiscontinuityLine('[vist#0:1/h264 @ 000001db1f5ede80] timestamp discontinuity (stream id=0): 70820241878, new offset= -70820241878')).toBe(true);
    expect(isDiscontinuityLine('[aist#1:0/aac @ 000001db1faaf480] timestamp discontinuity (stream id=0): 70820348223, new offset= -70820348223')).toBe(true);
    expect(isDiscontinuityLine('circuit discontinuity detected')).toBe(true);
  });

  it('ignora outras linhas de sync', () => {
    expect(isDiscontinuityLine('[mp4 @ 000001] Non-monotonous DTS in output stream')).toBe(false);
    expect(isDiscontinuityLine('Opening \'https://example.com/seg.ts\' for reading')).toBe(false);
    expect(isDiscontinuityLine('')).toBe(false);
  });
});
