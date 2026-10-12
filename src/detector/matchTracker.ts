import type { Page } from 'playwright';
import { getBrowser } from '../monitor/hltvMonitor.js';
import { RoundTracker, normWeapon } from './aceDetector.js';
import type { KillEvent } from '../types.js';
import { getLogger } from '../logger.js';

export interface SnapKill {
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
}

export interface RoundSnapshot {
  kills: SnapKill[];
  ctScore: number;
  tScore: number;
  map: string;
  round: number;
}

/** Nomes de armas para casamento best-effort no texto/alt do killfeed. */
const WEAPON_HINTS = [
  'ak-47', 'ak47', 'awp', 'm4a1', 'm4a4', 'desert eagle', 'deagle',
  'usp-s', 'usp', 'glock', 'famas', 'galil', 'aug', 'sg 553', 'ssg 08',
  'mac-10', 'mp9', 'mp7', 'ump-45', 'p90', 'nova', 'xm1014', 'mag-7',
  'sawed-off', 'negev', 'm249', 'tec-9', 'cz75', 'five-seven', 'p250',
  'dual berettas', 'r8 revolver', 'he grenade', 'molotov', 'incendiary',
  'flashbang', 'smoke', 'knife', 'zeus', 'g3sg1', 'scar-20',
];

/**
 * Lê scoreboard + killfeed da página do match.
 * Extração best-effort: killer/vítima quase sempre; arma/HS quando o DOM
 * expõe (alt de ícone ou texto). Assists e granadas lançadas (sem kill)
 * NÃO vêm no killfeed live — fidelidade total exige demo (fase 2).
 */
export async function readMatchSnapshot(page: Page): Promise<RoundSnapshot | null> {
  try {
    return await page.evaluate((weaponHints: string[]) => {
      const text = (sel: string): string => {
        const el = document.querySelector(sel);
        return (el?.textContent ?? '').trim();
      };
      const ct =
        Number.parseInt(text('.ctScore') || text('[data-ct-score]') || '0', 10) || 0;
      const t =
        Number.parseInt(text('.tScore') || text('[data-t-score]') || '0', 10) || 0;

      const rows = Array.from(
        document.querySelectorAll(
          '[class*="kill"], [class*="Kill"], [class*="feed"] [class*="player"], .scoreboard [class*="name"]',
        ),
      ).slice(0, 20);

      const norm = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9]/g, '');

      const kills = rows.slice(0, 5).flatMap((el) => {
        const line = (el.textContent ?? '').trim();
        if (!line) return [];
        const parts = line.split(/⚔|✖|killed|›|>/).map((s) => s.trim());
        const killer = parts[0] ?? '';
        if (!killer) return [];
        const victim = parts[1] ?? '';
        // Arma: 1) alt/title de ícone, 2) nome no texto da linha
        let weapon = '';
        el.querySelectorAll('img').forEach((img) => {
          const alt = `${img.getAttribute('alt') ?? ''} ${img.getAttribute('title') ?? ''}`;
          const hit = weaponHints.find((w) => alt.toLowerCase().includes(w));
          if (hit && !weapon) weapon = hit;
        });
        if (!weapon) {
          const low = line.toLowerCase();
          const hit = weaponHints.find((w) => low.includes(w));
          if (hit) weapon = hit;
        }
        // Headshot: ícone/classe indicativa
        const html = el.innerHTML.toLowerCase();
        const headshot =
          /headshot/.test(html) ||
          [...el.querySelectorAll('img')].some((img) =>
            /headshot|hs\b/.test(
              `${img.getAttribute('alt') ?? ''} ${img.getAttribute('title') ?? ''} ${img.getAttribute('class') ?? ''}`.toLowerCase(),
            ),
          );
        return [{ killer, victim, weapon, headshot }];
      });

      const map =
        document.querySelector('[class*="mapname"]')?.textContent?.trim() ??
        'map1';
      const round = ct + t + 1;
      return { kills, ctScore: ct, tScore: t, map, round };
    }, WEAPON_HINTS);
  } catch {
    return null;
  }
}

export interface TrackerCallbacks {
  onAce: (ace: {
    player: string;
    map: string;
    round: number;
    kills: KillEvent[];
    /** ISO do 1º kill — ancora o início do clipe. */
    startedAt?: string;
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
      for (const k of snap.kills) {
        tracker.addKill(k.killer, k.victim, {
          weapon: normWeapon(k.weapon) || undefined,
          headshot: k.headshot || undefined,
        });
      }

      const total = snap.ctScore + snap.tScore;
      // Virada de round = placar mudou (ou OT: total >= 24 continua valendo)
      if (lastTotal >= 0 && total !== lastTotal) {
        const { ace, kills } = tracker.closeRound();
        if (ace) {
          log.info({ ace, map: snap.map, round: snap.round }, 'ACE detectado');
          const firstAt = kills[0]?.at;
          cb.onAce({
            player: ace,
            map: snap.map,
            round: snap.round,
            kills,
            startedAt: firstAt ? new Date(firstAt).toISOString() : undefined,
          });
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
