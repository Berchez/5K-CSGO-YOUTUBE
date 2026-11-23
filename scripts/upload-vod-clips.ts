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
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHANNEL_ID } from '../src/channels.js';
import { getConfig } from '../src/config.js';
import { getDb, insertAce, insertClip } from '../src/db.js';
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

/** Linha do clipe VOD já registrada para este ace (se existir). */
export interface VodClipRow {
  filePath: string;
  youtubeVideoId: string | null;
  title: string | null;
  publishedAt: string | null;
}

/**
 * Procura o registro VOD pelo mesmo ace do sidecar. O formato `vod` é
 * separado do formato do clipe live para não sobrescrever o vídeo já
 * publicado pelo bot.
 */
export function findVodClip(dbFile: string, ace: AceEvent): VodClipRow | null {
  const row = getDb(dbFile)
    .prepare(
      `SELECT c.file_path AS filePath,
              c.youtube_video_id AS youtubeVideoId,
              c.title AS title,
              c.published_at AS publishedAt
       FROM clips c
       JOIN ace_events e ON e.id = c.ace_id
       WHERE e.channel_id=? AND e.match_id=? AND e.map=? AND e.round=? AND e.player=?
         AND c.channel_id=? AND COALESCE(c.format, '')=?
       ORDER BY c.id DESC
       LIMIT 1`,
    )
    .get(
      ace.channelId,
      ace.matchId,
      ace.map,
      ace.round,
      ace.player,
      ace.channelId,
      'vod',
    ) as VodClipRow | undefined;
  return row ?? null;
}

/**
 * Garante que o ace e o clipe VOD existam no banco. É idempotente: pode
 * ser chamada para reconciliar um sidecar que já tem `youtubeId`, sem
 * reenviar o vídeo.
 */
export function registerVodClip(
  dbFile: string,
  ace: AceEvent,
  filePath: string,
  privacy: string,
  videoId: string,
  options: { title?: string | null; publishedAt?: string | null } = {},
): number {
  const existing = findVodClip(dbFile, ace);
  if (existing?.youtubeVideoId && existing.youtubeVideoId !== videoId) {
    throw new Error(
      `vídeo VOD já registrado (${existing.youtubeVideoId}) não confere com o sidecar (${videoId})`,
    );
  }
  const aceId = insertAce(dbFile, ace, ace.channelId);
  insertClip(dbFile, aceId, filePath, privacy, videoId, {
    format: 'vod',
    // Na reconciliação, não apaga o título/data que já estavam no banco.
    title: options.title ?? existing?.title ?? null,
    publishedAt:
      options.publishedAt ?? existing?.publishedAt ?? new Date().toISOString(),
  });
  return aceId;
}

/** Persiste a publicação no sidecar sem apagar metadados de thumbnail. */
function persistPublication(
  sidecarPath: string,
  videoId: string,
  publishedAt: string,
  thumbnailAi?: boolean,
  thumbnailPath?: string | null,
): boolean {
  return updateClipSidecar(sidecarPath, (s) => {
    s.publication ??= { youtubeId: null, publishedAt: null, thumbnailAi: false };
    s.publication.youtubeId = videoId;
    s.publication.publishedAt = publishedAt;
    if (thumbnailAi !== undefined) s.publication.thumbnailAi = thumbnailAi;
    if (thumbnailPath) s.clip.thumbnailFile = path.basename(thumbnailPath);
  });
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
    // Este script ainda usa as credenciais e a config do canal default.
    // Não processar um sidecar de outro canal: publicá-lo aqui poderia
    // mandar um clipe EN para a conta do BR.
    if (side.channelId !== DEFAULT_CHANNEL_ID) {
      console.error(
        `${name}: canal ${side.channelId} — upload-vod-clips ainda processa somente o canal ${DEFAULT_CHANNEL_ID}`,
      );
      continue;
    }
    const mp4 = path.join(dir, side.clip.file ?? `${name}.mp4`);
    const ace = buildAce(side);
    const existingVod = findVodClip(cfg.DB_PATH, ace);

    // O sidecar pode ter o youtubeId de uma execução anterior enquanto a
    // escrita no banco falhou (ou foi feita por uma versão antiga do
    // script). Reconciliar o registro NÃO reenvia o vídeo.
    if (side.publication?.youtubeId) {
      const videoId = side.publication.youtubeId;
      const publishedAt =
        side.publication.publishedAt ?? existingVod?.publishedAt ?? new Date().toISOString();
      try {
        registerVodClip(cfg.DB_PATH, ace, mp4, cfg.YT_PRIVACY, videoId, {
          publishedAt,
        });
      } catch (e) {
        throw new Error(
          `falha ao reconciliar o clipe VOD ${videoId} no banco: ${String(e)}`,
        );
      }
      console.log(
        `${name}: já enviado (https://youtu.be/${videoId}) — registro no banco reconciliado`,
      );
      continue;
    }

    // O inverso também pode acontecer: o banco foi gravado e o sidecar
    // ficou sem o youtubeId. Recupera o sidecar e não duplica o upload.
    if (existingVod?.youtubeVideoId) {
      const videoId = existingVod.youtubeVideoId;
      const publishedAt = existingVod.publishedAt ?? new Date().toISOString();
      if (!persistPublication(sidecarPath, videoId, publishedAt)) {
        throw new Error(
          `falha ao reconciliar o youtubeId ${videoId} no sidecar (${sidecarPath})`,
        );
      }
      console.log(
        `${name}: já enviado (https://youtu.be/${videoId}) — sidecar reconciliado`,
      );
      continue;
    }

    if (!fs.existsSync(mp4)) {
      console.error(`${name}: mp4 ausente (${mp4}) — pulando`);
      continue;
    }
    // O ace precisa existir antes do upload: se a publicação falhar no
    // meio, a próxima execução encontra o evento e pode reconciliar o
    // registro em vez de criar um segundo clipe.
    insertAce(cfg.DB_PATH, ace, ace.channelId);
    console.log(`\n== ${name} ==`);

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
    // Primeiro persistimos o banco e depois o sidecar. Se uma das escritas
    // falhar, a próxima execução reconcilia a outra pelo videoId — sem
    // reenviar o vídeo.
    const publishedAt = new Date().toISOString();
    let registrationError: unknown = null;
    try {
      registerVodClip(cfg.DB_PATH, ace, mp4, cfg.YT_PRIVACY, videoId, {
        title: metadata?.title ?? null,
        publishedAt,
      });
    } catch (e) {
      // Ainda tentamos gravar o sidecar: com o youtubeId em disco, a
      // próxima rodada consegue reparar o banco sem duplicar o upload.
      registrationError = e;
    }
    const saved = persistPublication(
      sidecarPath,
      videoId,
      publishedAt,
      thumbPath != null,
      thumbPath,
    );
    if (!saved) {
      throw new Error(
        `falha ao gravar o youtubeId no sidecar (${sidecarPath}) — o vídeo JÁ foi enviado (${videoId}); lote interrompido para não reenviar`,
      );
    }
    if (registrationError) {
      throw new Error(
        `falha ao registrar o clipe VOD ${videoId} no banco: ${String(registrationError)}`,
      );
    }
  }
}

/** Executa o pipeline somente quando o arquivo é chamado diretamente. */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
