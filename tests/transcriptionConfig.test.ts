import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';

describe('config de transcrição', () => {
  it('defaults: Gemini, auto, VAD ligado, SRT', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.TRANSCRIPTION_PROVIDER).toBe('gemini');
    expect(cfg.TRANSCRIPTION_MODEL).toBe('');
    expect(cfg.TRANSCRIPTION_LANGUAGE).toBe('auto');
    expect(cfg.TRANSCRIPTION_VAD).toBe(true);
    expect(cfg.TRANSCRIPTION_TIMEOUT_MS).toBe(600_000);
    expect(cfg.TRANSCRIPTION_OUTPUT_FORMAT).toBe('srt');
    expect(cfg.TRANSCRIPTION_PYTHON).toBe('');
  });

  it('aceita os providers do registro e rejeita desconhecido', () => {
    expect(ConfigSchema.parse({ TRANSCRIPTION_PROVIDER: 'whisper-cpp' }).TRANSCRIPTION_PROVIDER).toBe(
      'whisper-cpp',
    );
    expect(() => ConfigSchema.parse({ TRANSCRIPTION_PROVIDER: 'nope' })).toThrow();
  });

  it('VAD aceita as formas de env booleano', () => {
    expect(ConfigSchema.parse({ TRANSCRIPTION_VAD: 'off' }).TRANSCRIPTION_VAD).toBe(false);
    expect(ConfigSchema.parse({ TRANSCRIPTION_VAD: '1' }).TRANSCRIPTION_VAD).toBe(true);
  });

  it('formato e timeout validados', () => {
    expect(ConfigSchema.parse({ TRANSCRIPTION_OUTPUT_FORMAT: 'vtt' }).TRANSCRIPTION_OUTPUT_FORMAT).toBe(
      'vtt',
    );
    expect(() => ConfigSchema.parse({ TRANSCRIPTION_OUTPUT_FORMAT: 'ass' })).toThrow();
    expect(
      ConfigSchema.parse({ TRANSCRIPTION_TIMEOUT_MS: '45000' }).TRANSCRIPTION_TIMEOUT_MS,
    ).toBe(45_000);
    expect(() => ConfigSchema.parse({ TRANSCRIPTION_TIMEOUT_MS: '5000' })).toThrow();
  });

  it('chaves de nuvem começam vazias', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.OPENAI_API_KEY).toBe('');
    expect(cfg.GROQ_API_KEY).toBe('');
    expect(cfg.DEEPGRAM_API_KEY).toBe('');
    expect(cfg.ASSEMBLYAI_API_KEY).toBe('');
    expect(cfg.ELEVENLABS_API_KEY).toBe('');
  });
});
