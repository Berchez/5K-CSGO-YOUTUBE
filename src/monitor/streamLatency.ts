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
 * A latência NÃO é constante: nem entre canais (uma oficial em 1080p60 e
 * um mirror brasileiro em 720p30 entregam o HLS com defasagens
 * diferentes) nem dentro da MESMA partida (pausa do streamer, buffering,
 * catch-up e restart da fonte mudam o atraso no meio do round). Por isso
 * existe o estado por canal: cada medição (a virada do placar vista no
 * vídeo) vira uma AMOSTRA com timestamp, e as âncoras usam a amostra que
 * estava em vigor no instante do evento.
 *
 * Medição (OCR da virada do placar) e aplicação (qual L vai para as
 * âncoras) são camadas separadas: o estado guarda o que foi medido, a
 * decisão (resolveAdaptiveLatency) escolhe o que aplicar, com o lado
 * seguro como regra (abrir mais cedo nunca perde a 1ª kill; fechar mais
 * tarde nunca perde a última).
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
  if (entries.length === 0) {
    return 'objeto vazio';
  }
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
 * O round fecha (relógio do jogo) no instante em que o placar do HLTV
 * mostra "Round over" (o timer real do round, quando o placar expõe);
 * sem esse relógio, cai na estimativa: detecção do ace − atraso do
 * placar em publicar o placar final. A virada no vídeo está na
 * timeline do vídeo (mtime). A diferença entre as duas é a latência.
 */
export function observedLatencyMs(
  videoRoundEndMs: number,
  gameRoundEndMs: number,
): number {
  return Math.round(videoRoundEndMs - gameRoundEndMs);
}

/**
 * Fim do round no relógio do jogo (ms): o instante real ("Round over"
 * no placar) quando existe; senão a estimativa (detecção do ace −
 * atraso do placar em publicar o placar final).
 */
export function gameRoundEndMs(params: {
  aceDetectedAtMs: number;
  scoreDelayMs: number;
  roundEndedAtMs?: number | null;
}): number {
  if (params.roundEndedAtMs != null && Number.isFinite(params.roundEndedAtMs)) {
    return params.roundEndedAtMs;
  }
  return params.aceDetectedAtMs - params.scoreDelayMs;
}

/** Origem da medição de latência. */
export type LatencySource = 'scoreboard' | 'killfeed';

/** Qualidade da medição: 'confident' casou o antes E o depois. */
export type LatencyQuality = 'confident' | 'after-only';

/** Referência do fim do round usada na medição. */
export type LatencyEndReference = 'timer-hltv' | 'estimada';

/** Uma medição de latência, com o instante em que foi medida. */
export interface LatencySample {
  /** Quando a medição foi feita (wall ms). */
  measuredAtMs: number;
  /** Latência observada (ms): vídeo − relógio do jogo. */
  latencyMs: number;
  /** De onde veio a medição. */
  source: LatencySource;
  /** Qualidade da medição. */
  quality: LatencyQuality;
  /**
   * De onde veio o fim do round: timer real do HLTV ou a estimativa
   * (detecção − atraso do placar). Persistido para o relatório mostrar a
   * confiança da medição mesmo depois de um restart.
   */
  reference?: LatencyEndReference;
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

/** Idade máxima de uma amostra para contar como "histórico recente" (ms). */
export const RECENT_SAMPLE_MAX_AGE_MS = 15 * 60_000;

/** Quantidade de amostras recentes consideradas por canal. */
export const RECENT_SAMPLE_LIMIT = 3;

/**
 * Histórico de latência OBSERVADA por canal.
 *
 * Cada amostra é uma medição real (a virada do placar vista no vídeo
 * menos o fechamento estimado do round) com o instante em que foi
 * medida. O estado é a base da latência ADAPTATIVA: o início do clipe
 * usa a amostra que estava em vigor quando a 1ª kill aconteceu (nunca a
 * do round atual — ela é medida depois da kill e contaminaria o
 * início), e o fim estimado usa o máximo da janela recente (alongar o
 * clipe é barato; cortar cedo perde a última kill).
 *
 * Também guarda o CROP do placar que funcionou por canal: cada canal
 * tem o overlay do placar em outro lugar, e um crop que não lê nada
 * deixa o canal sem medição (e sem âncora de fim).
 */
export class StreamLatencyTracker {
  private readonly samples = new Map<string, LatencySample[]>();
  private readonly crops = new Map<string, string>();
  private lastMeasuredAtMs = 0;

  /**
   * Registra uma medição. Amostra fora da faixa plausível é descartada
   * (o OCR casou o round errado). Devolve a amostra gravada ou null.
   */
  record(
    streamName: string | undefined,
    latencyMs: number,
    meta?: {
      measuredAtMs?: number;
      source?: LatencySource;
      quality?: LatencyQuality;
      reference?: LatencyEndReference;
    },
  ): LatencySample | null {
    if (!Number.isFinite(latencyMs)) return null;
    if (latencyMs < OBSERVED_LATENCY_MIN_MS || latencyMs > OBSERVED_LATENCY_MAX_MS) return null;
    const key = streamKey(streamName);
    // Sem timestamp explícito, o relógio avança de 1 em 1ms para manter a
    // ordem estável (várias medidas no mesmo ms).
    let measuredAtMs = meta?.measuredAtMs ?? Date.now();
    if (!Number.isFinite(measuredAtMs)) measuredAtMs = Date.now();
    if (measuredAtMs <= this.lastMeasuredAtMs) measuredAtMs = this.lastMeasuredAtMs + 1;
    this.lastMeasuredAtMs = measuredAtMs;
    const sample: LatencySample = {
      measuredAtMs,
      latencyMs: Math.round(latencyMs),
      source: meta?.source ?? 'scoreboard',
      quality: meta?.quality ?? 'confident',
      ...(meta?.reference != null ? { reference: meta.reference } : {}),
    };
    const list = this.samples.get(key) ?? [];
    list.push(sample);
    while (list.length > SAMPLES_PER_STREAM) list.shift();
    this.samples.set(key, list);
    return sample;
  }

  /** Mediana das amostras do canal (null = sem medição). */
  median(streamName: string | undefined): number | null {
    const list = this.samples.get(streamKey(streamName));
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => a.latencyMs - b.latencyMs);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid].latencyMs
      : Math.round((sorted[mid - 1].latencyMs + sorted[mid].latencyMs) / 2);
  }

  samplesCount(streamName: string | undefined): number {
    return this.samples.get(streamKey(streamName))?.length ?? 0;
  }

  /** Todas as amostras do canal, da mais antiga para a mais recente. */
  allSamples(streamName: string | undefined): LatencySample[] {
    return [...(this.samples.get(streamKey(streamName)) ?? [])];
  }

  /** A amostra mais recente do canal (null = sem medição). */
  latest(streamName: string | undefined): LatencySample | null {
    const list = this.samples.get(streamKey(streamName));
    return list && list.length > 0 ? list[list.length - 1] : null;
  }

  /**
   * A amostra mais recente medida ANTES de `beforeMs` (wall ms).
   *
   * É a consulta do INÍCIO do clipe: a amostra do round atual é medida
   * depois da 1ª kill, então usá-la no início deslocaria a abertura
   * para o regime errado quando a latência mudou no meio do round.
   */
  latestBefore(streamName: string | undefined, beforeMs: number): LatencySample | null {
    const list = this.samples.get(streamKey(streamName));
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].measuredAtMs < beforeMs) return list[i];
    }
    return null;
  }

  /**
   * Janela recente do canal: as últimas amostras dentro da idade
   * máxima. O máximo dessa janela é o valor CONSERVADOR do fim
   * estimado (alongar o clipe é barato).
   */
  recent(
    streamName: string | undefined,
    limit = RECENT_SAMPLE_LIMIT,
    maxAgeMs = RECENT_SAMPLE_MAX_AGE_MS,
    nowMs = Date.now(),
  ): LatencySample[] {
    const list = this.samples.get(streamKey(streamName));
    if (!list || list.length === 0) return [];
    return list
      .filter((sample) => nowMs - sample.measuredAtMs <= maxAgeMs)
      .slice(-Math.max(1, limit));
  }

  /** Maior latência da janela recente (null = sem medição). */
  recentMax(
    streamName: string | undefined,
    limit = RECENT_SAMPLE_LIMIT,
    maxAgeMs = RECENT_SAMPLE_MAX_AGE_MS,
    nowMs = Date.now(),
  ): number | null {
    const list = this.recent(streamName, limit, maxAgeMs, nowMs);
    if (list.length === 0) return null;
    return Math.max(...list.map((sample) => sample.latencyMs));
  }

  /** Crop do placar que funcionou por canal (null = sem override). */
  crop(streamName: string | undefined): string | null {
    return this.crops.get(streamKey(streamName)) ?? null;
  }

  /** Memoriza o crop que funcionou no canal (evita re-descobrir todo round). */
  setCrop(streamName: string | undefined, crop: string): void {
    const key = streamKey(streamName);
    if (!crop) return;
    this.crops.set(key, crop);
  }

  /** Canais com medição (diagnóstico). */
  channels(): string[] {
    return [...this.samples.keys()];
  }

  /** Serializa o estado (persistência entre reinícios do bot). */
  toJSON(): LatencyStateFile {
    const streams: LatencyStateFile['streams'] = {};
    for (const [key, list] of this.samples) {
      streams[key] = { samples: list.map((sample) => ({ ...sample })) };
    }
    for (const [key, crop] of this.crops) {
      streams[key] = { ...(streams[key] ?? { samples: [] }), crop };
    }
    return {
      version: LATENCY_STATE_VERSION,
      updatedAt: new Date().toISOString(),
      streams,
    };
  }

  /**
   * Reconstrói o estado a partir do arquivo persistido (best-effort).
   *
   * A restauração é ESTRITA: versão do schema, campos obrigatórios,
   * origem/qualidade conhecidas e faixa de latência. Arquivo de outra
   * versão ou com amostra fora do formato é descartado (estado vazio) —
   * o alternativo seria tratar lixo como medição válida e contaminar a
   * escolha da latência. As amostras são reordenadas por `measuredAtMs`
   * e limitadas ao tamanho da janela em memória (as mais recentes).
   */
  static fromJSON(raw: unknown): StreamLatencyTracker {
    const tracker = new StreamLatencyTracker();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return tracker;
    const file = raw as Partial<LatencyStateFile>;
    if (Number(file.version) !== LATENCY_STATE_VERSION) return tracker;
    const streams = file.streams;
    if (!streams || typeof streams !== 'object' || Array.isArray(streams)) return tracker;
    for (const [key, entry] of Object.entries(streams)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const channel = streamKey(key);
      if (!channel) continue;
      const list = Array.isArray(entry.samples) ? entry.samples : [];
      const restored: LatencySample[] = [];
      for (const sample of list) {
        if (!sample || typeof sample !== 'object' || Array.isArray(sample)) continue;
        const measuredAtMs = Number(sample.measuredAtMs);
        const latencyMs = Number(sample.latencyMs);
        if (!Number.isFinite(measuredAtMs) || measuredAtMs <= 0) continue;
        if (
          !Number.isFinite(latencyMs) ||
          latencyMs < OBSERVED_LATENCY_MIN_MS ||
          latencyMs > OBSERVED_LATENCY_MAX_MS
        ) {
          continue;
        }
        if (sample.source !== 'scoreboard' && sample.source !== 'killfeed') continue;
        if (sample.quality !== 'confident' && sample.quality !== 'after-only') continue;
        if (
          sample.reference != null &&
          sample.reference !== 'timer-hltv' &&
          sample.reference !== 'estimada'
        ) {
          continue;
        }
        restored.push({
          measuredAtMs: Math.round(measuredAtMs),
          latencyMs: Math.round(latencyMs),
          source: sample.source,
          quality: sample.quality,
          ...(sample.reference != null ? { reference: sample.reference } : {}),
        });
      }
      if (restored.length > 0) {
        restored.sort((a, b) => a.measuredAtMs - b.measuredAtMs);
        const kept = restored.slice(-SAMPLES_PER_STREAM);
        tracker.samples.set(channel, kept);
        for (const sample of kept) {
          if (sample.measuredAtMs > tracker.lastMeasuredAtMs) {
            tracker.lastMeasuredAtMs = sample.measuredAtMs;
          }
        }
      }
      if (typeof entry.crop === 'string' && entry.crop.trim()) {
        tracker.crops.set(channel, entry.crop.trim());
      }
    }
    return tracker;
  }
}

/** Chave canônica do canal (minúsculo, sem espaços nas pontas). */
function streamKey(streamName: string | undefined): string {
  return (streamName ?? 'desconhecida').trim().toLowerCase() || 'desconhecida';
}

/** Formato do arquivo de estado da latência. */
export interface LatencyStateFile {
  version: number;
  updatedAt: string;
  streams: Record<string, { samples: LatencySample[]; crop?: string }>;
}

/** Versão do formato do estado (mudança de schema → invalida o arquivo). */
export const LATENCY_STATE_VERSION = 1;

/** De onde veio a latência aplicada no INÍCIO do clipe. */
export type StartLatencySource = 'config' | 'prior' | 'current' | 'min-safe';

/** Decisão de latência adaptativa para um clipe. */
export interface AdaptiveLatencyDecision {
  /** Latência (ms) aplicada no INÍCIO do clipe e nos timestamps. */
  startLatencyMs: number;
  /** Latência (ms) aplicada no FIM ESTIMADO (sem âncora do OCR). */
  endLatencyMs: number;
  /** De onde veio a latência do início. */
  startSource: StartLatencySource;
  /** Amostra usada no início (null = só o configurado). */
  startSample: LatencySample | null;
  /** Amostra usada no fim estimado (null = só o configurado). */
  endSample: LatencySample | null;
  /** Diferença entre a amostra do round e a anterior (ms). */
  deltaMs: number | null;
  /** O round teve mudança grande de latência (regime trocou). */
  changed: boolean;
  /** Idade da amostra anterior (ms) — 0 quando não há amostra. */
  priorAgeMs: number | null;
}

/** Entradas da decisão de latência adaptativa. */
export interface AdaptiveLatencyParams {
  /** Latência configurada do canal (ou global). */
  configuredMs: number;
  /**
   * Amostras do canal medidas ANTES do evento (mais recente por
   * último). A última é a que estava em vigor na 1ª kill. Sem filtro de
   * idade: uma amostra da PARTIDA ANTERIOR ainda vale como ponto de
   * partida (é o que faz a sincronização entre partidas ser fácil).
   */
  priorSamples: LatencySample[];
  /**
   * Janela RECENTE (idade limitada) do canal: base do fim estimado.
   * Mais antiga que isso, a medição não descreve o regime atual.
   */
  recentSamples: LatencySample[];
  /** Amostra medida no round atual (depois da 1ª kill) — pode ser null. */
  current: LatencySample | null;
  /**
   * Aumento do atraso (ms) conhecido entre a amostra anterior e a
   * 1ª kill (salto do relógio de origem da playlist HLS).
   *
   * É um sinal AMBÍGUO (aumento de atraso ou conteúdo omitido) e por
   * isso NÃO move a âncora do início por inferência: ele (a) dispara a
   * medição exata pelo killfeed e (b) entra como candidato conservador
   * do fim ESTIMADO (fechar mais tarde nunca perde a última kill).
   */
  pendingShiftMs?: number;
  /** Acima deste delta o round é considerado "regime trocou". */
  maxStepMs: number;
  /**
   * Idade máxima (ms) da amostra anterior para usá-la DIRETO no início.
   * Mais velha que isso, o regime pode ser outro (restart/fonte
   * diferente) e o início usa `min(amostra, configurado)` — abrir mais
   * cedo nunca perde a 1ª kill. Default: RECENT_SAMPLE_MAX_AGE_MS.
   */
  maxPriorAgeMs?: number;
  /** Momento do evento (wall ms) — usado para a idade da amostra. */
  eventAtMs?: number;
  /** Agora (wall ms) — usado para a janela recente. */
  nowMs?: number;
}

/**
 * Decide a latência a aplicar no clipe (puro/testável).
 *
 * INÍCIO (1ª kill): a amostra em vigor era a última medida ANTES do
 * evento. A amostra do round atual é medida no FIM do round, DEPOIS da
 * 1ª kill — então ela só pode ANTECIPAR a abertura (quando é menor que
 * a amostra anterior). Usá-la quando é maior deslocaria o início para
 * frente e poderia cortar a 1ª kill se a latência tivesse subido após
 * o kill; esse lado é ignorado. Amostra anterior VELHA (mais de
 * `maxPriorAgeMs`) é limitada ao configurado pelo lado menor. O salto do
 * PDT não move o início por inferência — ele dispara o killfeed (a única
 * medição DENTRO do vídeo).
 *
 * FIM ESTIMADO (sem âncora do OCR): o MÁXIMO entre a amostra do round,
 * a janela recente e a amostra anterior ajustada pelo salto — fechar
 * mais tarde nunca tira a última kill, só pode pesar o arquivo.
 */
export function resolveAdaptiveLatency(params: AdaptiveLatencyParams): AdaptiveLatencyDecision {
  const {
    configuredMs,
    priorSamples,
    recentSamples,
    current,
    maxStepMs,
    eventAtMs = Date.now(),
    pendingShiftMs = 0,
  } = params;
  const prior = priorSamples.length > 0 ? priorSamples[priorSamples.length - 1] : null;
  const shiftMs = Number.isFinite(pendingShiftMs) && pendingShiftMs > 0 ? pendingShiftMs : 0;
  /**
   * Amostra anterior VELHA demais: o canal pode ter mudado de regime
   * (restart da fonte, outra partida horas depois) e usar o valor
   * inteiro deslocaria a abertura. O lado seguro é o MENOR entre ela e o
   * configurado — abrir mais cedo nunca tira a 1ª kill do clipe.
   */
  const priorAgeMs =
    prior != null ? Math.max(0, eventAtMs - prior.measuredAtMs) : null;
  const stalePrior =
    prior != null &&
    priorAgeMs != null &&
    priorAgeMs > (params.maxPriorAgeMs ?? RECENT_SAMPLE_MAX_AGE_MS);
  const base = prior
    ? stalePrior
      ? Math.min(prior.latencyMs, configuredMs)
      : prior.latencyMs
    : configuredMs;
  const baseSample = prior && base === prior.latencyMs ? prior : null;
  // A base do INÍCIO é a amostra anterior (sem o salto): o salto é
  // ambíguo e só é usado onde o erro é barato (fim) ou onde há medição
  // independente (killfeed).
  let startLatencyMs = base;
  let startSource: StartLatencySource = baseSample ? 'prior' : 'config';
  let changed = false;
  let deltaMs: number | null = null;
  if (current) {
    deltaMs = current.latencyMs - base;
    changed = Math.abs(deltaMs) > maxStepMs;
    if (current.latencyMs <= base) {
      // Menor que a amostra em vigor: abrir mais cedo é sempre seguro.
      startLatencyMs = current.latencyMs;
      startSource = changed ? 'min-safe' : 'current';
    }
    // current > base: mantém a base. A medição pode ter subido DEPOIS
    // da 1ª kill; adiantar o início com ela arriscaria cortar a kill.
  }
  /**
   * Candidato do fim vindo do relógio de origem: se a stream atrasou
   * (ou omitiu conteúdo) depois da última medição, fechar mais tarde é
   * o lado conservador. Só entra no fim estimado — nunca no início.
   */
  const shiftAdjustedPrior = prior ? prior.latencyMs + shiftMs : null;
  const endSample = current ?? prior;
  let endLatencyMs = configuredMs;
  if (current) {
    const recentMax =
      recentSamples.length > 0 ? Math.max(...recentSamples.map((sample) => sample.latencyMs)) : null;
    endLatencyMs =
      current.quality === 'confident'
        ? current.latencyMs
        : Math.max(
            current.latencyMs,
            recentMax ?? Number.NEGATIVE_INFINITY,
            shiftAdjustedPrior ?? Number.NEGATIVE_INFINITY,
          );
  } else {
    const candidates = [
      ...recentSamples.map((sample) => sample.latencyMs),
      ...(shiftAdjustedPrior != null ? [shiftAdjustedPrior] : []),
    ];
    endLatencyMs =
      candidates.length > 0
        ? Math.max(...candidates)
        : prior
          ? prior.latencyMs
          : configuredMs;
  }
  return {
    startLatencyMs,
    endLatencyMs,
    startSource,
    startSample: startSource === 'current' || startSource === 'min-safe' ? current : baseSample,
    endSample,
    deltaMs,
    changed,
    priorAgeMs,
  };
}

/** Modos de sincronização declarados pelo config (espelha CLIP_STREAM_SYNC). */
export type StreamSyncMode = 'auto' | 'log' | 'off';

/**
 * A latência adaptativa só é APLICADA no modo `auto`. Em `log` a
 * medição continua sendo registrada (a varredura roda), mas o corte é
 * idêntico ao anterior — é o modo shadow, usado para comparar o
 * comportamento antigo com o novo antes de confiar na medição.
 */
export function shouldApplyAdaptive(mode: StreamSyncMode, adaptiveEnabled: boolean): boolean {
  return adaptiveEnabled && mode === 'auto';
}
