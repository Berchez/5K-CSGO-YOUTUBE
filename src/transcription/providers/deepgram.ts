/**
 * Deepgram (Nova-3): WAV no corpo binário. Pede utterances (blocos com
 * tempo) e cai para words/transcript se a resposta não trouxer.
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
  requireEnvKey,
  timedWordsFromRecords,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

const URL = 'https://api.deepgram.com/v1/listen';

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const apiKey = requireEnvKey('DEEPGRAM_API_KEY');
  const params = new URLSearchParams({
    model: req.model,
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    // Nova-3 aceita `multi`; é o jeito de não fixar inglês quando o
    // idioma não foi escolhido.
    language: req.language ?? 'multi',
  });
  const bytes = new Uint8Array(fs.readFileSync(req.wavPath));
  const res = await fetchWithTimeout(
    `${URL}?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: bytes,
    },
    req.timeoutMs,
  );
  const body = asRecord(await readJsonResponse(res));
  const results = asRecord(body.results);
  const audioSec = req.audioSec ?? 0;
  const channel = asRecordArray(results.channels)[0] ?? {};
  const alternative = asRecordArray(channel.alternatives)[0] ?? {};
  const language =
    asText(channel.detected_language).trim() ||
    asText(body.language).trim() ||
    req.language;

  const utterances = asRecordArray(results.utterances);
  if (utterances.length > 0) {
    return {
      language,
      segments: sanitizeSegments(
        utterances.map((item) => ({
          startSec: item.start,
          endSec: item.end,
          text: item.transcript,
        })),
        audioSec,
      ),
    };
  }
  const words = timedWordsFromRecords(asRecordArray(alternative.words));
  if (words.length > 0) {
    return { language, segments: groupWordsIntoSegments(words) };
  }
  return {
    language,
    segments: singleSegment(asText(alternative.transcript), audioSec),
  };
}
