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
  /**
   * A amostra vale SÓ para o INÍCIO (estimativa baixa da latência).
   *
   * A medição pelo killfeed é `offset(1ª kill) + SCOREBOARD_DELAY_MS`:
   * como o `at` do placar é uma OBSERVAÇÃO (o poll chegou depois da
   * kill), o valor tends a ficar ABAIXO da latência real (é um limite
   * inferior enquanto o atraso do placar configurado for o real — se
   * o placar real publica antes do configurado, o valor passa do real).
   * No início ele é o lado seguro (abre mais cedo, nunca perde a 1ª
   * kill); no fim estimado ele fecharia o clipe antes do round acabar —
   * por isso fica fora do fim.
   */
  startOnly?: boolean;
}

/** Amostras guardadas por canal (mediana das últimas). */
const SAMPLES_PER_STREAM = 5;
/**
 * Amostras `startOnly` (medidas pelo killfeed) guardadas por canal.
 *
 * Anel SEPARADO de propósito: elas são estimativas baixas da latência e
 * servem só ao INÍCIO do clipe. No anel único elas expulsavam as
 * amostras do placar — que alimentam o FIM estimado (fechar mais tarde
 * nunca perde a última kill) — e a mediana passava a misturar um
 * limite inferior com medições de verdade.
 */
const START_SAMPLES_PER_STREAM = 5;
/**
 * Faixa de sanidade da latência observada (ms). Abaixo de 0 ou acima de
 * 120s o OCR não mediu latência: casou o round errado (ou a diferença
 * do relógio). Amostra fora da faixa não entra na mediana.
 */
export const OBSERVED_LATENCY_MIN_MS = 0;
export const OBSERVED_LATENCY_MAX_MS = 120_000;

/**
 * A latência (ms) está dentro da faixa plausível? Fora dela o OCR casou o
 * round errado (ou a diferença de relógio) e o valor NÃO é latência —
 * um negativo abriria o clipe antes do round, um >120s fecharia tarde
 * demais. Usado tanto na gravação (record) quanto na DECISÃO
 * (resolveAdaptiveLatency): a amostra pode chegar por caminhos que não
 * passam pelo record (a do round atual é montada no handleAce).
 */
export function plausibleLatencyMs(ms: number | null | undefined): ms is number {
  return (
    ms != null &&
    Number.isFinite(ms) &&
    ms >= OBSERVED_LATENCY_MIN_MS &&
    ms <= OBSERVED_LATENCY_MAX_MS
  );
}

/** A amostra é utilizável? (latência finita e na faixa plausível) */
export function plausibleSample(sample: LatencySample | null | undefined): sample is LatencySample {
  return sample != null && plausibleLatencyMs(sample.latencyMs);
}

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
  private readonly startSamples = new Map<string, LatencySample[]>();
  private readonly crops = new Map<string, string>();
  private readonly killfeedCrops = new Map<string, string>();
  private lastMeasuredAtMs = 0;
  /**
   * Versão do arquivo de onde o estado foi restaurado (null = estado novo,
   * sem arquivo). Diagnóstico da migração: o log do startup precisa dizer
   * que o arquivo veio de outra versão e o que foi aproveitado.
   */
  restoredFromVersion: number | null = null;
  /** Amostras restauradas (latência completa + do início). */
  restoredSamplesCount = 0;

  /**
   * Registra uma medição. Amostra fora da faixa plausível é descartada
   * (o OCR casou o round errado). Devolve a amostra gravada ou null.
   *
   * Amostra `startOnly` (killfeed) vai para o anel do INÍCIO; as demais
   * para o anel da latência completa.
   */
  record(
    streamName: string | undefined,
    latencyMs: number,
    meta?: {
      measuredAtMs?: number;
      source?: LatencySource;
      quality?: LatencyQuality;
      reference?: LatencyEndReference;
      startOnly?: boolean;
    },
  ): LatencySample | null {
    if (!plausibleLatencyMs(latencyMs)) return null;
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
      ...(meta?.startOnly === true ? { startOnly: true } : {}),
    };
    const startOnly = meta?.startOnly === true;
    const list = startOnly
      ? this.startSamples.get(key) ?? []
      : this.samples.get(key) ?? [];
    list.push(sample);
    while (list.length > (startOnly ? START_SAMPLES_PER_STREAM : SAMPLES_PER_STREAM)) {
      list.shift();
    }
    if (startOnly) this.startSamples.set(key, list);
    else this.samples.set(key, list);
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

  /**
   * Quantidade de amostras do INÍCIO (killfeed, limite inferior).
   * Não entram na mediana nem no fim estimado — só no início do clipe.
   */
  startSamplesCount(streamName: string | undefined): number {
    return this.startSamples.get(streamKey(streamName))?.length ?? 0;
  }

  /**
   * Todas as amostras do canal (latência completa + as do início), da mais
   * antiga para a mais recente.
   *
   * A união é o que a decisão do INÍCIO consulta: a amostra do killfeed
   * (limite inferior) entra só quando não há medição completa do canal.
   */
  allSamples(streamName: string | undefined): LatencySample[] {
    const key = streamKey(streamName);
    const list = [...(this.samples.get(key) ?? []), ...(this.startSamples.get(key) ?? [])];
    return list.sort((a, b) => a.measuredAtMs - b.measuredAtMs);
  }

  /**
   * A amostra mais recente do canal (latência COMPLETA).
   *
   * Só a latência completa: a amostra do INÍCIO (killfeed) é um limite
   * inferior e não substitui uma medição — quem quiser o histórico dos
   * dois anéis usa `allSamples`.
   */
  latest(streamName: string | undefined): LatencySample | null {
    const list = this.samples.get(streamKey(streamName)) ?? [];
    return list.length > 0 ? list[list.length - 1] : null;
  }

  /**
   * A amostra mais recente medida ANTES de `beforeMs` (wall ms).
   *
   * É a consulta do INÍCIO do clipe: a amostra do round atual é medida
   * depois da 1ª kill, então usá-la no início deslocaria a abertura
   * para o regime errado quando a latência mudou no meio do round.
   *
   * Só a latência COMPLETA (o limite inferior do killfeed não vale como
   * medição do regime — ver `allSamples` para o histórico dos dois).
   */
  latestBefore(streamName: string | undefined, beforeMs: number): LatencySample | null {
    const list = this.samples.get(streamKey(streamName)) ?? [];
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

  /**
   * Crop do KILLFEED que funcionou por canal. É separado do crop do
   * placar: são overlays diferentes (o placar fica no topo, o killfeed no
   * canto) e um mapa só faria o OCR do killfeed começar pelo crop errado
   * a cada ace.
   */
  killfeedCrop(streamName: string | undefined): string | null {
    return this.killfeedCrops.get(streamKey(streamName)) ?? null;
  }

  setKillfeedCrop(streamName: string | undefined, crop: string): void {
    const key = streamKey(streamName);
    if (!crop) return;
    this.killfeedCrops.set(key, crop);
  }

  /**
   * Canais com medição (diagnóstico).
   *
   * União dos DOIS anéis: um canal que só tem amostra do INÍCIO
   * (killfeed) também tem medição — omiti-lo fazia o canal sumir do
   * log de startup (e do `sync-report`).
   */
  channels(): string[] {
    return [...new Set([...this.samples.keys(), ...this.startSamples.keys()])];
  }

  /** Serializa o estado (persistência entre reinícios do bot). */
  toJSON(): LatencyStateFile {
    const streams: LatencyStateFile['streams'] = {};
    for (const [key, list] of this.samples) {
      streams[key] = { samples: list.map((sample) => ({ ...sample })) };
    }
    for (const [key, list] of this.startSamples) {
      streams[key] = {
        ...(streams[key] ?? { samples: [] }),
        startSamples: list.map((sample) => ({ ...sample })),
      };
    }
    for (const [key, crop] of this.crops) {
      streams[key] = { ...(streams[key] ?? { samples: [] }), crop };
    }
    for (const [key, killfeedCrop] of this.killfeedCrops) {
      streams[key] = { ...(streams[key] ?? { samples: [] }), killfeedCrop };
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
    const version = Number(file.version);
    /**
     * v1 é aceito SÓ para resgatar os crops memorizados (independentes do
     * schema de amostras): as amostras v1 podem ser `after-only` — atraso
     * de publicação do placar contado como latência — e o código v1
     * não distinguia `startOnly` (limite inferior) de latência
     * completa: um código antigo leria o limite como completo e o usaria
     * no FIM (cortando a última kill). As amostras v1 ficam de fora.
     *
     * v2 É aproveitada: o schema das amostras é o mesmo, e o `startOnly`
     * que pode existir nela é SEPARADO pelo roteamento abaixo (o anel
     * do início). Descartar o arquivo inteiro jogava fora a medição
     * completa de um canal por causa de uma amostra marcada.
     */
    if (version !== LATENCY_STATE_VERSION && version !== 1 && version !== 2) return tracker;
    const samplesAllowed = version >= 2;
    tracker.restoredFromVersion = version;
    const streams = file.streams;
    if (!streams || typeof streams !== 'object' || Array.isArray(streams)) return tracker;
    for (const [key, entry] of Object.entries(streams)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const channel = streamKey(key);
      if (!channel) continue;
      const list = Array.isArray(entry.samples) ? entry.samples : [];
      const startList = Array.isArray(entry.startSamples) ? entry.startSamples : [];
      const restored: LatencySample[] = [];
      const restoredStart: LatencySample[] = [];
      for (const sample of samplesAllowed ? [...list, ...startList] : []) {
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
        // Só `confident` é latência: `after-only` inclui o atraso de
        // publicação do placar e abriu clipes DEPOIS da 1ª kill
        // (medido no 2399756). O arquivo v1 fica velho pelo bump da
        // versão; o filtro aqui é a segunda trava.
        if (sample.quality !== 'confident') continue;
        if (
          sample.reference != null &&
          sample.reference !== 'timer-hltv' &&
          sample.reference !== 'estimada'
        ) {
          continue;
        }
        const restoredSample: LatencySample = {
          measuredAtMs: Math.round(measuredAtMs),
          latencyMs: Math.round(latencyMs),
          source: sample.source,
          quality: sample.quality,
          ...(sample.reference != null ? { reference: sample.reference } : {}),
          ...(sample.startOnly === true ? { startOnly: true } : {}),
        };
        // `startOnly` NUNCA entra no anel da latência completa: ali ele
        // viraria teto do fim estimado (fecharia antes do round acabar).
        if (restoredSample.startOnly === true) restoredStart.push(restoredSample);
        else restored.push(restoredSample);
      }
      if (restored.length > 0) {
        restored.sort((a, b) => a.measuredAtMs - b.measuredAtMs);
        const kept = restored.slice(-SAMPLES_PER_STREAM);
        tracker.samples.set(channel, kept);
        tracker.restoredSamplesCount += kept.length;
        for (const sample of kept) {
          if (sample.measuredAtMs > tracker.lastMeasuredAtMs) {
            tracker.lastMeasuredAtMs = sample.measuredAtMs;
          }
        }
      }
      if (restoredStart.length > 0) {
        restoredStart.sort((a, b) => a.measuredAtMs - b.measuredAtMs);
        const kept = restoredStart.slice(-START_SAMPLES_PER_STREAM);
        tracker.startSamples.set(channel, kept);
        tracker.restoredSamplesCount += kept.length;
        for (const sample of kept) {
          if (sample.measuredAtMs > tracker.lastMeasuredAtMs) {
            tracker.lastMeasuredAtMs = sample.measuredAtMs;
          }
        }
      }
      if (typeof entry.crop === 'string' && entry.crop.trim()) {
        tracker.crops.set(channel, entry.crop.trim());
      }
      if (typeof entry.killfeedCrop === 'string' && entry.killfeedCrop.trim()) {
        tracker.killfeedCrops.set(channel, entry.killfeedCrop.trim());
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
  streams: Record<
    string,
    {
      /** Amostras de latência completa (alimentam o fim estimado). */
      samples: LatencySample[];
      /** Amostras do INÍCIO (killfeed): limite inferior, fora do fim. */
      startSamples?: LatencySample[];
      crop?: string;
      killfeedCrop?: string;
    }
  >;
}

/**
 * Versão do formato do estado (mudança de schema → invalida o arquivo).
 *
 * v2: amostras `after-only` deixaram de ser latência (o atraso de
 * publicação do placar ia junto — 58-63s medidos para 45s reais no
 * 2399756) e só `confident` entra no estado. O bump descarta o estado
 * v1 envenenado em vez de ressuscitar amostras contaminadas.
 *
 * v3: as amostras do KILLFEED (`startOnly`) ganharam anel próprio. Sem
 * o bump, um rollback para o código v2 leria o limite inferior como
 * latência completa e o usaria no FIM estimado — fechando o clipe
 * antes da última kill. O arquivo v2 perde as amostras (só os crops,
 * que são independentes do schema, são resgatados).
 */
export const LATENCY_STATE_VERSION = 3;

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
     * Apenas amostras `confident` alimentam o início (o filtro é feito
     * dentro de resolveAdaptiveLatency).
     */
    priorSamples: LatencySample[];
  /**
   * Janela RECENTE (idade limitada) do canal: base do fim estimado.
   * Mais antiga que isso, a medição não descreve o regime atual.
   */
  recentSamples: LatencySample[];
  /**
   * Amostra medida no round atual (depois da 1ª kill) — pode ser null.
   * Amostra fora da faixa plausível é IGNORADA (o OCR casou o round
   * errado): ela nunca move o início nem o fim.
   */
  current: LatencySample | null;  /**
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
 * evento — e só conta se for `confident` (a virada do placar lida com o
 * "antes" e o "depois"). Amostra `after-only` carrega o atraso de
 * publicação do placar (~13-20s): usá-la como latência abriu o clipe
 * DEPOIS da 1ª kill (medido no 2399756: amostras de 58-63s para uma
 * latência real de 45s). A amostra do round atual é medida no FIM do
 * round, DEPOIS da 1ª kill — então ela só pode ANTECIPAR a abertura
 * (quando é menor que a amostra anterior). Amostra anterior VELHA (mais
 * de `maxPriorAgeMs`) é limitada ao configurado pelo lado menor. O salto
 * do PDT não move o início por inferência — ele dispara o killfeed (a
 * única medição DENTRO do vídeo).
 *
 * FIM ESTIMADO (sem âncora do OCR): o MÁXIMO entre a amostra do round,
 * a janela recente e a amostra anterior ajustada pelo salto — fechar
 * mais tarde nunca tira a última kill, só pode pesar o arquivo. Amostras
 * `startOnly` (killfeed = limite INFERIOR da latência) ficam de fora.
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
  /**
   * Toda amostra passa pela faixa plausível ANTES de decidir: a do round
   * atual chega montada pelo chamador (não pelo record, que já filtra) e
   * um valor negativo/enorme do OCR deslocaria o corte inteiro.
   */
  const sanePrior = priorSamples.filter(plausibleSample);
  const saneRecent = recentSamples.filter(plausibleSample);
  const currentSample = plausibleSample(current) ? current : null;
  /**
   * Amostra CONFIÁVEL para o início: a mais recente medida antes do
   * evento cuja qualidade seja `confident` E cujo fim de round veio do
   * timer real do HLTV. `after-only`/`gap-inferred` são âncoras de FIM
   * (a virada apareceu no vídeo, mas sem o "antes" não se sabe quando o
   * round fechou) e `estimada` carrega o erro de CLIP_SCORE_DELAY_MS
   * (±20s) — nenhuma das duas é latência.
   *
   * A amostra do KILLFEED (`startOnly`) é limite INFERIOR: ela serve
   * quando não há medição completa do canal, mas NUNCA substitui uma
   * medição de verdade. No mesmo round o killfeed é gravado DEPOIS do
   * placar — usá-lo como base trocaria a latência precisa pelo limite
   * inferior (e o `delta` contra ele dispararia "regime trocou" a toa,
   * reacendendo o OCR caro do killfeed).
   */
  const reversedPrior = [...sanePrior].reverse();
  const startPriorMeasured =
    reversedPrior.find(
      (sample) =>
        sample.quality === 'confident' &&
        sample.reference !== 'estimada' &&
        sample.startOnly !== true,
    ) ?? null;
  const startPriorKillfeed =
    reversedPrior.find(
      (sample) =>
        sample.quality === 'confident' &&
        sample.reference !== 'estimada' &&
        sample.startOnly === true,
    ) ?? null;
  const maxPriorAgeMs = params.maxPriorAgeMs ?? RECENT_SAMPLE_MAX_AGE_MS;
  const ageOf = (sample: LatencySample): number =>
    Math.max(0, eventAtMs - sample.measuredAtMs);
  const isStale = (sample: LatencySample | null): boolean =>
    sample != null && ageOf(sample) > maxPriorAgeMs;
  /**
   * Prior do INÍCIO: medição completa (enquanto não estiver velha) >
   * medição do killfeed (enquanto não estiver velha) > a mais recente
   * das duas (velha). Uma medição velha perde para uma recente — o
   * regime da stream pode ter mudado entre as partidas.
   */
  const startPrior =
    (startPriorMeasured != null && !isStale(startPriorMeasured)
      ? startPriorMeasured
      : null) ??
    (startPriorKillfeed != null && !isStale(startPriorKillfeed)
      ? startPriorKillfeed
      : null) ??
    startPriorMeasured ??
    startPriorKillfeed;
  const shiftMs = Number.isFinite(pendingShiftMs) && pendingShiftMs > 0 ? pendingShiftMs : 0;
  /**
   * Amostras `startOnly` (medidas pelo killfeed) são LIMITE INFERIOR da
   * latência: valem para abrir o clipe mais cedo, mas no FIM estimado
   * fechariam antes do round terminar. O fim só considera as demais.
   */
  const endPrior = [...sanePrior].reverse().find((sample) => sample.startOnly !== true) ?? null;
  const endRecent = saneRecent.filter((sample) => sample.startOnly !== true);
  const endCurrent =
    currentSample != null && currentSample.startOnly !== true ? currentSample : null;
  /**
   * Amostra anterior VELHA demais: o canal pode ter mudado de regime
   * (restart da fonte, outra partida horas depois) e usar o valor
   * inteiro deslocaria a abertura. O lado seguro é o MENOR entre ela e o
   * configurado — abrir mais cedo nunca tira a 1ª kill do clipe.
   */
  const priorAgeMs =
    startPrior != null ? Math.max(0, eventAtMs - startPrior.measuredAtMs) : null;
  const stalePrior =
    startPrior != null &&
    priorAgeMs != null &&
    priorAgeMs > maxPriorAgeMs;
  const base = startPrior
    ? stalePrior
      ? Math.min(startPrior.latencyMs, configuredMs)
      : startPrior.latencyMs
    : configuredMs;
  const baseSample = startPrior && base === startPrior.latencyMs ? startPrior : null;
  /**
   * Base da COMPARAÇÃO (delta / "regime trocou"): a última medição
   * COMPLETA do canal. Sem ela, o limite inferior do killfeed serviria
   * de referência — e a diferença entre ele e a medição do round (5-16s
   * do atraso de poll) dispararia "regime trocou" sem trocar de regime
   * (o efeito: outro OCR caro do killfeed no mesmo round).
   */
  const comparisonBaseMs =
    startPriorMeasured != null && !isStale(startPriorMeasured)
      ? startPriorMeasured.latencyMs
      : configuredMs;
  // A base do INÍCIO é a amostra anterior (sem o salto): o salto é
  // ambíguo e só é usado onde o erro é barato (fim) ou onde há medição
  // independente (killfeed).
  let startLatencyMs = base;
  let startSource: StartLatencySource = baseSample ? 'prior' : 'config';
  let changed = false;
  let deltaMs: number | null = null;
  /**
   * A amostra do round só pode ANTECIPAR o início quando é latência de
   * verdade: `confident` e fim do round pelo timer do HLTV. Com o fim
   * ESTIMADO o valor carrega o erro do atraso de publicação do placar
   * (±CLIP_SCORE_DELAY_MS) e antecipar com ele pode abrir DEPOIS da 1ª
   * kill — a mesma razão pela qual ela não alimenta o `startPrior`.
   */
  const currentForStart =
    currentSample != null &&
    currentSample.quality === 'confident' &&
    currentSample.reference !== 'estimada'
      ? currentSample
      : null;
  if (currentSample) {
    deltaMs = currentSample.latencyMs - comparisonBaseMs;
    changed = Math.abs(deltaMs) > maxStepMs;
    if (currentForStart != null && currentForStart.latencyMs <= base) {
      // Menor que a amostra em vigor: abrir mais cedo é sempre seguro.
      startLatencyMs = currentForStart.latencyMs;
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
  const shiftAdjustedPrior = endPrior ? endPrior.latencyMs + shiftMs : null;
  const endSample = endCurrent ?? endPrior;
  let endLatencyMs = configuredMs;
  if (endCurrent) {
    const recentMax =
      endRecent.length > 0 ? Math.max(...endRecent.map((sample) => sample.latencyMs)) : null;
    endLatencyMs =
      endCurrent.quality === 'confident'
        ? endCurrent.latencyMs
        : Math.max(
            endCurrent.latencyMs,
            recentMax ?? Number.NEGATIVE_INFINITY,
            shiftAdjustedPrior ?? Number.NEGATIVE_INFINITY,
          );
  } else {
    const candidates = [
      ...endRecent.map((sample) => sample.latencyMs),
      ...(shiftAdjustedPrior != null ? [shiftAdjustedPrior] : []),
    ];
    endLatencyMs =
      candidates.length > 0
        ? Math.max(...candidates)
        : endPrior
          ? endPrior.latencyMs
          : configuredMs;
  }
  return {
    startLatencyMs,
    endLatencyMs,
    startSource,
    startSample:
      startSource === 'current' || startSource === 'min-safe' ? currentSample : baseSample,
    endSample,
    deltaMs,
    changed,
    priorAgeMs,
  };
}

/** Modos de sincronização declarados pelo config (espelha CLIP_STREAM_SYNC). */
export type StreamSyncMode = 'auto' | 'log' | 'off';

/**
 * Decisão da latência de ABERTURA do clipe (puro/testável).
 *
 * A latência estimada pode ser de duas naturezas:
 * - MEDIDA (amostra do placar/killfeed): a melhor estimativa da latência
 *   real — o corte e os timestamps usam o valor inteiro;
 * - CONFIGURADA (palpite do dono, sem medição do canal): pode estar
 *   inflada, e aí o corte abriria DEPOIS da 1ª kill (o defeito mais
 *   caro). Nesse caso — e só nesse caso — o teto limita a ABERTURA.
 *
 * O teto NÃO mexe na estimativa: os timestamps e a cobertura continuam
 * com a melhor estimativa disponível. Abrir cedo é o lado barato do
 * corte; para os timestamps não existe lado barato, e usar um valor
 * limitado ali deslocaria a marca de tempo das kills na descrição.
 */
export interface StartLatencyParams {
  /** Latência estimada (ms): a melhor estimativa da latência real. */
  estimatedMs: number;
  /** Houve MEDIÇÃO do canal na decisão (amostra do placar/killfeed)? */
  measured: boolean;
  /** O killfeed ancorou o início (posição exata da 1ª kill no vídeo)? */
  killfeedAnchored: boolean;
  /** Teto da latência de ABERTURA (ms). 0 = desligado. */
  capMs: number;
  /** O modo adaptativo está sendo aplicado? */
  applyAdaptive: boolean;
}

/** Resultado da decisão da latência de abertura. */
export interface StartLatencyDecision {
  /** Latência estimada (ms): timestamps, sidecar e cobertura. */
  estimatedMs: number;
  /** Latência (ms) que o CORTE usa para abrir o clipe. */
  openMs: number;
  /** O teto limitou a abertura. */
  capped: boolean;
  /** Por quê (diagnóstico). */
  reason: 'adaptive-off' | 'killfeed' | 'measured' | 'capped' | 'config';
}

/**
 * Decide a latência de ABERTURA do clipe (puro/testável).
 *
 * Regras (em ordem):
 * 1. adaptativo desligado (`CLIP_STREAM_SYNC_ADAPTIVE=false` ou modo
 *    shadow): o corte usa o configurado como é — o teto é inativo
 *    (ninguém pediu a medição, ninguém quer a heurística);
 * 2. killfeed ancorou o início: a posição da 1ª kill é medição dentro do
 *    vídeo — o teto não se aplica (e o corte nem usa a latência);
 * 3. latência MEDIDA: o valor é a melhor estimativa — o teto não se
 *    aplica (silenciar uma medição seria mudar o corte sem motivo);
 * 4. sem medição: o teto limita a abertura ao valor configurado.
 */
export function resolveStartLatency(params: StartLatencyParams): StartLatencyDecision {
  const estimatedMs = params.estimatedMs;
  if (!params.applyAdaptive) {
    return { estimatedMs, openMs: estimatedMs, capped: false, reason: 'adaptive-off' };
  }
  if (params.killfeedAnchored) {
    return { estimatedMs, openMs: estimatedMs, capped: false, reason: 'killfeed' };
  }
  if (params.measured) {
    return { estimatedMs, openMs: estimatedMs, capped: false, reason: 'measured' };
  }
  if (params.capMs > 0 && estimatedMs > params.capMs) {
    return { estimatedMs, openMs: params.capMs, capped: true, reason: 'capped' };
  }
  return { estimatedMs, openMs: estimatedMs, capped: false, reason: 'config' };
}

/**
 * A latência adaptativa só é APLICADA no modo `auto`. Em `log` a
 * medição continua sendo registrada (a varredura roda), mas o corte é
 * idêntico ao anterior — é o modo shadow, usado para comparar o
 * comportamento antigo com o novo antes de confiar na medição.
 */
export function shouldApplyAdaptive(mode: StreamSyncMode, adaptiveEnabled: boolean): boolean {
  return adaptiveEnabled && mode === 'auto';
}
