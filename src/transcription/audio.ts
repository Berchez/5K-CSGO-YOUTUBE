/**
 * Áudio e binários do subsistema de transcrição.
 *
 * Todos os providers recebem o MESMO WAV (16 kHz, mono, PCM 16 bits):
 * evita que cada API lide com o mp4 e faz o custo/tamanho ficar
 * previsível (1 min ≈ 1,9 MB). O ffmpeg vem do resolver do clipper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { repoPath } from '../paths.js';
import { resolveFfmpegBin } from '../clipper/segmentProbe.js';

const execFileAsync = promisify(execFile);

/** Bytes por segundo do WAV que o ffmpeg gera (16000 × 2). */
export const WAV_BYTES_PER_SEC = 32_000;
/** Cabeçalho WAV (RIFF) aproximado. */
export const WAV_HEADER_BYTES = 44;

/** Duração de um WAV 16 kHz mono a partir do tamanho (puro/testável). */
export function wavDurationSecFromBytes(bytes: number): number {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= WAV_HEADER_BYTES) return 0;
  return Math.round(((size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SEC) * 1000) / 1000;
}

/** Extrai o áudio do vídeo num WAV 16 kHz mono (sobrescreve o destino). */
export async function extractAudioWav(
  videoPath: string,
  outPath: string,
  timeoutMs = 180_000,
): Promise<string> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await execFileAsync(
    resolveFfmpegBin(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostats',
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outPath,
    ],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 },
  );
  return outPath;
}

/** Python do venv do faster-whisper/vosk (ou PATH). */
export function resolvePythonBin(): string | null {
  const override = String(process.env.TRANSCRIPTION_PYTHON ?? '').trim();
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
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // segue
    }
  }
  const fallback = process.platform === 'win32' ? 'python' : 'python3';
  try {
    execFileSync(fallback, ['--version'], { stdio: 'ignore', windowsHide: true });
    return fallback;
  } catch {
    return null;
  }
}

/** Script Python do worker (fica em scripts/, fora do build TS). */
export function resolveWorkerScript(name: string): string {
  const full = repoPath('scripts', name);
  if (!fs.existsSync(full)) {
    throw new Error(`script de transcrição ausente: ${full}`);
  }
  return full;
}

/** Binário do whisper.cpp (Release/ ou raiz do pacote). */
export function resolveWhisperCppBin(): string {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const candidates = [
    path.resolve('.tools', 'whisper.cpp', 'Release', exe),
    path.resolve('.tools', 'whisper.cpp', exe),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/** Modelos ggml (small/medium/large-v3-q5_0/turbo-q5_0 + silero-vad). */
export function whisperCppModelsDir(): string {
  return path.resolve('.tools', 'models', 'ggml');
}

/** Caminho do .bin do modelo (`small` → ggml-small.bin; path é aceito). */
export function resolveWhisperCppModel(model: string): string {
  const value = String(model ?? '').trim();
  if (!value) throw new Error('modelo ggml vazio');
  if (/\.bin$/i.test(value) || /[/\\]/.test(value)) {
    return path.isAbsolute(value) ? value : path.resolve(value);
  }
  const file = value.startsWith('ggml-') ? `${value}.bin` : `ggml-${value}.bin`;
  return path.join(whisperCppModelsDir(), file);
}

/** Modelo do Silero VAD do whisper.cpp. */
export function resolveSileroVadModel(): string {
  return path.join(whisperCppModelsDir(), 'ggml-silero-v5.1.2.bin');
}

/** Pasta do modelo Vosk (`vosk-model-small-pt-0.3` → .tools/models/vosk/...). */
export function resolveVoskModelDir(model: string): string {
  const value = String(model ?? '').trim();
  if (!value) throw new Error('modelo vosk vazio');
  if (path.isAbsolute(value) || /[/\\]/.test(value)) {
    return path.isAbsolute(value) ? value : path.resolve(value);
  }
  return path.resolve('.tools', 'models', 'vosk', value);
}
