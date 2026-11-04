/** OpenAI: Whisper (com tempos) e GPT-4o Transcribe (sem tempos). */
import { getModelInfo } from '../registry.js';
import { requireEnvKey, type ProviderRequest, type ProviderTranscript } from './common.js';
import { transcribe as transcribeCompatible } from './openaiCompatible.js';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const info = getModelInfo('openai', req.model);
  return transcribeCompatible({
    ...req,
    url: ENDPOINT,
    apiKey: requireEnvKey('OPENAI_API_KEY'),
    timestamps: info?.timestamps ?? false,
  });
}
