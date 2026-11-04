import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_IDS,
  defaultModelFor,
  estimateCostUsd,
  getModelInfo,
  getProviderInfo,
  providerSelectOptions,
  requireProviderInfo,
} from '../src/transcription/registry.js';
import { providerStatus } from '../src/transcription/transcribe.js';

describe('registro de providers', () => {
  it('ids únicos e defaultModel dentro da lista', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
    for (const provider of PROVIDERS) {
      expect(provider.models.map((m) => m.id)).toContain(provider.defaultModel);
      expect(new Set(provider.models.map((m) => m.id)).size).toBe(
        provider.models.length,
      );
      expect(provider.notes.length).toBeGreaterThan(0);
    }
  });

  it('getProviderInfo/devolve o provider e o modelo padrão', () => {
    expect(getProviderInfo('groq')?.kind).toBe('cloud');
    expect(getProviderInfo('nope')).toBeUndefined();
    expect(defaultModelFor('whisper-cpp')).toBe('small');
    expect(() => requireProviderInfo('nope')).toThrow(/desconhecido/);
  });

  it('modelo com timestamps x sem timestamps', () => {
    expect(getModelInfo('openai', 'whisper-1')?.timestamps).toBe(true);
    expect(getModelInfo('openai', 'gpt-4o-mini-transcribe')?.timestamps).toBe(false);
  });

  it('estimativa de custo por duração', () => {
    expect(estimateCostUsd('faster-whisper', 'small', 3600)).toBe(0);
    expect(estimateCostUsd('groq', 'whisper-large-v3-turbo', 3600)).toBe(0.04);
    expect(estimateCostUsd('groq', 'whisper-large-v3-turbo', 60)).toBe(0.000667);
    expect(estimateCostUsd('gemini', 'gemini-3.5-transcribe', 0)).toBe(0);
  });

  it('opções do painel seguem a ordem do registro', () => {
    expect(providerSelectOptions().map((o) => o.value)).toEqual([...PROVIDER_IDS]);
  });
});

describe('providerStatus', () => {
  const rt = (opts: {
    env?: NodeJS.ProcessEnv;
    exists?: (file: string) => boolean;
  }) => ({
    env: opts.env ?? {},
    exists: opts.exists ?? (() => false),
  });

  it('sem nada instalado, tudo requer setup', () => {
    const status = providerStatus(rt({}));
    expect(status).toHaveLength(PROVIDER_IDS.length);
    for (const item of status) {
      expect(item.ready).toBe(false);
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  it('com chaves e venv, todos ficam prontos', () => {
    const status = providerStatus(
      rt({
        env: {
          TRANSCRIPTION_PYTHON: 'python',
          GEMINI_API_KEY: 'g',
          OPENAI_API_KEY: 'o',
          GROQ_API_KEY: 'q',
          DEEPGRAM_API_KEY: 'd',
          ASSEMBLYAI_API_KEY: 'a',
          ELEVENLABS_API_KEY: 'e',
        },
        exists: () => true,
      }),
    );
    for (const item of status) {
      expect(item.ready, `${item.id}: ${item.reason}`).toBe(true);
      expect(item.reason).toBe('');
    }
  });

  it('chave vazia não conta como configurada', () => {
    const status = providerStatus(
      rt({ env: { GEMINI_API_KEY: '   ' }, exists: () => false }),
    );
    expect(status.find((s) => s.id === 'gemini')?.ready).toBe(false);
  });
});
