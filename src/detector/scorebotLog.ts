/**
 * Leitura do killfeed do scorebot do HLTV (evento `log` do socket.io).
 *
 * O placar do DOM só expõe a contagem de K/D por jogador: arma, headshot e
 * assistência NUNCA aparecem lá. O scorebot publica cada kill com esses
 * campos — é a fonte canônica do detalhe.
 *
 * Formato observado (2026-11, match 2400205):
 *
 *   {"log":[{"Kill":{...}},{"Assist":{...}},{"RoundStart":{}}, ...]}
 *
 * - o replay inicial vem do MAIS NOVO para o mais antigo;
 * - `Assist` é um evento SEPARADO, ligado pelo `killEventId` (pode vir
 *   antes ou depois da kill);
 * - `MatchStarted`/`RoundStart` marcam a virada de mapa/round;
 * - os nomes dos campos variam entre versões do scorebot
 *   (`killerNick`/`killerName`, `headShot`/`headshot`, `noScope`/`noscope`),
 *   por isso a leitura é defensiva: campo ausente fica indefinido (nunca
 *   inventa `false`).
 */

/** Uma kill do killfeed, já normalizada e com o round resolvido. */
export interface ScorebotKill {
  /** Id do kill no jogo — dedup entre reconexões. */
  eventId: string | null;
  killer: string;
  victim: string;
  weapon?: string;
  headshot?: boolean;
  assistBy?: string;
  flashAssistBy?: string;
  throughSmoke?: boolean;
  wallbang?: boolean;
  noscope?: boolean;
  /** Mapa normalizado ('de_anubis' → 'anubis'); '' = desconhecido. */
  map: string;
  /** Round 1-based (0 = kill antes do 1º RoundStart do mapa). */
  round: number;
  /** Veio do replay de abertura (backlog), não do fluxo ao vivo. */
  replay: boolean;
}

/**
 * Mapa/round correntes, persistidos entre frames.
 *
 * POR QUE: só o replay de abertura traz `MatchStarted`/`RoundStart`. Um
 * frame AO VIVO traz apenas `Kill`/`Assist` — sem este estado, toda kill
 * live sairia com `round: 0` e `map: ''`, os filtros por round do
 * `RoundTracker` virariam no-op e o dedup (`scorebotKillKey`) casaria o
 * mesmo duelo em rounds diferentes.
 */
export interface ScorebotLogState {
  /** Mapa normalizado ('anubis'); '' = desconhecido. */
  map: string;
  /** Round 1-based (0 = antes do 1º `RoundStart` do mapa). */
  round: number;
}

export interface ScorebotLogOptions {
  /** O replay de abertura vem do mais novo para o mais antigo. */
  reverse?: boolean;
  /** Marca as kills como backlog do replay (ver `RoundTracker`). */
  replay?: boolean;
  /**
   * Assistências recebidas antes da kill, persistidas entre frames (o
   * `Assist` pode chegar num `log` separado). Quem chama mantém o mapa.
   */
  assistStore?: Map<string, string>;
  /**
   * Estado mapa/round entre frames. O parser COMEÇA dele e o ATUALIZA no
   * fim (o replay semeia; os frames ao vivo continuam de onde parou).
   */
  state?: ScorebotLogState;
}

/** Nome de mapa canônico: 'de_anubis'/'Anubis' → 'anubis'. Puro. */
export function normalizeMapName(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/^\s*de_/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Normaliza as chaves do evento (o payload mistura camelCase/PascalCase). */
function lowerKeys(ev: Record<string, unknown>): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(ev)) fields.set(key.toLowerCase(), value);
  return fields;
}

/** Texto de um campo entre vários nomes possíveis (defensivo). */
function text(fields: Map<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = fields.get(key.toLowerCase());
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** Booleano defensivo: aceita true/false, "true"/"false", 1/0. */
function bool(fields: Map<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = fields.get(key.toLowerCase());
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
  }
  return undefined;
}

const KILLER_KEYS = ['killerNick', 'killerName', 'killer'];
const VICTIM_KEYS = ['victimNick', 'victimName', 'victim'];
const WEAPON_KEYS = ['weapon', 'weaponName'];
const HEADSHOT_KEYS = ['headShot', 'headshot'];
const WALLBANG_KEYS = ['penetrated', 'wallbang', 'penetration'];
const SMOKE_KEYS = ['throughSmoke', 'thrusmoke', 'smokebang', 'throughsmoke'];
const NOSCOPE_KEYS = ['noScope', 'noscope'];
const FLASHER_KEYS = ['flasherNick', 'flasherName', 'flasher'];
const ASSIST_KEYS = ['assisterNick', 'assistNick', 'assisterName', 'assister', 'assist'];

/**
 * Converte os itens crus do evento `log` em kills normalizadas.
 *
 * Puro: recebe o array do payload e devolve kills (sem rede, sem relógio).
 * Ignora `Suicide` (é evento próprio — o placar também não conta como
 * kill), eventos de rodada e qualquer item desconhecido.
 *
 * `opts.state` (quando passado) é lido no começo e atualizado no fim: é
 * o que faz um frame ao vivo — que não repete `MatchStarted`/`RoundStart`
 * — herdar o mapa e o round do replay.
 */
export function parseScorebotLog(
  items: unknown[],
  opts: ScorebotLogOptions = {},
): ScorebotKill[] {
  const ordered = opts.reverse ? [...items].reverse() : items;
  const kills: ScorebotKill[] = [];
  const byEvent = new Map<string, ScorebotKill>();
  const pendingAssists = opts.assistStore ?? new Map<string, string>();
  const seen = new Set<string>();
  // O estado vem de fora (frames ao vivo não repetem MatchStarted/RoundStart).
  let map = normalizeMapName(opts.state?.map);
  let round = Math.max(0, Math.floor(Number(opts.state?.round) || 0));

  for (const raw of ordered) {
    if (!raw || typeof raw !== 'object') continue;
    for (const [type, payload] of Object.entries(raw as Record<string, unknown>)) {
      const ev = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      const fields = lowerKeys(ev);
      if (type === 'MatchStarted') {
        map = normalizeMapName(text(fields, ['map', 'mapName']));
        round = 0;
        continue;
      }
      if (type === 'RoundStart') {
        round += 1;
        continue;
      }
      if (type === 'Assist') {
        // Assist separado: guarda pelo id da kill e aplica quando ela
        // aparecer (o evento pode vir antes ou depois).
        const id = text(fields, ['killEventId', 'eventId']);
        const by = text(fields, ASSIST_KEYS);
        if (!id || !by) continue;
        const target = byEvent.get(id);
        if (target) {
          if (!target.assistBy) target.assistBy = by;
        } else {
          pendingAssists.set(id, by);
        }
        continue;
      }
      if (type !== 'Kill') continue;

      const killer = text(fields, KILLER_KEYS);
      const victim = text(fields, VICTIM_KEYS);
      if (!killer || !victim) continue;
      const eventId = text(fields, ['eventId', 'killEventId']);
      const key = eventId ? `id:${eventId}` : `kv:${killer}|${victim}|${map}|${round}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const weapon = text(fields, WEAPON_KEYS);
      const kill: ScorebotKill = {
        eventId: eventId || null,
        killer,
        victim,
        map,
        round,
        replay: opts.replay === true,
      };
      if (weapon) kill.weapon = weapon;
      const headshot = bool(fields, HEADSHOT_KEYS);
      if (headshot != null) kill.headshot = headshot;
      const wallbang = bool(fields, WALLBANG_KEYS);
      if (wallbang != null) kill.wallbang = wallbang;
      const smoke = bool(fields, SMOKE_KEYS);
      if (smoke != null) kill.throughSmoke = smoke;
      const noscope = bool(fields, NOSCOPE_KEYS);
      if (noscope != null) kill.noscope = noscope;
      const flasher = text(fields, FLASHER_KEYS);
      if (flasher) kill.flashAssistBy = flasher;
      const inlineAssist = text(fields, ASSIST_KEYS);
      if (inlineAssist) kill.assistBy = inlineAssist;
      if (eventId) {
        const pending = pendingAssists.get(eventId);
        if (pending) {
          if (!kill.assistBy) kill.assistBy = pending;
          pendingAssists.delete(eventId);
        }
        byEvent.set(eventId, kill);
      }
      kills.push(kill);
    }
  }
  // O frame seguinte começa do mapa/round em que este terminou.
  if (opts.state) {
    opts.state.map = map;
    opts.state.round = round;
  }
  return kills;
}

/** Chave estável de uma kill do killfeed (dedup entre reconexões). */
export function scorebotKillKey(kill: ScorebotKill): string {
  return kill.eventId
    ? `id:${kill.eventId}`
    : `${kill.killer.toLowerCase()}|${kill.victim.toLowerCase()}|${kill.map}|${kill.round}`;
}
