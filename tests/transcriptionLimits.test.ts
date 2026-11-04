import { describe, expect, it } from 'vitest';
import {
  PROVIDER_AUDIO_LIMITS,
  assertAudioWithinLimit,
} from '../src/transcription/limits.js';
import { PROVIDER_IDS } from '../src/transcription/registry.js';

const LOCAL_PROVIDERS = ['faster-whisper', 'whisper-cpp', 'vosk'] as const;

describe('limites de áudio por provider', () => {
  it('todo provider tem uma entrada na tabela', () => {
    for (const provider of PROVIDER_IDS) {
      expect(PROVIDER_AUDIO_LIMITS[provider]).toBeDefined();
    }
  });

  it('locais não têm limite de upload', () => {
    for (const provider of LOCAL_PROVIDERS) {
      const limit = PROVIDER_AUDIO_LIMITS[provider];
      expect(limit.maxBytes).toBeNull();
      expect(limit.maxSec).toBeNull();
      expect(() =>
        assertAudioWithinLimit(provider, { bytes: 5_000_000_000, seconds: 100_000 }),
      ).not.toThrow();
    }
  });

  it('aceita o áudio que cabe em cada provider', () => {
    for (const provider of PROVIDER_IDS) {
      const limit = PROVIDER_AUDIO_LIMITS[provider];
      const maxBytes = limit.maxBytes;
      if (maxBytes == null) continue;
      expect(() =>
        assertAudioWithinLimit(provider, {
          bytes: maxBytes,
          seconds: limit.maxSec ?? 1,
        }),
      ).not.toThrow();
    }
  });

  it('rejeita áudio grande demais em cada provider com limite', () => {
    for (const provider of PROVIDER_IDS) {
      const limit = PROVIDER_AUDIO_LIMITS[provider];
      const maxBytes = limit.maxBytes;
      if (maxBytes == null) continue;
      expect(() =>
        assertAudioWithinLimit(provider, { bytes: maxBytes + 1 }),
      ).toThrow(new RegExp(`áudio grande demais para o provider ${provider}`));
    }
  });

  it('rejeita áudio longo demais mesmo com tamanho dentro do limite', () => {
    for (const provider of PROVIDER_IDS) {
      const limit = PROVIDER_AUDIO_LIMITS[provider];
      const maxSec = limit.maxSec;
      if (maxSec == null) continue;
      expect(() =>
        assertAudioWithinLimit(provider, {
          bytes: Math.floor(limit.maxBytes ?? 1),
          seconds: maxSec + 1,
        }),
      ).toThrow(/áudio grande demais/);
    }
  });

  it('a mensagem cita o limite e diz o que fazer', () => {
    let message = '';
    try {
      assertAudioWithinLimit('gemini', {
        bytes: 30 * 1024 * 1024,
        seconds: 900,
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/áudio grande demais para o provider gemini/);
    expect(message).toMatch(/30,0 MB > 20,0 MB/);
    expect(message).toMatch(/15,0 min > 10,0 min/);
    expect(message).toMatch(/Corte o clipe em pedaços ou use um clipe menor/);
  });

  it('sem duração conhecida, o tamanho ainda é conferido', () => {
    expect(() =>
      assertAudioWithinLimit('openai', { bytes: 30 * 1024 * 1024 }),
    ).toThrow(/áudio grande demais para o provider openai/);
    expect(() =>
      assertAudioWithinLimit('openai', { bytes: 1024, seconds: null }),
    ).not.toThrow();
  });

  it('mensagem em português com o limite do provider', () => {
    expect(() =>
      assertAudioWithinLimit('groq', { bytes: 30 * 1024 * 1024 }),
    ).toThrow(/limite do groq: 25 MB por arquivo/);
  });
});
