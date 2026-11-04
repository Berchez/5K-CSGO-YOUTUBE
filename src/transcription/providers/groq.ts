/** Groq: Whisper Large v3/turbo pela API compatível com a da OpenAI. */
import { getModelInfo } from '../registry.js';
import { requireEnvKey, type ProviderRequest, type ProviderTranscript } from './common.js';
import { transcribe as transcribeCompatible } from './openaiCompatible.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

export async function transcribe(req: ProviderRequest): Promise<ProviderTranscript> {
  const info = getModelInfo('groq', req.model);
  return transcribeCompatible({
    ...req,
    url: ENDPOINT,
    apiKey: requireEnvKey('GROQ_API_KEY'),
    timestamps: info?.timestamps ?? true,
  });
}
