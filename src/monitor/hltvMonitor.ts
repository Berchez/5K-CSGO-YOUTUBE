import { type BrowserContext, type Page } from 'playwright';
import type { LiveMatch, StreamInfo } from '../types.js';
import { getLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { trySolveChallenge } from '../clipper/stealthBrowser.js';

const OFFICIAL_HINTS = ['esl', 'blast', 'pgl', 'starladder', 'faceit', 'major', 'iem', 'eslcs'];

// Eventos que quase sempre são tier-1 (fallback quando o HLTV não expõe estrelas no listing)
const TOP_TIER_EVENTS =
  /major|blast|iem |katowice|cologne|esl pro|pgl|starladder|blast\.tv|esports world cup|epl |shanghai|austin|copenhagen/i;

let browser: BrowserContext | null = null;

export async function getBrowser(): Promise<BrowserContext> {
  if (browser) return browser;
  // HLTV barra Chromium headless comum ("Just a moment..."): usa o contexto
  // stealth (preferindo o Chrome real) com perfil persistente — o cookie
  // de clearance do Cloudflare é reaproveitado entre polls.
  const { launchStealthContext } = await import('../clipper/stealthBrowser.js');
  const cfg = getConfig();
  // Headless é barrado pelo Cloudflare ("Just a moment" eterno); headed
  // minimizado limpa em ~10s. HLTV_HEADLESS=1 volta p/ headless (debug).
  const headless = cfg.HLTV_HEADLESS === '1';
  browser = await launchStealthContext({
    profileDir: cfg.HLTV_PROFILE,
    headless,
    extraArgs: headless ? [] : ['--start-minimized'],
  });
  return browser;
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

/** Conta estrelas cheias (fa-star, excluindo fa-star-o vazias). Mantido p/ compat. */
export function parseStarsFromHtml(starHtml: string, starCount: number): number {
  if (starCount > 0) return Math.min(5, starCount);
  const m = starHtml.match(/fa-star(?!-o)/g);
  return m ? Math.min(5, m.length) : 0;
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

export function pickPreferredStream(
  streams: StreamInfo[],
  priority: string,
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
    if (wantsEn && !gaulesActive && /gaules|nak|liminha|bt0|br/i.test(s.name)) score -= 500_000;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].s;
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

/**
 * Busca partidas LIVE na página /matches (layout HLTV 2026).
 * Container: div.match[data-livescore-match] (externo — o interno div.match
 * duplica, por isso o seletor mira só no que tem o atributo).
 * Live = .match-meta-live com texto "Live".
 * Retorna null se o Cloudflare bloquear (para o ciclo pular sem desmontar
 * recorders/trackers — [] significaria "sem lives" e derrubaria tudo).
 */
export async function fetchLiveMatches(
  matchesUrl: string,
  minStars: number,
  topTierOnly: boolean,
): Promise<LiveMatch[] | null> {
  const log = getLogger();
  const b = await getBrowser();
  // Sem userAgent fixo de propósito: o contexto stealth envia UA autêntico
  // (+ Client Hints consistentes); UA fixo desatualizado é assinatura clássica.
  const page: Page = await b.newPage();
  try {
    await page.goto(matchesUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitForClearance(page))) return null;
    await page.waitForTimeout(3000);

    const cards = await page.evaluate(() => {
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
      const wrappers = Array.from(
        document.querySelectorAll('div.match[data-livescore-match]'),
      );
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
        const stage =
          w.querySelector('.match-stage')?.textContent?.trim().slice(0, 40) ?? '';
        const liveEl = w.querySelector('.match-meta-live');
        const isLive = /live/i.test(liveEl?.textContent ?? '');
        let stars = 0;
        w.querySelectorAll('i.fa-star').forEach((s) => {
          const cls = s.getAttribute('class') ?? '';
          if (!cls.includes('fa-star-o') && !cls.includes('unselected')) stars += 1;
        });
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

    const matches: LiveMatch[] = [];
    for (const card of cards) {
      if (!card.isLive) continue; // tese do projeto: só lives (velocidade)
      const m = cardToLiveMatch(card);
      if (!matchPassesFilter(m.stars, m.isTopTierGuess, minStars, topTierOnly)) {
        continue;
      }
      matches.push(m);
    }
    log.info({ live: cards.filter((c) => c.isLive).length, kept: matches.length, minStars }, 'live matches filtradas');
    return matches;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Abre a página do match e extrai streams.
 * Layout 2026: div.stream-box com .stream-box-embed (nome) +
 * .watchbox-right .viewers (número cru "9988" ou "9.9k") +
 * .external-stream a[href] (link twitch/youtube/kick).
 * NÃO usar textContent da box inteira (concatena os dois spans de
 * viewers e gera contagem absurda que quebra o scoring).
 */
export async function fetchMatchStreams(matchPageUrl: string): Promise<StreamInfo[]> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(matchPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitForClearance(page))) return [];
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
        return { name: name || 'stream', href, viewersText };
      });
    });
    const out: StreamInfo[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (!r.href || seen.has(r.href)) continue;
      if (r.href.includes('hltv.org/live')) continue; // scoreboard, não vídeo
      if (!/twitch\.tv|youtube\.com|youtu\.be|kick\.com/.test(r.href)) continue;
      seen.add(r.href);
      out.push({ name: r.name, url: r.href, viewers: parseViewers(r.viewersText) });
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
