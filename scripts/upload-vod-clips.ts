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
  /** Time do JOGADOR (vem da demo) — evita assumir team2 e errar o rival. */
  playerTeam?: string;
  /** Time RIVAL (vem da demo). */
  opponentTeam?: string;
  event: string;
  kills: Array<{
    killer: string;
    victim: string;
    weapon: string;
    headshot: boolean;
    atVodSec: number;
    /** `at` no relógio do HLTV (epoch ms ou ISO) — quando existe. */
    at?: string | number;
    /** A posição no VOD foi ESTIMADA (o OCR não achou a linha). */
    appearEstimated?: boolean;
  }>;
  roundWinner?: string;
  /** Início do VOD (epoch ms) — o `vod.vodStartIso` tem o mesmo valor. */
  vod?: { vodStartIso?: string; videoId?: string };
  /**
   * Offset (ms) entre o relógio do HLTV (`kills[].at`) e o relógio do
   * VÍDEO. `at + offset` = o instante da kill no vídeo.
   */
  killVideoOffsetMs?: number;
  clipStartMs: number;
  clipDurationSec: number;
  clipFile: string;
  thumbnailFile?: string | null;
  youtubeId?: string;
  thumbnailAi?: boolean;
}

/** Epoch ms do início do VOD (o sidecar tem o valor; o fallback é o fixo). */
function vodStartMs(side: VodSidecar): number {
  const fromSide = side.vod?.vodStartIso ? Date.parse(side.vod.vodStartIso) : NaN;
  return Number.isFinite(fromSide) ? fromSide : VOD_START_MS;
}

function buildAce(side: VodSidecar): { ace: AceEvent; killTimeOffsetMs: number } {
  const startMs = vodStartMs(side);
  // O sidecar novo traz `at` no relógio do HLTV + `killVideoOffsetMs`
  // (o offset converte para o relógio do vídeo). O antigo não tem: aí a
  // posição vem do `atVodSec`, que já é a timeline do VOD.
  const offsetMs = Number.isFinite(side.killVideoOffsetMs) ? Number(side.killVideoOffsetMs) : null;
  const kills: KillEvent[] = side.kills.map((k) => {
    const atHltv = typeof k.at === 'number' ? k.at : Date.parse(String(k.at ?? ''));
    return {
      killer: k.killer ?? '',
      victim: k.victim ?? '',
      round: side.round,
      map: side.map,
      // `at` na timeline do VOD: com killTimeOffsetMs = 0, os timestamps da
      // descrição saem da posição real no vídeo (o killfeed já mediu).
      at:
        offsetMs != null && Number.isFinite(atHltv)
          ? atHltv
          : Math.round(startMs + k.atVodSec * 1000),
      weapon: k.weapon ?? '',
      headshot: Boolean(k.headshot),
      // Kill com posição ESTIMADA não entra com timestamp: a descrição
      // não pode afirmar um horário que ninguém mediu.
      estimated: Boolean(k.appearEstimated),
    };
  });
  const weaponCounts = new Map<string, number>();
  for (const k of kills) weaponCounts.set(k.weapon ?? '', (weaponCounts.get(k.weapon ?? '') ?? 0) + 1);
  const mainWeapon = [...weaponCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  // Time do jogador: o sidecar traz o lado real (da demo). O fallback
  // antigo (team2) publicava "contra X" do lado errado quando a info
  // faltava.
  const playerTeam = side.playerTeam || side.team2 || '';
  const opponentTeam =
    side.opponentTeam ||
    (playerTeam && playerTeam === side.team1 ? side.team2 : side.team1) ||
    '';
  const ace: AceEvent = {
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
      team: playerTeam,
      opponents: opponentTeam,
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
  return {
    ace,
    // Com `at` no relógio do HLTV, o offset do sidecar reconverte para o
    // vídeo; sem `at`, o `at` já está na timeline do VOD (offset 0).
    killTimeOffsetMs: offsetMs != null && side.kills.some((k) => k.at != null) ? offsetMs : 0,
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
    const { ace, killTimeOffsetMs } = buildAce(side);

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
    const clipStartSec = (side.clipStartMs - vodStartMs(side)) / 1000;
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
      killTimeOffsetMs,
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
    side.youtubeId = videoId;
    if (thumbPath) side.thumbnailFile = path.basename(thumbPath);
    side.thumbnailAi = thumbPath != null;
    fs.writeFileSync(sidecarPath, JSON.stringify(side, null, 2) + '\n');

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
