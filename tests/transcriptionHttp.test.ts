import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithTimeout,
  readJsonResponse,
  releaseResponseTimeout,
} from '../src/transcription/http.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** `fetch` falso: guarda o `init` para o teste inspecionar. */
function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn((url: string, init: RequestInit) =>
    Promise.resolve(impl(url, init)),
  );
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

/**
 * Resposta que nunca termina o corpo e que reage ao abort do signal
 * (como o undici faz: o corpo morre com o AbortError).
 */
function stallingResponse(signal: AbortSignal | null | undefined): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () =>
        controller.error(new DOMException('abortado', 'AbortError'));
      if (!signal) return;
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort);
    },
  });
  return new Response(stream, { status: 200 });
}

describe('fetchWithTimeout', () => {
  it('rejeita com timeout quando o corpo nunca chega', async () => {
    vi.useFakeTimers();
    mockFetch((_url, init) => stallingResponse(init.signal));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    const promise = readJsonResponse(res);
    const assertion = expect(promise).rejects.toThrow(/timeout após 1000ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('libera o timer depois de ler o corpo', async () => {
    vi.useFakeTimers();
    mockFetch(() => new Response('{"ok":true}', { status: 200 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    expect(vi.getTimerCount()).toBe(1);
    const body = await readJsonResponse(res);
    expect(body).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('libera o timer também quando o corpo vem vazio', async () => {
    vi.useFakeTimers();
    mockFetch(() => new Response('', { status: 200 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    expect(vi.getTimerCount()).toBe(1);
    await expect(readJsonResponse(res)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('libera o timer quando o corpo dá erro', async () => {
    vi.useFakeTimers();
    mockFetch(() => new Response('{"error":"x"}', { status: 500 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    expect(vi.getTimerCount()).toBe(1);
    await expect(readJsonResponse(res)).rejects.toThrow(/^HTTP 500/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releaseResponseTimeout limpa o timer de uma resposta não lida', async () => {
    vi.useFakeTimers();
    mockFetch(() => new Response('{"ok":true}', { status: 200 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    expect(vi.getTimerCount()).toBe(1);
    releaseResponseTimeout(res);
    expect(vi.getTimerCount()).toBe(0);
    releaseResponseTimeout(res);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('erro de HTTP mantém a mensagem HTTP <status>', async () => {
    mockFetch(() => new Response('{"error":"limite de taxa"}', { status: 429 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    await expect(readJsonResponse(res)).rejects.toThrow(/^HTTP 429/);
  });

  it('erro de HTTP mostra o trecho do corpo', async () => {
    mockFetch(() => new Response('{"error":"limite de taxa"}', { status: 429 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    await expect(readJsonResponse(res)).rejects.toThrow(/limite de taxa/);
  });

  it('corpo que não é JSON vira erro claro', async () => {
    mockFetch(() => new Response('não é json', { status: 200 }));
    const res = await fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    await expect(readJsonResponse(res)).rejects.toThrow(/resposta não é JSON/);
  });

  it('timeout do próprio fetch vira timeout (não erro genérico)', async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('abortado', 'AbortError'));
          });
        }),
    );
    const promise = fetchWithTimeout('https://exemplo.test/api', {}, 1_000);
    const assertion = expect(promise).rejects.toThrow(/timeout após 1000ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
