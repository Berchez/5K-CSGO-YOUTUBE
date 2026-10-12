/**
 * Teste ponta-a-ponta com PARTIDA JÁ ACABADA (VOD).
 *
 * O modo real do bot é LIVE (buffer circular p/ velocidade), mas este script
 * valida o resto do pipeline sem esperar um 5k ao vivo:
 *   VOD (yt-dlp, só o trecho) -> clipe mp4 + sidecar -> upload YT private (opcional)
 *
 * Uso:
 *   npm run test:vod -- --url <twitch|youtube VOD> --at 01:23:45 [--pre 60] [--post 15] [--player donk] [--upload]
 *   npm run test:vod -- --url <VOD> --at 5025   (segundos também valem)
 *
 * Sem --upload: só baixa o trecho e monta o clipe (valida download+clipper).
 * Com --upload: exige client_secrets.json + token.json (rode npm run auth:youtube antes).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { getLogger } from '../src/logger.js';
import { getDb, hasAce, insertAce, insertClip } from '../src/db.js';
import { uploadClip } from '../src/uploader/youtubeUploader.js';
import type { AceEvent } from '../src/types.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve('.');
const YTDLP = path.join(ROOT, '.tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG = path.join(ROOT, '.tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Fallback posicional: no Windows o `npm run ... -- --url X` às vezes
 * perde as flags (chega só os valores). Aceita: <url> <at> [player].
 */
function positionalArgs(): string[] {
  const withValue = new Set(['--url', '--at', '--pre', '--post', '--player', '--team1', '--team2', '--pteam', '--map', '--event', '--round', '--score', '--kills', '--firstat', '--ctx', '--playerphoto', '--team1logo', '--team2logo', '--mapimg']);
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--upload') continue;
    if (withValue.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('--') || a.endsWith('.ts')) continue;
    out.push(a);
  }
  return out;
}

/** "01:23:45" | "23:45" | "5025" -> segundos */
function parseTs(s: string): number {
  if (/^\d+(\.\d+)?$/.test(s)) return Number.parseFloat(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`timestamp inválido: ${s}`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

async function main(): Promise<void> {
  const pos = positionalArgs();
  const url = arg('url') ?? pos[0];
  const atRaw = arg('at') ?? pos[1];
  if (!url || !atRaw) {
    console.error(
      'Uso: npx tsx scripts/test-vod.ts --url <VOD> --at 01:23:45 [--pre 60] [--post 15] [--player donk] [--team1 Spirit] [--team2 Falcons] [--pteam Spirit] [--map Anubis] [--event "ESL Pro League Season 24"] [--round 9] [--score 6-3] [--kills "donk>a:ak47:hs,..."] [--firstat 01:22:30] [--ctx 10] [--refs] [--playerphoto URL] [--team1logo URL] [--team2logo URL] [--mapimg URL] [--upload]',
    );
    process.exit(2);
  }
  const pre = Number(arg('pre', '60'));
  const post = Number(arg('post', '15'));
  const player = arg('player') ?? pos[2] ?? 'TEST_PLAYER';
  const team1 = arg('team1', 'TEST_A')!;
  const team2 = arg('team2', 'TEST_B')!;
  const pteam = arg('pteam', '')!;
  const map = arg('map', 'test-map')!;
  const event = arg('event', '[TESTE] VOD partida acabada')!;
  const round = Number(arg('round', '1'));
  const score = arg('score');
  const killsSpec = arg('kills', '');
  // --firstat = momento do 1º kill: o clipe começa --ctx (default 10s) antes dele.
  // Sem --firstat: começa pre segundos antes do 5º kill (pode cair em cima da ação).
  const firstAtRaw = arg('firstat');
  const ctx = Number(arg('ctx', '10'));
  // Referências: --refs busca tudo sozinho; ou URLs explícitas por item.
  const wantRefs = hasFlag('refs');
  const refOverrides = {
    ...(arg('playerphoto') ? { player: arg('playerphoto') as string } : {}),
    ...(arg('team1logo') ? { team1Logo: arg('team1logo') as string } : {}),
    ...(arg('team2logo') ? { team2Logo: arg('team2logo') as string } : {}),
    ...(arg('mapimg') ? { mapImage: arg('mapimg') as string } : {}),
  };
  const doUpload = hasFlag('upload');

  const cfg = getConfig();
  const log = getLogger();
  // Garante que 'ffmpeg' resolve (clipper chama pelo nome) e yt-dlp acha o ffmpeg
  process.env.PATH = `${path.join(ROOT, '.tools')}${path.delimiter}${process.env.PATH ?? ''}`;

  if (!fs.existsSync(YTDLP)) throw new Error(`yt-dlp não encontrado em ${YTDLP}`);
  if (!fs.existsSync(FFMPEG)) throw new Error(`ffmpeg não encontrado em ${FFMPEG}`);
  fs.mkdirSync(cfg.CLIPS_DIR, { recursive: true });

  // 1) Valida URL + mostra duração
  const meta = await execFileAsync(YTDLP, [
    '--no-playlist',
    '--print',
    '%(title)s || DURATION=%(duration)s',
    url,
  ]).catch((e) => {
    throw new Error(`yt-dlp não conseguiu ler a URL (privada/removida/login?): ${String(e).slice(0, 300)}`);
  });
  console.log('VOD: ' + meta.stdout.trim().slice(0, 160));

  const at = parseTs(atRaw);
  const start = firstAtRaw ? fmt(parseTs(firstAtRaw) - ctx) : fmt(at - pre);
  const end = fmt(at + post);
  console.log(
    firstAtRaw
      ? `Trecho: ${start} → ${end} (1º kill em ${fmt(parseTs(firstAtRaw))} + ${ctx}s de contexto, ace em ${fmt(at)})`
      : `Trecho: ${start} → ${end} (ace em ${fmt(at)}, janela ${pre}s+${post}s, sem --firstat: pode começar em cima da ação)`,
  );

  // 2) Baixa SÓ o trecho (rápido, não baixa o VOD inteiro)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `test-vod_${stamp}_${slug(player)}`;
  const outPath = path.join(cfg.CLIPS_DIR, `${base}.mp4`);
  console.log('Baixando trecho (720p máx p/ ser rápido)...');
  await execFileAsync(YTDLP, [
    '--no-playlist',
    '--ffmpeg-location',
    path.join(ROOT, '.tools'),
    '--download-sections',
    `*${start}-${end}`,
    '--force-keyframes-at-cuts',
    '-f',
    'bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format',
    'mp4',
    '-o',
    outPath,
    url,
  ]);
  const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`Clipe OK: ${outPath} (${sizeMb} MB)`);

  // 3) Thumb composta + sidecar (mesmo padrão do clipper live)
  // 3) Objeto ace: com kills detalhados (--kills) monta summary real;
  // sem eles, kills fica vazio (honesto: sem dado, sem invenção).
  // Defaults honestos: avisa o que ficou placeholder para não confundir com dado real
  if (map === 'test-map') console.log('(dica: passe --map "Cache" p/ metadados reais)');
  if (round === 1) console.log('(dica: passe --round N p/ round real)');
  if (!score) console.log('(dica: passe --score 6-3 p/ placar real)');
  if (!killsSpec) {
    console.log('(dica: passe --kills "a>b:ak47:hs,..." p/ kills detalhados; vítimas ? = desconhecida)');
  }
  const { parseKillList } = await import('../src/detector/killParse.js');
  const { buildRoundSummary, describeAce } = await import('../src/detector/aceDetector.js');
  const { buildSidecar } = await import('../src/clipper/clipBuilder.js');
  const kills = killsSpec ? parseKillList(killsSpec, round, map) : [];
  const opponents = pteam
    ? (pteam === team1 ? team2 : team1)
    : `${team1} vs ${team2}`;
  const ace: AceEvent = {
    matchId: `test-vod-${stamp}`,
    map,
    round,
    player,
    team1,
    team2,
    event,
    detectedAt: new Date().toISOString(),
    kills,
    score: score || undefined,
    summary: kills.length === 5 ? buildRoundSummary(player, pteam, opponents, kills) : undefined,
  };
  if (ace.summary) {
    console.log('--- RESUMO DO ACE ---');
    console.log(describeAce(ace.summary, event));
    console.log('---------------------');
  } else if (killsSpec) {
    console.log(`(aviso: --kills com ${kills.length} kills, summary exige 5)`);
  }
  const thumbPath = path.join(cfg.CLIPS_DIR, `${base}.jpg`);
  try {
    const { makeSmartThumbnail } = await import('../src/clipper/thumbnail.js');
    // Referências visuais (foto/logos/mapa) quando pedidas
    let references = undefined as
      | import('../src/clipper/referenceImages.js').ReferenceImages
      | undefined;
    if (wantRefs || Object.keys(refOverrides).length > 0) {
      const { fetchReferenceImages } = await import('../src/clipper/referenceImages.js');
      references = await fetchReferenceImages({
        player,
        team1,
        team2,
        map,
        dir: path.join(cfg.CLIPS_DIR, 'refs', `test-vod-${stamp}`),
        overrides: Object.keys(refOverrides).length > 0 ? refOverrides : undefined,
      });
    }
    // Frame de ~3s antes do 5º kill (meio do ace), não do meio do clipe
    await makeSmartThumbnail(outPath, thumbPath, ace, Math.max(1, pre - 3), {
      mode: cfg.THUMB_MODE,
      ai: {
        order: cfg.THUMB_AI_ORDER.split(',').map((s) => s.trim()).filter(Boolean) as Array<'huggingface' | 'pollinations' | 'gemini' | 'gemini-web' | 'chatgpt' | 'grok'>,
        hfToken: cfg.HF_TOKEN || undefined,
        hfModel: cfg.HF_IMAGE_MODEL,
        geminiApiKey: cfg.GEMINI_API_KEY || undefined,
        geminiModel: cfg.GEMINI_IMAGE_MODEL,
        geminiWebProfileDir: cfg.GEMINI_WEB_PROFILE,
        chatgptProfileDir: cfg.CHATGPT_PROFILE,
        chatgptMinimized: cfg.CHATGPT_MINIMIZED === '1',
        grokProfileDir: cfg.GROK_PROFILE,
        grokMinimized: cfg.GROK_MINIMIZED === '1',
        references,
      },
    });
    console.log(`Thumb OK (${cfg.THUMB_MODE}): ${thumbPath}`);
  } catch {
    log.warn('thumb falhou (ok p/ teste)');
  }
  fs.writeFileSync(
    path.join(cfg.CLIPS_DIR, `${base}.json`),
    JSON.stringify(buildSidecar(ace, { clipFile: path.basename(outPath), vodUrl: url, aceAt: fmt(at) }), null, 2),
  );
  getDb(cfg.DB_PATH);
  if (!hasAce(cfg.DB_PATH, ace.matchId, ace.map, ace.round, ace.player)) {
    const aceId = insertAce(cfg.DB_PATH, ace);
    if (!doUpload) {
      insertClip(cfg.DB_PATH, aceId, outPath, 'local-test');
    }
  }

  // 4) Upload (só com --upload + credenciais)
  if (!doUpload) {
    console.log('\nOK sem upload. P/ testar upload: npm run auth:youtube  →  adicione --upload');
    return;
  }
  if (!fs.existsSync(cfg.YT_CLIENT_SECRETS)) {
    throw new Error(
      `sem ${cfg.YT_CLIENT_SECRETS}. Crie o OAuth Client no Google Cloud e rode: npm run auth:youtube`,
    );
  }
  const thumbExists = fs.existsSync(thumbPath) ? thumbPath : undefined;
  const videoId = await uploadClip({ ...ace, event: `[TESTE] ${ace.event}` }, outPath, {
    clientSecretsPath: cfg.YT_CLIENT_SECRETS,
    tokenPath: cfg.YT_TOKEN_PATH,
    privacy: cfg.YT_PRIVACY,
    categoryId: cfg.YT_CATEGORY_ID,
    defaultTags: cfg.YT_DEFAULT_TAGS,
    thumbnailPath: thumbExists,
  });
  const aceId = insertAce(cfg.DB_PATH, ace);
  insertClip(cfg.DB_PATH, aceId, outPath, cfg.YT_PRIVACY, videoId);
  console.log(`\nUPLOAD OK (private): https://youtu.be/${videoId}`);
}

main().catch((e) => {
  console.error('FALHOU: ' + (e as Error).message);
  process.exit(1);
});
