/**
 * API compatível com `/v1/audio/transcriptions` da OpenAI (OpenAI e
 * Groq). Multipart com o WAV; `verbose_json` quando o modelo devolve
 * segmentos (Whisper), `json` quando não devolve (GPT-4o Transcribe).
 */
import fs from 'node:fs';
import {
  asRecord,
  asRecordArray,
  asText,
  fetchWithTimeout,
  readJsonResponse,
} from '../http.js';
import { groupWordsIntoSegments, sanitizeSegments, singleSegment } from '../segments.js';
import {
  timedWordsFromRecords,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

export interface OpenAICompatibleRequest extends ProviderRequest {
  url: string;
  apiKey: string;
  /** Pede verbose_json com segmentos (só Whisper aceita). */
  timestamps: boolean;
}

export async function transcribe(
  req: OpenAICompatibleRequest,
): Promise<ProviderTranscript> {
  const bytes = new Uint8Array(fs.readFileSync(req.wavPath));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', req.model);
  form.append('response_format', req.timestamps ? 'verbose_json' : 'json');
  form.append('temperature', '0');
  if (req.language) form.append('language', req.language);
  const res = await fetchWithTimeout(
    req.url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${req.apiKey}` },
      body: form,
    },
    req.timeoutMs,
  );
  const body = asRecord(await readJsonResponse(res));
  const language = asText(body.language).trim() || req.language;
  const audioSec = req.audioSec ?? 0;
  if (!req.timestamps) {
    return { language, segments: singleSegment(asText(body.text), audioSec) };
  }
  const segments = sanitizeSegments(
    asRecordArray(body.segments).map((seg) => ({
      startSec: seg.start,
      endSec: seg.end,
      text: seg.text,
    })),
    audioSec,
  );
  if (segments.length > 0) return { language, segments };
  const words = timedWordsFromRecords(asRecordArray(body.words));
  if (words.length > 0) {
    return { language, segments: groupWordsIntoSegments(words) };
  }
  return { language, segments: singleSegment(asText(body.text), audioSec) };
}
