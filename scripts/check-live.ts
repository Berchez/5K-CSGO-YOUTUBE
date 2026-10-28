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
import { computePollDecision, POLL_START_GRACE_MS } from '../src/monitor/pollSchedule.js';
import { getConfig } from '../src/config.js';
import { loadWatchlistFile } from '../src/watchlist.js';
import { repoPath } from '../src/paths.js';

const cfg = getConfig();
const watchlist = loadWatchlistFile(repoPath('data', 'watchlist.json'));
const result = await fetchMatchListing(
  cfg.HLTV_MATCHES_URL,
  cfg.MIN_STARS,
  cfg.TOP_TIER_ONLY,
  {
    watchlist: watchlist.doc,
    starredMinKills: cfg.MIN_KILLS,
    unstarredMinKills: cfg.MIN_KILLS_NO_STARS,
  },
);
if (!result.ok) {
  console.log(
    result.reason === 'blocked'
      ? 'LIVE-TOTAL=bloqueado pelo Cloudflare (tente de novo em segundos)'
      : `LIVE-TOTAL=falha ao extrair o listing (${result.detail ?? 'sem detalhe'})`,
  );
} else {
  const listing = result.listing;
  console.log(`LIVE-TOTAL=${listing.liveTotal}`);
  console.log(`LIVE-KEPT=${listing.live.length}`);
  for (const m of listing.live) {
    console.log(
      `- [${m.matchId}] ${m.team1} vs ${m.team2} | ${m.event} | stars=${m.stars} topTier=${m.isTopTierGuess} | ${m.matchPageUrl}`,
    );
  }
  console.log(
    `FUTURAS-VISTAS=${listing.upcomingSeen} FUTURAS-COM-HORARIO=${listing.upcomingTotal} ELIGIVEIS-FUTURAS=${listing.upcoming.length}`,
  );
  console.log(
    `AGENDA-CONFIAVEL=${listing.scheduleReliable}${listing.scheduleReliable ? '' : ' (extração quebrada: poll fica no intervalo base)'}`,
  );
  const next = selectNextUpcoming(listing.upcoming, Date.now(), POLL_START_GRACE_MS);
  const now = Date.now();
  const decision = computePollDecision({
    now,
    nextMatchAt: next?.startsAt ?? null,
    baseIntervalMs: cfg.POLL_INTERVAL_MS,
    forceReasons: listing.live.length > 0 ? ['live'] : [],
    scheduleReliable: listing.scheduleReliable,
    adaptive: cfg.POLL_ADAPTIVE,
  });
  if (next) {
    console.log(
      `NEXT=[${next.matchId}] ${next.team1} vs ${next.team2} | ${new Date(next.startsAt).toISOString()} | watchlisted=${Boolean(next.watchlisted)}`,
    );
  } else {
    console.log('NEXT=nenhuma partida elegível no listing');
  }
  console.log(
    `NEXT-POLL=em ${Math.round(decision.delayMs / 60_000)}min (${new Date(now + decision.delayMs).toISOString()}) motivo=${decision.reason}`,
  );
}
await closeBrowser();
