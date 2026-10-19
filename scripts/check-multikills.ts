import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchStealthContext } from '../src/clipper/stealthBrowser.js';
import { waitForClearance } from '../src/monitor/hltvMonitor.js';

const require = createRequire(import.meta.url);
const { parseEvent, parseHeader } = require('@laihoe/demoparser2') as {
  parseEvent: (p: string, e: string, pe?: string[], oe?: string[]) => Record<string, unknown>[];
  parseHeader: (p: string) => Record<string, unknown>;
};

interface DemoLink {
  id: string;
  href: string;
}

interface KillGroup {
  player: string;
  team: string;
  kills: number;
  headshots: number;
  weapons: string[];
  victims: string[];
}

interface MapResult {
  map: string;
  demoFile: string;
  rounds: number;
  multiKills: Array<KillGroup & { round: number; label: string }>;
}

function parseArgs(argv: string[]): {
  matches: string[];
  minKills: number;
  linksOnly: boolean;
  keep: boolean;
  demoDir: string;
  analyzeDir: string | null;
} {
  const matches: string[] = [];
  let minKills = 4;
  let linksOnly = false;
  let keep = true;
  let demoDir = path.resolve('data/demos');
  let analyzeDir: string | null = null;
  for (const a of argv) {
    if (a === '--links-only') linksOnly = true;
    else if (a === '--clean') keep = false;
    else if (a === '--keep') keep = true;
    else if (a.startsWith('--min=')) minKills = Number(a.slice(6));
    else if (a.startsWith('--demo-dir=')) demoDir = path.resolve(a.slice(11));
    else if (a.startsWith('--analyze-dir=')) analyzeDir = path.resolve(a.slice(14));
    else if (/^\d+$/.test(a)) matches.push(`https://www.hltv.org/matches/${a}`);
    else matches.push(a);
  }
  return { matches, minKills, linksOnly, keep, demoDir, analyzeDir };
}

function matchIdOf(url: string): string {
  return url.match(/\/matches\/(\d+)/)?.[1] ?? url.replace(/\W+/g, '_');
}

async function extractDemoLinks(page: import('playwright').Page): Promise<DemoLink[]> {
  const hrefs = await page.$$eval('a[href*="/download/demo/"]', (els) =>
    els
      .map((e) => e.getAttribute('href') ?? '')
      .filter((h) => /\/download\/demo\/\d+/.test(h)),
  );
  return [...new Set(hrefs)].map((href) => ({ id: href.match(/\/download\/demo\/(\d+)/)![1], href }));
}

async function downloadDemo(
  ctx: import('playwright').BrowserContext,
  link: DemoLink,
  destDir: string,
): Promise<string> {
  const abs = `https://www.hltv.org${link.href}`;
  fs.mkdirSync(destDir, { recursive: true });
  const page = await ctx.newPage();
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 300_000 });
    await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await waitForClearance(page, 30_000);
    const download = await downloadPromise;
    const name = download.suggestedFilename() || `demo-${link.id}.rar`;
    const dest = path.join(destDir, name);
    await download.saveAs(dest);
    const { size } = fs.statSync(dest);
    console.log(`  baixado: ${name} (${(size / 1e6).toFixed(1)} MB)`);
    return dest;
  } finally {
    await page.close().catch(() => undefined);
  }
}

function extractRar(rarPath: string, outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync('tar', ['-xf', rarPath, '-C', outDir], { stdio: 'inherit' });
  return fs
    .readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith('.dem'))
    .map((f) => path.join(outDir, f));
}

function analyzeDemo(demoFile: string, minKills: number): MapResult {
  const map = String(parseHeader(demoFile).map_name ?? 'unknown');
  const matchStarts = parseEvent(demoFile, 'round_announce_match_start').map((r) => Number(r.tick));
  let realStart = matchStarts.length ? Math.max(...matchStarts) : 0;
  if (matchStarts.length === 0) {
    const freezeEnds = parseEvent(demoFile, 'round_freeze_end').map((r) => Number(r.tick));
    realStart = freezeEnds.length ? Math.min(...freezeEnds) : 0;
  }
  const allStarts = parseEvent(demoFile, 'round_start')
    .map((r) => Number(r.tick))
    .sort((a, b) => a - b);
  const boundaries = [realStart, ...allStarts.filter((t) => t > realStart)];
  const roundOf = (tick: number): number => {
    let round = 0;
    for (const b of boundaries) {
      if (b <= tick) round++;
      else break;
    }
    return round;
  };
  const deaths = parseEvent(demoFile, 'player_death', ['team_name']);
  const byRound = new Map<number, Map<string, KillGroup>>();
  for (const d of deaths) {
    const attacker = d.attacker_name as string | null;
    const victim = d.user_name as string | null;
    const tick = Number(d.tick);
    if (!attacker || attacker === victim) continue;
    if (d.attacker_team_name && d.user_team_name && d.attacker_team_name === d.user_team_name) continue;
    const round = roundOf(tick);
    if (round === 0) continue;
    const m = byRound.get(round) ?? new Map<string, KillGroup>();
    const g =
      m.get(attacker) ??
      { player: attacker, team: String(d.attacker_team_name ?? ''), kills: 0, headshots: 0, weapons: [], victims: [] };
    g.kills++;
    if (d.headshot) g.headshots++;
    const w = String(d.weapon ?? '');
    if (w && !g.weapons.includes(w)) g.weapons.push(w);
    g.victims.push(String(victim));
    m.set(attacker, g);
    byRound.set(round, m);
  }
  const multiKills: MapResult['multiKills'] = [];
  for (const [round, m] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    for (const g of m.values()) {
      if (g.kills >= minKills) {
        multiKills.push({ ...g, round, label: g.kills >= 5 ? 'ACE (5K)' : `${g.kills}K` });
      }
    }
  }
  return { map, demoFile, rounds: byRound.size, multiKills };
}

function printReport(matchId: string, results: MapResult[], minKills: number): void {
  console.log(`\n=== Match ${matchId} — multikills >= ${minKills} ===`);
  let total = 0;
  for (const r of results) {
    console.log(`  [${r.map}] rounds com kills: ${r.rounds}`);
    if (r.multiKills.length === 0) {
      console.log('    (nenhum)');
      continue;
    }
    for (const mk of r.multiKills) {
      total++;
      console.log(
        `    r${mk.round}: ${mk.label} — ${mk.player} (${mk.team}) ` +
          `[hs=${mk.headshots} armas=${mk.weapons.join('/')}] -> ${mk.victims.join(', ')}`,
      );
    }
  }
  console.log(`  TOTAL >= ${minKills}k: ${total}`);
}

async function main(): Promise<void> {
  const { matches, minKills, linksOnly, keep, demoDir, analyzeDir } = parseArgs(
    process.argv.slice(2),
  );

  if (analyzeDir) {
    const files = fs.readdirSync(analyzeDir).filter((f) => f.endsWith('.dem')).map((f) => path.join(analyzeDir, f));
    const results = files.map((f) => analyzeDemo(f, minKills));
    printReport(path.basename(analyzeDir), results, minKills);
    return;
  }

  if (matches.length === 0) {
    console.error('uso: tsx scripts/check-multikills.ts <url-ou-id> [...] [--min=4] [--links-only] [--clean]');
    process.exit(1);
  }

  const profileDir = path.resolve('data/hltv-check-profile');
  const ctx = await launchStealthContext({
    profileDir,
    headless: false,
    extraArgs: ['--start-minimized'],
    minimize: true,
    ignoreDefaultArgs: ['--disable-popup-blocking'],
  });

  try {
    for (const url of matches) {
      const matchId = matchIdOf(url);
      const outDir = path.join(demoDir, matchId);
      console.log(`\n== ${url} (match ${matchId}) ==`);
      const existing = fs.existsSync(outDir)
        ? fs.readdirSync(outDir).filter((f) => f.endsWith('.dem'))
        : [];
      if (existing.length > 0) {
        console.log(`  demos já extraídas: ${existing.length}`);
      } else {
        const page = await ctx.newPage();
        let links: DemoLink[] = [];
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await waitForClearance(page, 40_000);
          links = await extractDemoLinks(page);
          console.log(`  demos encontradas: ${links.length}`);
        } catch (e) {
          console.error(`  erro ao abrir a página: ${String(e)}`);
        } finally {
          await page.close().catch(() => undefined);
        }
        if (linksOnly) continue;
        for (const l of links) {
          const rar = await downloadDemo(ctx, l, path.join(demoDir, matchId));
          extractRar(rar, outDir);
          if (!keep) fs.rmSync(rar, { force: true });
        }
      }
      if (linksOnly) continue;
      const demos = fs.readdirSync(outDir).filter((f) => f.endsWith('.dem')).map((f) => path.join(outDir, f));
      const results = demos.map((f) => analyzeDemo(f, minKills));
      printReport(matchId, results, minKills);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
