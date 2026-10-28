import { type BrowserContext, type Page } from 'playwright';
import type { LiveMatch, StreamInfo } from '../types.js';
import { getLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { trySolveChallenge } from '../clipper/stealthBrowser.js';
import {
  resolveMatchRule,
  type MatchRuleResolution,
  type WatchlistDoc,
} from '../watchlist.js';

const OFFICIAL_HINTS = ['esl', 'blast', 'pgl', 'starladder', 'faceit', 'major', 'iem', 'eslcs'];

// Eventos que quase sempre são tier-1 (fallback quando o HLTV não expõe estrelas no listing)
const TOP_TIER_EVENTS =
  /major|blast|iem |katowice|cologne|esl pro|pgl|starladder|blast\.tv|esports world cup|epl |shanghai|austin|copenhagen/i;

let browser: BrowserContext | null = null;

/**
 * Registro de nascimento das abas: toda about:blank nasce no newPage e só
 * deveria existir até o goto commitar. Abas presas em branco (navegação que
 * nunca commitou + dono que nunca fechou) são lixo — o sweeper as recolhe.
 * A entrada é removida no evento 'close' da aba: sem isso o Map retém o
 * objeto Page (e a sessão CDP) para sempre — leak em processo 24/7 (abas
 * fechadas não aparecem em b.pages(), o sweep nunca as visitava).
 */
const pageBorn = new Map<Page, number>();

function trackPage(p: Page): Page {
  pageBorn.set(p, Date.now());
  p.once('close', () => pageBorn.delete(p));
  return p;
}

export async function newTrackedPage(): Promise<Page> {
  const b = await getBrowser();
  return trackPage(await b.newPage());
}

/**
 * Fecha abas about:blank mais velhas que maxAgeMs (default 2min — bem acima
 * do goto de 45s, então nunca mata aba em setup legítimo). Chamado a cada
 * ciclo de poll. Retorna quantas fechou. Também cobre chrome://newtab*
 * (variantes de blank por versão/flag).
 */
const BLANK_URLS = ['about:blank', 'chrome://newtab', 'chrome://new-tab-page'];
export async function sweepStaleBlankPages(maxAgeMs = 120_000): Promise<number> {
  const b = await getBrowser().catch(() => null);
  if (!b) return 0;
  let closed = 0;
  let blanks = 0;
  const now = Date.now();
  for (const p of b.pages()) {
    try {
      if (p.isClosed()) {
        pageBorn.delete(p);
        continue;
      }
      const born = pageBorn.get(p);
      if (born === undefined) continue; // aba externa (debug manual): não toca
      const url = p.url();
      if (!BLANK_URLS.some((bl) => url === bl || url.startsWith(`${bl}/`))) continue;
      blanks++;
      if (now - born > maxAgeMs) {
        await p.close().catch(() => undefined);
        pageBorn.delete(p);
        closed++;
      }
    } catch {
      // segue para a próxima aba
    }
  }
  // Visibilidade permanente: blanks recorrentes indicam churn (ex: rebusca
  // de streams) ou navegação que nunca commita — o log conta a história.
  if (blanks > 0 || closed > 0) {
    getLogger().info({ pages: b.pages().length, blanks, closed }, 'higiene de abas');
  }
  return closed;
}

let browserLaunching: Promise<BrowserContext> | null = null;
// Single-flight: duas chamadas concorrentes na 1ª vez lançavam 2 contextos
// no mesmo perfil (o 2º morre). Todas esperam o MESMO launch.

export async function getBrowser(): Promise<BrowserContext> {
  if (browser) return browser;
  if (browserLaunching) return browserLaunching;
  const launch = (async (): Promise<BrowserContext> => {
    // HLTV barra Chromium headless comum ("Just a moment..."): usa o contexto
    // stealth (preferindo o Chrome real) com perfil persistente — o cookie
    // de clearance do Cloudflare é reaproveitado entre polls.
    const { launchStealthContext } = await import('../clipper/stealthBrowser.js');
    const cfg = getConfig();
    // Headless é barrado pelo Cloudflare ("Just a moment" eterno); headed
    // minimizado limpa em ~10s. HLTV_HEADLESS=1 volta p/ headless (debug).
    const headless = cfg.HLTV_HEADLESS === '1';
    const b = await launchStealthContext({
      profileDir: cfg.HLTV_PROFILE,
      headless,
      extraArgs: headless ? [] : ['--start-minimized'],
      // Reforço via CDP (o Chrome real às vezes ignora a flag).
      minimize: !headless,
      // HLTV abre popunders de anúncio (viram about:blank presas): bloqueia.
      // (Logins manuais usam outro perfil/launcher, sem isso.)
      ignoreDefaultArgs: ['--disable-popup-blocking'],
    });
    // Contexto morreu (crash/kill): zera para o próximo getBrowser lançar
    // de novo — sem isso todas as chamadas falhariam para sempre.
    b.on('close', () => {
      if (browser === b) browser = null;
    });
    // Registra TODAS as abas (inclusive popups que escaparem): o sweep fecha
    // as que ficarem em branco. Sem isso, popup não registrado era ignorado.
    b.on('page', (p) => {
      if (!pageBorn.has(p)) trackPage(p);
    });
    for (const p of b.pages()) {
      if (!pageBorn.has(p)) trackPage(p);
    }
    browser = b;
    return b;
  })();
  browserLaunching = launch;
  try {
    return await launch;
  } finally {
    browserLaunching = null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
}

/**
 * Aguarda o Cloudflare liberar a página.
 * Checa TÍTULO (EN e PT-BR: "Just a moment..." / "Um momento…") E conteúdo
 * real (página de desafio tem ~300 chars) — título sozinho já passou
 * bloqueadoogs como liberado.
 * Sem isso, a extração roda sobre a página de desafio e retorna vazio —
 * parecendo "sem streams", "sem lives" ou zerando o placar do tracker.
 * Se o desafio escalar para checkbox ("não sou robô"), tenta 1 clique
 * automático via trySolveChallenge.
 */
const BLOCKED_TITLE =
  /just a moment|um momento|attention required|security check|verifying|cloudflare/i;

export async function waitForClearance(page: Page, timeoutMs = 25000): Promise<boolean> {
  const start = Date.now();
  let triedClick = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const title = await page.title();
      if (!BLOCKED_TITLE.test(title)) {
        const bodyLen = await page
          .evaluate(() => document.body.innerText.length)
          .catch(() => 0);
        if (bodyLen > 1000) return true;
      }
    } catch {
      // página recarregando — tenta de novo
    }
    if (!triedClick && Date.now() - start > 8000) {
      triedClick = true;
      try {
        await trySolveChallenge(page, getLogger(), 1);
      } catch {
        // segue esperando o timeout
      }
    }
    await page.waitForTimeout(1500);
  }
  getLogger().warn({ url: page.url() }, 'Cloudflare não liberou a página a tempo');
  return false;
}

/** Conta estrelas cheias (fa-star), ignorando vazias (fa-star-o/faded/unselected). */
export function parseStarsFromHtml(starHtml: string, starCount: number): number {
  if (starCount > 0) return Math.min(5, starCount);
  const tags = starHtml.match(/<i\b[^>]*class="[^"]*\bfa-star\b[^"]*"[^>]*>/gi) ?? [];
  const filled = tags.filter((t) => !/\bfa-star-o\b|\bfaded\b|\bunselected\b/i.test(t));
  return Math.min(5, filled.length);
}

export function guessTopTier(event: string, stars: number): boolean {
  return stars >= 4 || TOP_TIER_EVENTS.test(event);
}

export function matchPassesFilter(
  stars: number,
  isTopTierGuess: boolean,
  minStars: number,
  topTierOnly: boolean,
): boolean {
  // O listing do HLTV (2026) nem sempre expõe estrelas por partida.
  // stars===0 = desconhecido → decide pela heurística top-tier.
  if (stars === 0) {
    if (minStars <= 0 && !topTierOnly) return true;
    return isTopTierGuess;
  }
  if (stars < minStars) return false;
  if (topTierOnly && !isTopTierGuess) return false;
  return true;
}

/**
 * Política de kills por estrela: partida com pelo menos 1 estrela rende
 * clipe a partir de 4k; partida SEM estrela (0 = sem avaliação no listing)
 * só rende com 5k. O limite de estrelas em si continua em MIN_STARS.
 */
export function minKillsForStars(
  stars: number,
  starredMinKills: number,
  unstarredMinKills: number,
): number {
  return stars >= 1 ? starredMinKills : unstarredMinKills;
}

const COUNTRY_ALIASES: Record<string, string> = {
  BRASIL: 'BR',
  BRAZIL: 'BR',
  RUSSIA: 'RU',
  ARGENTINA: 'AR',
  OTHER: 'WORLD',
  WORLD: 'WORLD',
};

export function normalizeCountry(value: string | undefined): string {
  const raw = (value ?? '').trim().toUpperCase();
  return COUNTRY_ALIASES[raw] ?? raw;
}

function isCountryCode(value: string): boolean {
  return /^[A-Z]{2,3}$/.test(value) || value === 'WORLD';
}

export function parseStreamCountry(flagSrc: string, flagTitle = ''): string | undefined {
  const fromSrc = flagSrc.match(/\/flags\/[^/]+\/([A-Za-z]{2,5})\.(?:gif|png|svg)/i)?.[1];
  if (fromSrc) {
    const normalized = normalizeCountry(fromSrc);
    return isCountryCode(normalized) ? normalized : undefined;
  }
  const fromTitle = normalizeCountry(flagTitle);
  return isCountryCode(fromTitle) ? fromTitle : undefined;
}

export interface StreamPreference {
  country?: string;
  minViewers?: number;
}

export type StreamChoiceReason = 'preferred' | 'main' | 'fallback';

export interface StreamChoice {
  stream: StreamInfo;
  reason: StreamChoiceReason;
}

function byViewersDesc(a: StreamInfo, b: StreamInfo): number {
  return (b.viewers ?? 0) - (a.viewers ?? 0);
}

function scoreMainStream(
  streams: StreamInfo[],
  priority: string,
  penalty?: (stream: StreamInfo) => number,
): StreamInfo | null {
  if (streams.length === 0) return null;
  const prefs = priority
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  let wantsOfficial = prefs.includes('official');
  let wantsEn = prefs.includes('en');
  const wantsGaules = prefs.includes('gaules');
  const hasOfficial = streams.some(
    (s) => s.isOfficialGuess ?? OFFICIAL_HINTS.some((h) => s.name.toLowerCase().includes(h)),
  );
  const hasGaules = streams.some((s) => /gaules/i.test(s.name));

  // Fallback cruzado official <-> gaules: a escolhida indisponível usa a outra.
  // (Gaules não cobre todos os jogos; e a oficial pode cair.)
  // Sem nenhuma das duas no ar, vale a pontuação normal (viewers/idioma).
  const gaulesActive = wantsGaules || ((wantsOfficial || wantsEn) && !hasOfficial);
  if (wantsGaules && !hasGaules) {
    wantsOfficial = true;
    wantsEn = true;
  }

  const scored = streams.map((s) => {
    let score = s.viewers ?? 0;
    const name = s.name.toLowerCase();
    const official =
      s.isOfficialGuess ?? OFFICIAL_HINTS.some((h) => name.includes(h));
    // Gaules (pedido ou fallback) vence tudo — até oficial + viewers.
    if (gaulesActive && /gaules/i.test(name)) score += 2_000_000;
    if (wantsOfficial && official) score += 1_000_000;
    if (wantsEn && (s.language?.toLowerCase() === 'en' || name.includes('esl')))
      score += 100_000;
    // Evita restreams BR quando o usuário pediu EN oficial
    // (mas não quando o BR — Gaules pedido ou fallback — é o alvo).
    if (wantsEn && !gaulesActive && /gaules|nak|liminha|bt0|br/i.test(name)) score -= 500_000;
    score -= penalty?.(s) ?? 0;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.s ?? null;
}

function isPreferredBelowMin(
  stream: StreamInfo,
  country: string,
  minViewers: number,
): boolean {
  return normalizeCountry(stream.country) === country && (stream.viewers ?? 0) < minViewers;
}

const BELOW_MIN_PENALTY = 500_000;

export function selectStream(
  streams: StreamInfo[],
  priority: string,
  preference?: StreamPreference,
): StreamChoice | null {
  if (streams.length === 0) return null;
  const country = normalizeCountry(preference?.country);
  const minViewers = Math.max(0, preference?.minViewers ?? 0);

  if (country) {
    const preferred = streams
      .filter((s) => normalizeCountry(s.country) === country && (s.viewers ?? 0) >= minViewers)
      .sort(byViewersDesc)[0];
    if (preferred) return { stream: preferred, reason: 'preferred' };
  }

  // Stream do país abaixo do mínimo fica de penalty (não é removido): a
  // prioridade explícita (ex.: gaules) continua valendo, mas a stream do
  // país não ganha de uma oficial/en só por existir.
  const penalty = (stream: StreamInfo): number =>
    country && minViewers > 0 && isPreferredBelowMin(stream, country, minViewers)
      ? BELOW_MIN_PENALTY
      : 0;

  const main = scoreMainStream(streams, priority, penalty);
  if (main) {
    return { stream: main, reason: penalty(main) > 0 ? 'fallback' : 'main' };
  }

  const fallback = [...streams].sort(byViewersDesc)[0];
  return fallback ? { stream: fallback, reason: 'fallback' } : null;
}

export function pickPreferredStream(
  streams: StreamInfo[],
  priority: string,
): StreamInfo | null {
  return selectStream(streams, priority)?.stream ?? null;
}

export interface MatchCard {
  matchId: string;
  href: string;
  teamNames: string[];
  event: string;
  stage: string;
  isLive: boolean;
  stars: number;
}

/** Mapper puro card → LiveMatch (testável sem rede). */
export function cardToLiveMatch(card: MatchCard): LiveMatch {
  const isTopTierGuess = guessTopTier(card.event, card.stars);
  return {
    matchId: card.matchId,
    team1: card.teamNames[0] ?? 'TBD',
    team2: card.teamNames[1] ?? 'TBD',
    event: card.event || 'CS2 event',
    stars: card.stars,
    isTopTierGuess,
    matchPageUrl: `https://www.hltv.org${card.href}`,
    streams: [],
  };
}

/** Partida futura (ainda não live) extraída do listing, com horário marcado. */
export interface UpcomingMatch {
  matchId: string;
  team1: string;
  team2: string;
  event: string;
  stars: number;
  isTopTierGuess: boolean;
  /** Epoch ms do horário marcado no HLTV. */
  startsAt: number;
  matchPageUrl: string;
  /** true quando entrou pelo override da watchlist. */
  watchlisted?: boolean;
  watchlistedTeams?: string[];
}

/** Listing completo de uma consulta: o que está live e o que vem a seguir. */
export interface MatchListing {
  /** Live que passou no filtro (vira recorder/tracker). */
  live: LiveMatch[];
  /** Todas as live vistas na página (antes do filtro). */
  liveTotal: number;
  upcoming: UpcomingMatch[];
  /**
   * Partidas futuras com horário válido, ANTES do filtro de elegibilidade.
   * Serve para distinguir "não há partida elegível" de "a extração quebrau".
   */
  upcomingTotal: number;
  /** Cards futuros vistos no DOM (antes do dedupe). */
  upcomingSeen: number;
  /**
   * A agenda do listing é confiável? false = nenhum card futuro com
   * horário (DOM mudou / extração falhou) → o poll não pode adiar.
   */
  scheduleReliable: boolean;
}

/**
 * Timestamp do HLTV (`data-unix` / `data-zonedgrouping-entry-unix`).
 * A página usa epoch em ms; layouts antigos podem usar segundos.
 */
export function parseHltvUnixMs(value: string | number | null | undefined): number | null {
  const raw = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Mapper puro card futuro → UpcomingMatch (horário já parseado). */
export function cardToUpcomingMatch(card: UpcomingCard, startAt: number): UpcomingMatch {
  return {
    matchId: card.matchId,
    team1: card.teamNames[0] ?? 'TBD',
    team2: card.teamNames[1] ?? 'TBD',
    event: card.event || 'CS2 event',
    stars: card.stars,
    isTopTierGuess: guessTopTier(card.event, card.stars),
    startsAt: startAt,
    matchPageUrl: `https://www.hltv.org${card.href}`,
  };
}

/**
 * Dedupe por matchId: o HLTV repete o mesmo card em listas diferentes
 * ("por evento" e "cronológico"). Vence o horário mais próximo; o evento
 * só é usado para completar o que faltar. Puro/testável.
 */
export function dedupeUpcoming(matches: UpcomingMatch[]): UpcomingMatch[] {
  const byId = new Map<string, UpcomingMatch>();
  for (const m of matches) {
    const prev = byId.get(m.matchId);
    if (!prev) {
      byId.set(m.matchId, m);
    } else if (m.startsAt < prev.startsAt) {
      byId.set(m.matchId, { ...m, event: m.event || prev.event });
    } else if (m.startsAt === prev.startsAt && !prev.event && m.event) {
      byId.set(m.matchId, { ...prev, event: m.event });
    }
  }
  return [...byId.values()].sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Próxima partida futura por ordem de horário.
 * `graceMs` mantém no topo a partida cujo horário já passou (adiamento):
 * enquanto ela não aparece como live, o bot continua no intervalo base.
 */
export function selectNextUpcoming(
  matches: UpcomingMatch[],
  now: number,
  graceMs = 0,
): UpcomingMatch | null {
  let best: UpcomingMatch | null = null;
  for (const match of matches) {
    if (match.startsAt < now - graceMs) continue;
    if (!best || match.startsAt < best.startsAt) best = match;
  }
  return best;
}

export interface LiveMatchFilter {
  /** Watchlist carregada do disco (ausente = política por estrelas). */
  watchlist?: WatchlistDoc | null;
  /** Limiar para partidas com estrela (MIN_KILLS). */
  starredMinKills?: number;
  /** Limiar para partidas sem estrela (MIN_KILLS_NO_STARS). */
  unstarredMinKills?: number;
}

/**
 * Regra efetiva da partida: time na watchlist vence a política por estrelas
 * (grava mesmo com 0★) e usa o menor limiar dos times casados.
 */
export function effectiveMatchRule(
  match: Pick<LiveMatch, 'stars' | 'team1' | 'team2'>,
  filter: LiveMatchFilter = {},
): MatchRuleResolution {
  const fallback = minKillsForStars(
    match.stars,
    filter.starredMinKills ?? 4,
    filter.unstarredMinKills ?? 5,
  );
  return resolveMatchRule(filter.watchlist ?? null, [match.team1, match.team2], fallback);
}

/** Card futuro cru: mesmo formato do live + o timestamp bruto do listing. */
export interface UpcomingCard extends MatchCard {
  /** Timestamp bruto do HLTV (data-unix). Vazio = card sem horário. */
  startUnix: string;
}

/** Cards crus do listing, antes de qualquer filtro. */
export interface ListingCards {
  /** Cards do container live (div.match[data-livescore-match]). */
  live: MatchCard[];
  /** Cards futuros (.match-wrapper[data-match-id]). */
  upcoming: UpcomingCard[];
  /** Cards futuros vistos no DOM (antes do dedupe). */
  upcomingSeen: number;
  /** Erro na extração dos live (o listing inteiro vira "bloqueado"). */
  liveError: string | null;
  /** Erro na extração dos futuros (a agenda fica não confiável). */
  upcomingError: string | null;
  /**
   * Cards live que quebraram na extração. Um card live perdido = a
   * partida some do listing = o recorder dela é parado e o buffer
   * APAGADO. Por isso o erro é contabilizado: o listing inteiro é
   * tratado como inutilizável (mantém recorder/buffer).
   */
  liveCardErrors: number;
  /** Cards futuros que quebraram (a agenda fica não confiável). */
  upcomingCardErrors: number;
}

/**
 * Uma passada só no DOM: cards live + cards futuros, com o MESMO critério
 * de liveness nos dois.
 *
 * Layout 2026 do /matches:
 * - live: `div.match[data-livescore-match]` (o interno div.match duplica,
 *   por isso o seletor mira só no que tem o atributo);
 * - futuros: `.match-wrapper[data-match-id]` com `live="false"` e horário
 *   em `.match-time[data-unix]` (fallback: o wrapper de horário
 *   `data-zonedgrouping-entry-unix`).
 *
 * Liveness (idêntico nos dois lados): texto "Live" em `.match-meta-live`
 * OU atributo `live="true"`. O card futuro NÃO é descartado por ter
 * `[data-livescore-match]` dentro: esse atributo já apareceu em card que
 * não era live e descartar tudo deixaria o bot cego. O que separa live
 * de futuro é o id (o mesmo matchId aparece nas duas listas) e o
 * atributo `live`.
 *
 * Um card quebrado não derruba a extração inteira (try/catch por card).
 */
export async function extractListingCards(page: Page): Promise<ListingCards> {
  return page.evaluate(() => {
    type Card = {
      matchId: string;
      href: string;
      teamNames: string[];
      event: string;
      stage: string;
      isLive: boolean;
      stars: number;
    };
    const out: {
      live: Card[];
      upcoming: Array<Card & { startUnix: string }>;
      upcomingSeen: number;
      liveError: string | null;
      upcomingError: string | null;
      liveCardErrors: number;
      upcomingCardErrors: number;
    } = {
      live: [],
      upcoming: [],
      upcomingSeen: 0,
      liveError: null,
      upcomingError: null,
      liveCardErrors: 0,
      upcomingCardErrors: 0,
    };

    // O wrapper traz o número exato em data-stars (0-5). Os 5 <i> do
    // rating incluem estrelas "faded"; contar só os <i> dava 5 em jogo 1★.
    const parseStars = (root: Element): number => {
      const attr =
        root.getAttribute('data-stars') ??
        root.closest('[data-stars]')?.getAttribute('data-stars') ??
        '';
      const parsed = Number.parseInt(attr, 10);
      if (Number.isFinite(parsed)) return Math.max(0, Math.min(5, parsed));
      let stars = 0;
      root.querySelectorAll('i.fa-star').forEach((s) => {
        const cls = s.getAttribute('class') ?? '';
        if (!/\bfa-star-o\b|\bfaded\b|\bunselected\b/.test(cls)) stars += 1;
      });
      return Math.min(5, stars);
    };

    // Critério ÚNICO de liveness (vale para live e futuro).
    const isLiveCard = (root: Element): boolean => {
      const liveText = root.querySelector('.match-meta-live')?.textContent ?? '';
      if (/live/i.test(liveText)) return true;
      return root.closest('[live]')?.getAttribute('live') === 'true';
    };

    const parseCard = (root: Element, matchId: string, href: string, isLive: boolean): Card => {
      const teamNames = Array.from(root.querySelectorAll('.match-teamname'))
        .map((e) => (e.textContent ?? '').trim())
        .filter(Boolean)
        .slice(0, 2);
      const eventEl = root.querySelector('.match-event');
      // Ordem: atributo do próprio card → atributo do wrapper do evento
      // → texto do card. O texto do .match-event concatena o stage
      // ("evento + fase"), então ele é o ÚLTIMO recurso.
      const event =
        eventEl?.getAttribute('data-event-headline')?.trim() ||
        root.closest('[data-event-headline]')?.getAttribute('data-event-headline')?.trim() ||
        (eventEl?.textContent ?? '').trim().slice(0, 120) ||
        '';
      const stage = root.querySelector('.match-stage')?.textContent?.trim().slice(0, 40) ?? '';
      return { matchId, href, teamNames, event, stage, isLive, stars: parseStars(root) };
    };

    // 1) LIVE
    const seenLive = new Set<string>();
    try {
      for (const w of Array.from(document.querySelectorAll('div.match[data-livescore-match]'))) {
        try {
          const matchId = w.getAttribute('data-livescore-match') ?? '';
          if (!matchId || seenLive.has(matchId)) continue;
          const anchor = w.querySelector('a[href*="/matches/"]');
          const href = anchor?.getAttribute('href') ?? '';
          if (!/\/matches\/\d+/.test(href)) continue;
          seenLive.add(matchId);
          out.live.push(parseCard(w, matchId, href, isLiveCard(w)));
        } catch {
          // Card isolado quebrado: conta o erro (o listing pode ficar
          // inutilizável — ver liveCardErrors) e segue com o resto.
          out.liveCardErrors += 1;
        }
      }
    } catch (e) {
      out.liveError = String(e);
    }

    // 2) FUTUROS
    const liveIds = new Set(out.live.filter((c) => c.isLive).map((c) => c.matchId));
    try {
      for (const w of Array.from(document.querySelectorAll('.match-wrapper[data-match-id]'))) {
        try {
          const matchId = w.getAttribute('data-match-id') ?? '';
          if (!matchId) continue;
          // Live = id já visto na lista live, atributo live="true" ou
          // texto "Live". Nenhum sinal ambiguo descarta card futuro.
          if (liveIds.has(matchId) || isLiveCard(w)) continue;
          out.upcomingSeen += 1;
          const anchor = w.querySelector('a[href*="/matches/"]');
          const href = anchor?.getAttribute('href') ?? '';
          if (!/\/matches\/\d+/.test(href)) continue;
          const startUnix =
            w.querySelector('.match-time[data-unix]')?.getAttribute('data-unix') ??
            w.closest('[data-zonedgrouping-entry-unix]')?.getAttribute(
              'data-zonedgrouping-entry-unix',
            ) ??
            '';
          out.upcoming.push({ ...parseCard(w, matchId, href, false), startUnix });
        } catch {
          // Card isolado quebrado: conta o erro (a agenda fica não
          // confiável) e segue com o resto.
          out.upcomingCardErrors += 1;
        }
      }
    } catch (e) {
      out.upcomingError = String(e);
    }

    return out;
  });
}

/** Motivo pelo qual o listing não pôde ser usado neste poll. */
export type ListingFailureReason =
  /** Cloudflare não liberou a página (challenge). */
  | 'blocked'
  /** A página abriu, mas a extração dos cards quebrou. */
  | 'extraction-error';

export type ListingResult =
  | { ok: true; listing: MatchListing }
  | { ok: false; reason: ListingFailureReason; detail?: string };

/**
 * Busca o listing de /matches (layout HLTV 2026): partidas LIVE que passam
 * no filtro + as próximas partidas futuras que também passam no filtro.
 * Container live: div.match[data-livescore-match] (externo — o interno
 * div.match duplica, por isso o seletor mira só no que tem o atributo).
 * Live = .match-meta-live com texto "Live" OU wrapper com live="true".
 * Cards futuros: .match-wrapper[data-match-id] com live="false"; o horário
 * marcado vem de .match-time[data-unix] (fallback: o wrapper de horário
 * data-zonedgrouping-entry-unix) — mesmo HTML, zero page-load extra.
 *
 * Falha vem com o MOTIVO (blocked x extraction-error): o ciclo precisa
 * manter recorders/trackers nos dois casos (listing vazio significaria
 * "sem lives" e derrubaria tudo), mas a mensagem/log tem que ser honesto
 * — "bloqueado pelo Cloudflare" num erro de parsing é diagnóstico errado.
 */
export async function fetchMatchListing(
  matchesUrl: string,
  minStars: number,
  topTierOnly: boolean,
  filter: LiveMatchFilter = {},
): Promise<ListingResult> {
  const log = getLogger();
  const b = await getBrowser();
  // Sem userAgent fixo de propósito: o contexto stealth envia UA autêntico
  // (+ Client Hints consistentes); UA fixo desatualizado é assinatura clássica.
  const page: Page = await newTrackedPage();
  try {
    await page.goto(matchesUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitForClearance(page))) {
      return { ok: false, reason: 'blocked' };
    }
    await page.waitForTimeout(3000);

    const cards = await extractListingCards(page);
    if (cards.liveError || cards.liveCardErrors > 0) {
      // Falha na extração dos live = listing inutilizável: o poll pula
      // sem desmontar recorders/trackers. Um card live perdido também
      // conta: a partida sumiria do listing e o recorder dela seria
      // parado (e o buffer apagado) sem motivo.
      log.error(
        { err: cards.liveError, cardErrors: cards.liveCardErrors },
        'falha ao extrair as live do listing',
      );
      return {
        ok: false,
        reason: 'extraction-error',
        detail: cards.liveError ?? `${cards.liveCardErrors} card(s) live quebrado(s)`,
      };
    }
    if (cards.upcomingError || cards.upcomingCardErrors > 0) {
      // A agenda futura é opcional: o poll continua no intervalo base
      // (fail-open) em vez de dormir achando que não há partida.
      log.warn(
        { err: cards.upcomingError, cardErrors: cards.upcomingCardErrors },
        'falha ao extrair as partidas futuras',
      );
    }

    const listing = buildListing(cards, minStars, topTierOnly, filter);
    log.info(
      {
        live: listing.liveTotal,
        kept: listing.live.length,
        watchlisted: listing.live.filter((m) => m.watchlisted).length,
        upcoming: listing.upcoming.length,
        upcomingTotal: listing.upcomingTotal,
        upcomingSeen: listing.upcomingSeen,
        scheduleReliable: listing.scheduleReliable,
        next: listing.upcoming[0]
          ? {
              matchId: listing.upcoming[0].matchId,
              startsAt: new Date(listing.upcoming[0].startsAt).toISOString(),
            }
          : null,
        minStars,
      },
      'live matches filtradas',
    );
    return { ok: true, listing };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Fração mínima de cards futuros COM horário para a agenda ser
 * confiável. Abaixo disso, parte do listing não tem data (countdown,
 * "TBD") e o backoff miraria uma partida mais distante que a real.
 */
export const SCHEDULE_MIN_TIME_RATIO = 0.5;

/**
 * Listing puro: aplica os filtros (estrelas/watchlist) nos cards crus.
 * Separado do I/O para poder ser testado com fixture de HTML.
 */
export function buildListing(
  cards: ListingCards,
  minStars: number,
  topTierOnly: boolean,
  filter: LiveMatchFilter = {},
): MatchListing {
  const matches: LiveMatch[] = [];
  for (const card of cards.live) {
    if (!card.isLive) continue; // tese do projeto: só lives (velocidade)
    const m = cardToLiveMatch(card);
    const rule = effectiveMatchRule(m, filter);
    m.minKills = rule.minKills;
    if (rule.watchlisted) {
      // Watchlist ignora o corte de estrelas/top-tier: grava e usa o
      // limiar do time (menor entre os que casaram).
      m.watchlisted = true;
      m.watchlistedTeams = rule.matchedTeams;
    } else if (!matchPassesFilter(m.stars, m.isTopTierGuess, minStars, topTierOnly)) {
      continue;
    }
    matches.push(m);
  }
  // Estrelas primeiro: com MAX_RECORDINGS limitado, elas não podem perder
  // o slot para um jogo sem estrela. Watchlist desempata mesmas estrelas.
  matches.sort(
    (a, b) =>
      b.stars - a.stars || Number(Boolean(b.watchlisted)) - Number(Boolean(a.watchlisted)),
  );

  // Próximas partidas: mesmo HTML do live, sem page-load extra. A página
  // repete o mesmo card em "pinned"/listas — dedupe por matchId.
  const scheduled: UpcomingMatch[] = [];
  for (const card of cards.upcoming) {
    const startAt = parseHltvUnixMs(card.startUnix);
    if (startAt === null) continue;
    scheduled.push(cardToUpcomingMatch(card, startAt));
  }
  const deduped = dedupeUpcoming(scheduled);

  const upcoming: UpcomingMatch[] = [];
  for (const m of deduped) {
    const rule = effectiveMatchRule(m, filter);
    if (rule.watchlisted) {
      m.watchlisted = true;
      m.watchlistedTeams = rule.matchedTeams;
    } else if (!matchPassesFilter(m.stars, m.isTopTierGuess, minStars, topTierOnly)) {
      continue;
    }
    upcoming.push(m);
  }
  upcoming.sort((a, b) => a.startsAt - b.startsAt);

  // Confiabilidade da agenda: além de existir card com horário, a MAIOR
  // parte deles precisa ter horário. Se só uma minoria tem data, o
  // backoff miraria uma partida mais distante que a real (a mais
  // próxima pode ser a que está sem data) → fail-open: intervalo base.
  const uniqueSeen = new Set(cards.upcoming.map((c) => c.matchId)).size;
  const uniqueWithTime = new Set(scheduled.map((m) => m.matchId)).size;
  const timeRatio = uniqueSeen > 0 ? uniqueWithTime / uniqueSeen : 0;

  return {
    live: matches,
    liveTotal: cards.live.filter((c) => c.isLive).length,
    upcoming,
    // Partidas futuras com horário, antes do filtro de elegibilidade.
    upcomingTotal: deduped.length,
    upcomingSeen: cards.upcomingSeen,
    // Agenda confiável = o listing mostrou alguma partida futura com
    // horário (e a maioria dos cards tem horário). Sem isso o poll não
    // pode adiar (fail-open: intervalo base).
    scheduleReliable:
      !cards.upcomingError &&
      cards.upcomingCardErrors === 0 &&
      deduped.length > 0 &&
      timeRatio >= SCHEDULE_MIN_TIME_RATIO,
  };
}

/**
 * Abre a página do match e extrai streams.
 * Layout 2026: div.stream-box com .stream-box-embed (nome) +
 * .watchbox-right .viewers (número cru "9988" ou "9.9k") +
 * .external-stream a[href] (link twitch/youtube/kick).
 * NÃO usar textContent da box inteira (concatena os dois spans de
 * viewers e gera contagem absurda que quebra o scoring).
 *
 * Retorna NULL quando o Cloudflare bloqueou — "sem streams" ([]) e
 * "bloqueado" são coisas diferentes: o chamador não deve cachear 10min
 * de cego por causa de um soluço do challenge.
 */
export async function fetchMatchStreams(matchPageUrl: string): Promise<StreamInfo[] | null> {
  const page = await newTrackedPage();
  try {
    await page.goto(matchPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitForClearance(page))) return null;
    await page.waitForTimeout(2000);
    const raw = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('div.stream-box'));
      return boxes.map((el) => {
        const anchor = el.querySelector(
          '.external-stream a[href]',
        ) as HTMLAnchorElement | null;
        const href = anchor ? anchor.href : '';
        const name = (
          el.querySelector('.stream-box-embed')?.textContent ?? ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 60);
        const viewersText = (
          el.querySelector('.watchbox-right .viewers')?.textContent ?? ''
        ).trim();
        const flag = el.querySelector(
          '.stream-box-embed .stream-flag, .stream-flag',
        ) as HTMLImageElement | null;
        const flagSrc = flag?.getAttribute('src') ?? '';
        const flagTitle = flag?.getAttribute('title') ?? flag?.alt ?? '';
        return { name: name || 'stream', href, viewersText, flagSrc, flagTitle };
      });
    });
    const out: StreamInfo[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (!r.href || seen.has(r.href)) continue;
      if (r.href.includes('hltv.org/live')) continue; // scoreboard, não vídeo
      if (!/twitch\.tv|youtube\.com|youtu\.be|kick\.com/.test(r.href)) continue;
      seen.add(r.href);
      out.push({
        name: r.name,
        url: r.href,
        country: parseStreamCountry(r.flagSrc, r.flagTitle),
        viewers: parseViewers(r.viewersText),
      });
    }
    return out;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** "9988" | "9.9k" | "1,2k" (decimal BR) | "1,200" (milhar US) -> nº. Absurdos (>10M) e vazio = undefined. */
export function parseViewers(text: string): number | undefined {
  let t = text.trim();
  if (!t) return undefined;
  // Vírgula decimal BR ("1,2k" = 1.2k); resto das vírgulas = milhar US.
  if (/,\d{1,2}\s*k$/i.test(t)) t = t.replace(',', '.');
  t = t.replace(/,/g, '');
  const k = t.match(/^([\d.]+)\s*k$/i);
  let n: number | undefined;
  if (k) {
    n = Math.round(Number.parseFloat(k[1]) * 1000);
  } else if (/^\d+$/.test(t)) {
    n = Number.parseInt(t, 10);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n) || n > 10_000_000) return undefined;
  return n;
}
