/**
 * Helpers puros para transformar o que cada provider devolve em blocos de
 * transcrição sãos: tempo válido, texto limpo, sem sobreposição e — para
 * APIs que só dão palavras — blocos legíveis (por pausa/frase).
 */
import type { TimedWord, TranscriptionSegment } from './types.js';

/** Entrada crua (campos validados em runtime, vêm de JSON de terceiros). */
export interface RawSegment {
  startSec?: unknown;
  endSec?: unknown;
  text?: unknown;
}

/**
 * Código de idioma do jeito que as APIs gostam: `auto`/vazio → null (deixa
 * detectar), `pt-BR` → `pt`.
 */
export function normalizeLanguageCode(value?: string | null): string | null {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'auto' || raw === 'detect') return null;
  const base = raw.split(/[-_]/)[0];
  return base || null;
}

/** Espaços/quebras viram um espaço só; tira o excesso das pontas. */
export function normalizeSegmentText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Valida/ordena/limpa os segmentos do provider. Tempo inválido é
 * descartado (não vira legenda de 0s) e o fim para no começo do próximo
 * bloco — legenda que se sobrepõe pisca dois textos ao mesmo tempo.
 */
export function sanitizeSegments(
  raw: RawSegment[],
  audioSec?: number,
): TranscriptionSegment[] {
  const maxSec =
    Number.isFinite(audioSec) && Number(audioSec) > 0 ? Number(audioSec) : null;
  const valid: TranscriptionSegment[] = [];
  for (const item of raw ?? []) {
    const text = normalizeSegmentText(item?.text);
    if (!text) continue;
    let start = Number(item?.startSec);
    let end = Number(item?.endSec);
    if (!Number.isFinite(start)) continue;
    if (!Number.isFinite(end)) end = start + 0.4;
    start = Math.max(0, start);
    end = Math.max(start + 0.05, end);
    if (maxSec != null) {
      start = Math.min(start, maxSec);
      end = Math.min(end, maxSec);
    }
    if (end - start < 0.05) continue;
    valid.push({ startSec: start, endSec: end, text });
  }
  valid.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const out: TranscriptionSegment[] = [];
  for (const seg of valid) {
    const prev = out[out.length - 1];
    if (prev && seg.startSec < prev.endSec) {
      prev.endSec = Math.max(prev.startSec + 0.05, seg.startSec);
    }
    if (seg.endSec - seg.startSec < 0.05) continue;
    out.push(seg);
  }
  return out;
}

/** Fim de frase: a legenda fecha antes da próxima (mesmo sem pausa). */
export function isSentenceEnd(text: string): boolean {
  return /[.!?…]$/.test(text.trim());
}

function joinWord(current: string, piece: string): string {
  if (!current) return piece;
  if (/^[,.;:!?%)\]]/.test(piece)) return `${current}${piece}`;
  return `${current} ${piece}`;
}

export interface GroupWordsOptions {
  /** Máximo de caracteres por bloco (default 42). */
  maxChars?: number;
  /** Duração máxima de um bloco em segundos (default 6). */
  maxDurationSec?: number;
  /** Pausa que fecha o bloco em segundos (default 0,6). */
  gapSec?: number;
  /**
   * Tamanho mínimo para fechar no ponto final (default 12). Falas curtas
   * ("olha.", "é.") viram blocos de uma palavra quando o modelo pontua
   * cada interjeição — melhor juntar com o que vem depois.
   */
  minSentenceChars?: number;
}

/**
 * Junta palavras com tempo em blocos de legenda. Usado pelos providers
 * que só dão timestamps de palavra (Vosk, AssemblyAI, ElevenLabs) e como
 * reserva quando o provider esquece os segmentos.
 */
export function groupWordsIntoSegments(
  words: TimedWord[],
  opts: GroupWordsOptions = {},
): TranscriptionSegment[] {
  const maxChars = Math.max(8, Math.floor(opts.maxChars ?? 42));
  const maxDurationSec = Math.max(1, Number(opts.maxDurationSec ?? 6));
  const gapSec = Math.max(0, Number(opts.gapSec ?? 0.6));
  const minSentenceChars = Math.max(0, Number(opts.minSentenceChars ?? 12));
  const out: TranscriptionSegment[] = [];
  let text = '';
  let startSec: number | null = null;
  let endSec = 0;

  const flush = () => {
    const clean = normalizeSegmentText(text);
    if (clean && startSec != null && endSec > startSec) {
      out.push({ startSec, endSec, text: clean });
    }
    text = '';
    startSec = null;
    endSec = 0;
  };

  const list = words ?? [];
  for (let i = 0; i < list.length; i++) {
    const word = list[i];
    const piece = normalizeSegmentText(word?.text);
    const wStart = Number(word?.startSec);
    const wEnd = Number(word?.endSec);
    if (!piece || !Number.isFinite(wStart)) continue;
    const start = Math.max(0, wStart);
    const end = Number.isFinite(wEnd) ? Math.max(start + 0.05, wEnd) : start + 0.2;
    if (startSec != null) {
      const tooLate = end - startSec > maxDurationSec;
      const tooFar = start - endSec > gapSec;
      const tooLong = joinWord(text, piece).length > maxChars;
      if (tooLate || tooFar || tooLong) flush();
    }
    if (startSec == null) startSec = start;
    text = joinWord(text, piece);
    endSec = Math.max(endSec, end);
    if (isSentenceEnd(piece)) {
      const nextStart = Number(list[i + 1]?.startSec);
      const pauseAfter = !Number.isFinite(nextStart) || nextStart - end > gapSec;
      if (text.length >= minSentenceChars || pauseAfter) flush();
    }
  }
  flush();
  return sanitizeSegments(out);
}

/** Texto sem timestamps vira UM bloco (providers que não dão tempo). */
export function singleSegment(text: string, audioSec: number): TranscriptionSegment[] {
  const clean = normalizeSegmentText(text);
  if (!clean) return [];
  const dur = Number.isFinite(audioSec) && audioSec > 0 ? audioSec : 1;
  return [{ startSec: 0, endSec: dur, text: clean }];
}
