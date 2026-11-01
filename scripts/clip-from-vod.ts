/**
 * Gera clipes (mp4 + json + jpeg) de jogadas de um jogador a partir do VOD
 * do YouTube da live do gaules (transmissão ao vivo gravada).
 *
 * O VOD é "live from start" (DASH por fragmentos): baixamos só os fragmentos
 * (`&sq=N`, 5s cada) que cobrem a janela de cada jogada, com PTS absolutos —
 * dá para cortar com precisão sem baixar as ~19 GB do 1080p completo.
 *
 * O instante das kills no vídeo vem de OCR do killfeed (mesma técnica do bot);
 * o fim vem da virada do placar (decisão do usuário: clipe até a virada).
 *
 * Uso:
 *   npx tsx scripts/clip-from-vod.ts --player YEKINDAR --maps "mirage:17,nuke:5"
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseEvent, parseHeader } = require('@laihoe/demoparser2') as {
  parseEvent: (p: string, e: string, pe?: string[]) => Record<string, unknown>[];
  parseHeader: (p: string) => Record<string, unknown>;
};
const sharp = (await import('sharp')).default;
const { createWorker, PSM } = await import('tesseract.js');

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TMP = String(process.env.TEMP ?? '.');
const PROBE = path.join(TMP, 'vodprobe');
const FFMPEG = path.resolve('.tools/ffmpeg.exe');
const DEMO_DIR = path.resolve('data/demos/2399759');
const OUT_DIR = path.resolve('data/clips-vod/2399759');
const YT_URL = 'https://www.youtube.com/watch?v=E4_UQcOVpKc';
const YT_ID = 'E4_UQcOVpKc';
/** release_timestamp do VOD (início da live) = t 0 do vídeo. */
const VOD_START_MS = 1793432814_000;
const FRAG_SEC = 5;
const META_JSON = path.join(TMP, 'vod-yt.json');

let meta = JSON.parse(fs.readFileSync(META_JSON, 'utf8').replace(/^\uFEFF/, ''));
const baseUrl = (fid: string): string => {
  const f = (meta.formats as Array<{ format_id: string; url: string }>).find((x) => x.format_id === fid);
  if (!f?.url) throw new Error(`itag ${fid} indisponível na metadata`);
  return f.url;
};

type VodFormat = { format_id: string; height: number | null; fps: number | null; vcodec: string | null; acodec?: string | null; protocol?: string };
/** Só formatos DASH (`&sq=N` por fragmento); HLS (m3u8_native) não serve. */
const isDash = (f: VodFormat): boolean => f.protocol == null || f.protocol === 'https' || f.protocol === 'http_dash_segments';
const pickItag = (m: typeof meta, pred: (f: VodFormat) => boolean): string | null => {
  const pool = (m.formats as VodFormat[]).filter((f) => isDash(f) && f.vcodec && f.vcodec !== 'none' && f.height != null);
  const cands = pool.filter(pred).sort((a, b) => (a.height ?? 0) - (b.height ?? 0) || (a.fps ?? 0) - (b.fps ?? 0));
  return cands[cands.length - 1]?.format_id ?? null;
};
const pickProbeItag = (m: typeof meta): string => {
  const vids = (m.formats as VodFormat[]).filter(
    (f) => f.vcodec && f.vcodec !== 'none' && f.height != null && String(f.vcodec).startsWith('avc1'),
  );
  // 720p é o ponto ideal para o OCR do killfeed (360p não dá detalhe);
  // aceita 480p/360p se não houver, e sobe para 1080p se for o único.
  const c = vids
    .filter((f) => (f.height ?? 0) <= 720 && (f.height ?? 0) >= 360)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0));
  return (c[0] ?? vids.sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]).format_id;
};
const pickAudioItag = (m: typeof meta): string => {
  const ids = (m.formats as VodFormat[])
    .filter((f) => isDash(f) && f.acodec && f.acodec !== 'none')
    .map((f) => f.format_id);
  return ids.includes('140') ? '140' : ids[0];
};
const finalItag = (): string => pickItag(meta, (f) => f.height === 1080 && (f.fps ?? 0) >= 50) ?? pickItag(meta, (f) => (f.height ?? 0) >= 720) ?? '299';
let probeItag = pickProbeItag(meta);
/** Crop relativo do killfeed e do placar para a live do gaules (medidos). */
const KILLFEED_CROP = '0.70:0.05:0.30:0.25';
const SCOREBOARD_CROP = '0.30:0.03:0.40:0.10';
/** Margens do clipe (mesmas decisões do bot). */
const KILLFEED_APPEAR_DELAY_MS = 1_000;
const START_CONTEXT_SEC = 10;
const START_MARGIN_SEC = 5;
const END_AFTER_CLOSE_SEC = 8;

// ---------------------------------------------------------------------------
// Fragmentos DASH
// ---------------------------------------------------------------------------
/** As URLs do googlevideo expiram (~6h): renova a metadata quando um
 * download falha (HTTP 403) e tenta de novo. */
let refreshed = false;
async function refreshMeta(force = false): Promise<void> {
  if (refreshed && !force) return;
  refreshed = true;
  console.log('  (renovando metadata do VOD...)');
  const { stdout } = await execFileAsync(
    path.resolve('.tools/yt-dlp.exe'),
    ['--no-warnings', '-J', YT_URL],
    { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
  );
  meta = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  // o YouTube pode servir outro conjunto de itags — troca a prova se sumiu
  if (!(meta.formats as Array<{ format_id: string }>).some((f) => f.format_id === probeItag)) {
    probeItag = pickProbeItag(meta);
    console.log(`  (itag de prova agora é ${probeItag})`);
  }
}

/** Formato "live from start" (DASH por fragmentos) ou VOD normal (byte-range)? */
const isFragUrl = (url: string): boolean => /yt_live_broadcast|[?&]live=1/.test(url);

type Source = { kind: 'file'; path: string } | { kind: 'url'; url: string };

/** Resolve a fonte de vídeo/áudio: VOD normal → URL direta (o ffmpeg baixa
 * só a janela com range requests); live-fragmentado → cat de fragmentos. */
async function resolveSource(kind: 'probe' | 'final' | 'audio', fromSec: number, toSec: number): Promise<Source> {
  const fidOf = (): string =>
    kind === 'probe' ? probeItag : kind === 'final' ? finalItag() : pickAudioItag(meta);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fid = fidOf();
    const f = (meta.formats as Array<{ format_id: string; url?: string }>).find((x) => x.format_id === fid);
    if (!f?.url) {
      lastError = new Error(`itag ${fid} indisponível na metadata`);
      await refreshMeta();
      continue;
    }
    if (!isFragUrl(f.url)) return { kind: 'url', url: f.url };
    try {
      return { kind: 'file', path: await buildCatOnce(fid, fromSec, toSec) };
    } catch (e) {
      lastError = e;
      await refreshMeta();
    }
  }
  throw lastError ?? new Error('não consegui resolver a fonte');
}

async function buildCatOnce(fid: string, fromSec: number, toSec: number): Promise<string> {
  fs.mkdirSync(PROBE, { recursive: true });
  const sq0 = Math.max(0, Math.floor(fromSec / FRAG_SEC) - 2);
  const sq1 = Math.ceil(toSec / FRAG_SEC) + 2;
  const parts: string[] = [];
  const init = path.join(PROBE, `init_${fid}`);
  if (!fs.existsSync(init)) {
    await execFileAsync('curl.exe', ['-s', '-o', init, '--fail', `${baseUrl(fid)}&sq=0`], { timeout: 180_000 });
  }
  parts.push(init);
  for (let sq = sq0; sq <= sq1; sq++) {
    const p = path.join(PROBE, `frag_${fid}_${sq}`);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
      await execFileAsync('curl.exe', ['-s', '-o', p, '--fail', `${baseUrl(fid)}&sq=${sq}`], { timeout: 180_000 });
    }
    parts.push(p);
  }
  const cat = path.join(PROBE, `cat_${fid}_${sq0}_${sq1}.mp4`);
  const fh = fs.openSync(cat, 'w');
  for (const p of parts) fs.writeSync(fh, fs.readFileSync(p));
  fs.closeSync(fh);
  return cat;
}

/** Concatena init + fragmentos cobrindo [fromSec, toSec]; PTS absolutos.
 * Renova a metadata se as URLs expirarem; se o YouTube servir outro
 * conjunto de itags, remonta tudo com o novo (o cache antigo fica de lado —
 * misturar itags num mesmo cat corrompe o fluxo). */
export async function buildCat(
  kind: 'probe' | 'final' | 'audio',
  fromSec: number,
  toSec: number,
): Promise<string> {
  const fidOf = (): string =>
    kind === 'probe' ? probeItag : kind === 'final' ? finalItag() : pickAudioItag(meta);
  for (let attempt = 0; attempt < 2; attempt++) {
    const fid = fidOf();
    try {
      return await buildCatOnce(fid, fromSec, toSec);
    } catch (e) {
      await refreshMeta();
      if (fidOf() === fid || attempt === 1) throw e;
      console.log(`  (remontando o ${kind} com o itag ${fidOf()})`);
    }
  }
  throw new Error('não consegui montar o cat');
}

async function framesPipe(
  cat: string,
  fromSec: number,
  toSec: number,
  vf: string,
  fps = 1,
): Promise<Buffer[]> {
  const { stdout } = await execFileAsync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(fromSec), '-t', String(toSec - fromSec), '-i', cat, '-vf', `fps=${fps},${vf}`, '-f', 'image2pipe', '-vcodec', 'png', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
  );
  const END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const frames: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const idx = stdout.indexOf(END, pos);
    if (idx < 0) break;
    frames.push(stdout.subarray(pos, idx + END.length));
    pos = idx + END.length;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------
const norm = (s: string) => s.toLowerCase().replace(/0/g, 'o').replace(/[1ijl|]/g, 'l');

/** includes com tolerância de 1 caractere (OCR lê YEKINDAR como YEXINDAR etc.). */
function fuzzyIncludes(flat: string, target: string): boolean {
  return fuzzyIndexOf(flat, target, 1) >= 0;
}

/** Levenshtein com corte antecipado (nomes curtos). */
function editDistance(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let best = i;
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > maxDist) return maxDist + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Índice da 1ª ocorrência de `target` em `flat` com distância ≤ maxDist. */
function fuzzyIndexOf(flat: string, target: string, maxDist: number): number {
  if (!target) return -1;
  if (flat.includes(target)) return flat.indexOf(target);
  for (let i = 0; i <= Math.max(0, flat.length - target.length) + maxDist; i++) {
    const w = flat.slice(i, i + target.length);
    if (w.length && editDistance(w, target, maxDist) <= maxDist) return i;
  }
  return -1;
}

async function ocrFrames(
  frames: Buffer[],
  width: number,
  psm: string,
  whitelist?: string,
): Promise<string[]> {
  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: PSM[psm as keyof typeof PSM] as never,
    ...(whitelist ? { tessedit_char_whitelist: whitelist } : {}),
  });
  const texts: string[] = [];
  for (const f of frames) {
    const img = await sharp(f).resize({ width }).grayscale().normalize().withMetadata({ density: 300 }).png().toBuffer();
    const { data } = await worker.recognize(img);
    texts.push(String(data.text ?? ''));
  }
  await worker.terminate();
  return texts;
}

export interface VodKill {
  /** t no VOD (s) do frame cujo killfeed cita o jogador. */
  appearSec: number;
  text: string;
}

/** Varre o killfeed procurando FRAMES cujo texto cita `name` (texto inteiro —
 * linhas do killfeed costumam sair mescladas no OCR). */
export async function scanKillfeed(fromSec: number, toSec: number, name: string): Promise<VodKill[]> {
  const src = await resolveSource('probe', fromSec, toSec);
  const cat = src.kind === 'file' ? src.path : src.url;
  const [x, y, w, h] = KILLFEED_CROP.split(':').map(Number);
  const frames = await framesPipe(cat, fromSec, toSec, `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`);
  const texts = await ocrFrames(frames, 1600, 'SINGLE_BLOCK');
  const target = norm(name);
  const hits: VodKill[] = [];
  texts.forEach((text, i) => {
    const flat = norm(text.replace(/[^a-z0-9]/gi, ''));
    if (fuzzyIncludes(flat, target)) {
      const line = text.split('\n').filter((l) => l.trim()).join(' ⏎ ');
      hits.push({ appearSec: fromSec + i + 0.5, text: line });
    }
  });
  return hits;
}

export interface ScoreSample {
  sec: number;
  left: number | null;
  right: number | null;
  raw: string;
}

/**
 * Varre o PLACAR (HUD do gaules: `Nemiga 10 | 0:15 | 5 FURIA`) lendo só as
 * duas caixas de score — posições fixas medidas no frame (frações da barra):
 * esquerda 0.33–0.43, direita 0.55–0.66 da largura do crop.
 */
export async function scanScoreboard(fromSec: number, toSec: number): Promise<ScoreSample[]> {
  const src = await resolveSource('probe', fromSec, toSec);
  const cat = src.kind === 'file' ? src.path : src.url;
  const [x, y, w, h] = SCOREBOARD_CROP.split(':').map(Number);
  const readSide = async (frac0: number, frac1: number): Promise<Buffer[]> => {
    const cx = x + w * frac0;
    const cw = w * (frac1 - frac0);
    return framesPipe(cat, fromSec, toSec, `crop=iw*${cw.toFixed(4)}:ih*${h}:iw*${cx.toFixed(4)}:ih*${y}`);
  };
  const [leftFrames, rightFrames] = await Promise.all([readSide(0.33, 0.43), readSide(0.55, 0.66)]);
  const samples: ScoreSample[] = [];
  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE as never,
    tessedit_char_whitelist: '0123456789',
  });
  const parse = (t: string): number | null => {
    const m = t.replace(/\s/g, '').match(/^\d{1,2}/);
    const n = m ? Number(m[0]) : NaN;
    return Number.isFinite(n) && n <= 16 ? n : null;
  };
  for (let i = 0; i < leftFrames.length; i++) {
    const lImg = await sharp(leftFrames[i]).resize({ width: 240 }).grayscale().normalize().withMetadata({ density: 300 }).png().toBuffer();
    const rImg = await sharp(rightFrames[i]).resize({ width: 240 }).grayscale().normalize().withMetadata({ density: 300 }).png().toBuffer();
    const lr = await worker.recognize(lImg);
    const rr = await worker.recognize(rImg);
    samples.push({
      sec: fromSec + i + 0.5,
      left: parse(lr.data.text),
      right: parse(rr.data.text),
      raw: `${lr.data.text.trim()}|${rr.data.text.trim()}`,
    });
  }
  await worker.terminate();
  return samples;
}

/** Virada do placar VALIDADA: um lado soma exatamente +1 e o outro não muda,
 * com o valor PRÉ-virada já visto ≥3 vezes nas últimas 6 leituras daquele
 * lado (uma leitura errada isolada não vira virada) e o novo valor se
 * sustentando nas leituras seguintes. */
export function scoreTurnSec(samples: ScoreSample[]): { sec: number; from: string; to: string } | null {
  const before = (idx: number, side: 'left' | 'right'): number[] => {
    const out: number[] = [];
    for (let i = idx - 1; i >= 0 && out.length < 6; i--) {
      const v = samples[i][side];
      if (v != null) out.push(v);
    }
    return out; // mais recente primeiro
  };
  const after = (idx: number, side: 'left' | 'right'): number[] => {
    const out: number[] = [];
    for (let i = idx; i < samples.length && out.length < 3; i++) {
      const v = samples[i][side];
      if (v != null) out.push(v);
    }
    return out;
  };
  // i = 1ª amostra com o valor NOVO do lado que pontuou
  for (let i = 1; i < samples.length; i++) {
    for (const s of ['left', 'right'] as const) {
      const o: 'left' | 'right' = s === 'left' ? 'right' : 'left';
      const sBefore = before(i, s);
      const oBefore = before(i, o);
      if (sBefore.length < 3 || oBefore.length < 1) continue;
      const v = sBefore[0];
      if (sBefore[1] !== v) continue;
      if (sBefore.filter((x) => x === v).length < 3) continue;
      const w = oBefore[0];
      const sAfter = after(i, s);
      const oAfter = after(i, o);
      if (sAfter.length < 2) continue;
      if (sAfter[0] !== v + 1 || sAfter[1] !== v + 1) continue;
      if (oAfter.length < 1 || oAfter[0] !== w) continue;
      return {
        sec: samples[i].sec,
        from: s === 'left' ? `${v}-${w}` : `${w}-${v}`,
        to: s === 'left' ? `${v + 1}-${w}` : `${w}-${v + 1}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------
interface DemoKill {
  tick: number;
  attacker: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  attackerSide: string;
}
interface DemoRound {
  round: number;
  startTick: number;
  endTick: number | null;
  winner: string | null;
  kills: DemoKill[];
}

function loadDemoRounds(demoFile: string): { map: string; rounds: Map<number, DemoRound> } {
  const map = String(parseHeader(demoFile).map_name ?? '').replace(/^de_/, '');
  const matchStarts = parseEvent(demoFile, 'round_announce_match_start').map((r) => Number(r.tick));
  let realStart = matchStarts.length ? Math.max(...matchStarts) : 0;
  if (matchStarts.length === 0) {
    const fe = parseEvent(demoFile, 'round_freeze_end').map((r) => Number(r.tick));
    realStart = fe.length ? Math.min(...fe) : 0;
  }
  const starts = parseEvent(demoFile, 'round_start').map((r) => Number(r.tick)).sort((a, b) => a - b);
  const boundaries = [realStart, ...starts.filter((t) => t > realStart)];
  const roundOf = (tick: number): number => {
    let n = 0;
    for (const b of boundaries) {
      if (b <= tick) n++;
      else break;
    }
    return n;
  };
  const ends = parseEvent(demoFile, 'round_end').map((r) => ({ tick: Number(r.tick), winner: String(r.winner) }));
  const deaths = parseEvent(demoFile, 'player_death', ['team_name']);
  const rounds = new Map<number, DemoRound>();
  for (const d of deaths) {
    const tick = Number(d.tick);
    const round = roundOf(tick);
    if (!round) continue;
    const attacker = String(d.attacker_name ?? '');
    const victim = String(d.user_name ?? '');
    if (!attacker || attacker === victim) continue;
    if (d.attacker_team_name && d.user_team_name && d.attacker_team_name === d.user_team_name) continue;
    const r = rounds.get(round) ?? { round, startTick: boundaries[round - 1], endTick: null, winner: null, kills: [] };
    r.kills.push({
      tick,
      attacker,
      victim,
      weapon: String(d.weapon ?? ''),
      headshot: Boolean(d.headshot),
      attackerSide: String(d.attacker_team_name ?? ''),
    });
    rounds.set(round, r);
  }
  for (const e of ends) {
    const round = roundOf(e.tick);
    const r = rounds.get(round);
    if (r) {
      r.endTick = e.tick;
      r.winner = e.winner;
    }
  }
  return { map, rounds };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(): { player: string; maps: Array<{ map: string; round: number }> } {
  let player = 'YEKINDAR';
  const maps: Array<{ map: string; round: number }> = [];
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--player=')) player = a.slice(9);
    else if (a.startsWith('--maps=')) {
      for (const part of a.slice(7).split(',')) {
        const [m, r] = part.split(':');
        maps.push({ map: m.trim().toLowerCase(), round: Number(r) });
      }
    }
  }
  if (maps.length === 0) maps.push({ map: 'mirage', round: 17 }, { map: 'nuke', round: 5 });
  return { player, maps };
}

const iso = (ms: number) => new Date(ms).toISOString();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hms = (sec: number) => {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Pipeline por jogada
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { player, maps } = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROBE, { recursive: true });
  // metadata fresca no boot: URLs novas valem ~6h e, de preferência, vêm
  // como VOD normal (byte-range) — o ffmpeg baixa só as janelas usadas.
  await refreshMeta(true);

  for (const { map, round } of maps) {
    const demoFile = fs
      .readdirSync(DEMO_DIR)
      .filter((f) => f.endsWith('.dem'))
      .map((f) => path.join(DEMO_DIR, f))
      .find((f) => String(parseHeader(f).map_name ?? '').replace(/^de_/, '') === map);
    if (!demoFile) {
      console.error(`demo não encontrada para ${map}`);
      continue;
    }
    const { rounds } = loadDemoRounds(demoFile);
    const r = rounds.get(round);
    if (!r) {
      console.error(`round ${round} não encontrado em ${map}`);
      continue;
    }
    const kills = r.kills.filter((k) => k.attacker === player).sort((a, b) => a.tick - b.tick);
    if (kills.length === 0) {
      console.error(`${player} sem kills no ${map} r${round}`);
      continue;
    }
    if (!r.endTick) {
      console.error(`round ${map} r${round} sem round_end`);
      continue;
    }
    console.log(`\n=== ${map} r${round}: ${kills.length} kills de ${player} (round termina ${(r.endTick - r.startTick) / 64}s após o início) ===`);

    // 1) Janela de busca limitada ao ROUND (as kills da demo dão o offset
    //    dentro do round; a semente do bot dá o parede→VOD).
    const botSidecarPath = path.resolve(`data/clips/2399759_${cap(map)}_r${round}_${player}/2399759_${cap(map)}_r${round}_${player}.json`);
    let seedSec: number | null = null;
    if (fs.existsSync(botSidecarPath)) {
      const side = JSON.parse(fs.readFileSync(botSidecarPath, 'utf8'));
      const clipStartMs = Number(side.clipStartMs);
      if (Number.isFinite(clipStartMs)) seedSec = (clipStartMs - VOD_START_MS) / 1000;
    }
    const roundLenSec = (r.endTick - r.startTick) / 64;
    const firstKillInRoundSec: number = (kills[0].tick - r.startTick) / 64;
    // A 1ª kill aparece no vídeo ~26,4s depois do `at` (medido no r17);
    // o round inteiro cabe em [início do round − margem, fim do round + folga].
    const center = seedSec != null ? seedSec + firstKillInRoundSec + 30 : firstKillInRoundSec + 26.4 + 40;
    const from = Math.max(0, center - firstKillInRoundSec - 20);
    const to = center + (roundLenSec - firstKillInRoundSec) + 40;
    console.log(`  janela de busca: ${hms(from)}–${hms(to)} (${(to - from).toFixed(0)}s; semente ${seedSec != null ? hms(seedSec) : 'latência'})`);

    // 2) OCR do killfeed → frames com o jogador; cada kill é atribuída à
    //    PRIMEIRA linha (frame) cujo texto tem `jogador → vítima` NESSA
    //    ORDEM (linhas "SYPH0 → X" não valem para a vítima SYPH0). Fuzzy
    //    progressivo (≤1, depois ≤2) porque o OCR lê YEKINDAR→YEXINDAR e
    //    SYPH0→SYIMO. Kills não localizadas viram estimativa (gaps da demo)
    //    — o drift do VOD (stall/ad da live) quebra a previsão por ticks.
    const hits = await scanKillfeed(from, to, player);
    console.log('  leituras do killfeed (frames com o jogador):');
    for (const h of hits) console.log(`    ${hms(h.appearSec)}  ${h.text.replace(/\n/g, ' ⏎ ').slice(0, 120)}`);
    const playerNorm = norm(player);
    const victims = kills.map((k) => norm(k.victim.replace(/[^a-z0-9]/gi, '')));
    const killRel = kills.map((k) => (k.tick - r.startTick) / 64);
    interface Assignment { appearSec: number; estimated: boolean; eventEndSec: number | null }
    const assignments: Assignment[] = [];
    let evIdx = 0;
    let prevAppear: number | null = null;
    for (let i = 0; i < kills.length; i++) {
      // porte de gap: a kill i aparece, no vídeo, entre (gap da demo − 2s) e
      // (gap da demo + 45s) depois da kill anterior — o teto absorve o drift
      // do VOD (stall/ad da live) sem deixar um round seguinte (vítimas
      // repetidas) sequestrar o casamento.
      const minSec = prevAppear != null ? prevAppear - 2 : -Infinity;
      const maxSec = prevAppear != null ? prevAppear + Math.max(3, killRel[i] - killRel[i - 1]) + 45 : Infinity;
      let found: { sec: number; endSec: number; idx: number } | null = null;
      for (const maxDist of [1, 2]) {
        for (let e = evIdx; e < hits.length; e++) {
          if (hits[e].appearSec < minSec || hits[e].appearSec > maxSec) continue;
          const lines = hits[e].text.split('\n').map((l) => norm(l.replace(/[^a-z0-9]/gi, '')));
          const ok = lines.some((flat) => {
            const p = fuzzyIndexOf(flat, playerNorm, 1);
            return p >= 0 && fuzzyIndexOf(flat, victims[i], maxDist) > p;
          });
          if (ok) {
            found = { sec: hits[e].appearSec, endSec: hits[e].appearSec, idx: e };
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        evIdx = found.idx;
        prevAppear = found.sec;
        assignments.push({ appearSec: found.sec, estimated: false, eventEndSec: found.endSec });
      } else {
        const gap = i > 0 ? Math.max(3, killRel[i] - killRel[i - 1]) : 20;
        const est: number = (prevAppear ?? from) + gap;
        prevAppear = est;
        assignments.push({ appearSec: est, estimated: true, eventEndSec: null });
        console.warn(`  kill ${kills[i].victim}: não localizada no killfeed — estimada em ${hms(est)}`);
      }
    }
    for (let i = 0; i < kills.length; i++) {
      console.log(`  kill ${kills[i].attacker} → ${kills[i].victim}: ${assignments[i].estimated ? '≈' : ''}${hms(assignments[i].appearSec)}${assignments[i].estimated ? ' (estimada)' : ''}`);
    }
    if (assignments[0].estimated) {
      console.error('  1ª kill não localizada no killfeed — pulando esta jogada');
      continue;
    }
    const timed = kills.map((k, i) => ({ ...k, appearSec: assignments[i].appearSec, estimated: assignments[i].estimated }));

    // 3) Limites do clipe.
    //    Início: 1ª aparição − 1s (delay da linha) − contexto+margem.
    //    Fim: virada do placar (OCR) + 8s; fallback: fim do round (demo) + 11s
    //    (aproximado — o drift do VOD contra a demo pode deslocar alguns s).
    const firstAppear = timed[0].appearSec;
    const lastRealAppear = Math.max(...timed.filter((k) => !k.estimated).map((k) => k.appearSec));
    const startSec = firstAppear - KILLFEED_APPEAR_DELAY_MS / 1000 - START_CONTEXT_SEC - START_MARGIN_SEC;
    const roundStartVodSec = firstAppear - KILLFEED_APPEAR_DELAY_MS / 1000 - firstKillInRoundSec;
    const roundEndVideoSec = roundStartVodSec + (r.endTick - r.startTick) / 64;
    let endSec = roundEndVideoSec + 11;
    let endSource = 'fim do round (demo) + 11s (aproximado)';
    // Varre o placar do INÍCIO do round (para ler o placar inicial) até o
    // fim do round + folga para o drift — a virada do round é a 1ª transição
    // validada (+1 num lado) dentro da janela.
    const sb = await scanScoreboard(firstAppear - 10, firstAppear + (r.endTick - r.startTick) / 64 + 95);
    console.log('  placar lido no round:');
    for (const s of sb) console.log(`    ${hms(s.sec)}  esq=${s.left} dir=${s.right}  "${s.raw.slice(0, 40)}"`);
    const turn = scoreTurnSec(sb);
    const maxAssignedAppear = Math.max(...timed.map((k) => k.appearSec));
    const endFloor = maxAssignedAppear + 9;
    const endCeiling = firstAppear + (r.endTick - r.startTick) / 64 + 90;
    if (turn) {
      endSec = Math.min(Math.max(turn.sec + END_AFTER_CLOSE_SEC, endFloor), endCeiling);
      endSource = `virada do placar ${turn.from} → ${turn.to} em ${hms(turn.sec)} + 8s`;
    } else if (endSec < endFloor) {
      endSec = endFloor;
      endSource = 'piso da última kill + 9s (virada não detectada)';
    }
    endSec = Math.min(endSec, endCeiling);
    console.log(`  clipe: ${hms(startSec)} → ${hms(endSec)} (${(endSec - startSec).toFixed(1)}s); fim por ${endSource}`);

    // 4) Render: 1080p60 + áudio, re-encode para corte exato.
    const name = `2399759_${cap(map)}_r${round}_${player}`;
    const outDir = path.join(OUT_DIR, name);
    fs.mkdirSync(outDir, { recursive: true });
    const srcV = await resolveSource('final', startSec - 5, endSec + 5);
    const srcA = await resolveSource('audio', startSec - 5, endSec + 5);
    const catV = srcV.kind === 'file' ? srcV.path : srcV.url;
    const catA = srcA.kind === 'file' ? srcA.path : srcA.url;
    const mp4 = path.join(outDir, `${name}.mp4`);
    await execFileAsync(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(startSec), '-to', String(endSec), '-i', catV, '-ss', String(startSec), '-to', String(endSec), '-i', catA, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4],
      { timeout: 900_000 },
    );

    // 5) Thumbnail: no instante da ÚLTIMA kill (a linha aparece ~1s depois
    //    da kill na tela) — logo após o round encerrar a broadcast corta
    //    para a câmera dos jogadores.
    const thumbSec = Math.max(...timed.filter((k) => !k.estimated).map((k) => k.appearSec)) - 1;
    const jpg = path.join(outDir, `${name}.jpg`);
    await execFileAsync(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(thumbSec), '-i', catV, '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '2', jpg],
      { timeout: 120_000 },
    );

    // 6) JSON sidecar.
    // `at` do HLTV: usa o sidecar do bot quando a lista de kills bate com a
    // demo (mesmas vítimas, mesma ordem); senão, aproxima da aparição − delta.
    let hltvAt: number[] | null = null;
    if (fs.existsSync(botSidecarPath)) {
      try {
        const botSide = JSON.parse(fs.readFileSync(botSidecarPath, 'utf8'));
        const list = Array.isArray(botSide.kills) ? botSide.kills : [];
        if (
          list.length === timed.length &&
          list.every((k: { victim?: string }, i: number) => String(k.victim ?? '').toLowerCase() === String(timed[i].victim).toLowerCase())
        ) {
        const parsed: number[] = list
          .map((k: { at?: string | number }) => (typeof k.at === 'number' ? k.at : Date.parse(String(k.at))))
          .filter(Number.isFinite);
        if (parsed.length === timed.length) hltvAt = parsed;
        }
      } catch {
        /* sidecar inutilizável — usa a aproximação */
      }
    }
    const gameToVodDeltaSec =
      hltvAt != null ? firstAppear - KILLFEED_APPEAR_DELAY_MS / 1000 - (hltvAt[0] - VOD_START_MS) / 1000 : 26.4;
    const atMs = (k: { appearSec: number }) =>
      Math.round(VOD_START_MS + (k.appearSec - KILLFEED_APPEAR_DELAY_MS / 1000 - gameToVodDeltaSec) * 1000);
    const side = {
      matchId: '2399759',
      map: cap(map),
      round,
      player,
      team1: 'Nemiga',
      team2: 'FURIA',
      event: 'PGL Masters Bucharest 2026',
      generatedAt: iso(Date.now()),
      clipSource: 'youtube-vod (live do gaules)',
      vod: {
        videoId: YT_ID,
        url: YT_URL,
        vodStartIso: iso(VOD_START_MS),
        startSec: Math.round(startSec * 1000) / 1000,
        endSec: Math.round(endSec * 1000) / 1000,
        videoItag: finalItag(),
        endAnchor: endSource,
        gameToVodDeltaSec: Math.round(gameToVodDeltaSec * 100) / 100,
      },
      kills: timed.map((k, i) => ({
        killer: k.attacker,
        victim: k.victim,
        weapon: k.weapon,
        headshot: k.headshot,
        at: iso(hltvAt != null ? hltvAt[i] : atMs(k)),
        atSource: hltvAt != null ? 'hltv-live' : 'estimado (killfeed ocr)',
        atVodSec: Math.round(k.appearSec * 1000) / 1000,
        appearEstimated: k.estimated,
      })),
      roundKills: r.kills.map((k) => ({ killer: k.attacker, victim: k.victim, weapon: k.weapon, headshot: k.headshot })),
      roundWinner: r.winner,
      clipStartMs: Math.round(VOD_START_MS + startSec * 1000),
      clipDurationSec: Math.round((endSec - startSec) * 1000) / 1000,
      clipFile: `${name}.mp4`,
      thumbnailFile: `${name}.jpg`,
      streamName: 'gaules',
      note: 'clipado do VOD do YouTube (live do gaules) com âncoras de killfeed/placar por OCR; timings `at` aproximados (±3s)',
    };
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(side, null, 2) + '\n');
    const size = fs.statSync(mp4).size;
    console.log(`  ✓ ${mp4} (${(size / 1e6).toFixed(1)} MB) + ${name}.jpg + ${name}.json`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
