/**
 * HTTP dos providers de nuvem: timeout explícito e erro que mostra o que
 * a API respondeu (sem o corpo inteiro no log).
 */

/** `fetch` com AbortController (funciona no Node 20+ sem depender de DOM). */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ms = Math.max(1_000, Number(timeoutMs) || 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`timeout após ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Lê o corpo como JSON; em erro, joga status + trecho do corpo. */
export async function readJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
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
