import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { getDb, hasAce, insertAce, insertClip } from './db.js';
import { killAll } from './procRegistry.js';
import {
  closeBrowser,
  fetchLiveMatches,
  fetchMatchStreams,
  pickPreferredStream,
} from './monitor/hltvMonitor.js';
import { trackMatch } from './detector/matchTracker.js';
import { buildRoundSummary, describeAce } from './detector/aceDetector.js';
import { StreamRecorder } from './recorder/streamRecorder.js';
import { buildClip } from './clipper/clipBuilder.js';
import { uploadClip } from './uploader/youtubeUploader.js';
import type { AceEvent, StreamInfo } from './types.js';
import type { ReferenceImages } from './clipper/referenceImages.js';

// Streams por partida (a página do match raramente muda mid-game —
// buscar 1x evita N page loads por ciclo e rate-limit do Cloudflare).
const streamsCache = new Map<string, StreamInfo[]>();

// Referências por partida (foto/logos/mapa): busca 1x, reusa nos aces seguintes.
const refsCache = new Map<string, ReferenceImages>();

async function getRefs(
  matchId: string,
  player: string,
  team1: string,
  team2: string,
  map: string,
  clipsDir: string,
): Promise<ReferenceImages> {
  const hit = refsCache.get(matchId);
  if (hit) return hit;
  const { fetchReferenceImages } = await import('./clipper/referenceImages.js');
  const refs = await fetchReferenceImages({
    player,
    team1,
    team2,
    map,
    dir: `${clipsDir}/refs/${matchId}`,
  });
  refsCache.set(matchId, refs);
  return refs;
}

const activeRecorders = new Map<string, StreamRecorder>();
const activeTrackers = new Set<string>();
let stopping = false;

async function ensureDirs(cfg: ReturnType<typeof getConfig>): Promise<void> {
  fs.mkdirSync(cfg.BUFFER_DIR, { recursive: true });
  fs.mkdirSync(cfg.CLIPS_DIR, { recursive: true });
  fs.mkdirSync('./logs', { recursive: true });
  fs.mkdirSync('./data', { recursive: true });
}

function twitchUrlFrom(streamUrl: string): string {
  if (/^https?:\/\//.test(streamUrl)) return streamUrl;
  if (/twitch\.tv/.test(streamUrl)) return streamUrl;
  return streamUrl;
}

async function handleAce(
  ace: AceEvent,
  matchId: string,
  cfg: ReturnType<typeof getConfig>,
): Promise<void> {
  const log = getLogger();
  if (hasAce(cfg.DB_PATH, ace.matchId, ace.map, ace.round, ace.player)) {
    log.info('ace duplicado, ignorando');
    return;
  }
  const aceId = insertAce(cfg.DB_PATH, ace);
  const recorder = activeRecorders.get(matchId);
  const segments = recorder?.listSegments() ?? [];
  if (segments.length === 0) {
    log.warn('sem buffer para cortar (stream caiu ou iniciou agora), evento salvo sem clipe');
    return;
  }
  try {
    // Referências visuais (foto/logos/mapa) — best-effort, em paralelo ao corte
    const references = await getRefs(matchId, ace.player, ace.team1, ace.team2, ace.map, cfg.CLIPS_DIR).catch(
      () => ({}) as ReferenceImages,
    );
    const clip = await buildClip(ace, segments, {
      bufferDir: `${cfg.BUFFER_DIR}/${matchId}`,
      clipsDir: cfg.CLIPS_DIR,
      preRollSec: cfg.CLIP_PRE_ROLL_SEC,
      postRollSec: cfg.CLIP_POST_ROLL_SEC,
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      contextSec: cfg.CLIP_CONTEXT_SEC,
      aceStartMs: ace.startedAt ? Date.parse(ace.startedAt) : undefined,
      upscaleHeight: cfg.CLIP_UPSCALE_HEIGHT || undefined,
      thumb: {
        mode: cfg.THUMB_MODE,
        ai: {
          order: cfg.THUMB_AI_ORDER.split(',').map((s) => s.trim()).filter(Boolean) as Array<'huggingface' | 'pollinations' | 'gemini' | 'gemini-web' | 'chatgpt' | 'grok'>,
          timeoutMs: cfg.THUMB_AI_TIMEOUT_MS,
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
      },
    });
    let videoId: string | undefined;
    try {
      videoId = await uploadClip(ace, clip.filePath, {
        clientSecretsPath: cfg.YT_CLIENT_SECRETS,
        tokenPath: cfg.YT_TOKEN_PATH,
        privacy: cfg.YT_PRIVACY,
        categoryId: cfg.YT_CATEGORY_ID,
        defaultTags: cfg.YT_DEFAULT_TAGS,
        thumbnailPath: clip.thumbnailPath,
      });
    } catch (e) {
      log.error({ err: String(e) }, 'falha no upload YT — clipe mantido local para retry manual');
    }
    insertClip(cfg.DB_PATH, aceId, clip.filePath, cfg.YT_PRIVACY, videoId);
  } catch (e) {
    log.error({ err: String(e) }, 'falha ao montar clipe');
  }
}

async function pollOnce(): Promise<void> {
  const cfg = getConfig();
  const log = getLogger();
  getDb(cfg.DB_PATH);

  const matches = await fetchLiveMatches(
    cfg.HLTV_MATCHES_URL,
    cfg.MIN_STARS,
    cfg.TOP_TIER_ONLY,
  );
  if (!matches) {
    log.warn('listing bloqueado pelo Cloudflare — mantendo recorders/trackers');
    return;
  }

  for (const m of matches) {
    if (stopping) break;

    // 1) Recorder (máx MAX_RECORDINGS, stream por STREAM_PRIORITY)
    // Recorders mortos (stream caiu/URL expirou) são descartados p/ recriar.
    for (const [id, rec] of activeRecorders) {
      if (!rec.isRunning) {
        await rec.stop().catch(() => undefined);
        activeRecorders.delete(id);
        log.info({ matchId: id }, 'recorder morto, vai recriar');
      }
    }
    // Recorders mortos (stream caiu/URL expirou) são descartados p/ recriar.
    if (!activeRecorders.has(m.matchId) && activeRecorders.size < cfg.MAX_RECORDINGS) {
      try {
        // Cache: a lista de streams quase não muda mid-match.
        // Só busca de novo se nunca achou nada (vazia não entra no cache
        // para tentar de novo quando o Cloudflare liberar).
        let streams = streamsCache.get(m.matchId);
        if (!streams) {
          streams = await fetchMatchStreams(m.matchPageUrl);
          if (streams.length > 0) streamsCache.set(m.matchId, streams);
        }
        m.streams = streams;
        const chosen = pickPreferredStream(m.streams, cfg.STREAM_PRIORITY);
        if (!chosen) {
          log.info({ matchId: m.matchId }, 'sem stream disponível, pulando gravação');
        } else {
          const rec = new StreamRecorder({
            streamUrl: twitchUrlFrom(chosen.url),
            bufferDir: `${cfg.BUFFER_DIR}/${m.matchId}`,
            segmentTimeSec: cfg.SEGMENT_TIME_SEC,
            segmentWrap: cfg.SEGMENT_WRAP,
          });
          await rec.start();
          activeRecorders.set(m.matchId, rec);
          log.info({ matchId: m.matchId, stream: chosen.name }, 'gravando buffer');
        }
      } catch (e) {
        log.warn({ err: String(e), matchId: m.matchId }, 'não foi possível iniciar gravação');
      }
    }

    // 2) Tracker de ace (1 por partida)
    if (!activeTrackers.has(m.matchId)) {
      activeTrackers.add(m.matchId);
      trackMatch(m.matchPageUrl, m.matchId, {
        shouldStop: () => stopping || !activeTrackers.has(m.matchId),
        onAce: (a) => {
          // Time do autor desconhecido no live: resumo com confronto completo.
          const summary = buildRoundSummary(
            a.player,
            '',
            `${m.team1} vs ${m.team2}`,
            a.kills,
          );
          log.info(
            { summary: describeAce(summary, m.event).split('\n')[0] },
            'resumo do ace',
          );
          return handleAce(
            {
              matchId: m.matchId,
              map: a.map,
              round: a.round,
              player: a.player,
              team1: m.team1,
              team2: m.team2,
              event: m.event,
              detectedAt: new Date().toISOString(),
              startedAt: a.startedAt,
              kills: a.kills.map((kk) => ({ ...kk, map: a.map })),
              summary,
            },
            m.matchId,
            cfg,
          ).catch((e) => log.error({ err: String(e) }, 'erro no handleAce'));
        },
      }, cfg.MIN_KILLS)
        .catch((e) => log.warn({ err: String(e) }, 'tracker encerrou com erro'))
        .finally(() => {
          activeTrackers.delete(m.matchId);
          log.info({ matchId: m.matchId }, 'tracking encerrado');
        });
    }
  }

  // 3) Limpa recorders de partidas que saíram do filtro
  const liveIds = new Set(matches.map((m) => m.matchId));
  for (const [id, rec] of activeRecorders) {
    if (!liveIds.has(id)) {
      await rec.stop().catch(() => undefined);
      activeRecorders.delete(id);
      activeTrackers.delete(id);
      streamsCache.delete(id);
      fs.rmSync(`${cfg.BUFFER_DIR}/${id}`, { recursive: true, force: true });
      log.info({ matchId: id }, 'partida fora do ar, gravação parada');
    }
  }
}

async function main(): Promise<void> {
  const cfg = getConfig();
  // Bins vendored (.tools/ffmpeg do repo) no PATH — o clipper chama
  // 'ffmpeg' pelo nome (concat, thumb, upscale). Igual ao test-vod.
  process.env.PATH = `${path.resolve('.tools')}${path.delimiter}${process.env.PATH ?? ''}`;
  await ensureDirs(cfg);
  const log = getLogger();
  log.info(
    {
      minStars: cfg.MIN_STARS,
      minKills: cfg.MIN_KILLS,
      stream: cfg.STREAM_PRIORITY,
      privacy: cfg.YT_PRIVACY,
      maxRec: cfg.MAX_RECORDINGS,
    },
    `bot iniciado (multikills ${cfg.MIN_KILLS}k+ live, 16:9, log em arquivo)`,
  );

  const bins = StreamRecorder.checkBinaries();
  if (!bins.ffmpeg || !bins.ytdlp) {
    log.warn(
      'ffmpeg/yt-dlp ausentes (nem no PATH nem em .tools/). Sem eles não há buffer local — o bot só detecta, sem cortar clipes.',
    );
  }

  const shutdown = async (): Promise<void> => {
    stopping = true;
    for (const rec of activeRecorders.values()) await rec.stop().catch(() => undefined);
    await closeBrowser();
    // Mata qualquer ffmpeg restante (render em andamento etc.) — o Windows
    // NÃO mata filhos quando o pai morre; sem isso viram órfãos de CPU.
    killAll();
    log.info('encerrado');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Última linha de defesa: mortes SEM sinal (kill direto/crash) —
  // síncrono e best-effort (taskkill por PID dos trackeados).
  process.on('exit', () => killAll());

  while (!stopping) {
    try {
      await pollOnce();
    } catch (e) {
      log.error({ err: String(e) }, 'erro no ciclo de poll');
    }
    await new Promise((r) => setTimeout(r, cfg.POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
