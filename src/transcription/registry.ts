/**
 * Registro dos providers de transcrição: TUDO que o painel e o relatório
 * precisam (custo, velocidade medida, timestamps, setup) num lugar só.
 *
 * Os números de velocidade foram medidos nesta máquina (i5-12400F, CPU)
 * com o clip de 142,86s do YEKINDAR, salvo quando marcados como
 * estimativa. Custo é sempre em USD por HORA de áudio (local = 0).
 */
import type { TranscriptionProviderId } from './types.js';

export interface TranscriptionModelInfo {
  id: string;
  label: string;
  /** USD por hora de áudio (0 = local). */
  costUsdPerHour: number;
  /** Segundos de parede por minuto de áudio (medido nesta máquina). */
  measuredWallSecPerAudioMin?: number;
  /** Segundos de parede por minuto de áudio (estimativa/documentação). */
  estimatedWallSecPerAudioMin?: number;
  /** A API devolve timestamps utilizáveis (segmento ou palavra)? */
  timestamps: boolean;
  note?: string;
}

export interface TranscriptionProviderInfo {
  id: TranscriptionProviderId;
  label: string;
  kind: 'local' | 'cloud';
  defaultModel: string;
  models: TranscriptionModelInfo[];
  /** Env (nome) com a credencial; ausente nos locais. */
  requiresKeyEnv?: string;
  /** Detecta o idioma sozinho (`auto`) em vez de exigir modelo por idioma. */
  languageAuto: boolean;
  supportsVad: boolean;
  /** Setup e limites curtos (aparece no painel/relatório). */
  notes: string;
  /** Evidência de velocidade (dos clips reais), vazia = não medido. */
  speedNote: string;
  /** Algum modelo foi medido localmente? */
  measured: boolean;
}

export const PROVIDER_IDS = [
  'faster-whisper',
  'whisper-cpp',
  'vosk',
  'gemini',
  'openai',
  'groq',
  'deepgram',
  'assemblyai',
  'elevenlabs',
] as const satisfies readonly TranscriptionProviderId[];

export const PROVIDERS: TranscriptionProviderInfo[] = [
  {
    id: 'faster-whisper',
    label: 'Faster-Whisper (local)',
    kind: 'local',
    defaultModel: 'small',
    models: [
      {
        id: 'small',
        label: 'Small (int8)',
        costUsdPerHour: 0,
        measuredWallSecPerAudioMin: 13.4,
        timestamps: true,
        note: '32,0s no clip de 142,86s com VAD (13,4 s/min); medição anterior deu 15,11 s/min.',
      },
      {
        id: 'medium',
        label: 'Medium (int8)',
        costUsdPerHour: 0,
        measuredWallSecPerAudioMin: 40.73,
        timestamps: true,
        note: '40,73 s/min; melhor qualidade, ~2,7x mais lento.',
      },
      {
        id: 'large-v3',
        label: 'Large v3 (int8)',
        costUsdPerHour: 0,
        estimatedWallSecPerAudioMin: 80,
        timestamps: true,
        note: 'Estimado ~80 s/min (não medido; deve ficar ~2x o medium).',
      },
    ],
    languageAuto: true,
    supportsVad: true,
    notes:
      'Requer Python 3.12 + venv em .tools/py312 (faster-whisper e av 14.2). Modelos ficam em .tools/hf-cache.',
    speedNote: '13,4 s por minuto de áudio (small int8, VAD, CPU).',
    measured: true,
  },
  {
    id: 'whisper-cpp',
    label: 'whisper.cpp (local)',
    kind: 'local',
    defaultModel: 'small',
    models: [
      {
        id: 'small',
        label: 'Small (ggml, fp32)',
        costUsdPerHour: 0,
        measuredWallSecPerAudioMin: 35.9,
        timestamps: true,
        note: '51,3s no clip de 142,86s com Silero VAD (35,9 s/min); rodada isolada já deu 37,5s — varia com a carga da máquina.',
      },
      {
        id: 'large-v3-turbo-q5_0',
        label: 'Large v3 Turbo (q5_0)',
        costUsdPerHour: 0,
        measuredWallSecPerAudioMin: 34.08,
        timestamps: true,
        note: '34,08 s/min; mais lento que o small na CPU.',
      },
      {
        id: 'medium',
        label: 'Medium (ggml)',
        costUsdPerHour: 0,
        estimatedWallSecPerAudioMin: 45,
        timestamps: true,
        note: 'Estimado ~45 s/min (não medido).',
      },
      {
        id: 'large-v3-q5_0',
        label: 'Large v3 (q5_0)',
        costUsdPerHour: 0,
        estimatedWallSecPerAudioMin: 80,
        timestamps: true,
        note: 'Estimado ~80 s/min (não medido).',
      },
    ],
    languageAuto: true,
    supportsVad: true,
    notes:
      'Exige .tools/whisper.cpp/Release/whisper-cli.exe e o .bin em .tools/models/ggml. Vulkan só via build (sem pacote pronto p/ Windows).',
    speedNote: '35,9 s por minuto de áudio (small + Silero VAD, CPU); varia com a carga da máquina.',
    measured: true,
  },
  {
    id: 'vosk',
    label: 'Vosk (local, pt-BR)',
    kind: 'local',
    defaultModel: 'vosk-model-small-pt-0.3',
    models: [
      {
        id: 'vosk-model-small-pt-0.3',
        label: 'Small PT (31 MB)',
        costUsdPerHour: 0,
        measuredWallSecPerAudioMin: 13.48,
        timestamps: true,
        note: 'Rápido, mas sem pontuação e precisão baixa (WER 68,9% no Coraa).',
      },
    ],
    languageAuto: false,
    supportsVad: false,
    notes:
      'Modelo fixo de português em .tools/models/vosk/vosk-model-small-pt-0.3. Sem tradução e sem detectar outro idioma.',
    speedNote:
      '13,5 s por minuto de áudio — no mesmo nível do faster-whisper (13,4), mas sem pontuação e com precisão baixa.',
    measured: true,
  },
  {
    id: 'gemini',
    label: 'Gemini API (nuvem)',
    kind: 'cloud',
    defaultModel: 'gemini-3.5-transcribe',
    models: [
      {
        id: 'gemini-3.5-transcribe',
        label: 'Gemini 3.5 Transcribe',
        costUsdPerHour: 0.3,
        measuredWallSecPerAudioMin: 3.4,
        timestamps: true,
        note: 'Word timestamps, diarização e 85+ idiomas. O áudio vai INLINE (16 kHz mono): o pedido cabe em ~20 MB ≈ 10 min de áudio por chamada.',
      },
      {
        id: 'gemini-3-flash-preview',
        label: 'Gemini 3 Flash (legenda atual)',
        costUsdPerHour: 0.3,
        estimatedWallSecPerAudioMin: 10.5,
        timestamps: true,
        note: 'Modelo usado hoje no pipeline de legenda dos Shorts.',
      },
    ],
    requiresKeyEnv: 'GEMINI_API_KEY',
    languageAuto: true,
    supportsVad: false,
    notes:
      'Custo por token ($2/M entrada + $12/M saída; ~$0,005/min). O áudio vai inline em 16 kHz mono (≈32 KB/s): ~20 MB ≈ 10 min de áudio por chamada.',
    speedNote: '8,0 s no clipe de 142,86 s (3,4 s/min) — 51 blocos, pt-BR.',
    measured: true,
  },
  {
    id: 'openai',
    label: 'OpenAI (nuvem)',
    kind: 'cloud',
    defaultModel: 'gpt-4o-mini-transcribe',
    models: [
      {
        id: 'gpt-4o-mini-transcribe',
        label: 'GPT-4o mini Transcribe',
        costUsdPerHour: 0.18,
        timestamps: false,
        note: 'Sem timestamps: a legenda sai num bloco único.',
      },
      {
        id: 'gpt-4o-transcribe',
        label: 'GPT-4o Transcribe',
        costUsdPerHour: 0.36,
        timestamps: false,
        note: 'Sem timestamps: a legenda sai num bloco único.',
      },
      {
        id: 'whisper-1',
        label: 'Whisper 1',
        costUsdPerHour: 0.36,
        timestamps: true,
        note: 'verbose_json com segmentos.',
      },
    ],
    requiresKeyEnv: 'OPENAI_API_KEY',
    languageAuto: true,
    supportsVad: false,
    notes:
      'Usa OPENAI_API_KEY. Limite de 25 MB por arquivo (WAV 16 kHz mono fica bem abaixo).',
    speedNote: 'Não medido (sem chave nesta máquina).',
    measured: false,
  },
  {
    id: 'groq',
    label: 'Groq (nuvem)',
    kind: 'cloud',
    defaultModel: 'whisper-large-v3-turbo',
    models: [
      {
        id: 'whisper-large-v3-turbo',
        label: 'Whisper Large v3 Turbo',
        costUsdPerHour: 0.04,
        estimatedWallSecPerAudioMin: 0.28,
        timestamps: true,
        note: 'RTF 216 documentado (216x tempo real).',
      },
      {
        id: 'whisper-large-v3',
        label: 'Whisper Large v3',
        costUsdPerHour: 0.111,
        estimatedWallSecPerAudioMin: 0.32,
        timestamps: true,
        note: 'RTF 189 documentado; WER 10,3% (o turbo fica em 12%).',
      },
    ],
    requiresKeyEnv: 'GROQ_API_KEY',
    languageAuto: true,
    supportsVad: false,
    notes:
      'Usa GROQ_API_KEY. Free tier: 20 req/min, 2K req/dia, 8h de áudio/dia; máx. 25 MB por arquivo.',
    speedNote: '0,3 s por minuto de áudio (RTF documentado, não medido).',
    measured: false,
  },
  {
    id: 'deepgram',
    label: 'Deepgram (nuvem)',
    kind: 'cloud',
    defaultModel: 'nova-3',
    models: [
      {
        id: 'nova-3',
        label: 'Nova 3',
        costUsdPerHour: 0.258,
        timestamps: true,
        note: 'Utterances + words; language=multi detecta o idioma.',
      },
    ],
    requiresKeyEnv: 'DEEPGRAM_API_KEY',
    languageAuto: true,
    supportsVad: false,
    notes:
      'Usa DEEPGRAM_API_KEY. Envia o WAV como corpo binário e pede utterances (smart_format + pontuação).',
    speedNote: 'Não medido (sem chave nesta máquina).',
    measured: false,
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI (nuvem)',
    kind: 'cloud',
    defaultModel: 'best',
    models: [
      {
        id: 'best',
        label: 'Best (Universal-3.5 Pro)',
        costUsdPerHour: 0.21,
        timestamps: true,
        note: '$0,21/h; melhor precisão da casa.',
      },
      {
        id: 'nano',
        label: 'Nano (rápido)',
        costUsdPerHour: 0.15,
        timestamps: true,
        note: '$0,15/h; mais barato/rápido, precisão menor.',
      },
    ],
    requiresKeyEnv: 'ASSEMBLYAI_API_KEY',
    languageAuto: true,
    supportsVad: false,
    notes:
      'Usa ASSEMBLYAI_API_KEY. Fluxo em duas etapas (upload + job com polling); $50 de crédito inicial.',
    speedNote: 'Não medido (sem chave nesta máquina).',
    measured: false,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs Scribe (nuvem)',
    kind: 'cloud',
    defaultModel: 'scribe_v2',
    models: [
      {
        id: 'scribe_v2',
        label: 'Scribe v2',
        costUsdPerHour: 0.22,
        timestamps: true,
        note: 'Word timestamps; $0,22/h (Realtime custa $0,39/h).',
      },
    ],
    requiresKeyEnv: 'ELEVENLABS_API_KEY',
    languageAuto: true,
    supportsVad: false,
    notes:
      'Usa ELEVENLABS_API_KEY. Multipart com o WAV; resposta traz words com start/end.',
    speedNote: 'Não medido (sem chave nesta máquina).',
    measured: false,
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Provider pelo id (undefined se desconhecido). */
export function getProviderInfo(id: string): TranscriptionProviderInfo | undefined {
  return BY_ID.get(id as TranscriptionProviderId);
}

/** O id é um provider conhecido? (guarda de config/CLI) */
export function isProviderId(value: string): value is TranscriptionProviderId {
  return BY_ID.has(value as TranscriptionProviderId);
}

/** Informações do provider; erro claro se o id não existe. */
export function requireProviderInfo(id: string): TranscriptionProviderInfo {
  const info = getProviderInfo(id);
  if (!info) throw new Error(`provider de transcrição desconhecido: ${id}`);
  return info;
}

/** Modelo pelo id dentro do provider (undefined se não listado). */
export function getModelInfo(
  provider: TranscriptionProviderId,
  model: string,
): TranscriptionModelInfo | undefined {
  return requireProviderInfo(provider).models.find((m) => m.id === model);
}

/** Modelo padrão do provider. */
export function defaultModelFor(provider: TranscriptionProviderId): string {
  return requireProviderInfo(provider).defaultModel;
}

/** Custo estimado (USD) para uma duração de áudio (s). */
export function estimateCostUsd(
  provider: TranscriptionProviderId,
  model: string,
  audioSec: number,
): number {
  const info = requireProviderInfo(provider);
  const chosen = getModelInfo(provider, model) ?? info.models[0];
  const sec = Number(audioSec);
  if (!chosen || !Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round((chosen.costUsdPerHour * (sec / 3600)) * 1e6) / 1e6;
}

/** Opções do select do painel (id + rótulo curto). */
export function providerSelectOptions(): Array<{ value: string; label: string }> {
  return PROVIDERS.map((p) => ({ value: p.id, label: p.label }));
}

/** Lista de modelos do provider para a ajuda do painel/CLI. */
export function modelIdsFor(provider: TranscriptionProviderId): string[] {
  return requireProviderInfo(provider).models.map((m) => m.id);
}
