/**
 * ElevenLabs Scribe v2: multipart com o WAV, resposta com palavras e
 * tempos (os tokens de espaço/evento são descartados).
 */
import fs from 'node:fs';
import {
  asRecord,
  asRecordArray,
  asText,
  fetchWithTimeout,
  readJsonResponse,
} from '../http.js';
import { groupWordsIntoSegments, singleSegment } from '../segments.js';
import {
  requireEnvKey,
  timedWordsFromRecords,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const apiKey = requireEnvKey('ELEVENLABS_API_KEY');
  const bytes = new Uint8Array(fs.readFileSync(req.wavPath));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model_id', req.model);
  if (req.language) form.append('language_code', req.language);
  const res = await fetchWithTimeout(
    ENDPOINT,
    { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
    req.timeoutMs,
  );
  const body = asRecord(await readJsonResponse(res));
  const words = timedWordsFromRecords(asRecordArray(body.words), {
    textKeys: ['text'],
    skipTypes: ['spacing', 'audio_event'],
  });
  const language = asText(body.language_code).trim() || req.language;
  const audioSec = req.audioSec ?? 0;
  if (words.length > 0) {
    return { language, segments: groupWordsIntoSegments(words) };
  }
  return { language, segments: singleSegment(asText(body.text), audioSec) };
}
