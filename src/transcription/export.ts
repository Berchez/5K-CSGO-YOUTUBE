/**
 * Exportação da transcrição para legenda: SRT (o formato que o YouTube e
 * os editores importam), WebVTT (web) e texto puro.
 *
 * Funções puras: recebem os segmentos e devolvem a string. Quem grava o
 * arquivo é o chamador.
 */
import { sanitizeSegments } from './segments.js';
import type { TranscriptFormat, TranscriptionSegment } from './types.js';

function pad(value: number, size: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(size, '0');
}

/** `HH:MM:SS,mmm` (SRT). */
export function formatSrtTime(sec: number): string {
  const totalMs = Math.round(Math.max(0, Number(sec) || 0) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** `HH:MM:SS.mmm` (WebVTT). */
export function formatVttTime(sec: number): string {
  return formatSrtTime(sec).replace(',', '.');
}

/** Escapa o texto no WebVTT (o `<` abriria uma tag de cue). */
export function escapeVttText(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** SRT completo (numeração + tempos + texto), com newline no fim. */
export function toSrt(segments: TranscriptionSegment[]): string {
  const cues = sanitizeSegments(segments);
  const blocks = cues.map((seg, i) => {
    const text = seg.text.trim();
    return `${i + 1}\n${formatSrtTime(seg.startSec)} --> ${formatSrtTime(seg.endSec)}\n${text}`;
  });
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

/** WebVTT completo (cabeçalho `WEBVTT`), com newline no fim. */
export function toVtt(segments: TranscriptionSegment[]): string {
  const cues = sanitizeSegments(segments);
  const blocks = cues.map((seg) => {
    const text = escapeVttText(seg.text.trim());
    return `${formatVttTime(seg.startSec)} --> ${formatVttTime(seg.endSec)}\n${text}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;
}

/** Texto puro (uma fala por linha), sem tempos. */
export function toTxt(segments: TranscriptionSegment[]): string {
  const cues = sanitizeSegments(segments);
  return cues.length > 0 ? `${cues.map((seg) => seg.text.trim()).join('\n')}\n` : '';
}

/** Extensão do arquivo por formato. */
export function transcriptExtension(format: TranscriptFormat): string {
  return format === 'vtt' ? 'vtt' : format === 'txt' ? 'txt' : 'srt';
}

/** Serializa no formato pedido (ponto único usado pelo CLI e pelo adapter). */
export function toTranscript(
  segments: TranscriptionSegment[],
  format: TranscriptFormat,
): string {
  if (format === 'vtt') return toVtt(segments);
  if (format === 'txt') return toTxt(segments);
  return toSrt(segments);
}
