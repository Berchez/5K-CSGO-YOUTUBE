/**
 * Peças compartilhadas pelos providers: contrato interno, timeout,
 * leitura de JSON de terceiros e conversão de "palavras com tempo".
 */
import fs from 'node:fs';
import { asNumber, asRecord, asText } from '../http.js';
import type { TimedWord, TranscriptionSegment } from '../types.js';

/** Pedido já normalizado (modelo/idioma/timeout resolvidos). */
export interface ProviderRequest {
  /** WAV 16 kHz mono extraído do clipe. */
  wavPath: string;
  /** Duração do WAV (s), quando conhecida. */
  audioSec?: number;
  model: string;
  /** Código ISO-639-1 ou null = detectar. */
  language: string | null;
  vad: boolean;
  timeoutMs: number;
  /**
   * Pede timestamps por PALAVRA (providers que suportam). A legenda
   * queimada usa isso: bloco montado das palavras reais nunca fica
   * adiantado em relação à fala.
   */
  words?: boolean;
  /** Tamanho máximo do bloco (caracteres) quando o provider segmenta. */
  maxSegmentChars?: number;
}

/** Resposta crua do provider (antes do `TranscriptResult`). */
export interface ProviderTranscript {
  language: string | null;
  segments: TranscriptionSegment[];
}

/** `withTimeout` sem depender de AbortSignal do DOM. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const ms = Math.max(1_000, Number(timeoutMs) || 60_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${label} após ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Lê um JSON local (worker/CLI). */
export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

/** Credencial obrigatória com erro de setup claro. */
export function requireEnvKey(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} ausente — configure no .env para usar este provider`);
  }
  return value;
}

/** JSON devolvido por modelo de IA: aceita cercas ```json e texto em volta. */
export function parseLooseJson(raw: string): unknown {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

/** `00:01:02,500` / `01:02.5` → segundos (JSON antigo do whisper.cpp). */
export function clockToSec(value: string): number {
  const parts = String(value ?? '')
    .trim()
    .replace(',', '.')
    .split(':');
  if (parts.length < 2) return NaN;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return NaN;
  let sec = 0;
  for (const n of nums) sec = sec * 60 + n;
  return sec;
}

/**
 * Offset de tempo textual em segundos. Gemini manda `"0.100s"`; também
 * aceita `"150ms"`, `"00:01.500"` e número puro.
 */
export function offsetToSec(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const raw = asText(value).trim().replace(',', '.');
  if (!raw) return NaN;
  if (/^[\d.]+ms$/i.test(raw)) return Number(raw.slice(0, -2)) / 1000;
  if (/^[\d.]+s$/i.test(raw)) return Number(raw.slice(0, -1));
  if (raw.includes(':')) return clockToSec(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Converte as listas de "words" das APIs (Deepgram/AssemblyAI/ElevenLabs/
 * Vosk) em `TimedWord[]`. `ms` converte tempos de milissegundos.
 */
export function timedWordsFromRecords(
  records: Array<Record<string, unknown>>,
  opts: { ms?: boolean; textKeys?: string[]; skipTypes?: string[] } = {},
): TimedWord[] {
  const textKeys = opts.textKeys ?? ['text', 'word', 'transcript'];
  const skipTypes = new Set(opts.skipTypes ?? []);
  const out: TimedWord[] = [];
  for (const record of records ?? []) {
    const type = asText(record.type).toLowerCase();
    if (type && skipTypes.has(type)) continue;
    let text = '';
    for (const key of textKeys) {
      text = asText(record[key]).trim();
      if (text) break;
    }
    if (!text) continue;
    let start = asNumber(record.start ?? record.startSec);
    let end = asNumber(record.end ?? record.endSec);
    if (!Number.isFinite(start)) continue;
    if (!Number.isFinite(end)) end = start;
    if (opts.ms) {
      start /= 1000;
      end /= 1000;
    }
    out.push({ startSec: Math.max(0, start), endSec: Math.max(0, end), text });
  }
  return out;
}

/** Idioma da resposta de um objeto JSON (campo `language`/`language_code`). */
export function languageFromRecord(record: Record<string, unknown>): string | null {
  const value = asText(record.language_code) || asText(record.language);
  return value.trim() || null;
}

/** Extrai `segments` (ou `lines`) de um JSON de transcrição de IA. */
export function segmentsFromJson(value: unknown): TranscriptionSegment[] {
  const record = asRecord(value);
  const items = Array.isArray(record.segments)
    ? record.segments
    : Array.isArray(record.lines)
      ? record.lines
      : [];
  const out: TranscriptionSegment[] = [];
  for (const item of items) {
    const rec = asRecord(item);
    out.push({
      startSec: asNumber(rec.start ?? rec.startSec),
      endSec: asNumber(rec.end ?? rec.endSec),
      text: asText(rec.text),
    });
  }
  return out;
}
