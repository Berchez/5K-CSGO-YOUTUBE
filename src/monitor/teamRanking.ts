import fs from 'node:fs';
import path from 'node:path';
import { normalizeName } from '../watchlist.js';

/**
 * Ranking de times do HLTV (`/ranking/teams`).
 *
 * POR QUE existe: o listing do HLTV não expõe o rank dos times, só as
 * estrelas do evento. Partidas sem estrela (0★) entre times grandes ficavam
 * de fora do monitoramento; a regra de rank é o segundo fator de busca —
 * independente das estrelas e sem tocar na watchlist.
 *
 * Fail-closed: time SEM rank conhecido nunca entra pela regra de rank. O I/O
 * (browser + cache) fica em `ensureTeamRanking` (`hltvMonitor.ts`); aqui só
 * mora a regra pura e o cache em disco.
 */

/** Ponto cru extraído da página; o parser (`buildTeamRanking`) é puro. */
export interface RankingEntry {
  /** Texto da posição ("#18" ou "18"). */
  position: string;
  /** Nome do time como aparece no ranking. */
  name: string;
}

export interface TeamRanking {
  /** epoch ms da coleta (idade/TTL e diagnóstico). */
  fetchedAt: number;
  /** Nome normalizado -> rank (1 = melhor). */
  ranks: Record<string, number>;
}

/** Lados liberados pela regra de rank quando a soma não passa. */
export type RankAllowedSide = 'both' | 'team1' | 'team2' | null;

export interface RankMatchDecision {
  /** A partida entra pela regra de rank (0★ deixa de ser impedimento). */
  qualifies: boolean;
  /** Entrou pela soma dos ranks (< `sumMax`) — libera os DOIS lados. */
  bySum: boolean;
  /** Entrou por um time com rank < `strongMax` — libera só ele. */
  byStrongTeam: boolean;
  /** Motivo curto para log/diagnóstico. */
  reason: 'sum' | 'strong-team' | 'none';
  allowed: RankAllowedSide;
}

/** Normaliza o nome do time para casar listing x ranking x placar. */
export function normalizeRankingName(value: string | null | undefined): string {
  // O placar usa "Team Vitality" e o ranking/listing "Vitality": o prefixo
  // "team " não pode separar o mesmo time.
  return normalizeName(String(value ?? '')).replace(/^team\s+/, '');
}

function parsePosition(value: string): number | null {
  const match = String(value ?? '')
    .trim()
    .match(/^#?(\d+)$/);
  if (!match) return null;
  const position = Number.parseInt(match[1], 10);
  return Number.isFinite(position) && position > 0 ? position : null;
}

/**
 * Parser puro dos pontos crus da página: descarta entrada sem posição/nome e,
 * em caso de nome repetido, mantém o MELHOR rank (o ranking não deveria
 * repetir time — se repetir, o fail-closed é usar o melhor).
 */
export function buildTeamRanking(
  entries: ReadonlyArray<RankingEntry>,
  fetchedAt = Date.now(),
): TeamRanking {
  const ranks: Record<string, number> = {};
  for (const entry of entries) {
    const name = normalizeRankingName(entry?.name);
    if (!name) continue;
    const position = parsePosition(entry?.position ?? '');
    if (position == null) continue;
    const prev = ranks[name];
    if (prev == null || position < prev) ranks[name] = position;
  }
  return { fetchedAt, ranks };
}

/** Rank do time (null = sem rank conhecido: a regra de rank não se aplica). */
export function rankOfTeam(
  ranking: TeamRanking | null | undefined,
  team: string | null | undefined,
): number | null {
  if (!ranking) return null;
  const key = normalizeRankingName(team);
  if (!key) return null;
  const rank = ranking.ranks[key];
  return typeof rank === 'number' && Number.isFinite(rank) && rank > 0 ? rank : null;
}

/**
 * Decisão da regra de rank (pura):
 * 1. soma dos ranks < `sumMax` (X) → entra e libera OS DOIS lados;
 * 2. senão, rank < `strongMax` (Y) → entra liberando só o time forte
 *    (os dois, se ambos estiverem abaixo de Y);
 * 3. senão → não entra.
 *
 * Comparação ESTRITA ("abaixo de X"/"menor que Y") e fail-closed: se
 * QUALQUER um dos dois times não tem rank conhecido (fora da lista, nome que
 * não casou), a regra de rank não se aplica a esta partida — ela não é
 * "meio rankeada". Estrelas/watchlist seguem normais.
 */
export function rankMatchDecision(params: {
  rank1: number | null;
  rank2: number | null;
  /** X: soma máxima (0 = regra desligada). */
  sumMax: number;
  /** Y: rank de um time só (0 = regra desligada). */
  strongMax: number;
}): RankMatchDecision {
  const sumMax = Math.max(0, Math.trunc(params.sumMax ?? 0));
  const strongMax = Math.max(0, Math.trunc(params.strongMax ?? 0));
  const rank1 =
    typeof params.rank1 === 'number' && params.rank1 > 0 ? Math.trunc(params.rank1) : null;
  const rank2 =
    typeof params.rank2 === 'number' && params.rank2 > 0 ? Math.trunc(params.rank2) : null;

  const none: RankMatchDecision = {
    qualifies: false,
    bySum: false,
    byStrongTeam: false,
    reason: 'none',
    allowed: null,
  };

  // Fail-closed: sem o rank dos DOIS times não há decisão de rank (nem soma,
  // nem "time forte"). Uma partida meio-rankeada não entra por esta regra.
  if (rank1 == null || rank2 == null) return none;

  if (sumMax > 0 && rank1 + rank2 < sumMax) {
    return { qualifies: true, bySum: true, byStrongTeam: false, reason: 'sum', allowed: 'both' };
  }
  if (strongMax > 0) {
    const strong1 = rank1 < strongMax;
    const strong2 = rank2 < strongMax;
    if (strong1 && strong2) {
      return {
        qualifies: true,
        bySum: false,
        byStrongTeam: true,
        reason: 'strong-team',
        allowed: 'both',
      };
    }
    if (strong1) {
      return {
        qualifies: true,
        bySum: false,
        byStrongTeam: true,
        reason: 'strong-team',
        allowed: 'team1',
      };
    }
    if (strong2) {
      return {
        qualifies: true,
        bySum: false,
        byStrongTeam: true,
        reason: 'strong-team',
        allowed: 'team2',
      };
    }
  }
  return none;
}

/**
 * Nomes (como estão no LISTING) dos times que podem gerar clipe pela regra
 * de rank. Vazio = nenhum lado liberado.
 */
export function rankAllowedTeams(
  decision: RankMatchDecision,
  team1: string,
  team2: string,
): string[] {
  if (!decision.qualifies) return [];
  if (decision.allowed === 'both') return [team1, team2].filter((team) => team.trim().length > 0);
  if (decision.allowed === 'team1') return team1 ? [team1] : [];
  if (decision.allowed === 'team2') return team2 ? [team2] : [];
  return [];
}

/** O time do killer está liberado pela regra de rank? (fail-closed) */
export function rankAllowsTeam(
  allowedTeams: readonly string[] | null | undefined,
  team: string | null | undefined,
): boolean {
  const key = normalizeRankingName(team);
  if (!key) return false;
  return (allowedTeams ?? []).some((allowed) => normalizeRankingName(allowed) === key);
}

/**
 * Como a regra de rank trata as ESTRELAS do listing — independente do
 * `MIN_STARS` global:
 *
 * - `below-general` (default): a regra é o PLANO B / segundo fator — só vale
 *   para a partida que NÃO passou no filtro geral de estrelas/top-tier.
 *   Partida que o `MIN_STARS` já aceitou segue o limiar geral; o rank não a
 *   "rebaixa" para 4k. É o que preenche os dias sem partida grande.
 * - `any`: a condição de rank vale para QUALQUER avaliação (0★..5★) e também
 *   baixa o limiar para `RANK_MIN_KILLS` em partida já aceita por estrelas.
 *   Gera mais clipes; opt-in, não é o padrão.
 */
export type RankStarsMode = 'any' | 'below-general';

/**
 * A regra de rank pode valer para esta partida, dado o modo de estrelas?
 * (puro; default `below-general` = só quando o geral não aceitou)
 */
export function rankStarsModeAllows(
  mode: RankStarsMode | null | undefined,
  passesGeneral: boolean,
): boolean {
  // Ausente/desconhecido cai no default `below-general`: o rank é o plano B.
  if (mode === 'any') return true;
  return !passesGeneral;
}

/** Limiar da política normal (null = bloqueado). */
export interface RankThresholdBase {
  minKills: number | null;
  source: string;
}

/**
 * Combina a política normal (estrelas/watchlist) com a regra de rank.
 *
 * POR QUE: a condição de rank é um FATOR DE BUSCA com estrelas PRÓPRIAS
 * (`RANK_STARS_MODE`): no default `below-general`, ela só é atendida quando
 * o filtro geral recusou a partida (é o plano B, que preenche os dias sem
 * partida grande); no modo `any`, também vale para partida já aceita por
 * estrelas e rende 4k/5K (`RANK_MIN_KILLS`) mesmo com 1★/2★.
 * O rank só ADICIONA, nunca restringe:
 *
 * - time liberado pelo rank + limiar normal → o MENOR dos dois vence (o
 *   mais permissivo): 4k passa a render clip mesmo com o geral em 5k;
 * - limiar EXPLICITO da watchlist (`source` player/team) → a watchlist
 *   vence: o rank não rebaixa um `minKills` escolhido pelo dono;
 * - time liberado pelo rank + política bloqueada (partida que não passa
 *   por estrelas) → o limiar de rank vale;
 * - time NÃO liberado pelo rank → segue a política normal (bloqueado se a
 *   partida entrou só pelo rank/watchlist);
 * - watchlist com override ATIVO → ela manda no bloqueio: o adversário
 *   bloqueado pela watchlist não é ressuscitado pelo rank.
 */
export function applyRankThreshold(params: {
  /** Limiar da política normal (null = bloqueado). */
  base: RankThresholdBase;
  /** Regra de rank da partida (null = regra desligada/sem lados liberados). */
  rank: { minKills: number; allowedTeams: readonly string[] } | null | undefined;
  /** Time do killer, já canonicalizado para o nome do LISTING. */
  team: string | null | undefined;
  /** O override da watchlist está ativo nesta partida? */
  watchlistOverride: boolean;
}): RankThresholdBase {
  const { base, rank, team, watchlistOverride } = params;
  if (!rank || rank.allowedTeams.length === 0) return base;
  // A watchlist tem precedência explícita ("first hit wins"): um
  // minKills escolhido para um jogador/time não pode ser rebaixado pelo
  // rank sem que o dono perceba. O rank ainda pode abrir uma partida
  // bloqueada (base null), mas não mexe num limiar explícito.
  if (base.source === 'player' || base.source === 'team') return base;
  if (!rankAllowsTeam(rank.allowedTeams, team)) return base;
  if (base.minKills == null) {
    // Bloqueado pela política geral: o rank abre o caminho — mas só sem
    // override da watchlist (aí o adversário bloqueado é regra da
    // watchlist, que vem antes do rank).
    if (watchlistOverride) return base;
    return { minKills: rank.minKills, source: 'rank' };
  }
  // A política já é mais permissiva? O rank não pode PIORAR o limiar.
  if (rank.minKills < base.minKills) return { minKills: rank.minKills, source: 'rank' };
  return base;
}

/** Estado do cache em disco (o chamador decide se busca de novo). */
export interface RankingCacheRead {
  ranking: TeamRanking | null;
  /** Idade da coleta em ms (null = sem cache). */
  ageMs: number | null;
  /** Cache existe mas está mais velho que o TTL. */
  stale: boolean;
  /** Arquivo existia e não pôde ser lido/validado. */
  error: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida o JSON do cache (formato desconhecido/ inválido = null). */
export function parseRankingCache(raw: unknown): TeamRanking | null {
  if (!isPlainObject(raw)) return null;
  const fetchedAt = Number(raw.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
  if (!isPlainObject(raw.ranks)) return null;
  const ranks: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw.ranks)) {
    const key = normalizeRankingName(name);
    const rank = Number(value);
    if (!key || !Number.isFinite(rank) || rank <= 0) continue;
    ranks[key] = Math.trunc(rank);
  }
  if (Object.keys(ranks).length === 0) return null;
  return { fetchedAt: Math.trunc(fetchedAt), ranks };
}

/**
 * Lê o cache do disco. Arquivo ausente NÃO é erro (primeiro boot); arquivo
 * corrompido é erro e o chamador loga (o ranking será buscado de novo).
 */
export function readRankingCache(
  file: string,
  now = Date.now(),
  ttlMs = 0,
): RankingCacheRead {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ranking = parseRankingCache(raw);
    if (!ranking) {
      return { ranking: null, ageMs: null, stale: false, error: 'cache do ranking inválido' };
    }
    const ageMs = Math.max(0, now - ranking.fetchedAt);
    return { ranking, ageMs, stale: ttlMs > 0 && ageMs > ttlMs, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ranking: null, ageMs: null, stale: false, error: null };
    return { ranking: null, ageMs: null, stale: false, error: String(e).slice(0, 300) };
  }
}

/** Grava o cache de forma atômica (tmp + rename): leitura nunca vê meio JSON. */
export function writeRankingCache(file: string, ranking: TeamRanking): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ranking, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
