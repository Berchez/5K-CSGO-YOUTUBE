/**
 * Enriquecimento das kills do sidecar com o detalhe do killfeed.
 *
 * POR QUE: o placar do DOM só conta K/D. O placar "vê" a vítima pela
 * coluna de mortes — e, quando OUTRO jogador mata no mesmo round, a
 * ordem das mortes não é a ordem das kills do autor: o placar acaba
 * pareando a vítima ERRADA (o caso real: kyousuke no Anubis r13 matou
 * HeavyGod, mas o sidecar dizia TeSeS — o HeavyGod tinha matado o TeSeS
 * um instante antes).
 *
 * O killfeed do scorebot tem a VERDADE (quem matou quem, com qual arma,
 * headshot, assistência). Aqui mora a parte PURA: casar as kills do
 * sidecar com as do killfeed e aplicar o detalhe.
 *
 * O pareamento é pela VÍTIMA quando ela bate (âncoras por LCS) e, no
 * que sobra, pela ORDEM (as duas listas são cronológicas). Assim:
 * - 5×5 com as mesmas vítimas → casa exata;
 * - 5×5 com UMA vítima errada → as outras quatro viram âncora e a
 *   quinta casa pela ordem (a errada é corrigida);
 * - contagens diferentes → as âncoras seguram o resto e o que sobra
 *   fica sem par (não inventa).
 */
import type { ScorebotKill } from './scorebotLog.js';
import { normWeapon } from './aceDetector.js';

/** Uma kill do sidecar (só os campos que o killfeed pode completar). */
export interface EnrichableKill {
  killer: string;
  victim: string;
  weapon?: string | null;
  headshot?: boolean | null;
  assistBy?: string | null;
  flashAssistBy?: string | null;
  throughSmoke?: boolean | null;
  wallbang?: boolean | null;
  noscope?: boolean | null;
}

/** Um par de casas (índice do sidecar → índice do killfeed). */
export interface KillPair {
  sideIndex: number;
  feedIndex: number;
}

/** O que mudou numa kill (para o relatório do backfill). */
export interface KillChange {
  index: number;
  killer: string;
  field: string;
  from: string | null;
  to: string | null;
}

export interface EnrichResult {
  /** As kills do sidecar, já com o detalhe do killfeed. */
  kills: EnrichableKill[];
  /** Quantas kills do sidecar receberam o detalhe. */
  paired: number;
  /** Quantas kills o killfeed tinha para o round. */
  feedKills: number;
  /** `eventId`s do scorebot que entraram no round. */
  eventIds: string[];
  /** O que mudou (campo a campo). */
  changes: KillChange[];
}

/** Compara nomes sem acento, caixa e espaço (o placar e o feed divergem). */
export function normalizePlayerName(name: string | null | undefined): string {
  const COMBINING = /[\u0300-\u036f]/g;
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/\s+/g, '');
}

/**
 * Ancora as duas listas pelo nome da vítima (LCS).
 *
 * Devolve os pares `[índiceA, índiceB]` em ordem crescente.
 */
function lcsAnchors(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * Casa as kills do sidecar com as do killfeed.
 *
 * Regras:
 * - as vítimas iguais viram ÂNCORA (LCS);
 * - dentro de cada intervalo entre âncoras, o que sobra casa pela
 *   ORDEM (as listas são cronológicas) — MAS SÓ quando os dois vãos
 *   têm o MESMO tamanho: com vãos diferentes, casar "pela ordem" é
 *   chute (o título saía com a vítima errada) e o README promete que
 *   nada é inventado;
 * - o que sobra sem par simplesmente não é pareado (nada é inventado).
 */
export function pairKillsWithFeed(
  sideKills: Array<{ victim: string }>,
  feedKills: Array<{ victim: string }>,
): KillPair[] {
  const sideNames = sideKills.map((k) => normalizePlayerName(k.victim));
  const feedNames = feedKills.map((k) => normalizePlayerName(k.victim));
  const anchors = lcsAnchors(sideNames, feedNames);
  const pairs: KillPair[] = [];
  let si = 0;
  let fi = 0;
  const walk = (anchor: [number, number] | null): void => {
    const sideEnd = anchor ? anchor[0] : sideNames.length;
    const feedEnd = anchor ? anchor[1] : feedNames.length;
    const gapSide = sideEnd - si;
    const gapFeed = feedEnd - fi;
    // Vãos do mesmo tamanho: a ordem casa kill a kill sem chute.
    if (gapSide === gapFeed) {
      for (let k = 0; k < gapSide; k++) {
        pairs.push({ sideIndex: si + k, feedIndex: fi + k });
      }
    }
    if (anchor) pairs.push({ sideIndex: anchor[0], feedIndex: anchor[1] });
    si = sideEnd + (anchor ? 1 : 0);
    fi = feedEnd + (anchor ? 1 : 0);
  };
  for (const anchor of anchors) walk(anchor);
  walk(null);
  return pairs;
}

/** A kill do killfeed tem o detalhe? (a arma/HS/assistência) */
function feedDetail(feed: ScorebotKill): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {};
  /**
   * A arma entra CANÔNICA: o scorebot manda `m4a1_silencer` e o sidecar
   * guarda `m4a1silencer` (a chave do live). Sem normalizar aqui, o
   * dry-run do enrich acusava "mudança" em TODO clipe e o `--apply`
   * zerava o título do Short sem nenhuma mudança real.
   */
  if (feed.weapon) out.weapon = normWeapon(feed.weapon) || feed.weapon;
  if (feed.headshot != null) out.headshot = feed.headshot;
  if (feed.assistBy) out.assistBy = feed.assistBy;
  if (feed.flashAssistBy) out.flashAssistBy = feed.flashAssistBy;
  if (feed.throughSmoke != null) out.throughSmoke = feed.throughSmoke;
  if (feed.wallbang != null) out.wallbang = feed.wallbang;
  if (feed.noscope != null) out.noscope = feed.noscope;
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return String(a ?? '') === String(b ?? '');
}

/**
 * Aplica o detalhe do killfeed nas kills do sidecar.
 *
 * A VÍTIMA sempre vem do killfeed (é o dado que estava errado). Os
 * demais campos só são sobrescritos quando o feed TEM o valor: campo
 * ausente no feed fica como está (nunca vira `false`).
 */
export function enrichKillsWithFeed(
  sideKills: EnrichableKill[],
  feedKills: ScorebotKill[],
): EnrichResult {
  const kills = sideKills.map((k) => ({ ...k }));
  const pairs = pairKillsWithFeed(kills, feedKills);
  const changes: KillChange[] = [];
  const eventIds: string[] = [];

  for (const pair of pairs) {
    const side = kills[pair.sideIndex];
    const feed = feedKills[pair.feedIndex];
    if (!side || !feed) continue;
    // A vítima do feed é a verdade (o placar pode ter pareado errado).
    const feedVictim = feed.victim?.trim();
    if (feedVictim && !sameValue(side.victim, feedVictim)) {
      changes.push({
        index: pair.sideIndex,
        killer: side.killer,
        field: 'victim',
        from: side.victim ?? null,
        to: feedVictim,
      });
      side.victim = feedVictim;
    }
    for (const [field, value] of Object.entries(feedDetail(feed))) {
      const current = (side as Record<string, unknown>)[field];
      if (sameValue(current, value)) continue;
      changes.push({
        index: pair.sideIndex,
        killer: side.killer,
        field,
        from: current == null ? null : String(current),
        to: value == null ? null : String(value),
      });
      (side as Record<string, unknown>)[field] = value;
    }
    if (feed.eventId && !eventIds.includes(feed.eventId)) eventIds.push(feed.eventId);
  }

  return {
    kills,
    paired: pairs.length,
    feedKills: feedKills.length,
    eventIds,
    changes,
  };
}

/**
 * As kills do killfeed que pertencem a um round/jogador.
 *
 * Filtra por mapa (normalizado), round e autor. É ESTRITO de propósito:
 * uma kill sem round (`round: 0`, o backlog antes do 1º `RoundStart`) ou
 * sem mapa NÃO entra — no backfill, casar uma kill de outro round (ou de
 * outro mapa) escreveria a vítima errada no sidecar.
 */
export function selectFeedKills(input: {
  kills: ScorebotKill[];
  map: string;
  round: number;
  player: string;
}): ScorebotKill[] {
  const map = input.map.trim().toLowerCase();
  const player = normalizePlayerName(input.player);
  return input.kills.filter((kill) => {
    if (player && normalizePlayerName(kill.killer) !== player) return false;
    // Kill SEM round (o backlog antes do 1º `RoundStart`) não entra em
    // NENHUM backfill: casá-la com um round seria chute — a vítima (e o
    // título) sairiam errados.
    if (!(kill.round > 0)) return false;
    if (input.round > 0 && kill.round !== input.round) return false;
    // Kill SEM mapa também não entra (o mapa é o filtro do round).
    if (!kill.map) return false;
    if (map && kill.map !== map) return false;
    return true;
  });
}
