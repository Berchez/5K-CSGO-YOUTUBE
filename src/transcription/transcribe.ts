/**
 * Adapter único de transcrição: um áudio → segmentos com tempo.
 *
 * O chamador pede `provider`/`model`/`language`/`vad`; o dispatcher
 * extrai o WAV, chama o provider certo e devolve o mesmo
 * `TranscriptResult`. Credencial e binário ausentes viram erro claro
 * (nunca um clipe com legenda vazia em silêncio).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoPath } from '../paths.js';
import { getConfig, type AppConfig } from '../config.js';
import {
  defaultModelFor,
  isProviderId,
  PROVIDERS,
  requireProviderInfo,
} from './registry.js';
import {
  extractAudioWav,
  resolveVoskModelDir,
  resolveWhisperCppBin,
  resolveWhisperCppModel,
  wavDurationSecFromBytes,
} from './audio.js';
import { normalizeLanguageCode, sanitizeSegments } from './segments.js';
import { toTranscript, transcriptExtension } from './export.js';
import type {
  ProviderStatus,
  TranscribeFileOptions,
  TranscribeOptions,
  TranscriptFormat,
  TranscriptResult,
  TranscriptionProviderId,
} from './types.js';
import type { ProviderRequest, ProviderTranscript } from './providers/common.js';
import { transcribe as transcribeFasterWhisper } from './providers/fasterWhisper.js';
import { transcribe as transcribeWhisperCpp } from './providers/whisperCpp.js';
import { transcribe as transcribeVosk } from './providers/vosk.js';
import { transcribe as transcribeGemini } from './providers/gemini.js';
import { transcribe as transcribeOpenai } from './providers/openai.js';
import { transcribe as transcribeGroq } from './providers/groq.js';
import { transcribe as transcribeDeepgram } from './providers/deepgram.js';
import { transcribe as transcribeAssemblyAi } from './providers/assemblyai.js';
import { transcribe as transcribeElevenLabs } from './providers/elevenlabs.js';

export interface ResolvedTranscriptionOptions {
  provider: TranscriptionProviderId;
  model: string;
  language: string | null;
  vad: boolean;
  timeoutMs: number;
}

const TRANSCRIBERS: Record<
  TranscriptionProviderId,
  (req: ProviderRequest) => Promise<ProviderTranscript>
> = {
  'faster-whisper': transcribeFasterWhisper,
  'whisper-cpp': transcribeWhisperCpp,
  vosk: transcribeVosk,
  gemini: transcribeGemini,
  openai: transcribeOpenai,
  groq: transcribeGroq,
  deepgram: transcribeDeepgram,
  assemblyai: transcribeAssemblyAi,
  elevenlabs: transcribeElevenLabs,
};

/** Aplica os defaults da config e valida provider/modelo/idioma. */
export function resolveTranscriptionOptions(
  opts: TranscribeOptions = {},
  cfg: AppConfig,
): ResolvedTranscriptionOptions {
  const provider = opts.provider ?? cfg.TRANSCRIPTION_PROVIDER;
  if (!isProviderId(provider)) {
    throw new Error(`provider de transcrição desconhecido: ${provider}`);
  }
  const info = requireProviderInfo(provider);
  const fromCfg = provider === cfg.TRANSCRIPTION_PROVIDER ? cfg.TRANSCRIPTION_MODEL : '';
  const wanted = String(opts.model ?? fromCfg ?? '').trim();
  const model = wanted || defaultModelFor(provider);
  const language = normalizeLanguageCode(opts.language ?? cfg.TRANSCRIPTION_LANGUAGE);
  const vad = info.supportsVad ? (opts.vad ?? cfg.TRANSCRIPTION_VAD) : false;
  const timeoutMs = Math.max(10_000, opts.timeoutMs ?? cfg.TRANSCRIPTION_TIMEOUT_MS);
  return { provider, model, language, vad, timeoutMs };
}

/** Transcrição completa de um vídeo/clipe (extrai o WAV e descarta). */
export async function transcribeVideo(
  videoPath: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`vídeo não encontrado: ${videoPath}`);
  }
  const cfg = getConfig();
  const resolved = resolveTranscriptionOptions(opts, cfg);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '5k-asr-'));
  try {
    const wavPath = path.join(tmpDir, 'audio.wav');
    await extractAudioWav(videoPath, wavPath, Math.min(resolved.timeoutMs, 180_000));
    const audioSec = wavDurationSecFromBytes(fs.statSync(wavPath).size);
    if (audioSec <= 0) throw new Error('o vídeo não tem áudio utilizável');
    const startedAt = Date.now();
    const provider = TRANSCRIBERS[resolved.provider];
    const raw = await provider({
      wavPath,
      audioSec,
      model: resolved.model,
      language: resolved.language,
      vad: resolved.vad,
      timeoutMs: resolved.timeoutMs,
    });
    const segments = sanitizeSegments(raw.segments, audioSec);
    return {
      provider: resolved.provider,
      model: resolved.model,
      language: raw.language ?? resolved.language,
      segments,
      audioSec,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Transcrição + gravação da legenda (SRT/VTT/TXT). */
export async function transcribeToFile(
  videoPath: string,
  opts: TranscribeFileOptions = {},
): Promise<{ result: TranscriptResult; outPath: string }> {
  const cfg = getConfig();
  const result = await transcribeVideo(videoPath, opts);
  const format: TranscriptFormat = opts.format ?? cfg.TRANSCRIPTION_OUTPUT_FORMAT;
  const outPath = opts.outPath ?? defaultTranscriptPath(videoPath, format);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, toTranscript(result.segments, format), 'utf8');
  return { result, outPath };
}

/** `clip.mp4` + `srt` → `clip.srt` (no mesmo diretório). */
export function defaultTranscriptPath(videoPath: string, format: TranscriptFormat): string {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}.${transcriptExtension(format)}`);
}

export interface StatusRuntime {
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
}

function defaultRuntime(): StatusRuntime {
  return { env: process.env, exists: (file) => fs.existsSync(file) };
}

function pythonFrom(rt: StatusRuntime): string | null {
  const override = String(rt.env.TRANSCRIPTION_PYTHON ?? '').trim();
  if (override) return override;
  const candidates =
    process.platform === 'win32'
      ? [
          path.resolve('.tools', 'py312', 'Scripts', 'python.exe'),
          path.resolve('.tools', 'py312', 'python.exe'),
        ]
      : [
          path.resolve('.tools', 'py312', 'bin', 'python'),
          path.resolve('.tools', 'py312', 'bin', 'python3'),
        ];
  return candidates.find((candidate) => rt.exists(candidate)) ?? null;
}

/**
 * O que está pronto NESTA máquina: binário/modelo/credencial presentes.
 * Puro o bastante para testar (env + exists injetados).
 */
export function providerStatus(rt: StatusRuntime = defaultRuntime()): ProviderStatus[] {
  return PROVIDERS.map((info) => {
    const label = info.label;
    if (info.requiresKeyEnv) {
      const ready = String(rt.env[info.requiresKeyEnv] ?? '').trim().length > 0;
      return {
        id: info.id,
        label,
        ready,
        reason: ready ? '' : `defina ${info.requiresKeyEnv} no .env`,
      };
    }
    if (info.id === 'faster-whisper') {
      const python = pythonFrom(rt);
      const script = repoPath('scripts', 'transcribe-faster-whisper.py');
      const ready = !!python && rt.exists(script);
      return {
        id: info.id,
        label,
        ready,
        reason: ready ? '' : 'crie o venv .tools/py312 (Python 3.12 + faster-whisper)',
      };
    }
    if (info.id === 'whisper-cpp') {
      const ready =
        rt.exists(resolveWhisperCppBin()) &&
        rt.exists(resolveWhisperCppModel(info.defaultModel));
      return {
        id: info.id,
        label,
        ready,
        reason: ready ? '' : 'baixe o whisper-cli e o modelo ggml para .tools',
      };
    }
    const ready =
      !!pythonFrom(rt) && rt.exists(resolveVoskModelDir(info.defaultModel));
    return {
      id: info.id,
      label,
      ready,
      reason: ready ? '' : 'baixe o modelo Vosk para .tools/models/vosk',
    };
  });
}

/** Atalho usado pelo CLI para avisar o que falta antes de transcrever. */
export function providerReady(id: TranscriptionProviderId): ProviderStatus {
  const status = providerStatus().find((item) => item.id === id);
  return (
    status ?? { id, label: id, ready: false, reason: 'provider desconhecido' }
  );
}
