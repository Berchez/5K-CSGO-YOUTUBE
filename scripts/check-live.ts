/**
 * Utilidade dev: mostra o que está LIVE agora no HLTV, o que passa no
 * filtro do bot e qual seria o próximo poll (poll adaptativo).
 * Uso: npx tsx scripts/check-live.ts
 */
import {
  closeBrowser,
  fetchMatchListing,
  selectNextUpcoming,
} from '../src/monitor/hltvMonitor.js';
import { nextPollDelayMs, POLL_START_GRACE_MS } from '../src/monitor/pollSchedule.js';
import { getConfig } from '../src/config.js';
import { loadWatchlistFile } from '../src/watchlist.js';
import { repoPath } from '../src/paths.js';

const cfg = getConfig();
const watchlist = loadWatchlistFile(repoPath('data', 'watchlist.json'));
const listing = await fetchMatchListing(
  cfg.HLTV_MATCHES_URL,
  cfg.MIN_STARS,
  cfg.TOP_TIER_ONLY,
  {
    watchlist: watchlist.doc,
    starredMinKills: cfg.MIN_KILLS,
    unstarredMinKills: cfg.MIN_KILLS_NO_STARS,
  },
);
if (!listing) {
  console.log('LIVE-TOTAL=bloqueado pelo Cloudflare (tente de novo em segundos)');
} else {
  console.log(`LIVE-TOTAL=${listing.liveTotal}`);
  console.log(`LIVE-KEPT=${listing.live.length}`);
  for (const m of listing.live) {
    console.log(
      `- [${m.matchId}] ${m.team1} vs ${m.team2} | ${m.event} | stars=${m.stars} topTier=${m.isTopTierGuess} | ${m.matchPageUrl}`,
    );
  }
  console.log(`ELIGIVEIS-FUTURAS=${listing.upcoming.length}`);
  const next = selectNextUpcoming(listing.upcoming, Date.now(), POLL_START_GRACE_MS);
  if (next) {
    const now = Date.now();
    const delay = nextPollDelayMs({
      now,
      nextMatchAt: next.startsAt,
      baseIntervalMs: cfg.POLL_INTERVAL_MS,
      forceBase: listing.live.length > 0,
    });
    console.log(
      `NEXT=[${next.matchId}] ${next.team1} vs ${next.team2} | ${new Date(next.startsAt).toISOString()} | watchlisted=${Boolean(next.watchlisted)}`,
    );
    console.log(
      `NEXT-POLL=em ${Math.round(delay / 60_000)}min (${new Date(now + delay).toISOString()})`,
    );
  } else {
    console.log('NEXT=nenhuma partida elegível no listing');
  }
}
await closeBrowser();
