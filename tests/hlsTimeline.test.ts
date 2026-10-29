import { describe, expect, it } from 'vitest';
import {
  describePlaylist,
  findTimelineShifts,
  mergePlaylistSegments,
  originOffsetMs,
  parseHlsPlaylist,
  sumShifts,
} from '../src/recorder/hlsTimeline.js';

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
  '#EXTINF:10.000,',
  'seg100.ts',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:10.000Z',
  '#EXTINF:10.000,',
  'seg101.ts',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:20.000Z',
  '#EXTINF:10.000,',
  'seg102.ts',
].join('\n');

const PLAYLIST_COM_SALTO = [
  '#EXTM3U',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
  '#EXTINF:10.000,',
  'seg100.ts',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:40.000Z',
  '#EXTINF:10.000,',
  'seg101.ts',
].join('\n');

describe('parseHlsPlaylist', () => {
  it('lê PDT, duração e descontinuidade de cada segmento', () => {
    const segments = parseHlsPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
        '#EXTINF:10.000,',
        'seg100.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:10.000Z',
        '#EXTINF:9.500,',
        'seg101.ts',
      ].join('\n'),
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].pdtMs).toBe(Date.parse('2026-10-29T03:00:00.000Z'));
    expect(segments[0].durationSec).toBe(10);
    expect(segments[0].discontinuity).toBe(false);
    expect(segments[1].discontinuity).toBe(true);
    expect(segments[1].durationSec).toBe(9.5);
    expect(segments[1].uri).toBe('seg101.ts');
  });

  it('playlist sem PDT devolve segmentos com pdtMs null (fonte sem relógio de origem)', () => {
    const segments = parseHlsPlaylist(['#EXTM3U', '#EXTINF:10.000,', 'seg100.ts'].join('\n'));
    expect(segments).toHaveLength(1);
    expect(segments[0].pdtMs).toBeNull();
  });
});

describe('findTimelineShifts', () => {
  it('não acusa salto em playlist normal', () => {
    expect(findTimelineShifts(parseHlsPlaylist(PLAYLIST), 10)).toEqual([]);
  });

  it('acusa o salto do relógio de origem (a stream andou atrás do jogo)', () => {
    const shifts = findTimelineShifts(parseHlsPlaylist(PLAYLIST_COM_SALTO), 10);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].shiftSec).toBe(30);
    expect(shifts[0].atPdtMs).toBe(Date.parse('2026-10-29T03:00:40.000Z'));
  });

  it('tolera variação pequena de duração (não é salto)', () => {
    const shifts = findTimelineShifts(
      parseHlsPlaylist(
        [
          '#EXTM3U',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
          '#EXTINF:10.000,',
          'a.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:12.000Z',
          '#EXTINF:10.000,',
          'b.ts',
        ].join('\n'),
      ),
      10,
    );
    expect(shifts).toEqual([]);
  });

  it('conta a duração dos segmentos sem PDT entre dois com PDT', () => {
    const shifts = findTimelineShifts(
      parseHlsPlaylist(
        [
          '#EXTM3U',
          '#EXTINF:10.000,',
          'a.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
          '#EXTINF:10.000,',
          'b.ts',
          '#EXTINF:10.000,',
          'c.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:01:00.000Z',
          '#EXTINF:10.000,',
          'd.ts',
        ].join('\n'),
      ),
      10,
    );
    // 60s de PDT para 20s de conteúdo (b + c): o salto é 40s, não 50s.
    expect(shifts).toHaveLength(1);
    expect(shifts[0].shiftSec).toBe(40);
  });

  it('não acusa salto quando o PDT pula um segmento sem relógio', () => {
    const shifts = findTimelineShifts(
      parseHlsPlaylist(
        [
          '#EXTM3U',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
          '#EXTINF:10.000,',
          'a.ts',
          '#EXTINF:10.000,',
          'b.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:20.000Z',
          '#EXTINF:10.000,',
          'c.ts',
        ].join('\n'),
      ),
      10,
    );
    expect(shifts).toEqual([]);
  });

  it('usa a duração do segmento ANTERIOR como referência (não a do atual)', () => {
    const shifts = findTimelineShifts(
      parseHlsPlaylist(
        [
          '#EXTM3U',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
          '#EXTINF:6.000,',
          'a.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:06.000Z',
          '#EXTINF:10.000,',
          'b.ts',
        ].join('\n'),
      ),
      10,
    );
    expect(shifts).toEqual([]);
  });
});

describe('sumShifts', () => {
  it('soma só os saltos da janela', () => {
    const shifts = findTimelineShifts(
      parseHlsPlaylist(
        [
          '#EXTM3U',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
          '#EXTINF:10.000,',
          'a.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:40.000Z',
          '#EXTINF:10.000,',
          'b.ts',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:01:00.000Z',
          '#EXTINF:10.000,',
          'c.ts',
        ].join('\n'),
      ),
      10,
    );
    const from = Date.parse('2026-10-29T03:00:30.000Z');
    const to = Date.parse('2026-10-29T03:00:50.000Z');
    expect(sumShifts(shifts, from, to)).toBe(30_000);
    expect(sumShifts(shifts)).toBe(40_000);
  });
});

describe('describePlaylist', () => {
  it('resume a playlist para diagnóstico', () => {
    const resumo = describePlaylist(PLAYLIST);
    expect(resumo.segmentos).toBe(3);
    expect(resumo.comPdt).toBe(3);
    expect(resumo.descontinuidades).toBe(0);
    expect(resumo.primeiroPdt).toBe('2026-10-29T03:00:00.000Z');
    expect(resumo.ultimoPdt).toBe('2026-10-29T03:00:20.000Z');
  });

  it('playlist sem PDT não quebra', () => {
    const resumo = describePlaylist('#EXTM3U\n#EXTINF:10.000,\na.ts\n');
    expect(resumo.comPdt).toBe(0);
    expect(resumo.primeiroPdt).toBeNull();
  });
});

describe('mergePlaylistSegments', () => {
  it('mantém o antecessor do salto que caía na borda da janela deslizante', () => {
    const primeira = parseHlsPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:00.000Z',
        '#EXTINF:10.000,',
        'a.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:40.000Z',
        '#EXTINF:10.000,',
        'b.ts',
      ].join('\n'),
    );
    // Na leitura seguinte a janela já slidou: "b.ts" é o primeiro.
    const segunda = parseHlsPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:40.000Z',
        '#EXTINF:10.000,',
        'b.ts',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T03:00:50.000Z',
        '#EXTINF:10.000,',
        'c.ts',
      ].join('\n'),
    );
    // Sem a fusão, o salto de 30s já não aparece (b.ts é o primeiro).
    expect(findTimelineShifts(segunda, 10)).toEqual([]);
    const merged = mergePlaylistSegments(primeira, segunda);
    const shifts = findTimelineShifts(merged, 10);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].shiftSec).toBe(30);
  });

  it('não duplica segmentos (a janela deslizante repete os mesmos)', () => {
    const lista = parseHlsPlaylist(PLAYLIST);
    const merged = mergePlaylistSegments(lista, lista);
    expect(merged).toHaveLength(lista.length);
    expect(new Set(merged.map((segment) => segment.uri)).size).toBe(merged.length);
  });
});

describe('originOffsetMs', () => {
  it('é o mtime local menos o PDT mais novo', () => {
    const pdt = [1_000_000, 2_000_000];
    expect(originOffsetMs(pdt, 2_500_000)).toBe(500_000);
  });

  it('sem PDT ou sem mtime local, offset zero (sem chute)', () => {
    expect(originOffsetMs([], 2_500_000)).toBe(0);
    expect(originOffsetMs([1_000_000], null)).toBe(0);
  });
});
