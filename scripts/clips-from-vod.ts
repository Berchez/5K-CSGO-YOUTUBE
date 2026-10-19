/**
 * Gera clipes (multikills) de uma partida JÁ ACABADA a partir dos VODs do HLTV.
 *
 * - Extrai os links de VOD por mapa da página da partida (stream-box).
 * - Lê as demos locais (.dem) para achar os rounds com >= N kills e os ticks.
 * - Converte tick -> segundo do VOD (tickrate 64) usando o início real do mapa.
 * - Baixa só o trecho (yt-dlp), aplica upscale e grava sidecar JSON.
 *
 * NÃO faz upload (o bot já roda com YT_UPLOAD=false; aqui nem importa o uploader).
 *
 * Uso:
 *   npx tsx scripts/clips-from-vod.ts --match=<url|id> --demo-dir=data/demos/2399417 [--min=4]
 *     [--out=data/clips] [--upscale=1440] [--ctx=10] [--post=15] [--no-upscale]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { BrowserContext } from 'playwright';
import { launchStealthContext } from '../src/clipper/stealthBrowser.js';
import { waitForClearance } from '../src/monitor/hltvMonitor.js';
import { upscaleClip, buildSidecar } from '../src/clipper/clipBuilder.js';
import { buildRoundSummary } from '../src/detector/aceDetector.js';
import type { AceEvent, KillEvent } from '../src/types.js';

const require = createRequire(import.meta.url);
const { parseEvent, parseHeader } = require('@laihoe/demoparser2') as {
  parseEvent: (p: string, e: string, pe?: string[], oe?: string[]) => Record<string, unknown>[];
  parseHeader: (p: string) => Record<string, unknown>;
};

const execFileAsync = promisify(execFile);
const ROOT = path.resolve('.');
const YTDLP = path.join(ROOT, '.tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const TICKRATE = 64;

const MAP_NAMES: Record<string, string> = {
  'dust 2': 'de_dust2',
  dust2: 'de_dust2',
  ancient: 'de_ancient',
  nuke: 'de_nuke',
  mirage: 'de_mirage',
  cache: 'de_cache',
  inferno: 'de_inferno',
  anubis: 'de_anubis',
  overpass: 'de_overpass',
  train: 'de_train',
  vertigo: 'de_vertigo',
};
const DISPLAY: Record<string, string> = {
  de_dust2: 'Dust2',
  de_ancient: 'Ancient',
  de_nuke: 'Nuke',
  de_mirage: 'Mirage',
  de_cache: 'Cache',
  de_inferno: 'Inferno',
  de_anubis: 'Anubis',
  de_overpass: 'Overpass',
  de_train: 'Train',
  de_vertigo: 'Vertigo',
};
const ROSTERS: Record<string, string[]> = {
  FURIA: ['KSCERATO', 'FalleN', 'YEKINDAR', 'yuurih', 'molodoy'],
  BETBOOM: ['Magnojez', 'zorte', 'S1ren', 'd1Ledez', 'Boombl4'],
};

function arg(name: string, def?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '');
}

interface VodEntry {
  map: string;
  display: string;
  vodUrl: string;
  startSec: number;
}

async function extractVods(ctx: BrowserContext, matchUrl: string): Promise<VodEntry[]> {
  const page = await ctx.newPage();
  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForClearance(page, 40_000);
    await page.waitForTimeout(2000);
    const raw = await page.$$eval('.stream-box', (els) =>
      els
        .map((e) => ({
          text: (e.textContent || '').replace(/\s+/g, ' ').trim(),
          embed: e.getAttribute('data-stream-embed') || '',
        }))
        .filter((x) => x.embed && /Map \d/i.test(x.text)),
    );
    const out: VodEntry[] = [];
    for (const r of raw) {
      const label = r.text.match(/Map\s+(\d+)\s*-\s*([^)]+)/i);
      if (!label) continue;
      const mapName = label[2].trim().toLowerCase();
      const map = MAP_NAMES[mapName];
      if (!map) continue;
      const video = r.embed.match(/video=v(\d+)/i)?.[1];
      const t = r.embed.match(/[?&]t=([0-9hms]+)/i)?.[1];
      if (!video || !t) continue;
      const sec =
        (Number(t.match(/(\d+)h/)?.[1] ?? 0) * 3600) +
        (Number(t.match(/(\d+)m/)?.[1] ?? 0) * 60) +
        Number(t.match(/(\d+)s/)?.[1] ?? 0);
      out.push({ map, display: DISPLAY[map] ?? label[2].trim(), vodUrl: `https://www.twitch.tv/videos/${video}`, startSec: sec });
    }
    const seen = new Set<string>();
    return out.filter((v) => (seen.has(v.map) ? false : (seen.add(v.map), true)));
  } finally {
    await page.close().catch(() => undefined);
  }
}

interface RoundStart {
  tick: number;
  round: number;
}

interface Boundaries {
  realStart: number;
  starts: RoundStart[];
  useField: boolean;
}

/** Início real do mapa + round_starts. O campo `round` do demo bate com o
 * overlay da transmissão quando é monotônico (ex.: dust2 com restart), mas em
 * alguns demos vem todo zerado/1 (ex.: cache) — nesses casos usa o índice. */
function buildBoundaries(file: string): Boundaries {
  const ms = parseEvent(file, 'round_announce_match_start').map((r) => Number(r.tick));
  let realStart = ms.length ? Math.max(...ms) : 0;
  if (ms.length === 0) {
    const fe = parseEvent(file, 'round_freeze_end').map((r) => Number(r.tick));
    realStart = fe.length ? Math.min(...fe) : 0;
  }
  const starts = parseEvent(file, 'round_start')
    .map((r) => ({ tick: Number(r.tick), round: Number(r.round) }))
    .filter((s) => Number.isFinite(s.round) && s.round > 0)
    .sort((a, b) => a.tick - b.tick);
  let useField = starts.length > 0 && starts[starts.length - 1].round > 1;
  if (useField) {
    for (let i = 1; i < starts.length; i++) {
      if (starts[i].round < starts[i - 1].round) {
        useField = false;
        break;
      }
    }
  }
  return { realStart, starts, useField };
}

function roundOf(b: Boundaries, tick: number): number {
  if (tick < b.realStart) return 0;
  if (b.useField) {
    let round = 0;
    for (const s of b.starts) {
      if (s.tick <= tick) round = s.round;
      else break;
    }
    return round;
  }
  if (tick < b.realStart) return 0;
  let round = 1;
  for (const s of b.starts) {
    if (s.tick > b.realStart && s.tick <= tick) round++;
  }
  return round;
}

interface MultiKill {
  map: string;
  round: number;
  player: string;
  team: string;
  firstTick: number;
  lastTick: number;
  kills: KillEvent[];
}

function findMultiKills(file: string, minKills: number): MultiKill[] {
  const map = String(parseHeader(file).map_name ?? 'unknown');
  const b = buildBoundaries(file);
  const deaths = parseEvent(file, 'player_death', ['team_name']);

  const groups = new Map<string, MultiKill>();
  for (const d of deaths) {
    const attacker = d.attacker_name as string | null;
    const victim = d.user_name as string | null;
    const tick = Number(d.tick);
    if (!attacker || attacker === victim) continue;
    if (d.attacker_team_name && d.user_team_name && d.attacker_team_name === d.user_team_name) continue;
    const round = roundOf(b, tick);
    if (!round) continue;
    const key = `${round}|${attacker}`;
    const g =
      groups.get(key) ??
      {
        map,
        round,
        player: attacker,
        team: '',
        firstTick: tick,
        lastTick: tick,
        kills: [],
      };
    g.lastTick = tick;
    g.kills.push({
      killer: attacker,
      victim: String(victim),
      round,
      map,
      weapon: String(d.weapon ?? ''),
      headshot: Boolean(d.headshot),
      assistBy: (d.assister_name as string | null) || undefined,
    });
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.kills.length >= minKills).sort((a, b) => a.firstTick - b.firstTick);
}

function teamOf(player: string, teams: string[]): { team: string; opponent: string } {
  for (const t of Object.keys(ROSTERS)) {
    if (ROSTERS[t].includes(player)) {
      const other = Object.keys(ROSTERS).find((x) => x !== t);
      return { team: t, opponent: other ? teams.includes(other) ? other : '' : '' };
    }
  }
  return { team: '', opponent: '' };
}

async function main(): Promise<void> {
  const matchArg = arg('match');
  const demoDir = arg('demo-dir');
  if (!matchArg || !demoDir) {
    console.error('uso: tsx scripts/clips-from-vod.ts --match=<url|id> --demo-dir=<dir> [--min=4] [--out=data/clips] [--upscale=1440] [--ctx=10] [--post=15] [--no-upscale]');
    process.exit(2);
  }
  const matchUrl = /^\d+$/.test(matchArg) ? `https://www.hltv.org/matches/${matchArg}` : matchArg;
  const matchId = matchArg.match(/\/matches\/(\d+)/)?.[1] ?? matchArg.replace(/\W+/g, '_');
  const minKills = Number(arg('min', '4'));
  const outDir = path.resolve(arg('out', 'data/clips')!);
  const upscale = flag('no-upscale') ? 0 : Number(arg('upscale', '1440'));
  const ctxSec = Number(arg('ctx', '10'));
  const postSec = Number(arg('post', '15'));
  const teams = [arg('team1', 'FURIA')!, arg('team2', 'BETBOOM')!];
  const event = arg('event', 'Thunderpick World Championship 2026')!;
  const only = arg('only')?.toLowerCase();

  process.env.PATH = `${path.join(ROOT, '.tools')}${path.delimiter}${process.env.PATH ?? ''}`;
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const demos = fs
    .readdirSync(demoDir)
    .filter((f) => f.endsWith('.dem'))
    .sort()
    .map((f) => path.join(demoDir, f));

  console.log(`match ${matchId}: ${demos.length} demo(s), >= ${minKills} kills`);
  const browser = await launchStealthContext({
    profileDir: path.resolve('data/hltv-check-profile'),
    headless: false,
    extraArgs: ['--start-minimized'],
    minimize: true,
  });
  let vods: VodEntry[] = [];
  try {
    vods = await extractVods(browser, matchUrl);
  } finally {
    await browser.close().catch(() => undefined);
  }
  console.log('VODs:', vods.map((v) => `${v.map}@${fmt(v.startSec)}`).join(', '));

  let made = 0;
  let skipped = 0;
  for (const demo of demos) {
    const map = String(parseHeader(demo).map_name ?? 'unknown');
    if (only && map !== only && !(DISPLAY[map] ?? '').toLowerCase().includes(only)) continue;
    const vod = vods.find((v) => v.map === map);
    if (!vod) {
      console.warn(`  [${map}] sem VOD — pulando ${path.basename(demo)}`);
      continue;
    }
    const mks = findMultiKills(demo, minKills);
    console.log(`  [${map}] ${mks.length} multikill(s) >= ${minKills}`);
    for (const mk of mks) {
      const { team, opponent } = teamOf(mk.player, teams);
      const name = `${matchId}_${DISPLAY[map] ?? map}_r${mk.round}_${slug(mk.player)}`;
      const finalPath = path.join(outDir, `${name}.mp4`);
      if (fs.existsSync(finalPath)) {
        console.log(`    ${name}: já existe, pulando`);
        skipped++;
        continue;
      }
      const { realStart } = buildBoundaries(demo);
      const startSec = Math.max(1, vod.startSec + (mk.firstTick - realStart) / TICKRATE - ctxSec);
      const endSec = vod.startSec + (mk.lastTick - realStart) / TICKRATE + postSec;
      const tmpPath = path.join(tmpDir, `${name}.mp4`);
      console.log(`    ${name}: baixando ${fmt(startSec)} → ${fmt(endSec)}`);
      await execFileAsync(
        YTDLP,
        [
          '--no-playlist',
          '--ffmpeg-location',
          path.join(ROOT, '.tools'),
          '--download-sections',
          `*${fmt(startSec)}-${fmt(endSec)}`,
          '-f',
          'bv*[height<=1080]+ba/b[height<=1080]',
          '--merge-output-format',
          'mp4',
          '-o',
          tmpPath,
          vod.vodUrl,
        ],
        { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      );
      if (upscale > 0) {
        console.log(`      upscale ${upscale}p...`);
        await upscaleClip(tmpPath, upscale);
      }
      fs.renameSync(tmpPath, finalPath);
      const ace: AceEvent = {
        matchId,
        map,
        round: mk.round,
        player: mk.player,
        team1: teams[0],
        team2: teams[1],
        event,
        detectedAt: new Date().toISOString(),
        kills: mk.kills,
        summary: buildRoundSummary(mk.player, team, opponent || teams.filter((t) => t !== team).join(' / '), mk.kills),
      };
      fs.writeFileSync(
        path.join(outDir, `${name}.json`),
        JSON.stringify(buildSidecar(ace, { clipFile: path.basename(finalPath), vodUrl: vod.vodUrl, vodAt: fmt(startSec) }), null, 2),
      );
      const mb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(1);
      console.log(`      OK: ${path.basename(finalPath)} (${mb} MB)`);
      made++;
    }
  }
  console.log(`\nclipes gerados: ${made} | pulados: ${skipped}`);
}

main().catch((e) => {
  console.error('FALHOU: ' + (e as Error).message);
  process.exit(1);
});
