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
  /** Epoch ms do horário marcado (só em cards futuros). */
  startAt?: number;
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

/** Partida futura (ainda não live)extraída do listing, com horário marcado. */
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

/** Mapper puro card futuro → UpcomingMatch. */
export function cardToUpcomingMatch(card: MatchCard & { startAt: number }): UpcomingMatch {
  return {
    matchId: card.matchId,
    team1: card.teamNames[0] ?? 'TBD',
    team2: card.teamNames[1] ?? 'TBD',
    event: card.event || 'CS2 event',
    stars: card.stars,
    isTopTierGuess: guessTopTier(card.event, card.stars),
    startsAt: card.startAt,
    matchPageUrl: `https://www.hltv.org${card.href}`,
  };
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
export type UpcomingCard = MatchCard & { startUnix: string };

/**
 * Cards LIVE da página /matches.
 * Container: div.match[data-livescore-match] (externo — o interno div.match
 * duplica, por isso o seletor mira só no que tem o atributo).
 * Live = .match-meta-live com texto "Live".
 */
export async function extractLiveCards(page: Page): Promise<MatchCard[]> {
  return page.evaluate(() => {
    const out: Array<{
      matchId: string;
      href: string;
      teamNames: string[];
      event: string;
      stage: string;
      isLive: boolean;
      stars: number;
    }> = [];
    const seen = new Set<string>();
    const wrappers = Array.from(document.querySelectorAll('div.match[data-livescore-match]'));
    for (const w of wrappers) {
      const matchId = w.getAttribute('data-livescore-match') ?? '';
      if (!matchId || seen.has(matchId)) continue;
      const anchor = w.querySelector('a[href*="/matches/"]');
      const href = anchor?.getAttribute('href') ?? '';
      if (!/\/matches\/\d+/.test(href)) continue;
      seen.add(matchId);

      const teamNames = Array.from(w.querySelectorAll('.match-teamname'))
        .map((e) => (e.textContent ?? '').trim())
        .filter(Boolean)
        .slice(0, 2);
      const eventEl = w.querySelector('.match-event');
      const event =
        eventEl?.getAttribute('data-event-headline')?.trim() ||
        (eventEl?.textContent ?? '').trim().slice(0, 120);
      const stage = w.querySelector('.match-stage')?.textContent?.trim().slice(0, 40) ?? '';
      const liveEl = w.querySelector('.match-meta-live');
      const isLive = /live/i.test(liveEl?.textContent ?? '');
      // O wrapper traz o número exato em data-stars (0-5). Os 5 <i> do
      // rating incluem estrelas "faded"; contar só os <i> dava 5 em jogo 1★.
      const starsAttr = w.closest('[data-stars]')?.getAttribute('data-stars') ?? '';
      const starsFromAttr = Number.parseInt(starsAttr, 10);
      let stars = Number.isFinite(starsFromAttr)
        ? Math.max(0, Math.min(5, starsFromAttr))
        : 0;
      if (!Number.isFinite(starsFromAttr)) {
        w.querySelectorAll('i.fa-star').forEach((s) => {
          const cls = s.getAttribute('class') ?? '';
          if (!/\bfa-star-o\b|\bfaded\b|\bunselected\b/.test(cls)) stars += 1;
        });
      }
      out.push({
        matchId,
        href,
        teamNames,
        event,
        stage,
        isLive,
        stars: Math.min(5, stars),
      });
    }
    return out;
  });
}

/**
 * Cards FUTUROS da página /matches (mesmo HTML do live, zero page-load
 * extra). Horário marcado em .match-time[data-unix] — fallback no wrapper
 * de horário data-zonedgrouping-entry-unix. Live é ignorado aqui.
 */
export async function extractUpcomingCards(page: Page): Promise<UpcomingCard[]> {
  return page.evaluate(() => {
    const out: Array<{
      matchId: string;
      href: string;
      teamNames: string[];
      event: string;
      stage: string;
      isLive: boolean;
      stars: number;
      startUnix: string;
    }> = [];
    const wrappers = Array.from(document.querySelectorAll('.match-wrapper[data-match-id]'));
    for (const w of wrappers) {
      const matchId = w.getAttribute('data-match-id') ?? '';
      if (!matchId) continue;
      const isLive =
        w.getAttribute('live') === 'true' || w.querySelector('[data-livescore-match]') !== null;
      if (isLive) continue;
      const anchor = w.querySelector('a[href*="/matches/"]');
      const href = anchor?.getAttribute('href') ?? '';
      if (!/\/matches\/\d+/.test(href)) continue;
      const teamNames = Array.from(w.querySelectorAll('.match-teamname'))
        .map((e) => (e.textContent ?? '').trim())
        .filter(Boolean)
        .slice(0, 2);
      // Em cards futuros o nome do evento fica no wrapper do evento.
      const eventEl = w.closest('[data-event-headline]');
      const event =
        eventEl?.getAttribute('data-event-headline')?.trim() ||
        w.querySelector('.match-event')?.getAttribute('data-event-headline')?.trim() ||
        (w.querySelector('.match-event')?.textContent ?? '').trim().slice(0, 120) ||
        '';
      const stage = w.querySelector('.match-stage')?.textContent?.trim().slice(0, 40) ?? '';
      const starsAttr = w.getAttribute('data-stars') ?? '';
      const starsFromAttr = Number.parseInt(starsAttr, 10);
      let stars = Number.isFinite(starsFromAttr)
        ? Math.max(0, Math.min(5, starsFromAttr))
        : 0;
      if (!Number.isFinite(starsFromAttr)) {
        w.querySelectorAll('i.fa-star').forEach((s) => {
          const cls = s.getAttribute('class') ?? '';
          if (!/\bfa-star-o\b|\bfaded\b|\bunselected\b/.test(cls)) stars += 1;
        });
      }
      const startUnix =
        w.querySelector('.match-time[data-unix]')?.getAttribute('data-unix') ??
        w.closest('[data-zonedgrouping-entry-unix]')?.getAttribute('data-zonedgrouping-entry-unix') ??
        '';
      out.push({
        matchId,
        href,
        teamNames,
        event,
        stage,
        isLive: false,
        stars: Math.min(5, stars),
        startUnix,
      });
    }
    return out;
  });
}

/**
 * Busca o listing de /matches (layout HLTV 2026): partidas LIVE que passam
 * no filtro + as próximas partidas futuras que também passam no filtro.
 * Container live: div.match[data-livescore-match] (externo — o interno
 * div.match duplica, por isso o seletor mira só no que tem o atributo).
 * Live = .match-meta-live com texto "Live".
 * Cards futuros: .match-wrapper[data-match-id] com live="false"; o horário
 * marcado vem de .match-time[data-unix] (fallback: o wrapper de horário
 * data-zonedgrouping-entry-unix) — mesmo HTML, zero page-load extra.
 * Retorna null se o Cloudflare bloquear (para o ciclo pular sem desmontar
 * recorders/trackers — [] significaria "sem lives" e derrubaria tudo).
 */
export async function fetchMatchListing(
  matchesUrl: string,
  minStars: number,
  topTierOnly: boolean,
  filter: LiveMatchFilter = {},
): Promise<MatchListing | null> {
  const log = getLogger();
  const b = await getBrowser();
  // Sem userAgent fixo de propósito: o contexto stealth envia UA autêntico
  // (+ Client Hints consistentes); UA fixo desatualizado é assinatura clássica.
  const page: Page = await newTrackedPage();
  try {
    await page.goto(matchesUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitForClearance(page))) return null;
    await page.waitForTimeout(3000);

    const cards = await extractLiveCards(page);
    const upcomingCards = await extractUpcomingCards(page);

    const matches: LiveMatch[] = [];
    for (const card of cards) {
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
        b.stars - a.stars ||
        Number(Boolean(b.watchlisted)) - Number(Boolean(a.watchlisted)),
    );

    // Próximas partidas: mesmo HTML do live, sem page-load extra. A página
    // repete o mesmo card em "pinned"/listas — dedupe por matchId.
    const byId = new Map<string, UpcomingMatch>();
    for (const card of upcomingCards) {
      const startAt = parseHltvUnixMs(card.startUnix);
      if (startAt === null) continue;
      const m = cardToUpcomingMatch({ ...card, isLive: false, startAt });
      const prev = byId.get(m.matchId);
      if (!prev) {
        byId.set(m.matchId, m);
      } else if (m.startsAt < prev.startsAt) {
        byId.set(m.matchId, { ...m, event: m.event || prev.event });
      } else if (m.startsAt === prev.startsAt && !prev.event && m.event) {
        byId.set(m.matchId, { ...prev, event: m.event });
      }
    }

    const upcoming: UpcomingMatch[] = [];
    for (const m of byId.values()) {
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

    log.info(
      {
        live: cards.filter((c) => c.isLive).length,
        kept: matches.length,
        watchlisted: matches.filter((m) => m.watchlisted).length,
        upcoming: upcoming.length,
        next: upcoming[0]
          ? { matchId: upcoming[0].matchId, startsAt: new Date(upcoming[0].startsAt).toISOString() }
          : null,
        minStars,
      },
      'live matches filtradas',
    );
    return { live: matches, liveTotal: cards.filter((c) => c.isLive).length, upcoming };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Wrapper compatível: só as partidas live que passaram no filtro. */
export async function fetchLiveMatches(
  matchesUrl: string,
  minStars: number,
  topTierOnly: boolean,
  filter: LiveMatchFilter = {},
): Promise<LiveMatch[] | null> {
  const listing = await fetchMatchListing(matchesUrl, minStars, topTierOnly, filter);
  return listing?.live ?? null;
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
