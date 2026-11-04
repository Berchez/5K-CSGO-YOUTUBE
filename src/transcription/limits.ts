/**
 * Limite de áudio por provider de transcrição (fonte única).
 *
 * O áudio vai INLINE no pedido (WAV 16 kHz mono ≈ 32 KB/s): a API só
 * rejeita DEPOIS do upload, gastando banda e tempo. A pré-checagem falha
 * cedo, com o limite do provider na mensagem.
 *
 * Os números são os limites públicos de cada API. Ajuste aqui quando o
 * provider mudar — nenhum outro lugar deve repetir esses valores.
 */
import type { TranscriptionProviderId } from './types.js';

/** Limite de áudio aceito por um provider. */
export interface ProviderAudioLimit {
  /** Bytes máx. do arquivo enviado (inline ou upload); null = sem limite. */
  maxBytes: number | null;
  /** Duração máx. do áudio (s); null = o provider não limita a duração. */
  maxSec: number | null;
  /** Como o limite é descrito (aparece na mensagem de erro). */
  note: string;
}

/** 1 MiB em bytes (os providers anunciam o limite em MB). */
const MIB = 1024 * 1024;

/**
 * Limite de cada provider. Locais (vosk/whisper) não têm upload: o WAV
 * é lido do disco, então não existe limite de tamanho.
 */
export const PROVIDER_AUDIO_LIMITS: Record<
  TranscriptionProviderId,
  ProviderAudioLimit
> = {
  'faster-whisper': {
    maxBytes: null,
    maxSec: null,
    note: 'local, sem limite de upload',
  },
  'whisper-cpp': {
    maxBytes: null,
    maxSec: null,
    note: 'local, sem limite de upload',
  },
  vosk: {
    maxBytes: null,
    maxSec: null,
    note: 'local, sem limite de upload',
  },
  gemini: {
    maxBytes: 20 * MIB,
    maxSec: 600,
    note: 'áudio inline, ~20 MB por requisição (≈10 min)',
  },
  openai: {
    maxBytes: 25 * MIB,
    maxSec: 780,
    note: '25 MB por arquivo (≈13 min)',
  },
  groq: {
    maxBytes: 25 * MIB,
    maxSec: 780,
    note: '25 MB por arquivo (≈13 min)',
  },
  deepgram: {
    maxBytes: 100 * MIB,
    maxSec: null,
    note: 'áudio no corpo binário, ~100 MB por requisição',
  },
  assemblyai: {
    maxBytes: 100 * MIB,
    maxSec: null,
    note: 'upload do WAV, ~100 MB por arquivo',
  },
  elevenlabs: {
    maxBytes: 125 * MIB,
    maxSec: null,
    note: 'multipart, ~125 MB por arquivo',
  },
};

/** Tamanho em MB no formato pt-BR (vírgula nos decimais). */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / MIB;
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

/** Duração em min/s no formato pt-BR (vírgula nos decimais). */
export function formatDuration(sec: number): string {
  if (Math.abs(sec) >= 60) {
    return `${(sec / 60).toFixed(1).replace('.', ',')} min`;
  }
  return `${sec.toFixed(1).replace('.', ',')} s`;
}

/**
 * Falha cedo quando o áudio não cabe no provider (tamanho e/ou duração).
 *
 * Função pura: não lê arquivo, não faz rede — só decide e monta a
 * mensagem. O chamador (o dispatcher) passa o tamanho do WAV e a
 * duração já calculados.
 */
export function assertAudioWithinLimit(
  provider: TranscriptionProviderId,
  audio: { bytes: number; seconds?: number | null },
): void {
  const limit = PROVIDER_AUDIO_LIMITS[provider];
  if (!limit) return;
  if (limit.maxBytes == null && limit.maxSec == null) return;

  const bytes = Number(audio.bytes);
  const seconds =
    audio.seconds == null || audio.seconds === undefined
      ? null
      : Number(audio.seconds);

  const overBytes =
    limit.maxBytes != null &&
    Number.isFinite(bytes) &&
    bytes > limit.maxBytes;
  const overSec =
    limit.maxSec != null &&
    seconds != null &&
    Number.isFinite(seconds) &&
    seconds > limit.maxSec;

  if (!overBytes && !overSec) return;

  const parts: string[] = [];
  if (overBytes && limit.maxBytes != null) {
    parts.push(`${formatMegabytes(bytes)} > ${formatMegabytes(limit.maxBytes)}`);
  }
  if (overSec && limit.maxSec != null && seconds != null) {
    parts.push(`${formatDuration(seconds)} > ${formatDuration(limit.maxSec)}`);
  }
  throw new Error(
    `áudio grande demais para o provider ${provider}: ${parts.join(' e ')}. ` +
      `Corte o clipe em pedaços ou use um clipe menor ` +
      `(limite do ${provider}: ${limit.note}).`,
  );
}
