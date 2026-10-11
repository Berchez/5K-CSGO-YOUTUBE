import { chromium, type Browser, type Page } from 'playwright';
import type { LiveMatch, StreamInfo } from '../types.js';
import { getLogger } from '../logger.js';

const OFFICIAL_HINTS = ['esl', 'blast', 'pgl', 'starladder', 'faceit', 'major', 'iem', 'eslcs'];

// Eventos que quase sempre são tier-1 (fallback quando o HLTV não expõe estrelas no listing)
const TOP_TIER_EVENTS =
  /major|blast|iem |katowice|cologne|esl pro|pgl|starladder|blast\.tv|esports world cup|epl |shanghai|austin|copenhagen/i;

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
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
  const wantsOfficial = prefs.includes('official');
  const wantsEn = prefs.includes('en');

  const scored = streams.map((s) => {
    let score = s.viewers ?? 0;
    const name = s.name.toLowerCase();
    const official =
      s.isOfficialGuess ?? OFFICIAL_HINTS.some((h) => name.includes(h));
    if (wantsOfficial && official) score += 1_000_000;
    if (wantsEn && (s.language?.toLowerCase() === 'en' || name.includes('esl')))
      score += 100_000;
    // Evita restreams BR quando o usuário pediu EN oficial
    if (wantsEn && /gaules|nak|liminha|bt0|br/i.test(s.name)) score -= 500_000;
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
 */
export async function fetchLiveMatches(
  matchesUrl: string,
  minStars: number,
  topTierOnly: boolean,
): Promise<LiveMatch[]> {
  const log = getLogger();
  const b = await getBrowser();
  const page: Page = await b.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  try {
    await page.goto(matchesUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

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
 * Layout 2026: divs .stream-box (texto "NOME + viewers", ex "FRAG10271.0k")
 * com <a> interno para twitch/kick/youtube; .stream-box-embed é só o player.
 */
export async function fetchMatchStreams(matchPageUrl: string): Promise<StreamInfo[]> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(matchPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    const raw = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('.stream-box'));
      return boxes.map((el) => {
        const anchor =
          el.querySelector('a[href]') ??
          (el.closest('a[href]') as HTMLAnchorElement | null);
        const href =
          anchor && 'href' in anchor
            ? (anchor as HTMLAnchorElement).href
            : '';
        const text = (el.textContent ?? '').trim().replace(/\s+/g, '');
        return { text, href };
      });
    });
    const out: StreamInfo[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (!r.href || seen.has(r.href)) continue;
      if (r.href.includes('hltv.org/live')) continue; // scoreboard, não vídeo
      if (!/twitch\.tv|youtube\.com|youtu\.be|kick\.com/.test(r.href)) continue;
      seen.add(r.href);
      // "FRAG10271.0k" → name=FRAG, viewers=10270 ; "ESL_CS5.2k" → 5200
      const m = r.text.match(/^(.*?)(\d+(?:\.\d+)?)k$/i);
      const name = (m ? m[1] : r.text).slice(0, 60) || 'stream';
      const viewers = m ? Math.round(Number.parseFloat(m[2]) * 1000) : undefined;
      out.push({ name, url: r.href, viewers });
    }
    return out;
  } finally {
    await page.close().catch(() => undefined);
  }
}
