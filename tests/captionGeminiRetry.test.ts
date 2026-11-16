import { describe, expect, it } from 'vitest';
import {
  isTransientGeminiError,
  withGeminiRetry,
} from '../src/clipper/shortCaptionsAi.js';
import { hasDegradedCaptions, isRetryableCaptionFailure } from '../src/clipper/shortCaptions.js';

describe('retry do Gemini (erro transitório)', () => {
  it('5xx é transitório', () => {
    expect(isTransientGeminiError({ status: 503 })).toBe(true);
    expect(isTransientGeminiError({ status: 500 })).toBe(true);
    expect(isTransientGeminiError({ status: 502, message: 'bad gateway' })).toBe(true);
  });

  it('UNAVAILABLE e "high demand" são transitórios', () => {
    expect(isTransientGeminiError(new Error('UNAVAILABLE'))).toBe(true);
    expect(isTransientGeminiError(new Error('The model is overloaded (high demand)'))).toBe(true);
  });

  it('a COTA (429) NUNCA é transitória', () => {
    expect(isTransientGeminiError({ status: 429 })).toBe(false);
    expect(isTransientGeminiError(new Error('quota exceeded for quota metric'))).toBe(false);
    expect(isTransientGeminiError(new Error('RESOURCE_EXHAUSTED'))).toBe(false);
    expect(isTransientGeminiError(new Error('rate limit reached'))).toBe(false);
  });

  it('erro de conteúdo não é transitório', () => {
    expect(isTransientGeminiError(new Error('resposta da transcrição com JSON inválido'))).toBe(false);
    expect(isTransientGeminiError(new Error('timeout gemini-transcricao após 60000ms'))).toBe(false);
  });

  it('repete a chamada até dar certo', async () => {
    let calls = 0;
    const result = await withGeminiRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw { status: 503, message: 'UNAVAILABLE' };
        return 'ok';
      },
      { attempts: 3, retryDelayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('respeita o número de tentativas', async () => {
    let calls = 0;
    await expect(
      withGeminiRetry(
        async () => {
          calls += 1;
          throw { status: 503 };
        },
        { attempts: 2, retryDelayMs: 0 },
      ),
    ).rejects.toBeTruthy();
    expect(calls).toBe(2);
  });

  it('erro final (cota) sobe na hora, sem repetir', async () => {
    let calls = 0;
    await expect(
      withGeminiRetry(
        async () => {
          calls += 1;
          throw { status: 429, message: 'quota exceeded' };
        },
        { attempts: 3, retryDelayMs: 0 },
      ),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('a espera dobra a cada repetição', async () => {
    const delays: number[] = [];
    await withGeminiRetry(
      async () => {
        throw { status: 503 };
      },
      {
        attempts: 3,
        retryDelayMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    ).catch(() => undefined);
    expect(delays).toEqual([10, 20]);
  });
});

describe('legenda degradada', () => {
  it('reconhece a legenda degradada (refine/translate falhou)', () => {
    expect(hasDegradedCaptions({ applied: true, degraded: ['refine'] })).toBe(true);
    expect(hasDegradedCaptions({ applied: true, degraded: ['translate'] })).toBe(true);
    expect(hasDegradedCaptions({ applied: true })).toBe(false);
    expect(hasDegradedCaptions(null)).toBe(false);
  });

  it('degradada NÃO é falha de publicação (a legenda foi queimada)', () => {
    const status = { applied: true, degraded: ['refine' as const] };
    expect(isRetryableCaptionFailure(status)).toBe(false);
    expect(hasDegradedCaptions(status)).toBe(true);
  });
});
