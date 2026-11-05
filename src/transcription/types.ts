/**
 * Transcrição de áudio (fala) de um clipe: contrato único usado por todos
 * os providers.
 *
 * O resto do bot não conhece SDK nem CLI de transcrição: pede um
 * `TranscribeOptions` e recebe `TranscriptResult` com os tempos em
 * segundos RELATIVOS ao áudio enviado (o clipe inteiro ou a janela).
 */

/** Providers implementados (locais e de API). */
export type TranscriptionProviderId =
  | 'faster-whisper'
  | 'whisper-cpp'
  | 'vosk'
  | 'gemini'
  | 'openai'
  | 'groq'
  | 'deepgram'
  | 'assemblyai'
  | 'elevenlabs';

/** Formato de saída de legenda. */
export type TranscriptFormat = 'srt' | 'vtt' | 'txt';

/** Um trecho de fala transcrito. */
export interface TranscriptionSegment {
  /** Início em segundos desde o começo do áudio enviado. */
  startSec: number;
  /** Fim em segundos desde o começo do áudio enviado. */
  endSec: number;
  /** Texto falado (já sem espaços sobrando). */
  text: string;
}

/** Resultado de uma transcrição. */
export interface TranscriptResult {
  provider: TranscriptionProviderId;
  /** Modelo usado (id do provider, não o caminho do arquivo). */
  model: string;
  /** Idioma detectado/pedido (ISO-639-1 quando conhecido). */
  language: string | null;
  segments: TranscriptionSegment[];
  /** Duração do WAV enviado ao provider (s). */
  audioSec: number;
  /** Tempo de parede só da transcrição (ms), sem extrair o áudio. */
  elapsedMs: number;
}

/** Pedido de transcrição. Campos ausentes caem na config (`TRANSCRIPTION_*`). */
export interface TranscribeOptions {
  provider?: TranscriptionProviderId;
  /** Vazio/ausente = modelo padrão do provider. */
  model?: string;
  /** `auto` (default) deixa o provider detectar; `pt`, `en`... força. */
  language?: string;
  /** VAD (detecção de fala) quando o provider suporta. */
  vad?: boolean;
  timeoutMs?: number;
  /**
   * Timestamps por palavra quando o provider suporta (whisper.cpp).
   * A legenda queimada pede isso: o bloco sai do tempo das palavras, não
   * do segmento inteiro.
   */
  words?: boolean;
  /** Tamanho máximo do bloco em caracteres (provider que segmenta). */
  maxSegmentChars?: number;
}

/** Pedido de transcrição já gravando a legenda num arquivo. */
export interface TranscribeFileOptions extends TranscribeOptions {
  format?: TranscriptFormat;
  /** Caminho do arquivo de saída; ausente = troca a extensão do vídeo. */
  outPath?: string;
}

/** Estado de um provider (o que falta para usar). */
export interface ProviderStatus {
  id: TranscriptionProviderId;
  label: string;
  ready: boolean;
  /** Motivo curto quando não está pronto; vazio quando está. */
  reason: string;
}

/** Palavra com tempo, devolvida por APIs que só dão timestamps de palavra. */
export interface TimedWord {
  startSec: number;
  endSec: number;
  text: string;
}
