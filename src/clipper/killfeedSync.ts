import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KillEvent } from '../types.js';
import { resolveFfprobeBin } from './segmentProbe.js';
import { resolveFfmpegBin } from './clipBuilder.js';

const execFileAsync = promisify(execFile);

/** Frequência de amostragem do killfeed (fps). */
const SAMPLE_RATE = 1;
/** Tolerância ANTES da 1ª kill estimada (ms): o killfeed aparece na hora. */
const EARLY_TOLERANCE_MS = 15_000;
/** Tolerância DEPOIS da última kill estimada (ms). */
const LATE_TOLERANCE_MS = 15_000;
/** Duas medições do mesmo kill podem diferir até isto (ms). */
const CONSISTENCY_TOLERANCE_MS = 2_500;
/** Dispersão máxima da mediana (ms) para aceitar o conjunto. */
const MAX_MEDIAN_DEVIATION_MS = 1_500;
/** Offset negativo além disso = casou o frame errado. */
const MIN_ALLOWED_OFFSET_MS = -5_000;
/**
 * Atraso entre o kill e a 1ª aparição da linha no killfeed (ms).
 *
 * A linha do killfeed entra no instante do kill, mas a amostragem de 1fps
 * só a enxerga no PRÓXIMO frame — até 1s depois. A âncora desconta esse
 * atraso: abrir 1s antes é o lado barato (o corte nunca perde a kill).
 */
const KILLFEED_APPEAR_DELAY_MS = 1_000;
/** Distância de edição tolerada entre o nome lido e o esperado. */
const NICKNAME_MAX_DISTANCE = 1;
/** Tokens máximos entre killer e vítima para o casamento valer. */
const NICKNAME_PROXIMITY_TOKENS = 10;
/**
 * Folga do teto da última kill (ms).
 *
 * Uma observação legítima fica a ~(latência + 0..2s de amostragem) da
 * kill; o atraso de observação do placar (poll) varia até ~16s entre
 * kills da mesma partida (medido: 5,2s/5,3s/16,4s). Um casamento FALSO
 * num round seguinte fica muito além disso — e não pode empurrar o fim
 * do clipe (o piso do fim usaria a posição errada).
 */
const KILLFEED_POLL_SLACK_MS = 25_000;

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

/** Uma leitura do killfeed: casa com a kill de índice `killIndex`. */
export interface KillfeedObservation {
  killIndex: number;
  streamAtMs: number;
}

/** Resultado da calibração pelo killfeed. */
export interface KillfeedSyncResult {
  /**
   * Offset entre o relógio do PLACAR (do kill) e o do VÍDEO (ms):
   * `videoTime − (kill.at − atraso do placar)`. Com ele, o instante do
   * kill no vídeo é (kill.at − atraso + offset).
   *
   * Null quando não há conjunto consistente (o `at` do placar é a
   * OBSERVAÇÃO — o poll do HLTV atrasa 5..20s — então kills com atrasos
   * de poll diferentes produzem offsets diferentes e o conjunto se
   * divide). A âncora do INÍCIO não depende dele (é leitura direta).
   */
  offsetMs: number | null;
  /**
   * Instante no VÍDEO da 1ª kill do evento (ms) — âncora do início.
   * Quando o OCR casou a 1ª kill, é a 1ª APARIÇÃO da linha dela no
   * killfeed (menos o atraso de amostragem); quando não casou, é
   * DERIVADA do offset consistente. Nunca é o instante da 1ª kill
   * CASADA (que poderia ser a 2ª/3ª kill).
   */
  firstKillVideoMs: number | null;
  /** O OCR reconheceu a 1ª kill (false = âncora derivada do offset). */
  firstKillMatched: boolean;
  /**
   * Instante no vídeo da ÚLTIMA kill observada pelo killfeed (ms) — piso
   * do FIM do clipe: a última kill tem que estar dentro, mesmo quando a
   * âncora do placar falhou ou leu round errado.
   */
  lastKillVideoMs: number | null;
  /**
   * Kills no conjunto consistente (corroboração do offset). Menor que
   * `matchedKills` quando kills com atraso de poll diferente ficam fora.
   */
  clusterKills: number;
  /**
   * Offset dos timestamps da descrição (ms): `videoTime − kill.at`.
   * É o que alinha a marca de tempo da kill com a tela.
   *
   * Só é CONFIÁVEL em `confident`: em `first-kill-only` ele vem de UMA
   * leitura e carrega o atraso do poll do HLTV daquela kill (medido:
   * 5,2s/5,3s/16,4s no mesmo round) — o consumidor não deve usá-lo na
   * descrição.
   */
  killVideoOffsetMs: number | null;
  /** Kills lidas pelo OCR (com observação válida), casadas ou não. */
  matchedKills: number;
  totalKills: number;
  medianDeviationMs: number | null;
  /**
   * A varredura terminou com o material cobrindo a janela inteira (não
   * abortou/expirou). Sem isso, "não casou" NÃO é evidência de ausência.
   */
  windowCovered: boolean;
  reason:
    | 'confident'
    | 'first-kill-only'
    | 'insufficient-matches'
    | 'inconsistent-offsets'
    | 'no-timestamped-kills'
    | 'no-killfeed';
  /** Crop do killfeed que produziu as leituras. */
  crop?: string | null;
}

/** Opções da varredura do killfeed. */
export interface KillfeedScanOptions {
  kills: KillEvent[];
  /** Atraso do placar por kill (ms). */
  scoreboardDelayMs: number;
  /**
   * Latência estimada (ms): converte o relógio do placar no relógio do
   * vídeo para saber QUAL segmento varrer. É só uma dica — o resultado
   * é medido, não derivado dela.
   */
  latencyHintMs: number;
  /**
   * Latência MÁXIMA plausível (ms): o killfeed é acionado justamente
   * quando o regime pode ter mudado, então a janela vai da latência do
   * início até este valor. Sem ele, a janela usa só o hint (comportamento
   * antigo) — e perderia o kill quando a latência tivesse subido.
   */
  latencyMaxMs?: number;
  /** Duração do segmento (s). */
  segmentTimeSec: number;
  /** Segmentos disponíveis (ordenados por mtime). */
  listSegments: () => string[];
  /**
   * Descarta o segmento mais novo da lista (ainda sendo escrito pelo
   * recorder). Default true; a lista vinda do freezer já contém só
   * arquivos fechados.
   */
  skipNewest?: boolean;
  /** Crops tentados, em ordem (o primeiro é o principal). */
  crops: string[];
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Janela da timeline do VÍDEO a varrer (ms), a partir da FAIXA de
 * latências plausíveis.
 *
 * A janela tem que cobrir as kills quando a latência MUDOU: o killfeed é
 * acionado pelo salto do PDT ou pela troca de regime, exatamente os
 * casos em que o hint antigo está errado. Usar só o hint perderia o
 * killfeed (e a única medição DENTRO do vídeo) justo quando ele é
 * necessário. As tolerâncias cobrem a amostragem de 1fps e o jitter do
 * killfeed. Puro/testável.
 */
export function killfeedScanWindowMs(params: {
  kills: KillEvent[];
  scoreboardDelayMs: number;
  latencyHintMs: number;
  latencyMaxMs?: number;
  earlyToleranceMs?: number;
  lateToleranceMs?: number;
}): { startMs: number; endMs: number } | null {
  const times = params.kills
    .filter((kill) => Number.isFinite(kill.at))
    .map((kill) => kill.at! - params.scoreboardDelayMs);
  if (times.length === 0) return null;
  const minLatency = Math.max(
    0,
    Math.min(params.latencyHintMs, params.latencyMaxMs ?? params.latencyHintMs),
  );
  const maxLatency = Math.max(
    params.latencyHintMs,
    params.latencyMaxMs ?? params.latencyHintMs,
  );
  return {
    startMs:
      Math.min(...times) +
      minLatency -
      (params.earlyToleranceMs ?? EARLY_TOLERANCE_MS),
    endMs:
      Math.max(...times) +
      maxLatency +
      (params.lateToleranceMs ?? LATE_TOLERANCE_MS),
  };
}

/** Estimativa pura do offset/âncoras a partir das leituras do killfeed. */
export interface StreamOffsetEstimate {
  offsetMs: number | null;
  matchedKills: number;
  totalKills: number;
  medianDeviationMs: number | null;
  reason: KillfeedSyncResult['reason'];
  firstKillVideoMs: number | null;
  firstKillMatched: boolean;
  lastKillVideoMs: number | null;
  clusterKills: number;
  killVideoOffsetMs: number | null;
}

/**
 * Estima o offset placar→vídeo e as âncoras do clipe a partir das
 * leituras do killfeed.
 *
 * O killfeed é o ÚNICO sinal que dá o instante do kill DENTRO do vídeo
 * (o placar do HLTV só diz QUANDO ele mostrou). Cada leitura casa
 * killer+vítima e devolve o instante no vídeo.
 *
 * ÂNCORA DO INÍCIO = a 1ª APARIÇÃO da linha da 1ª kill no killfeed
 * (menos o atraso de amostragem) — medição DIRETA, que não depende do
 * `at` do placar: o poll do HLTV observou as 3 kills do 2399756 com
 * atrasos de 5,2s, 5,3s e 16,4s, então `kill.at + offset` erra até 11s.
 * O offset (mediana do cluster) fica para os timestamps da descrição e
 * para o estado de latência — e exige corroboração (≥ 2 kills com o
 * mesmo offset dentro da tolerância).
 */
export function estimateStreamOffset(
  kills: KillEvent[],
  observations: KillfeedObservation[],
  scoreboardDelayMs: number,
  maxLagSec: number,
): StreamOffsetEstimate {
  const empty = (reason: KillfeedSyncResult['reason'], totalKills: number): StreamOffsetEstimate => ({
    offsetMs: null,
    matchedKills: 0,
    totalKills,
    medianDeviationMs: null,
    reason,
    firstKillVideoMs: null,
    firstKillMatched: false,
    lastKillVideoMs: null,
    clusterKills: 0,
    killVideoOffsetMs: null,
  });
  const timestamped = kills
    .map((kill, killIndex) => ({ kill, killIndex }))
    .filter(({ kill }) => Number.isFinite(kill.at));
  if (timestamped.length === 0) {
    return empty('no-timestamped-kills', 0);
  }

  // A 1ª aparição de cada kill no killfeed = o instante do kill (+1s de
  // amostragem). Observações posteriores são a MESMA linha persistindo.
  const firstSeenByKill = new Map<number, number>();
  for (const observation of observations) {
    const current = firstSeenByKill.get(observation.killIndex);
    if (current == null || observation.streamAtMs < current) {
      firstSeenByKill.set(observation.killIndex, observation.streamAtMs);
    }
  }

  const candidates = [...firstSeenByKill]
    .map(([killIndex, streamAtMs]) => {
      const kill = kills[killIndex];
      if (!kill || !Number.isFinite(kill.at) || !Number.isFinite(streamAtMs)) return null;
      const offsetMs = streamAtMs - (kill.at! - scoreboardDelayMs);
      if (offsetMs < MIN_ALLOWED_OFFSET_MS || offsetMs > maxLagSec * 1000) return null;
      return { killIndex, offsetMs, streamAtMs };
    })
    .filter((candidate): candidate is { killIndex: number; offsetMs: number; streamAtMs: number } => candidate !== null);

  const minimumMatches = Math.min(
    timestamped.length,
    Math.max(2, Math.ceil(timestamped.length * 0.6)),
  );
  let best: Array<{ killIndex: number; offsetMs: number; streamAtMs: number }> = [];
  for (const candidate of candidates) {
    const cluster = candidates
      .filter((item) => Math.abs(item.offsetMs - candidate.offsetMs) <= CONSISTENCY_TOLERANCE_MS)
      .sort((a, b) => Math.abs(a.offsetMs - candidate.offsetMs) - Math.abs(b.offsetMs - candidate.offsetMs));
    if (cluster.length > best.length) best = cluster;
  }

  const firstTimestamped = timestamped[0];
  const firstCandidate =
    candidates.find((candidate) => candidate.killIndex === firstTimestamped.killIndex) ?? null;
  /**
   * Corroboração da 1ª kill: o offset dela concorda com outra kill
   * (mesmo cluster) — prova de que o OCR leu a linha certa, não um nome
   * parecido em frame distante.
   */
  const firstClusterKills = firstCandidate
    ? candidates.filter(
        (item) => Math.abs(item.offsetMs - firstCandidate.offsetMs) <= CONSISTENCY_TOLERANCE_MS,
      ).length
    : 0;

  const matchedKills = new Set(candidates.map((candidate) => candidate.killIndex)).size;
  const clusterKills = best.length;
  /**
   * Âncora DIRETA da 1ª kill (a leitura do killfeed) — vale mesmo sem
   * cluster: a linha só aparece quando o kill aconteceu.
   */
  const directAnchorMs = firstCandidate
    ? firstCandidate.streamAtMs - KILLFEED_APPEAR_DELAY_MS
    : null;
  const directKillVideoOffsetMs =
    firstCandidate != null ? directAnchorMs! - firstTimestamped.kill.at! : null;
  /**
   * Offset corroborado (≥ 2 kills no mesmo cluster, desvio mediano
   * aceitável): é o único que vira latência/timestamps.
   */
  const clusterOffsetMs =
    clusterKills >= minimumMatches ? median(best.map((item) => item.offsetMs)) : null;
  const clusterDeviationMs =
    clusterOffsetMs != null
      ? median(best.map((item) => Math.abs(item.offsetMs - clusterOffsetMs)))
      : null;
  const clusterUsable =
    clusterOffsetMs != null &&
    (clusterDeviationMs ?? Number.POSITIVE_INFINITY) <= MAX_MEDIAN_DEVIATION_MS;
  /**
   * Âncora DERIVADA: o offset vale para QUALQUER kill do round (é a
   * diferença entre os relógios). Aplicá-lo ao `at` da 1ª kill
   * reconstrói o instante dela no vídeo mesmo quando o OCR não leu o
   * nome dela — o caso em que usar a 1ª kill CASADA começaria o clipe
   * na 2ª/3ª kill.
   */
  const derivedAnchorMs =
    clusterUsable && clusterOffsetMs != null
      ? firstTimestamped.kill.at! -
        scoreboardDelayMs +
        Math.round(clusterOffsetMs) -
        KILLFEED_APPEAR_DELAY_MS
      : null;

  /**
   * Última kill no vídeo: a 1ª aparição da linha menos a amostragem.
   * Conservador de propósito — um falso positivo só ALONGA o clipe
   * (piso do fim); encurtar é o que perde a última kill.
   *
   * TETO: um casamento falso num round SEGUINTE (mesmo par killer→vítima
   * repetido) não pode empurrar o fim — o piso do fim e o corte
   * replay-aware usariam a posição errada. O teto usa o intervalo
   * placar entre a 1ª e a última kill + folga para a variação do poll.
   *
   * Sem âncora (nenhuma kill com offset corroborado) o valor fica NULL:
   * sem teto, um falso positivo no round seguinte viraria barreira dura
   * do corte replay-aware (clipe com dezenas de segundos de cauda).
   */
  const lastTimestamped = timestamped[timestamped.length - 1];
  const anchorForCeiling = directAnchorMs ?? derivedAnchorMs;
  const observedLastKillMs =
    candidates.length > 0
      ? Math.max(...candidates.map((candidate) => candidate.streamAtMs)) - KILLFEED_APPEAR_DELAY_MS
      : null;
  const lastKillVideoMs =
    anchorForCeiling != null && observedLastKillMs != null
      ? Math.min(
          observedLastKillMs,
          anchorForCeiling +
            Math.max(0, lastTimestamped.kill.at! - firstTimestamped.kill.at!) +
            KILLFEED_POLL_SLACK_MS,
        )
      : null;

  if (firstCandidate && firstClusterKills >= 2) {
    const offsetMs = median(
      candidates
        .filter((item) => Math.abs(item.offsetMs - firstCandidate.offsetMs) <= CONSISTENCY_TOLERANCE_MS)
        .map((item) => item.offsetMs),
    );
    return {
      offsetMs: Math.round(offsetMs),
      matchedKills,
      totalKills: timestamped.length,
      medianDeviationMs: Math.round(median(
        candidates
          .filter((item) => Math.abs(item.offsetMs - firstCandidate.offsetMs) <= CONSISTENCY_TOLERANCE_MS)
          .map((item) => Math.abs(item.offsetMs - offsetMs)),
      )),
      reason: 'confident',
      firstKillVideoMs: directAnchorMs,
      firstKillMatched: true,
      lastKillVideoMs,
      clusterKills: firstClusterKills,
      killVideoOffsetMs: directKillVideoOffsetMs,
    };
  }

  if (firstCandidate) {
    // 1ª kill lida, mas sem corroboração: a âncora é EXATA (o killfeed
    // só mostra a linha quando o kill aconteceu); o offset/latência não
    // tem de onde vir com confiança.
    return {
      offsetMs: null,
      matchedKills,
      totalKills: timestamped.length,
      medianDeviationMs: null,
      reason: 'first-kill-only',
      firstKillVideoMs: directAnchorMs,
      firstKillMatched: true,
      lastKillVideoMs,
      clusterKills: firstClusterKills,
      killVideoOffsetMs: directKillVideoOffsetMs,
    };
  }

  if (clusterUsable && clusterOffsetMs != null) {
    return {
      offsetMs: Math.round(clusterOffsetMs),
      matchedKills,
      totalKills: timestamped.length,
      medianDeviationMs: Math.round(clusterDeviationMs ?? 0),
      reason: 'confident',
      firstKillVideoMs: derivedAnchorMs,
      firstKillMatched: false,
      lastKillVideoMs,
      clusterKills,
      killVideoOffsetMs: Math.round(clusterOffsetMs) - scoreboardDelayMs,
    };
  }

  return {
    offsetMs: null,
    matchedKills,
    totalKills: timestamped.length,
    medianDeviationMs: clusterDeviationMs != null ? Math.round(clusterDeviationMs) : null,
    reason: matchedKills >= minimumMatches ? 'inconsistent-offsets' : 'insufficient-matches',
    firstKillVideoMs: null,
    firstKillMatched: false,
    lastKillVideoMs,
    clusterKills,
    killVideoOffsetMs: null,
  };
}

function normalizeNickname(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Chave do nome: minúsculas, sem separadores ("KaiR0N-" → "kair0n"). */
function nicknameKey(value: string): string {
  return normalizeNickname(value).join('');
}

/**
 * Chave canônica para comparar com a leitura do OCR: 0↔O e a CLASSE de
 * confusão {1, i, j, l} são erros sistemáticos do leitor ("KaiR0N-" lido
 * "KaiRON-", "jL" lido "IL", "khaN" lido "haN"). Sem isso o matcher exige
 * nomes perfeitos e perde justamente a 1ª kill (medido: 4/4 aces do
 * 2399756).
 *
 * `j` entra na mesma classe porque o OCR confunde a perna curta das três
 * letras: é isso que faz "IL" casar "jL" sem abrir a porta para "al".
 */
function canonicalKey(value: string): string {
  return nicknameKey(value).replace(/0/g, 'o').replace(/[1ijl]/g, 'l');
}

/** Distância de edição (Levenshtein), cortando quando passa de `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j++) previous.push(j);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/** Uma ocorrência de um nome na sequência de tokens do OCR. */
interface NicknameHit {
  /** Índice do token onde o nome começa. */
  start: number;
  /** Índice do token onde o nome termina (inclusivo). */
  end: number;
}

/**
 * Todas as ocorrências (não sobrepostas) de um nome nos tokens do OCR.
 * O nome pode vir dividido entre tokens ("Kai" "RON") e com um caractere
 * trocado pelo leitor — a distância de edição cobre ambos (medido no
 * 2399756: "KaiR0N-" lido "KaiRON-", "jL" lido "IL", "khaN" lido "haN").
 * O falso positivo fica preso por exigir killer E vítima próximos no
 * texto (mesma linha) e, na âncora, pelo cluster quando existe.
 */
function findNicknameHits(tokens: string[], nickname: string): NicknameHit[] {
  const target = canonicalKey(nickname);
  if (target.length < 2) return [];
  /**
   * Nome CURTO (≤3 letras) exige leitura EXATA (após a classe de
   * confusão): com distância 1, "jL" casava qualquer token de 2-3 letras
   * ("al", "il", "ll") — e uma leitura falsa vira âncora (e descarte) sem
   * corroboração. Nomes longos mantêm distância 1: um caractere
   * perdido/trocado é comum ("khaN"→"haN", "KaiR0N-"→"KaiRON-") e o
   * falso positivo fica improvável.
   */
  const maxDistance = target.length <= 3 ? 0 : NICKNAME_MAX_DISTANCE;
  const hits: NicknameHit[] = [];
  let index = 0;
  while (index < tokens.length) {
    let matched: NicknameHit | null = null;
    for (let len = 1; len <= 4 && index + len <= tokens.length; len++) {
      const candidate = canonicalKey(tokens.slice(index, index + len).join(''));
      // Um token de 1 caractere casaria qualquer nome de 2 letras por
      // inserção ("j" ≈ "jL") — ruído puro do OCR.
      if (candidate.length < 2) continue;
      if (candidate.length < target.length - maxDistance) continue;
      if (candidate.length > target.length + maxDistance) break;
      if (editDistance(candidate, target, maxDistance) <= maxDistance) {
        matched = { start: index, end: index + len - 1 };
        break;
      }
    }
    if (matched != null) {
      hits.push(matched);
      index = matched.end + 1;
    } else {
      index += 1;
    }
  }
  return hits;
}

/**
 * Quais kills (índice) o texto do killfeed casa?
 *
 * Tolerante ao ruído do OCR (distância de edição ≤ 1 + confusões 0/O,
 * 1/l/I), com três travas contra falso positivo:
 * - killer e vítima têm que aparecer os dois;
 * - perto um do outro no texto (a mesma linha do feed);
 * - self-kill (killer == vítima) exige o nome 2x — uma ocorrência só
 *   casaria qualquer frame com o nome do jogador (medido no 2399756:
 *   "ZywOo→ZywOo" e "jL→jL" casavam frames sem o suicide).
 */
export function matchKillfeedText(text: string, kills: KillEvent[]): number[] {
  const tokens = normalizeNickname(text);
  return kills.flatMap((kill, index) => {
    const killer = nicknameKey(kill.killer);
    const victim = nicknameKey(kill.victim);
    if (killer.length < 2 || victim.length < 2) return [];
    const killerHits = findNicknameHits(tokens, killer);
    if (killerHits.length === 0) return [];
    const victimHits = findNicknameHits(tokens, victim);
    if (victimHits.length === 0) return [];
    if (killer === victim && killerHits.length < 2) return [];
    const sameLine = killerHits.some((killerHit) =>
      victimHits.some(
        (victimHit) => Math.abs(victimHit.start - killerHit.end) <= NICKNAME_PROXIMITY_TOKENS,
      ),
    );
    return sameLine ? [index] : [];
  });
}

async function probeDuration(file: string, ffprobe: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { timeout: 15_000, windowsHide: true },
  );
  const durationSec = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`duração inválida no segmento ${path.basename(file)}`);
  }
  return durationSec;
}

interface CropCandidate {
  raw: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseCrop(raw: string): CropCandidate | null {
  const parts = raw.split(':').map(Number);
  if (
    parts.length !== 4 ||
    !parts.every(Number.isFinite) ||
    parts[0] < 0 ||
    parts[1] < 0 ||
    parts[2] <= 0 ||
    parts[3] <= 0 ||
    parts[0] + parts[2] > 1 ||
    parts[1] + parts[3] > 1
  ) {
    return null;
  }
  return { raw, x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Varre um segmento procurando o killfeed. Tenta o crop principal; se
 * não casar nenhuma kill, tenta os alternativos (o killfeed fica em
 * cantos diferentes conforme o canal).
 */
async function scanSegment(
  file: string,
  durationSec: number,
  directory: string,
  ffmpeg: string,
  worker: OcrWorker,
  sharp: typeof import('sharp').default,
  kills: KillEvent[],
  segmentEndMs: number,
  crops: CropCandidate[],
  abort?: () => boolean,
): Promise<{ observations: KillfeedObservation[]; crop: string | null }> {
  const observations: KillfeedObservation[] = [];
  let usedCrop: string | null = null;
  for (const crop of crops) {
    if (abort?.()) break;
    const framesDir = path.join(
      directory,
      `${path.basename(file, path.extname(file))}-${Math.round(segmentEndMs)}-${crop.raw.replace(/[^0-9.]/g, '_')}`,
    );
    fs.mkdirSync(framesDir, { recursive: true });
    try {
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          file,
          '-vf',
          `fps=${SAMPLE_RATE},crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`,
          path.join(framesDir, 'frame_%04d.png'),
        ],
        { timeout: Math.max(30_000, Math.ceil(durationSec * 10_000)), windowsHide: true },
      );
    } catch {
      continue;
    }
    const frames = fs.readdirSync(framesDir).filter((name) => name.endsWith('.png')).sort();
    const segmentStartMs = segmentEndMs - durationSec * 1000;
    let matched = 0;
    for (let i = 0; i < frames.length; i++) {
      if (abort?.()) break;
      const image = await sharp(path.join(framesDir, frames[i]))
        .resize({ width: 2400 })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
      const { data } = await worker.recognize(image);
      const streamAtMs = segmentStartMs + (i * 1000) / SAMPLE_RATE;
      for (const killIndex of matchKillfeedText(String(data.text ?? ''), kills)) {
        observations.push({ killIndex, streamAtMs });
        matched++;
      }
    }
    if (matched > 0) {
      usedCrop = crop.raw;
      break;
    }
  }
  return { observations, crop: usedCrop };
}

/**
 * Procura as kills do ace no KILLFEED do vídeo.
 *
 * Quando o placar do vídeo não pôde ser lido (ou o round trocou de
 * regime de latência), esta é a segunda medição: ela dá o instante do
 * kill DENTRO do vídeo, que não depende de nenhuma latência estimada.
 *
 * A janela varrida é calculada com a latência SUGERIDA (só para saber
 * qual segmento olhar) — o resultado é medido.
 */
export async function scanKillfeedForLatency(
  options: KillfeedScanOptions,
): Promise<KillfeedSyncResult> {
  const {
    kills,
    scoreboardDelayMs,
    latencyHintMs,
    latencyMaxMs,
    segmentTimeSec,
    listSegments,
    crops,
  } = options;
  const timestamped = kills.filter((kill) => Number.isFinite(kill.at));
  const cropCandidates = crops
    .map((raw) => parseCrop(raw))
    .filter((crop): crop is CropCandidate => crop !== null);
  if (timestamped.length === 0 || cropCandidates.length === 0) {
    return {
      ...estimateStreamOffset(kills, [], scoreboardDelayMs, 0),
      crop: null,
      windowCovered: false,
    };
  }

  // Janela no relógio do VÍDEO: instante estimado das kills ± tolerância,
  // cobrindo a FAIXA de latências (o hint pode estar no regime antigo).
  const window = killfeedScanWindowMs({
    kills,
    scoreboardDelayMs,
    latencyHintMs,
    latencyMaxMs,
  });
  if (!window) {
    return {
      ...estimateStreamOffset(kills, [], scoreboardDelayMs, 0),
      crop: null,
      windowCovered: false,
    };
  }
  const { startMs: scanStartMs, endMs: scanEndMs } = window;
  /**
   * Orçamento de espera: o material da janela precisa chegar ao buffer.
   * Sem prazo, uma stream que caiu (ou cujo buffer não avança mais)
   * deixaria o `handleAce` preso no OCR para sempre — o `shouldStop` só
   * cobre o shutdown do processo.
   */
  const scanDeadlineMs =
    Date.now() + Math.max(60_000, scanEndMs - Date.now() + segmentTimeSec * 1000 + 20_000);
  const aborted = (): boolean =>
    (options.shouldStop?.() ?? false) || Date.now() > scanDeadlineMs;
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) throw new Error('ffprobe indisponível para calibragem OCR');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-killfeed-sync-'));
  const seen = new Set<string>();
  const observations: KillfeedObservation[] = [];
  let worker: OcrWorker | null = null;
  let cropUsed: string | null = null;
  let windowCovered = false;

  try {
    const { default: sharp } = await import('sharp');
    const { createWorker, PSM } = await import('tesseract.js');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const ffmpeg = resolveFfmpegBin();

    const estimate = (): KillfeedSyncResult => {
      const base = estimateStreamOffset(kills, observations, scoreboardDelayMs, 180);
      return {
        ...base,
        crop: cropUsed,
        windowCovered,
      };
    };

    while (!aborted()) {
      const listed = listSegments();
      const stableSegments =
        (options.skipNewest ?? true) && listed.length > 1 ? listed.slice(0, -1) : listed;
      for (const file of stableSegments) {
        if (aborted()) break;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const key = `${file}:${stat.size}:${stat.mtimeMs}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let durationSec: number;
        try {
          durationSec = await probeDuration(file, ffprobe);
        } catch {
          continue;
        }
        const segmentStartMs = stat.mtimeMs - durationSec * 1000;
        const segmentEndMs = stat.mtimeMs;
        if (segmentEndMs < scanStartMs || segmentStartMs > scanEndMs) continue;

        const scanned = await scanSegment(
          file,
          durationSec,
          dir,
          ffmpeg,
          worker,
          sharp,
          kills,
          segmentEndMs,
          cropCandidates,
          aborted,
        );
        observations.push(...scanned.observations);
        if (scanned.crop) cropUsed = scanned.crop;
        const result = estimate();
        // Todas as kills do ace já foram lidas? As 1ªs aparições estão
        // fixas — varrer mais segmentos não acrescenta nada. Parcial:
        // CONTINUAR — o lastKillVideoMs (piso do fim) precisa da ÚLTIMA
        // kill, e o cluster se forma antes dela (medido no r9: o cluster
        // fecha na 2ª kill; a 3ª — a que importa — vinha depois).
        if (result.matchedKills === result.totalKills) return result;
      }
      // Terminou a varredura: o material disponível já cobre a janela
      // (ou não existe mais) — não fica esperando a partida inteira.
      const newest = stableSegments.at(-1);
      let newestEndMs = 0;
      if (newest) {
        try {
          newestEndMs = fs.statSync(newest).mtimeMs;
        } catch {
          newestEndMs = 0;
        }
      }
      if (newestEndMs >= scanEndMs) {
        windowCovered = true;
        break;
      }
      if (aborted()) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2000));
    }
    return estimate();
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
