/**
 * AssemblyAI: upload do WAV, criação do job e polling até terminar.
 * O `words` (ms) vira bloco de legenda pela função pura compartilhada.
 */
import fs from 'node:fs';
import {
  asRecord,
  asRecordArray,
  asText,
  fetchWithTimeout,
  postJson,
  readJsonResponse,
} from '../http.js';
import { groupWordsIntoSegments, sanitizeSegments, singleSegment } from '../segments.js';
import {
  requireEnvKey,
  timedWordsFromRecords,
  type ProviderRequest,
  type ProviderTranscript,
} from './common.js';

const BASE = 'https://api.assemblyai.com/v2';
const POLL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const apiKey = requireEnvKey('ASSEMBLYAI_API_KEY');
  const auth = { authorization: apiKey };
  const bytes = new Uint8Array(fs.readFileSync(req.wavPath));
  const uploadRes = await fetchWithTimeout(
    `${BASE}/upload`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    },
    req.timeoutMs,
  );
  const upload = asRecord(await readJsonResponse(uploadRes));
  const audioUrl = asText(upload.upload_url);
  if (!audioUrl) throw new Error('AssemblyAI: upload sem upload_url');

  const created = asRecord(
    await postJson(
      `${BASE}/transcript`,
      {
        audio_url: audioUrl,
        speech_model: req.model,
        punctuate: true,
        format_text: true,
        ...(req.language
          ? { language_code: req.language }
          : { language_detection: true }),
      },
      auth,
      req.timeoutMs,
    ),
  );
  const jobId = asText(created.id);
  if (!jobId) throw new Error('AssemblyAI: job sem id');

  const deadline = Date.now() + Math.max(10_000, req.timeoutMs);
  let job: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(
      `${BASE}/transcript/${jobId}`,
      { headers: auth },
      Math.min(30_000, req.timeoutMs),
    );
    job = asRecord(await readJsonResponse(res));
    const status = asText(job.status);
    if (status === 'completed') break;
    if (status === 'error') {
      throw new Error(`AssemblyAI: ${asText(job.error) || 'job falhou'}`);
    }
    await sleep(POLL_MS);
  }
  if (asText(job.status) !== 'completed') {
    throw new Error(`AssemblyAI: timeout aguardando o job (${asText(job.status)})`);
  }

  const language = asText(job.language_code).trim() || req.language;
  const audioSec = req.audioSec ?? 0;
  const utterances = asRecordArray(job.utterances);
  if (utterances.length > 0) {
    return {
      language,
      segments: sanitizeSegments(
        utterances.map((item) => ({
          startSec: item.start,
          endSec: item.end,
          text: item.text,
        })),
        audioSec,
      ),
    };
  }
  const words = timedWordsFromRecords(asRecordArray(job.words), { ms: true });
  if (words.length > 0) {
    return { language, segments: groupWordsIntoSegments(words) };
  }
  return { language, segments: singleSegment(asText(job.text), audioSec) };
}
