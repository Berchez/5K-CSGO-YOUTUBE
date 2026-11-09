import fs from 'node:fs';

/**
 * Watchlist: times/jogadores que fogem da política por estrelas.
 * - Time na lista → a partida é gravada mesmo abaixo de MIN_STARS, com
 *   limiar próprio e um piso de estrelas próprio (minStars).
 * - Jogador na lista → o limiar do jogador vence o do time naquele round.
 * O arquivo é lido pelo bot a cada poll (hot-reload por mtime) e editado
 * pelo painel em data/watchlist.json.
 */

export interface WatchlistDefaults {
  minKills: number;
  /**
   * Piso de estrelas para entrar pelo override da watchlist. 0 = sem
   * piso (time na lista entra em qualquer partida, inclusive 0★).
   */
  minStars: number;
  clutch: boolean;
}

export interface WatchlistTeamRule {
  names: string[];
  minKills?: number;
  /** Piso de estrelas deste time (herda defaults.minStars). 0 = sem piso. */
  minStars?: number;
  clutch?: boolean;
  enabled: boolean;
}

export interface WatchlistPlayerRule {
  names: string[];
  minKills?: number;
  clutch?: boolean;
  enabled: boolean;
}

export interface WatchlistDoc {
  version: 1;
  enabled: boolean;
  defaults: WatchlistDefaults;
  teams: WatchlistTeamRule[];
  players: WatchlistPlayerRule[];
}

export interface WatchlistValidation {
  ok: boolean;
  value?: WatchlistDoc;
  errors: string[];
}

/** Time da lista que casou com a partida. */
export interface MatchTeamMatch {
  /** Nome do time que casou (como está na lista). */
  team: string;
  /** Limiar do time (herda o default quando não vem na entrada). */
  minKills: number;
  /** Piso de estrelas pedido pelo time (herda o default). */
  minStars: number;
  /** O time ATENDEU o próprio piso de estrelas nesta partida? */
  floorMet: boolean;
  /** Clutch do time (entra só se o piso foi atendido). */
  clutch: boolean;
}

export interface MatchRuleResolution {
  /** Algum time da partida está na lista (o override PODE valer). */
  watchlisted: boolean;
  /**
   * Limiar EFETIVO da partida: o menor entre os times que ATENDERAM o
   * piso de estrelas. Sem nenhum time atendendo, vale o limiar geral.
   */
  minKills: number;
  /** Piso MENOR entre os times que atenderam (0 = nenhum atendeu). */
  minStars: number;
  clutch: boolean;
  /** Todos os times que casaram com a lista (atendendo o piso ou não). */
  matchedTeams: string[];
  /** Detalhe por time: o que casou e se atendeu o piso. */
  teams: MatchTeamMatch[];
}

export interface PlayerRuleResolution {
  minKills: number;
  clutch: boolean;
  matchedName: string;
}

export interface TeamRuleResolution {
  minKills: number;
  minStars: number;
  clutch: boolean;
  matchedName: string;
}

/** De onde veio o limiar do killer (log/diagnóstico). */
export type KillerRuleSource = 'player' | 'team' | 'general' | 'blocked';

export interface KillerRuleResolution {
  /** null = não pode gerar clipe (adversário em partida só da watchlist). */
  minKills: number | null;
  source: KillerRuleSource;
  matchedName?: string;
}

export interface KillerRuleParams {
  doc: WatchlistDoc | null | undefined;
  player: string;
  /** Time do killer (do placar). null = desconhecido. */
  playerTeam: string | null | undefined;
  /** true quando a partida passa no filtro geral de estrelas/top-tier. */
  passesGeneral: boolean;
  /** Limiar da política geral para esta partida (minKillsForStars). */
  generalMinKills: number;
  /**
   * O override da watchlist está ATIVO nesta partida: algum time da lista
   * casou E atendeu o piso de estrelas dele (minStars).
   *
   * Sem isso o limiar do time valia em QUALQUER partida (mesmo 1★ com
   * piso 2) e o piso virava decoração. A entrada pela política geral
   * continua valendo — quem não está na lista usa o limiar geral.
   */
  watchlistOverride: boolean;
  /**
   * Estrelas da partida: o piso do TIME do killer é conferido contra elas
   * (um time com piso 3 não dá o limiar dele numa partida de 1★, mesmo
   * que outro time da partida tenha atendido o piso).
   */
  stars: number;
}

export interface LoadedWatchlist {
  doc: WatchlistDoc;
  error: string | null;
  missing: boolean;
  /** Arquivo ausente, mas ainda usando a última versão boa (grace). */
  stale: boolean;
  changed: boolean;
}

export const WATCHLIST_DEFAULT_MIN_KILLS = 4;
/** Janela em que um arquivo ausente (save do editor) mantém a última versão boa. */
export const WATCHLIST_MISSING_GRACE_MS = 60_000;
const MAX_ENTRIES = 100;
const MAX_NAMES_PER_ENTRY = 20;
const MAX_NAME_LENGTH = 60;

/** Minúsculas, sem acentos e com espaços colapsados (Fúria == FURIA). */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function defaultWatchlistDoc(): WatchlistDoc {
  return {
    version: 1,
    enabled: true,
    defaults: { minKills: WATCHLIST_DEFAULT_MIN_KILLS, minStars: 0, clutch: false },
    teams: [],
    players: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMinKills(value: unknown, path: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 5) {
    errors.push(`${path}: mínimo de kills deve ser um inteiro entre 2 e 5.`);
    return undefined;
  }
  return value;
}

/** Piso de estrelas: inteiro de 0 (sem piso) a 5. */
function parseMinStars(value: unknown, path: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5) {
    errors.push(`${path}: mínimo de estrelas deve ser um inteiro entre 0 e 5.`);
    return undefined;
  }
  return value;
}

function parseBool(value: unknown, path: string, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    errors.push(`${path}: use true ou false.`);
    return undefined;
  }
  return value;
}

function parseNames(value: unknown, path: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: informe ao menos um nome (array de strings).`);
    return null;
  }
  if (value.length > MAX_NAMES_PER_ENTRY) {
    errors.push(`${path}: no máximo ${MAX_NAMES_PER_ENTRY} nomes por entrada.`);
    return null;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`${path}[${i}]: nome vazio ou inválido.`);
      continue;
    }
    const name = raw.trim();
    if (name.length > MAX_NAME_LENGTH) {
      errors.push(`${path}[${i}]: nome com mais de ${MAX_NAME_LENGTH} caracteres.`);
      continue;
    }
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length === 0) {
    errors.push(`${path}: nenhum nome válido.`);
    return null;
  }
  return out;
}

interface ParsedRule {
  names: string[];
  minKills?: number;
  minStars?: number;
  clutch?: boolean;
  enabled: boolean;
}

function parseRuleList(
  raw: unknown,
  path: string,
  kind: 'time' | 'jogador',
  errors: string[],
): ParsedRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path}: deve ser uma lista.`);
    return [];
  }
  if (raw.length > MAX_ENTRIES) {
    errors.push(`${path}: no máximo ${MAX_ENTRIES} entradas.`);
    return [];
  }
  const out: ParsedRule[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const at = `${path}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: deve ser um objeto.`);
      continue;
    }
    const names = parseNames(entry.names, `${at}.names`, errors);
    if (!names) continue;
    const minKills = parseMinKills(entry.minKills, `${at}.minKills`, errors);
    // minStars só faz sentido para time (piso de estrelas da partida).
    const minStars =
      kind === 'time' ? parseMinStars(entry.minStars, `${at}.minStars`, errors) : undefined;
    const clutch = parseBool(entry.clutch, `${at}.clutch`, errors);
    const enabled = parseBool(entry.enabled, `${at}.enabled`, errors) ?? true;
    let duplicate = false;
    for (const name of names) {
      const key = normalizeName(name);
      const first = seen.get(key);
      if (first !== undefined) {
        errors.push(
          `${path}: "${name}" (${kind}) aparece mais de uma vez (entradas ${first + 1} e ${i + 1}).`,
        );
        duplicate = true;
        continue;
      }
      seen.set(key, i);
    }
    if (duplicate) continue;
    out.push({ names, minKills, minStars, clutch, enabled });
  }
  return out;
}

/**
 * Valida e normaliza o documento. Campos desconhecidos são ignorados;
 * qualquer erro invalida o documento inteiro (o bot mantém a última versão
 * boa e o painel mostra as mensagens).
 */
export function validateWatchlistDoc(input: unknown): WatchlistValidation {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['O documento deve ser um objeto JSON.'] };
  }
  const doc = defaultWatchlistDoc();
  const enabled = parseBool(input.enabled, 'enabled', errors);
  if (enabled !== undefined) doc.enabled = enabled;
  if (input.defaults !== undefined) {
    if (!isPlainObject(input.defaults)) {
      errors.push('defaults: deve ser um objeto.');
    } else {
      const minKills = parseMinKills(input.defaults.minKills, 'defaults.minKills', errors);
      if (minKills !== undefined) doc.defaults.minKills = minKills;
      const minStars = parseMinStars(input.defaults.minStars, 'defaults.minStars', errors);
      if (minStars !== undefined) doc.defaults.minStars = minStars;
      const clutch = parseBool(input.defaults.clutch, 'defaults.clutch', errors);
      if (clutch !== undefined) doc.defaults.clutch = clutch;
    }
  }
  doc.teams = parseRuleList(input.teams, 'teams', 'time', errors).map((rule) => ({
    names: rule.names,
    minKills: rule.minKills,
    minStars: rule.minStars,
    clutch: rule.clutch,
    enabled: rule.enabled,
  }));
  doc.players = parseRuleList(input.players, 'players', 'jogador', errors).map((rule) => ({
    names: rule.names,
    minKills: rule.minKills,
    clutch: rule.clutch,
    enabled: rule.enabled,
  }));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: doc, errors };
}

/**
 * Regra de partida: time da lista ignora o corte de estrelas (dentro do
 * piso de estrelas do time) e usa o menor limiar.
 *
 * O piso é POR TIME: um time que NÃO atendeu o próprio piso perde o
 * limiar dele (não entra no mínimo da partida). A agregação é feita
 * só com os times que atenderam — senão o limiar de um time com piso 3
 * valia numa partida de 1★ porque OUTRO time da lista tinha piso 0.
 */
export function resolveMatchRule(
  doc: WatchlistDoc | null | undefined,
  teams: Array<string | null | undefined>,
  fallbackMinKills: number,
  stars: number,
): MatchRuleResolution {
  const fallback: MatchRuleResolution = {
    watchlisted: false,
    minKills: fallbackMinKills,
    minStars: 0,
    clutch: false,
    matchedTeams: [],
    teams: [],
  };
  if (!doc || !doc.enabled) return fallback;
  const wanted = new Set(
    teams.map((team) => normalizeName(team ?? '')).filter((name) => name.length > 0),
  );
  if (wanted.size === 0) return fallback;
  const matched: MatchTeamMatch[] = [];
  for (const rule of doc.teams) {
    if (!rule.enabled) continue;
    const team = rule.names.find((name) => wanted.has(normalizeName(name)));
    if (!team) continue;
    const minStars = rule.minStars ?? doc.defaults.minStars;
    matched.push({
      team,
      minKills: rule.minKills ?? doc.defaults.minKills,
      minStars,
      floorMet: watchlistStarsFloorMet(stars, minStars),
      clutch: rule.clutch ?? doc.defaults.clutch,
    });
  }
  if (matched.length === 0) return fallback;
  const qualified = matched.filter((t) => t.floorMet);
  const minKills = qualified.length
    ? Math.min(...qualified.map((t) => t.minKills))
    : fallbackMinKills;
  const minStars = qualified.length ? Math.min(...qualified.map((t) => t.minStars)) : 0;
  return {
    watchlisted: true,
    minKills,
    minStars,
    clutch: qualified.some((t) => t.clutch),
    matchedTeams: matched.map((t) => t.team),
    teams: matched,
  };
}

/**
 * Piso de estrelas do override da watchlist. 0 = sem piso (o time da
 * lista entra em qualquer partida, inclusive 0★). Estrelas 0 no listing
 * são DESCONHECIDAS: com piso > 0 a partida NÃO entra pelo override
 * (só entra se passar na política geral).
 */
export function watchlistStarsFloorMet(stars: number, minStars: number): boolean {
  const floor = Number.isFinite(minStars) ? Math.max(0, Math.trunc(minStars)) : 0;
  if (floor <= 0) return true;
  const value = Number.isFinite(stars) ? Math.max(0, Math.trunc(stars)) : 0;
  return value >= floor;
}

/** Regra do time de um nome exato (usada para o time do killer). */
export function resolveTeamRule(
  doc: WatchlistDoc | null | undefined,
  teamName: string | null | undefined,
): TeamRuleResolution | null {
  if (!doc || !doc.enabled) return null;
  const wanted = normalizeName(teamName ?? '');
  if (!wanted) return null;
  const hits = doc.teams.filter(
    (rule) => rule.enabled && rule.names.some((name) => normalizeName(name) === wanted),
  );
  if (hits.length === 0) return null;
  let minKills = Number.POSITIVE_INFINITY;
  let minStars = Number.POSITIVE_INFINITY;
  let clutch = false;
  let matchedName = teamName ?? '';
  for (const rule of hits) {
    minKills = Math.min(minKills, rule.minKills ?? doc.defaults.minKills);
    minStars = Math.min(minStars, rule.minStars ?? doc.defaults.minStars);
    clutch = clutch || (rule.clutch ?? doc.defaults.clutch);
    matchedName = rule.names[0] ?? matchedName;
  }
  return {
    minKills: Number.isFinite(minKills) ? minKills : WATCHLIST_DEFAULT_MIN_KILLS,
    minStars: Number.isFinite(minStars) ? minStars : 0,
    clutch,
    matchedName,
  };
}

/**
 * Limiar do killer do round (puro):
 * 1. time na lista (com o override ATIVO) → limiar do time (ou do
 *    jogador, se ele estiver na lista de jogadores);
 * 2. jogador na lista → limiar do jogador (entrada explícita vale mesmo
 *    fora do time da lista);
 * 3. partida que passa na política geral → limiar geral;
 * 4. caso contrário → null (NÃO gera clipe).
 */
export function resolveKillerMinKills(params: KillerRuleParams): KillerRuleResolution {
  const {
    doc,
    player,
    playerTeam,
    passesGeneral,
    generalMinKills,
    watchlistOverride,
    stars,
  } = params;
  if (!doc || !doc.enabled) {
    // Sem watchlist vale a política geral — e nada além dela.
    if (passesGeneral) return { minKills: generalMinKills, source: 'general' };
    return { minKills: null, source: 'blocked' };
  }
  // O limiar do TIME só vale com o override ativo (algum time atendeu o
  // piso) E quando o PRÓPRIO time do killer atendeu o piso dele: um time
  // com piso 3 perde o limiar dele numa partida de 1★, mesmo que outro
  // time da lista tenha atendido o piso.
  const teamRule = watchlistOverride ? resolveTeamRule(doc, playerTeam) : null;
  const teamApplies = teamRule != null && watchlistStarsFloorMet(stars, teamRule.minStars);
  const playerRule = resolvePlayerRule(doc, player);
  if (teamApplies && teamRule) {
    if (playerRule) {
      return { minKills: playerRule.minKills, source: 'player', matchedName: playerRule.matchedName };
    }
    return { minKills: teamRule.minKills, source: 'team', matchedName: teamRule.matchedName };
  }
  if (playerRule) {
    return { minKills: playerRule.minKills, source: 'player', matchedName: playerRule.matchedName };
  }
  if (passesGeneral) {
    return { minKills: generalMinKills, source: 'general' };
  }
  return { minKills: null, source: 'blocked' };
}

/**
 * Casa o nome do time lido no PLACAR com o nome do time no LISTING.
 *
 * O placar traz o nome do cabeçalho da tabela ("Team Vitality") e o
 * listing traz o nome do card ("Vitality"): sem casar os dois, o time do
 * killer fica desconhecido e — numa partida que só entrou pela
 * watchlist — TODO mundo é bloqueado (fail-closed silencioso).
 *
 * O casamento é por nome normalizado (sem acento/maiúscula); o prefixo
 * "team " é ignorado porque o HLTV usa os dois jeitos.
 */
export function matchTeamAlias(
  raw: string | null | undefined,
  aliases: Array<string | null | undefined>,
): string | null {
  const wanted = normalizeName(raw ?? '');
  if (!wanted) return null;
  const candidates = aliases
    .map((alias) => String(alias ?? '').trim())
    .filter((alias) => alias.length > 0);
  for (const alias of candidates) {
    const normalized = normalizeName(alias);
    if (!normalized) continue;
    if (normalized === wanted) return alias;
    // "team vitality" x "vitality".
    const strip = (value: string): string => value.replace(/^team\s+/, '');
    if (strip(normalized) === strip(wanted)) return alias;
  }
  return null;
}

export interface KillerPolicyParams {
  doc: WatchlistDoc | null | undefined;
  /** A partida passa na política geral (estrelas/top-tier). */
  passesGeneral: boolean;
  /** Limiar da política geral para esta partida. */
  generalMinKills: number;
  /** O override da watchlist está ATIVO (time na lista + piso atendido). */
  watchlistOverride: boolean;
  /** Estrelas da partida (piso do time do killer). */
  stars: number;
  /** Nomes dos times como estão no listing (para casar o placar). */
  teamAliases?: Array<string | null | undefined>;
}

/**
 * Política do round (puro/testável): resolve o limiar do killer a partir
 * do jogador e do time lido no placar.
 *
 * O time do placar é canonicalizado para o nome do LISTING antes de casar
 * com a watchlist (ver `matchTeamAlias`).
 */
export function createKillerPolicy(
  params: KillerPolicyParams,
): (player: string, team: string | null | undefined) => KillerRuleResolution {
  const {
    doc,
    passesGeneral,
    generalMinKills,
    watchlistOverride,
    stars,
    teamAliases,
  } = params;
  return (player: string, team: string | null | undefined): KillerRuleResolution => {
    const canonical = matchTeamAlias(team, teamAliases ?? []) ?? team ?? null;
    return resolveKillerMinKills({
      doc,
      player,
      playerTeam: canonical,
      passesGeneral,
      generalMinKills,
      watchlistOverride,
      stars,
    });
  };
}

export interface RoundPolicyParams {
  /** Doc da watchlist do momento (hot-reload: ler de novo a cada round). */
  doc: WatchlistDoc | null | undefined;
  /** Estrelas da partida. */
  stars: number;
  /** Times da partida (nomes do listing). */
  teams: Array<string | null | undefined>;
  /** A partida passa na política geral (estrelas/top-tier). */
  passesGeneral: boolean;
  /** Limiar da política geral para esta partida. */
  generalMinKills: number;
}

export interface RoundPolicy {
  /** Regra da partida (piso por time já aplicado). */
  rule: MatchRuleResolution;
  /** O override da watchlist está ATIVO (algum time atendeu o piso). */
  overrideActive: boolean;
  /** Limiar do killer do round. */
  killer: (player: string, team: string | null | undefined) => KillerRuleResolution;
}

/**
 * Política da PARTIDA (puro/testável): junta a regra de partida (piso por
 * time) com a política do killer.
 *
 * O chamador recalcula isto a cada round — o doc entra como parâmetro,
 * então a watchlist recarregada no disco vale para a partida em andamento
 * sem reiniciar o bot.
 */
export function resolveRoundPolicy(params: RoundPolicyParams): RoundPolicy {
  const { doc, stars, teams, passesGeneral, generalMinKills } = params;
  const rule = resolveMatchRule(doc, teams, generalMinKills, stars);
  const overrideActive = rule.watchlisted && rule.teams.some((t) => t.floorMet);
  return {
    rule,
    overrideActive,
    killer: createKillerPolicy({
      doc,
      passesGeneral,
      generalMinKills,
      watchlistOverride: overrideActive,
      stars,
      teamAliases: teams,
    }),
  };
}

/** Regra de jogador (killer do round): sobrescreve o limiar da partida. */
export function resolvePlayerRule(
  doc: WatchlistDoc | null | undefined,
  player: string,
): PlayerRuleResolution | null {
  if (!doc || !doc.enabled) return null;
  const wanted = normalizeName(player);
  if (!wanted) return null;
  const hits = doc.players.filter(
    (rule) => rule.enabled && rule.names.some((name) => normalizeName(name) === wanted),
  );
  if (hits.length === 0) return null;
  let minKills = Number.POSITIVE_INFINITY;
  let clutch = false;
  let matchedName = player;
  for (const rule of hits) {
    minKills = Math.min(minKills, rule.minKills ?? doc.defaults.minKills);
    clutch = clutch || (rule.clutch ?? doc.defaults.clutch);
    matchedName = rule.names[0] ?? player;
  }
  return {
    minKills: Number.isFinite(minKills) ? minKills : WATCHLIST_DEFAULT_MIN_KILLS,
    clutch,
    matchedName,
  };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  doc: WatchlistDoc;
  error: string | null;
  missing: boolean;
  stale: boolean;
  /** Última versão validada (preservada se o arquivo sumir/ficar inválido). */
  lastGoodDoc: WatchlistDoc | null;
  lastGoodAt: number;
}

const watchlistCache = new Map<string, CacheEntry>();

/**
 * Lê o arquivo com cache por mtime. JSON inválido mantém a última versão
 * boa (error != null) e nunca derruba o bot. Arquivo ausente mantém a última
 * versão boa por WATCHLIST_MISSING_GRACE_MS (rename/save do editor) e depois
 * cai no doc padrão (watchlist desligada).
 */
export function loadWatchlistFile(filePath: string, now = Date.now()): LoadedWatchlist {
  const prev = watchlistCache.get(filePath);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    stat = null;
  }
  if (!stat) {
    const lastGoodDoc = prev?.lastGoodDoc ?? null;
    const lastGoodAt = prev?.lastGoodAt ?? 0;
    const stale = lastGoodDoc !== null && now - lastGoodAt <= WATCHLIST_MISSING_GRACE_MS;
    const doc = stale && lastGoodDoc ? lastGoodDoc : defaultWatchlistDoc();
    const changed = !prev || !prev.missing || prev.stale !== stale;
    const entry: CacheEntry = {
      mtimeMs: -1,
      size: -1,
      doc,
      error: null,
      missing: true,
      stale,
      lastGoodDoc,
      lastGoodAt,
    };
    watchlistCache.set(filePath, entry);
    return { doc, error: null, missing: true, stale, changed };
  }
  if (prev && !prev.missing && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
    return { doc: prev.doc, error: prev.error, missing: false, stale: false, changed: false };
  }
  let doc = prev?.lastGoodDoc ?? defaultWatchlistDoc();
  let error: string | null = null;
  let lastGoodDoc = prev?.lastGoodDoc ?? null;
  let lastGoodAt = prev?.lastGoodAt ?? 0;
  try {
    // BOM (Notepad/PowerShell) quebra JSON.parse; remove só o prefixo.
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    const validation = validateWatchlistDoc(parsed);
    if (validation.ok && validation.value) {
      doc = validation.value;
      lastGoodDoc = validation.value;
      lastGoodAt = now;
    } else {
      error = validation.errors.join('; ') || 'watchlist inválida';
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const entry: CacheEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    doc,
    error,
    missing: false,
    stale: false,
    lastGoodDoc,
    lastGoodAt,
  };
  watchlistCache.set(filePath, entry);
  return { doc, error, missing: false, stale: false, changed: true };
}
