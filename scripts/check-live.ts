/**
 * Utilidade dev: mostra o que está LIVE agora no HLTV e o que passaria no filtro.
 * Uso: npx tsx scripts/check-live.ts
 */
import { fetchLiveMatches, closeBrowser } from '../src/monitor/hltvMonitor.js';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const all = await fetchLiveMatches(cfg.HLTV_MATCHES_URL, 0, false);
if (!all) {
  console.log('LIVE-TOTAL=bloqueado pelo Cloudflare (tente de novo em segundos)');
} else {
  console.log(`LIVE-TOTAL=${all.length}`);
  for (const m of all) {
    console.log(
      `- [${m.matchId}] ${m.team1} vs ${m.team2} | ${m.event} | stars=${m.stars} topTier=${m.isTopTierGuess} | ${m.matchPageUrl}`,
    );
  }
}
await closeBrowser();
