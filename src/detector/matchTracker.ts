import type { Page } from 'playwright';
import { getBrowser } from '../monitor/hltvMonitor.js';
import { RoundTracker } from './aceDetector.js';
import { getLogger } from '../logger.js';

export interface RoundSnapshot {
  kills: Array<{ killer: string; victim: string }>;
  ctScore: number;
  tScore: number;
  map: string;
  round: number;
}

/**
 * Lê scoreboard + killfeed da página do match.
 * Usa múltiplos seletores candidatos (sem XPath absoluto).
 */
export async function readMatchSnapshot(page: Page): Promise<RoundSnapshot | null> {
  try {
    return await page.evaluate(() => {
      const text = (sel: string): string => {
        const el = document.querySelector(sel);
        return (el?.textContent ?? '').trim();
      };
      const ct =
        Number.parseInt(text('.ctScore') || text('[data-ct-score]') || '0', 10) || 0;
      const t =
        Number.parseInt(text('.tScore') || text('[data-t-score]') || '0', 10) || 0;

      const killRows = Array.from(
        document.querySelectorAll(
          '[class*="kill"], [class*="Kill"], [class*="feed"] [class*="player"], .scoreboard [class*="name"]',
        ),
      )
        .slice(0, 20)
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean);

      // Fallback genérico: procura linhas "Killer ⚔ Victim"
      const kills: Array<{ killer: string; victim: string }> = killRows
        .slice(0, 5)
        .map((line) => {
          const parts = line.split(/⚔|✖|killed|›|>/).map((s) => s.trim());
          return { killer: parts[0] ?? '', victim: parts[1] ?? '' };
        })
        .filter((k) => k.killer.length > 0);

      const map =
        document.querySelector('[class*="mapname"]')?.textContent?.trim() ??
        'map1';
      const round = ct + t + 1;
      return { kills, ctScore: ct, tScore: t, map, round };
    });
  } catch {
    return null;
  }
}

export interface TrackerCallbacks {
  onAce: (ace: {
    player: string;
    map: string;
    round: number;
    kills: Array<{ killer: string; victim: string; round: number; map: string }>;
  }) => void;
  shouldStop: () => boolean;
}

/**
 * Polling por partida. Detecta virada de round via soma dos placares
 * (CS2 MR12: termina em 13, com OT — não mais 16).
 */
export async function trackMatch(
  matchPageUrl: string,
  matchId: string,
  cb: TrackerCallbacks,
): Promise<void> {
  const log = getLogger().child({ matchId });
  const b = await getBrowser();
  const page = await b.newPage();
  const tracker = new RoundTracker();
  try {
    await page.goto(matchPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let lastTotal = -1;
    log.info('iniciando tracking do match');

    while (!cb.shouldStop()) {
      const snap = await readMatchSnapshot(page);
      if (!snap) {
        await page.waitForTimeout(5000);
        continue;
      }
      tracker.setContext(snap.map, snap.round);
      for (const k of snap.kills) tracker.addKill(k.killer, k.victim);

      const total = snap.ctScore + snap.tScore;
      // Virada de round = placar mudou (ou OT: total >= 24 continua valendo)
      if (lastTotal >= 0 && total !== lastTotal) {
        const { ace, kills } = tracker.closeRound();
        if (ace) {
          log.info({ ace, map: snap.map, round: snap.round }, 'ACE detectado');
          cb.onAce({ player: ace, map: snap.map, round: snap.round, kills });
        }
        tracker.setContext(snap.map, snap.round);
      }
      lastTotal = total;

      // Fim de mapa melhor-de: MR12 → 13 wins; OT vai além de 24 rounds
      if (snap.ctScore === 13 || snap.tScore === 13) {
        // Não para de imediato: pode ter OT ou próximo mapa — espera 60s
        await page.waitForTimeout(60000);
        const again = await readMatchSnapshot(page);
        if (!again || (again.ctScore === 13 || again.tScore === 13)) break;
      }
      await page.waitForTimeout(2000);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}
