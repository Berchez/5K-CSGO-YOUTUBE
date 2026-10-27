import fs from 'node:fs';

/**
 * Watchlist: times/jogadores que fogem da política por estrelas.
 * - Time na lista → a partida é gravada mesmo com 0★, com limiar próprio.
 * - Jogador na lista → o limiar do jogador vence o do time naquele round.
 * O arquivo é lido pelo bot a cada poll (hot-reload por mtime) e editado
 * pelo painel em data/watchlist.json.
 */

export interface WatchlistDefaults {
  minKills: number;
  clutch: boolean;
}

export interface WatchlistTeamRule {
  names: string[];
  minKills?: number;
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

export interface MatchRuleResolution {
  watchlisted: boolean;
  minKills: number;
  clutch: boolean;
  matchedTeams: string[];
}

export interface PlayerRuleResolution {
  minKills: number;
  clutch: boolean;
  matchedName: string;
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
    defaults: { minKills: WATCHLIST_DEFAULT_MIN_KILLS, clutch: false },
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
    out.push({ names, minKills, clutch, enabled });
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
      const clutch = parseBool(input.defaults.clutch, 'defaults.clutch', errors);
      if (clutch !== undefined) doc.defaults.clutch = clutch;
    }
  }
  doc.teams = parseRuleList(input.teams, 'teams', 'time', errors).map((rule) => ({
    ...rule,
  }));
  doc.players = parseRuleList(input.players, 'players', 'jogador', errors).map((rule) => ({
    ...rule,
  }));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: doc, errors };
}

/** Regra de partida: time da lista ignora estrelas e usa o menor limiar. */
export function resolveMatchRule(
  doc: WatchlistDoc | null | undefined,
  teams: Array<string | null | undefined>,
  fallbackMinKills: number,
): MatchRuleResolution {
  const fallback: MatchRuleResolution = {
    watchlisted: false,
    minKills: fallbackMinKills,
    clutch: false,
    matchedTeams: [],
  };
  if (!doc || !doc.enabled) return fallback;
  const wanted = new Set(
    teams.map((team) => normalizeName(team ?? '')).filter((name) => name.length > 0),
  );
  if (wanted.size === 0) return fallback;
  const hits: Array<{ rule: WatchlistTeamRule; team: string }> = [];
  for (const rule of doc.teams) {
    if (!rule.enabled) continue;
    const team = rule.names.find((name) => wanted.has(normalizeName(name)));
    if (team) hits.push({ rule, team });
  }
  if (hits.length === 0) return fallback;
  let minKills = Number.POSITIVE_INFINITY;
  let clutch = false;
  const matchedTeams: string[] = [];
  for (const { rule, team } of hits) {
    minKills = Math.min(minKills, rule.minKills ?? doc.defaults.minKills);
    clutch = clutch || (rule.clutch ?? doc.defaults.clutch);
    matchedTeams.push(team);
  }
  return {
    watchlisted: true,
    minKills: Number.isFinite(minKills) ? minKills : fallbackMinKills,
    clutch,
    matchedTeams,
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
