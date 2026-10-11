import fs from 'node:fs';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { getDb, hasAce, insertAce, insertClip } from './db.js';
import {
  closeBrowser,
  fetchLiveMatches,
  fetchMatchStreams,
  pickPreferredStream,
} from './monitor/hltvMonitor.js';
import { trackMatch } from './detector/matchTracker.js';
import { StreamRecorder } from './recorder/streamRecorder.js';
import { buildClip } from './clipper/clipBuilder.js';
import { uploadClip } from './uploader/youtubeUploader.js';
import type { AceEvent } from './types.js';

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
    const clip = await buildClip(ace, segments, {
      bufferDir: `${cfg.BUFFER_DIR}/${matchId}`,
      clipsDir: cfg.CLIPS_DIR,
      preRollSec: cfg.CLIP_PRE_ROLL_SEC,
      postRollSec: cfg.CLIP_POST_ROLL_SEC,
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
    });
    let videoId: string | undefined;
    try {
      videoId = await uploadClip(ace, clip.filePath, {
        clientSecretsPath: cfg.YT_CLIENT_SECRETS,
        tokenPath: cfg.YT_TOKEN_PATH,
        privacy: cfg.YT_PRIVACY,
        categoryId: cfg.YT_CATEGORY_ID,
        defaultTags: cfg.YT_DEFAULT_TAGS,
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

  for (const m of matches) {
    if (stopping) break;

    // 1) Recorder (máx MAX_RECORDINGS, só oficiais EN por preferência)
    if (!activeRecorders.has(m.matchId) && activeRecorders.size < cfg.MAX_RECORDINGS) {
      try {
        if (m.streams.length === 0) {
          m.streams = await fetchMatchStreams(m.matchPageUrl);
        }
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
        onAce: (a) =>
          handleAce(
            {
              matchId: m.matchId,
              map: a.map,
              round: a.round,
              player: a.player,
              team1: m.team1,
              team2: m.team2,
              event: m.event,
              detectedAt: new Date().toISOString(),
              kills: a.kills.map((kk) => ({ ...kk, map: a.map })),
            },
            m.matchId,
            cfg,
          ).catch((e) => log.error({ err: String(e) }, 'erro no handleAce')),
      })
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
      log.info({ matchId: id }, 'partida fora do ar, gravação parada');
    }
  }
}

async function main(): Promise<void> {
  const cfg = getConfig();
  await ensureDirs(cfg);
  const log = getLogger();
  log.info(
    {
      minStars: cfg.MIN_STARS,
      privacy: cfg.YT_PRIVACY,
      maxRec: cfg.MAX_RECORDINGS,
    },
    '5K bot iniciado (MVP: só 5k live, 16:9, log em arquivo)',
  );

  const bins = StreamRecorder.checkBinaries();
  if (!bins.ffmpeg || !bins.streamlink) {
    log.warn(
      'ffmpeg/streamlink ausentes. Instale com: winget install Gyan.FFmpeg; winget install Streamlink.Streamlink — e reinicie o terminal.',
    );
  }

  const shutdown = async (): Promise<void> => {
    stopping = true;
    for (const rec of activeRecorders.values()) await rec.stop().catch(() => undefined);
    await closeBrowser();
    log.info('encerrado');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

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
