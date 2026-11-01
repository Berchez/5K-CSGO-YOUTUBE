/**
 * Envia os clipes gerados do VOD (data/clips-vod) pelo MESMO pipeline do
 * bot: metadados IA (com guarda anti-alucinação), thumbnail IA
 * (chatgpt/grok/gemini-web, fallback composto), registro no banco e
 * upload unlisted.
 *
 * Os clipes já nascem com sidecar (kills + âncoras de killfeed/placar);
 * aqui só falta o que o bot faria no ao vivo: refs, thumb de IA,
 * metadados e o upload.
 *
 * Uso: npx tsx scripts/upload-vod-clips.ts [pasta-do-clipe ...]
 *      (sem argumentos: todas as pastas de data/clips-vod/2399759)
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { getDb, insertClip } from '../src/db.js';
import { uploadClip } from '../src/uploader/youtubeUploader.js';
import { buildVideoMetadataSafe } from '../src/uploader/videoMetadata.js';
import { createMetadataAi } from '../src/uploader/metadataAi.js';
import { makeClipThumbnail } from '../src/clipper/clipBuilder.js';
import { fetchReferenceImages, type ReferenceImages } from '../src/clipper/referenceImages.js';
import type { AceEvent, KillEvent } from '../src/types.js';

const VOD_START_MS = 1793432814_000; // release_timestamp do VOD do gaules
const DEFAULT_DIR = path.resolve('data/clips-vod/2399759');

interface VodSidecar {
  matchId: string;
  map: string;
  round: number;
  player: string;
  team1: string;
  team2: string;
  event: string;
  kills: Array<{ killer: string; victim: string; weapon: string; headshot: boolean; atVodSec: number }>;
  roundWinner?: string;
  clipStartMs: number;
  clipDurationSec: number;
  clipFile: string;
  thumbnailFile?: string | null;
  youtubeId?: string;
  thumbnailAi?: boolean;
}

function buildAce(side: VodSidecar): AceEvent {
  const kills: KillEvent[] = side.kills.map((k) => ({
    killer: k.killer ?? '',
    victim: k.victim ?? '',
    round: side.round,
    map: side.map,
    // `at` na timeline do VOD: com killTimeOffsetMs = 0, os timestamps da
    // descrição saem da posição real no vídeo (o killfeed já mediu).
    at: Math.round(VOD_START_MS + k.atVodSec * 1000),
    weapon: k.weapon ?? '',
    headshot: Boolean(k.headshot),
  }));
  const weaponCounts = new Map<string, number>();
  for (const k of kills) weaponCounts.set(k.weapon ?? '', (weaponCounts.get(k.weapon ?? '') ?? 0) + 1);
  const mainWeapon = [...weaponCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return {
    matchId: side.matchId,
    map: side.map,
    round: side.round,
    player: side.player,
    team1: side.team1,
    team2: side.team2,
    event: side.event,
    detectedAt: new Date().toISOString(),
    kills,
    summary: {
      round: side.round,
      map: side.map,
      player: side.player,
      team: side.team2,
      opponents: `${side.team1} vs ${side.team2}`,
      kills,
      victims: kills.map((k) => k.victim),
      weapons: kills.map((k) => k.weapon ?? ''),
      headshots: kills.filter((k) => k.headshot).length,
      assists: [],
      flashAssists: [],
      grenades: [],
      mainWeapon,
    },
  };
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const targets = process.argv.slice(2).length
    ? process.argv.slice(2).map((a) => path.resolve(a))
    : fs
        .readdirSync(DEFAULT_DIR)
        .filter((d) => fs.existsSync(path.join(DEFAULT_DIR, d, `${d}.json`)))
        .map((d) => path.join(DEFAULT_DIR, d));
  if (targets.length === 0) {
    console.error('nenhum clipe encontrado');
    process.exit(1);
  }
  const metadataAi = createMetadataAi({
    order: cfg.YT_META_AI_ORDER,
    timeoutMs: cfg.YT_META_AI_TIMEOUT_MS,
    geminiApiKey: cfg.GEMINI_API_KEY || undefined,
    geminiModel: cfg.YT_META_GEMINI_MODEL,
    hfToken: cfg.HF_TOKEN || undefined,
    hfModel: cfg.YT_META_HF_MODEL,
  });

  for (const dir of targets) {
    const name = path.basename(dir);
    const sidecarPath = path.join(dir, `${name}.json`);
    const side: VodSidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (side.youtubeId) {
      console.log(`${name}: já enviado (https://youtu.be/${side.youtubeId}) — pulando`);
      continue;
    }
    const mp4 = path.join(dir, side.clipFile);
    if (!fs.existsSync(mp4)) {
      console.error(`${name}: mp4 ausente (${mp4}) — pulando`);
      continue;
    }
    console.log(`\n== ${name} ==`);
    const ace = buildAce(side);

    // Referências (foto do player, logos, mapa) — cache em data/clips/refs.
    let refs: ReferenceImages = {};
    try {
      refs = await fetchReferenceImages({
        player: ace.player,
        team1: ace.team1,
        team2: ace.team2,
        map: ace.map,
        dir: `${cfg.CLIPS_DIR}/refs/${ace.matchId}`,
        hltvProfileDir: cfg.HLTV_PROFILE,
      });
      console.log(`  refs: player=${refs.player ? 'ok' : '—'} logos=${refs.team1Logo ? 'ok' : '—'}/${refs.team2Logo ? 'ok' : '—'}`);
    } catch (e) {
      console.warn(`  refs falhou (segue sem): ${String(e).slice(0, 120)}`);
    }

    // Thumbnail IA (chatgpt → grok → gemini-web; fallback composto).
    const clipStartSec = (side.clipStartMs - VOD_START_MS) / 1000;
    const lastKillSec = Math.max(...side.kills.map((k) => k.atVodSec));
    const thumbAtSec = Math.max(1, Math.min(lastKillSec - clipStartSec - 1, side.clipDurationSec - 1));
    let thumbPath: string | null = null;
    try {
      thumbPath = await makeClipThumbnail(ace, mp4, {
        atSec: thumbAtSec,
        outPath: path.join(dir, side.thumbnailFile || `${name}.jpg`),
        thumb: {
          mode: cfg.THUMB_MODE,
          ai: {
            order: cfg.THUMB_AI_ORDER.split(',').map((s) => s.trim()).filter(Boolean) as Array<
              'huggingface' | 'pollinations' | 'gemini' | 'gemini-web' | 'chatgpt' | 'grok'
            >,
            timeoutMs: cfg.THUMB_AI_TIMEOUT_MS,
            hfToken: cfg.HF_TOKEN || undefined,
            hfModel: cfg.HF_IMAGE_MODEL,
            geminiApiKey: cfg.GEMINI_API_KEY || undefined,
            geminiModel: cfg.GEMINI_IMAGE_MODEL,
            geminiWebProfileDir: cfg.GEMINI_WEB_PROFILE,
            geminiWebChromeProfile: cfg.GEMINI_WEB_CHROME_PROFILE || undefined,
            geminiWebHeadless: cfg.GEMINI_WEB_HEADLESS,
            chatgptProfileDir: cfg.CHATGPT_PROFILE,
            chatgptMinimized: cfg.CHATGPT_MINIMIZED,
            grokProfileDir: cfg.GROK_PROFILE,
            grokMinimized: cfg.GROK_MINIMIZED,
            references: refs,
          },
        },
      });
      console.log(`  thumbnail: ${thumbPath ?? 'FALHOU (segue sem)'}`);
    } catch (e) {
      console.warn(`  thumbnail falhou: ${String(e).slice(0, 160)}`);
    }

    // Metadados IA (com guarda anti-alucinação) — o contexto vem do ace
    // montado do sidecar (timestamps = posição real no VOD).
    const metadata = await buildVideoMetadataSafe(ace, {
      mode: cfg.YT_META_MODE,
      ai: (ctx) => metadataAi(ctx),
      brand: cfg.YT_BRAND,
      cta: cfg.YT_DESC_CTA,
      privacy: cfg.YT_PRIVACY,
      defaultTags: cfg.YT_DEFAULT_TAGS,
      clipStartMs: side.clipStartMs,
      clipDurationSec: side.clipDurationSec,
      killTimeOffsetMs: 0,
    });
    console.log(`  metadados: ${metadata ? `${metadata.source} — "${metadata.title}"` : 'LEGADO (template)'}`);

    // Upload (unlisted) + thumbnail aplicada no vídeo.
    const videoId = await uploadClip(ace, mp4, {
      clientSecretsPath: cfg.YT_CLIENT_SECRETS,
      tokenPath: cfg.YT_TOKEN_PATH,
      privacy: cfg.YT_PRIVACY,
      categoryId: cfg.YT_CATEGORY_ID,
      defaultTags: cfg.YT_DEFAULT_TAGS,
      metadata,
      thumbnailPath: thumbPath ?? undefined,
    });
    console.log(`  ✓ https://youtu.be/${videoId} (${cfg.YT_PRIVACY})`);

    // Registro no banco (mesmo ace_event do bot) + sidecar atualizado.
    const db = getDb(cfg.DB_PATH);
    const row = db
      .prepare('SELECT id FROM ace_events WHERE match_id=? AND map=? AND round=? AND player=?')
      .get(ace.matchId, ace.map, ace.round, ace.player) as { id: number } | undefined;
    if (row) insertClip(cfg.DB_PATH, row.id, mp4, cfg.YT_PRIVACY, videoId);
    else console.warn('  ace_event não encontrado no banco — clipe não registrado');
    side.youtubeId = videoId;
    if (thumbPath) side.thumbnailFile = path.basename(thumbPath);
    side.thumbnailAi = thumbPath != null;
    fs.writeFileSync(sidecarPath, JSON.stringify(side, null, 2) + '\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
