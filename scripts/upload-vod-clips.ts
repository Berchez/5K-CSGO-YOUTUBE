/**
 * Envia os clipes gerados do VOD (data/clips-vod) pelo MESMO pipeline do
 * bot: metadados IA (com guarda anti-alucinação), thumbnail IA
 * (chatgpt/grok/gemini-web, fallback composto), registro no banco e
 * upload com a visibilidade configurada em `YT_PRIVACY`.
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
import { refreshRoundSummary } from '../src/detector/aceDetector.js';
import {
  readClipSidecar,
  sidecarToAce,
  updateClipSidecar,
  type ClipSidecarV2,
} from '../src/clipper/sidecar.js';
import type { AceEvent } from '../src/types.js';

const DEFAULT_DIR = path.resolve('data/clips-vod/2399759');

/**
 * Reconstroi o ace com os `at` na timeline do VOD: o metadata usa
 * `clipStartMs + kill.at` com offset 0 para os timestamps da descricao.
 */
function buildAce(side: ClipSidecarV2): AceEvent {
  const ace = sidecarToAce(side);
  const clipStartMs = side.clip.startMs;
  if (clipStartMs != null) {
    ace.kills = ace.kills.map((kill, i) => {
      const videoSec = side.kills[i]?.videoSec;
      return videoSec != null && Number.isFinite(videoSec)
        ? { ...kill, at: Math.round(clipStartMs + videoSec * 1000) }
        : kill;
    });
    // O resumo é recalculado com as kills ATUAIS: os agregados (arma
    // principal, headshots, assistências) saem delas — um resumo velho
    // punha o título com a arma errada.
    ace.summary = ace.summary ? refreshRoundSummary(ace.summary, ace.kills) : ace.summary;
    ace.clipStartMs = clipStartMs;
    ace.clipDurationSec = side.clip.durationSec ?? undefined;
    ace.killVideoOffsetMs = 0;
  }
  return ace;
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
    const side = readClipSidecar(sidecarPath);
    if (!side) {
      console.error(`${name}: sidecar inválido — pulando`);
      continue;
    }
    if (side.publication?.youtubeId) {
      console.log(`${name}: já enviado (https://youtu.be/${side.publication.youtubeId}) — pulando`);
      continue;
    }
    const mp4 = path.join(dir, side.clip.file ?? `${name}.mp4`);
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
    const durationSec = side.clip.durationSec ?? 0;
    const videoSecs = side.kills
      .map((k) => k.videoSec)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const lastKillSec = videoSecs.length > 0 ? Math.max(...videoSecs) : durationSec;
    const thumbAtSec = Math.max(1, Math.min(lastKillSec - 1, Math.max(1, durationSec - 1)));
    let thumbPath: string | null = null;
    try {
      thumbPath = await makeClipThumbnail(ace, mp4, {
        atSec: thumbAtSec,
        outPath: path.join(dir, side.clip.thumbnailFile || `${name}.jpg`),
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
      clipStartMs: ace.clipStartMs,
      clipDurationSec: ace.clipDurationSec,
      killTimeOffsetMs: ace.killVideoOffsetMs ?? 0,
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
    // O sidecar é gravado ANTES do insert: se o banco falhar, o
    // youtubeId já está no disco e o script não reenvia o vídeo.
    //
    // A falha de escrita NÃO pode passar em silêncio: sem o youtubeId no
    // sidecar, a próxima rodada REENVIA o vídeo (o canal ganha dois
    // vídeos do mesmo clipe). O lote para aqui para o dono resolver.
    const saved = updateClipSidecar(sidecarPath, (s) => {
      s.publication ??= { youtubeId: null, publishedAt: null, thumbnailAi: false };
      s.publication.youtubeId = videoId;
      s.publication.publishedAt = new Date().toISOString();
      s.publication.thumbnailAi = thumbPath != null;
      if (thumbPath) s.clip.thumbnailFile = path.basename(thumbPath);
    });
    if (!saved) {
      throw new Error(
        `falha ao gravar o youtubeId no sidecar (${sidecarPath}) — o vídeo JÁ foi enviado (${videoId}); lote interrompido para não reenviar`,
      );
    }

    const db = getDb(cfg.DB_PATH);
    const row = db
      .prepare('SELECT id FROM ace_events WHERE match_id=? AND map=? AND round=? AND player=?')
      .get(ace.matchId, ace.map, ace.round, ace.player) as { id: number } | undefined;
    // `format: 'vod'` é obrigatório: sem ele, o clipe do VOD cairia na
    // MESMA linha do clipe do bot (mesmo ace, formato vazio) e
    // sobrescreveria o `youtube_video_id` do vídeo já publicado.
    if (row) {
      insertClip(cfg.DB_PATH, row.id, mp4, cfg.YT_PRIVACY, videoId, {
        format: 'vod',
        title: metadata?.title ?? null,
        publishedAt: new Date().toISOString(),
      });
    } else console.warn('  ace_event não encontrado no banco — clipe não registrado');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
