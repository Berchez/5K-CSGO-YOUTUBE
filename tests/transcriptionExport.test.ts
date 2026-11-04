import { describe, expect, it } from 'vitest';
import {
  escapeVttText,
  formatSrtTime,
  formatVttTime,
  toSrt,
  toTxt,
  toVtt,
  toTranscript,
  transcriptExtension,
} from '../src/transcription/export.js';
import type { TranscriptionSegment } from '../src/transcription/types.js';

const SEGMENTS: TranscriptionSegment[] = [
  { startSec: 1, endSec: 2.5, text: 'Fala um' },
  { startSec: 3, endSec: 4, text: 'Fala dois' },
];

describe('formatSrtTime', () => {
  it('formata horas/minutos/segundos/milissegundos', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(1.5)).toBe('00:00:01,500');
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('arredonda milissegundos sem estourar o segundo', () => {
    expect(formatSrtTime(59.9996)).toBe('00:01:00,000');
  });

  it('trata negativo e inválido como zero', () => {
    expect(formatSrtTime(-3)).toBe('00:00:00,000');
    expect(formatSrtTime(Number.NaN)).toBe('00:00:00,000');
  });
});

describe('formatVttTime', () => {
  it('usa ponto no lugar da vírgula', () => {
    expect(formatVttTime(1.5)).toBe('00:00:01.500');
  });
});

describe('toSrt', () => {
  it('numera e separa os blocos com uma linha em branco', () => {
    expect(toSrt(SEGMENTS)).toBe(
      '1\n00:00:01,000 --> 00:00:02,500\nFala um\n\n2\n00:00:03,000 --> 00:00:04,000\nFala dois\n',
    );
  });

  it('descarta segmento inválido e devolve vazio sem fala', () => {
    expect(
      toSrt([{ startSec: Number.NaN, endSec: 2, text: 'x' }]),
    ).toBe('');
  });
});

describe('toVtt', () => {
  it('começa com WEBVTT e usa tempo com ponto', () => {
    expect(toVtt(SEGMENTS)).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nFala um\n\n00:00:03.000 --> 00:00:04.000\nFala dois\n',
    );
  });

  it('sem segmentos devolve só o cabeçalho', () => {
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });
});

describe('escapeVttText', () => {
  it('escapa &, < e > para não abrir tag de cue', () => {
    expect(escapeVttText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('toTxt', () => {
  it('junta uma fala por linha', () => {
    expect(toTxt(SEGMENTS)).toBe('Fala um\nFala dois\n');
  });
});

describe('toTranscript', () => {
  it('despacha pelo formato', () => {
    expect(toTranscript(SEGMENTS, 'txt')).toBe(toTxt(SEGMENTS));
    expect(toTranscript(SEGMENTS, 'vtt')).toBe(toVtt(SEGMENTS));
    expect(toTranscript(SEGMENTS, 'srt')).toBe(toSrt(SEGMENTS));
  });
});

describe('transcriptExtension', () => {
  it('devolve a extensão de cada formato', () => {
    expect(transcriptExtension('srt')).toBe('srt');
    expect(transcriptExtension('vtt')).toBe('vtt');
    expect(transcriptExtension('txt')).toBe('txt');
  });
});
