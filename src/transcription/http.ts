/**
 * HTTP dos providers de nuvem: timeout explícito e erro que mostra o que
 * a API respondeu (sem o corpo inteiro no log).
 *
 * O timeout vale até o FIM da leitura do corpo: um servidor que manda os
 * headers e trava no corpo não pode segurar o processo. Por isso o timer
 * vive junto da `Response` e é liberado em `readJsonResponse`.
 */

/** Estado do timeout de uma resposta (ms, abort e liberação). */
interface ResponseTimeoutState {
  /** Timeout usado (ms) — aparece na mensagem de erro. */
  timeoutMs: number;
  /** O timer já disparou (o abort foi por timeout). */
  timedOut: boolean;
  /** Limpa o timer (idempotente). */
  release: () => void;
}

/** Timer por resposta: só o `WeakMap` mantém a referência viva. */
const responseTimeouts = new WeakMap<Response, ResponseTimeoutState>();

/**
 * Libera o timer de uma resposta (chame quando o corpo não for mais
 * lido). Idempotente: chamar duas vezes não faz nada.
 */
export function releaseResponseTimeout(res: Response): void {
  const state = responseTimeouts.get(res);
  if (!state) return;
  responseTimeouts.delete(res);
  state.release();
}

/** `unref` do timer: um timer esquecido não segura o processo Node. */
function unrefTimer(timer: unknown): void {
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
}

/**
 * `fetch` com AbortController (funciona no Node 20+ sem depender de DOM).
 *
 * O timer NÃO é limpo aqui: ele continua valendo durante a leitura do
 * corpo (veja `readJsonResponse`, que o libera no `finally`).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ms = Math.max(1_000, Number(timeoutMs) || 60_000);
  const controller = new AbortController();
  const state: ResponseTimeoutState = {
    timeoutMs: ms,
    timedOut: false,
    release: () => {},
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, ms);
  state.release = () => clearTimeout(timer);
  unrefTimer(timer);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    responseTimeouts.set(res, state);
    return res;
  } catch (e) {
    state.release();
    if (state.timedOut) throw new Error(`timeout após ${ms}ms`);
    throw e;
  }
}

/**
 * Lê o corpo como JSON; em erro, joga status + trecho do corpo.
 *
 * O timer da resposta é liberado em TODOS os caminhos (sucesso, erro,
 * corpo vazio). Se o corpo foi cortado pelo timeout, o erro sai como
 * timeout (e não como falha genérica de stream).
 */
export async function readJsonResponse(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    const state = responseTimeouts.get(res);
    if (state?.timedOut) {
      throw new Error(`timeout após ${state.timeoutMs}ms`);
    }
    throw e;
  } finally {
    releaseResponseTimeout(res);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`resposta não é JSON: ${text.slice(0, 200)}`);
  }
}

/** POST JSON já com `readJsonResponse`. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  return readJsonResponse(res);
}

/** Objeto JSON ou `{}` (respostas de terceiros não são confiáveis). */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Array de objetos dentro de uma resposta. */
export function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

/** Texto de um campo desconhecido (vazio quando não é string). */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Número de um campo desconhecido (NaN quando não é número). */
export function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}
