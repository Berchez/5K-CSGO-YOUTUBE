/**
 * Latência da stream gravada: quanto o material gravado atrasa em
 * relação ao jogo real.
 *
 * O recorder consome HLS: o conteúdo de um instante chega no buffer
 * CLIP_STREAM_LATENCY_MS depois. O mtime do segmento marca QUANDO o
 * arquivo foi escrito (logo, a timeline do vídeo), e não o instante do
 * jogo — sem esta correção a âncora (que vem do placar, no relógio do
 * jogo) aponta para material que ainda não foi gravado.
 *
 * A latência NÃO é igual em toda stream: uma oficial em 1080p60 e um
 * mirror brasileiro em 720p30 entregam o HLS com defasagens diferentes.
 * Por isso o mapa por canal (CLIP_STREAM_LATENCY_BY_STREAM) existe, e a
 * medição observada (quando o OCR acha a virada do placar no vídeo)
 * alimenta a telemetria para calibrar.
 */

/** Parse do mapa de latência por stream: JSON {"Gaules": 22000}. */
export function parseLatencyMap(raw: string | undefined): Record<string, number> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const name = key.trim();
    const ms = typeof value === 'number' ? value : Number(value);
    if (!name || !Number.isFinite(ms) || ms < 0 || ms > 120_000) continue;
    out[name.toLowerCase()] = Math.round(ms);
  }
  return out;
}

/**
 * Latência efetiva da stream: o valor do canal quando existe (nome
 * exato, ignorando caixa, ou o canal cujo nome começa com o nome
 * configurado), senão o valor global.
 *
 * O match é deliberadamente RESTRITO: exato primeiro; depois só o nome
 * configurado que é PREFIXO do canal real ("Gaules" casa "Gaules 2",
 * mas "tv" não casa "ESL TV"). Um `includes` nos dois sentidos casava
 * "tv" com "ESL TV" — e a ordem de inserção do mapa decidia.
 */
export function resolveStreamLatencyMs(
  defaultMs: number,
  byStream: Record<string, number>,
  streamName?: string,
): number {
  const name = (streamName ?? '').trim().toLowerCase();
  if (!name || !byStream) return defaultMs;
  const exact = byStream[name];
  if (typeof exact === 'number') return exact;
  // Prefixo: o nome configurado é o início do canal real.
  let bestKey: string | null = null;
  for (const key of Object.keys(byStream)) {
    if (!key) continue;
    if (!name.startsWith(key)) continue;
    if (!bestKey || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey) return byStream[bestKey];
  return defaultMs;
}

/**
 * O mapa de latência é válido? (JSON válido, objeto, valores no range).
 * Devolve null quando está OK e a mensagem do problema quando não é —
 * o startup avisa em vez de aceitar o mapa vazio em silêncio.
 */
export function latencyMapProblem(raw: string | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'JSON inválido';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'não é um objeto JSON {"stream": ms}';
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return 'objeto vazio';
  const invalidos = entries.filter(([, value]) => {
    const ms = typeof value === 'number' ? value : Number(value);
    return !Number.isFinite(ms) || ms < 0 || ms > 120_000;
  });
  if (invalidos.length > 0) {
    return `${invalidos.length} valor(es) fora da faixa (0-120000 ms)`;
  }
  return null;
}

/**
 * Latência OBSERVADA (ms): o instante da virada do placar vista no
 * vídeo menos o instante (no relógio do jogo) em que o round fechou.
 *
 * O round fecha (relógio do jogo) ≈ detecção do ace − atraso do placar
 * em publicar o placar final; a virada no vídeo está na timeline do
 * vídeo (mtime). A diferença entre as duas é a latência da stream.
 */
export function observedLatencyMs(
  detectedEndMs: number,
  aceDetectedAtMs: number,
  scoreDelayMs: number,
): number {
  return Math.round(detectedEndMs - (aceDetectedAtMs - scoreDelayMs));
}

/** Amostras guardadas por canal (mediana das últimas). */
const SAMPLES_PER_STREAM = 5;
/**
 * Faixa de sanidade da latência observada (ms). Abaixo de 0 ou acima de
 * 120s o OCR não mediu latência: casou o round errado (ou a diferença
 * do relógio). Amostra fora da faixa não entra na mediana.
 */
export const OBSERVED_LATENCY_MIN_MS = 0;
export const OBSERVED_LATENCY_MAX_MS = 120_000;

/**
 * Histórico de latência observada por canal. Só mede: não ajusta as
 * âncoras sozinho (uma calibração errada quebraria todos os clipes do
 * canal). Serve para o log dizer "esta stream entrega N ms atrás" e o
 * dono ajustar CLIP_STREAM_LATENCY_MS / o mapa por canal.
 */
export class StreamLatencyTracker {
  private readonly samples = new Map<string, number[]>();

  record(streamName: string | undefined, latencyMs: number): void {
    if (!Number.isFinite(latencyMs)) return;
    if (latencyMs < OBSERVED_LATENCY_MIN_MS || latencyMs > OBSERVED_LATENCY_MAX_MS) return;
    const key = (streamName ?? 'desconhecida').trim().toLowerCase() || 'desconhecida';
    const list = this.samples.get(key) ?? [];
    list.push(Math.round(latencyMs));
    while (list.length > SAMPLES_PER_STREAM) list.shift();
    this.samples.set(key, list);
  }

  /** Mediana das amostras do canal (null = sem medição). */
  median(streamName: string | undefined): number | null {
    const key = (streamName ?? 'desconhecida').trim().toLowerCase() || 'desconhecida';
    const list = this.samples.get(key);
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  samplesCount(streamName: string | undefined): number {
    const key = (streamName ?? 'desconhecida').trim().toLowerCase() || 'desconhecida';
    return this.samples.get(key)?.length ?? 0;
  }
}
