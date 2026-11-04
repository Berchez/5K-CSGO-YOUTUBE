/**
 * Gemini (API) como transcritor. O `gemini-3.5-transcribe` é um modelo
 * dedicado: usa a Interactions API e devolve `word_info` com offsets
 * (`"0.100s"`). O `gemini-3-flash-preview`, usado no pipeline de legenda
 * dos Shorts, continua no `generateContent` com prompt JSON.
 */
import fs from 'node:fs';
import type { GoogleGenAI } from '@google/genai';
import { asRecord, asRecordArray, asText } from '../http.js';
import {
  groupWordsIntoSegments,
  sanitizeSegments,
  singleSegment,
} from '../segments.js';
import type { TimedWord } from '../types.js';
import {
  languageFromRecord,
  offsetToSec,
  parseLooseJson,
  requireEnvKey,
  segmentsFromJson,
  withTimeout,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

/** Modelos que usam a Interactions API de transcrição dedicada. */
export function isDedicatedTranscribeModel(model: string): boolean {
  return /^gemini-3\.5-transcribe/i.test(String(model ?? '').trim());
}

/** Código ISO-639-1 → BCP-47 (a Interactions API pede `language_codes`). */
export function toBcp47Language(language: string | null): string[] {
  const raw = String(language ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return [];
  if (raw.includes('-')) return [String(language).trim()];
  const regional: Record<string, string> = {
    pt: 'pt-BR',
    en: 'en-US',
    es: 'es-419',
    zh: 'cmn-Hans-CN',
  };
  return [regional[raw] ?? raw];
}

/** Extrai as palavras com tempo dos `annotations` da Interactions API. */
export function wordsFromInteraction(value: unknown): TimedWord[] {
  const words: TimedWord[] = [];
  for (const step of asRecordArray(asRecord(value).steps)) {
    for (const part of asRecordArray(step.content)) {
      if (asText(part.type) !== 'text') continue;
      for (const annotation of asRecordArray(part.annotations)) {
        if (asText(annotation.type) !== 'word_info') continue;
        const text = asText(annotation.text).trim();
        const startSec = offsetToSec(annotation.start_offset);
        if (!text || !Number.isFinite(startSec)) continue;
        const endSec = offsetToSec(annotation.end_offset);
        words.push({
          startSec,
          endSec: Number.isFinite(endSec) ? endSec : startSec + 0.1,
          text,
        });
      }
    }
  }
  return words;
}

/** Instrução: transcrição literal com tempo por fala (sem traduzir). */
export function buildTranscriptionPrompt(audioSec: number): string {
  return [
    'Transcreva o áudio de um trecho de transmissão de CS2 (commentário de caster).',
    '',
    'REGRAS:',
    `- O áudio tem cerca de ${Math.max(1, Math.round(audioSec))} segundos.`,
    '- "start" e "end" são segundos DEPOIS do início do áudio (0 = o primeiro segundo), com start < end.',
    '- Escreva EXATAMENTE o que é falado, no idioma original: não resuma, não traduza, não comente e não corrija nomes.',
    '- Uma entrada = uma fala curta (uma frase). Não sobreponha os tempos.',
    '- "language" é o idioma falado (ex.: "pt", "en").',
    '',
    'Responda APENAS com JSON válido:',
    '{"language":"en","segments":[{"start":1.20,"end":3.40,"text":"..."}]}',
  ].join('\n');
}

/** Transcrição dedicada (`gemini-3.5-transcribe`) via Interactions API. */
async function transcribeDedicated(
  req: ProviderRequest,
  ai: GoogleGenAI,
): Promise<ProviderTranscript> {
  const audio = fs.readFileSync(req.wavPath);
  const run = ai.interactions.create({
    model: req.model,
    input: [
      {
        type: 'audio',
        data: audio.toString('base64'),
        mime_type: 'audio/wav',
      },
    ],
    generation_config: {
      transcription_config: {
        mode: { type: 'verbatim', timestamp_granularities: ['word'] },
        ...(req.language ? { language_codes: toBcp47Language(req.language) } : {}),
      },
    },
  });
  const res = await withTimeout(run, req.timeoutMs, 'gemini-transcricao');
  const words = wordsFromInteraction(res);
  let segments = groupWordsIntoSegments(words);
  if (segments.length === 0) {
    segments = singleSegment(asText(asRecord(res).output_text), req.audioSec ?? 0);
  }
  return { language: req.language, segments };
}

/** Modelo de texto (Flash): prompt JSON via generateContent. */
async function transcribePrompted(
  req: ProviderRequest,
  ai: GoogleGenAI,
): Promise<ProviderTranscript> {
  const audio = fs.readFileSync(req.wavPath);
  const run = ai.models.generateContent({
    model: req.model,
    contents: [
      {
        inlineData: {
          mimeType: 'audio/wav',
          data: audio.toString('base64'),
        },
      },
      { text: buildTranscriptionPrompt(req.audioSec ?? 0) },
    ],
    config: { temperature: 0.1, maxOutputTokens: 16384 },
  });
  const res = await withTimeout(run, req.timeoutMs, 'gemini-transcricao');
  const parsed = parseLooseJson(res.text ?? '');
  const record = asRecord(parsed);
  let segments = sanitizeSegments(segmentsFromJson(parsed), req.audioSec);
  if (segments.length === 0) {
    segments = singleSegment(asText(record.text), req.audioSec ?? 0);
  }
  return {
    language: languageFromRecord(record) ?? req.language,
    segments,
  };
}

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const apiKey = requireEnvKey('GEMINI_API_KEY');
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  if (isDedicatedTranscribeModel(req.model)) return transcribeDedicated(req, ai);
  return transcribePrompted(req, ai);
}
