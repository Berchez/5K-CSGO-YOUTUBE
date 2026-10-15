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
import { buildClip, computeAceEndMs, newestSegmentEndMs, pickSegments, probeConcatSpan, resolveFfprobeBin } from './clipper/clipBuilder.js';
import { uploadClip } from './uploader/youtubeUploader.js';
import type { AceEvent, StreamInfo } from './types.js';
import type { ReferenceImages } from './clipper/referenceImages.js';

// Streams por partida (a página do match raramente muda mid-game —
// buscar 1x evita N page loads por ciclo e rate-limit do Cloudflare).
const streamsCache = new Map<string, StreamInfo[]>();
// Última tentativa SEM streams por partida. Dois casos, TTLs diferentes:
// - vazio DE VERDADE (partida sem transmissão): 10min — sem este TTL a
//   partida reabria aba no browser a CADA poll (45s), churn perpétuo.
// - BLOQUEADO pelo Cloudflare: 60s — não é "sem streams", é soluço do
//   challenge; 10min às cegas custaria aces sem buffer.
const streamsMiss = new Map<string, { at: number; blocked: boolean }>();
const STREAMS_MISS_TTL_MS = 10 * 60_000;
const STREAMS_BLOCKED_TTL_MS = 60_000;

// Referências por partida (foto/logos/mapa): busca 1x, reusa nos aces
// seguintes. Evictada quando a partida sai do ar (guarda bytes de imagens).
const refsCache = new Map<string, ReferenceImages>();

// Aces em construção (handleAce pendente): o poll NÃO apaga o buffer de
// partida com clipe em andamento — o ace do round final é justamente o que
// a espera do fim ancorado pode atravessar. O build trabalha sobre um
// SNAPSHOT dos segmentos; o buffer físico sai no ciclo seguinte.
const pendingClips = new Set<string>();
const deferredBufferCleanup = new Set<string>();

/** Copia os segmentos escolhidos PRESERVANDO o mtime (pipeline mtime-driven). */
function snapshotSegments(files: string[], destDir: string): string[] {
  fs.mkdirSync(destDir, { recursive: true });
  const out: string[] = [];
  for (const f of files) {
    const dest = path.join(destDir, path.basename(f));
    fs.copyFileSync(f, dest);
    const st = fs.statSync(f);
    fs.utimesSync(dest, st.atime, st.mtime);
    out.push(dest);
  }
  return out;
}

async function getRefs(
  matchId: string,
  player: string,
  team1: string,
  team2: string,
  map: string,
  clipsDir: string,
  hltvProfileDir?: string,
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
    hltvProfileDir,
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
  pendingClips.add(matchId);
  let snapDir: string | null = null;
  try {
    let segments = recorder?.listSegments() ?? [];
    if (segments.length === 0) {
      log.warn('sem buffer para cortar (stream caiu ou iniciou agora), evento salvo sem clipe');
      return;
    }
    // Referências visuais rodam EM PARALELO à espera do buffer (browser
    // + downloads podem levar minutos; antes somavam na latência do clipe).
    const refsPromise = getRefs(matchId, ace.player, ace.team1, ace.team2, ace.map, cfg.CLIPS_DIR, cfg.HLTV_PROFILE).catch(
      () => ({}) as ReferenceImages,
    );
    // Fim ancorado no PRÓXIMO round: volta ao fechamento REAL do round
    // (detecção − lag do placar) e anda CLIP_END_AFTER_CLOSE_SEC — mirando
    // ~5s antes da ação do round seguinte (win panel + freeze ≈ 13s). A
    // âncora antiga (detecção + delay + cauda) caía 10-20s DENTRO do próximo
    // round por causa do lag do placar — clipe sangrava rounds seguintes.
    // Em timeout/pausa tática o gap estica e a margem só cresce (seguro).
    const endMs = computeAceEndMs(Date.now(), cfg.SCOREBOARD_DELAY_MS, cfg.CLIP_END_AFTER_CLOSE_SEC);
    let endCovered = false;
    const waitUntil = Date.now() + 150_000;
    while (!stopping && Date.now() < waitUntil) {
      segments = recorder?.listSegments() ?? [];
      if (segments.length === 0) break;
      if (newestSegmentEndMs(segments) >= endMs + cfg.SEGMENT_TIME_SEC * 1000 + 5_000) {
        endCovered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (segments.length === 0) {
      log.warn('sem buffer para cortar (stream caiu ou iniciou agora), evento salvo sem clipe');
      return;
    }
    const aceEndMs = endCovered ? endMs : undefined;
    if (endCovered) {
      ace.endedAt = new Date(endMs).toISOString();
    } else {
      log.warn('buffer não alcançou o fim a tempo, cortando cauda atual (fallback)');
    }

    // SNAPSHOT dos segmentos escolhidos: o buffer é CIRCULAR (SEGMENT_WRAP
    // sobrescreve os arquivos) e a partida pode sair do ar (poll para o
    // recorder e apaga o buffer) enquanto refs/render/thumb ainda rodam —
    // minutos. Copia preservando mtime (seleção/trim são mtime-driven) e
    // constrói o clipe a partir da cópia imune ao churn do buffer.
    const picked = pickSegments(segments, {
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      preRollSec: cfg.CLIP_PRE_ROLL_SEC,
      postRollSec: cfg.CLIP_POST_ROLL_SEC,
      contextSec: cfg.CLIP_CONTEXT_SEC,
      aceStartMs: ace.startedAt ? Date.parse(ace.startedAt) : undefined,
      aceEndMs,
    });
    snapDir = path.join(cfg.CLIPS_DIR, '.build', `${matchId}-r${ace.round}-${Date.now()}`);
    const snapshot = snapshotSegments(picked, snapDir);
    log.info({ picked: picked.length, snap: path.basename(snapDir) }, 'segmentos congelados (snapshot)');
    // Span REAL medido nos ORIGINAIS (birthtime intacto — cópias perdem):
    // segmento que nunca cortou cobre minutos, não `slot`. Sem medição o
    // trim assume n × slot e ancora fora do material (clipe gigante).
    let concatSpanSec: number | undefined;
    try {
      const span = await probeConcatSpan(picked, resolveFfprobeBin(), cfg.SEGMENT_TIME_SEC);
      if (span) {
        log.info({ spanSec: span.spanSec, reliable: span.reliable, files: picked.length }, 'span do concat medido');
        if (span.reliable) concatSpanSec = span.spanSec;
      }
    } catch {
      // best-effort: segue com o cálculo legado
    }

    try {
      const references = await refsPromise;
      const clip = await buildClip(ace, snapshot, {
        bufferDir: snapDir,
        clipsDir: cfg.CLIPS_DIR,
        preRollSec: cfg.CLIP_PRE_ROLL_SEC,
        postRollSec: cfg.CLIP_POST_ROLL_SEC,
        segmentTimeSec: cfg.SEGMENT_TIME_SEC,
        contextSec: cfg.CLIP_CONTEXT_SEC,
        aceStartMs: ace.startedAt ? Date.parse(ace.startedAt) : undefined,
        aceEndMs,
        concatSpanSec,
        avSync: cfg.CLIP_AV_SYNC,
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
      if (!cfg.YT_UPLOAD) {
        log.info({ clip: clip.filePath }, 'upload desativado (YT_UPLOAD=false) — clipe mantido local');
      } else {
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
      }
      insertClip(cfg.DB_PATH, aceId, clip.filePath, cfg.YT_PRIVACY, videoId);
    } finally {
      fs.rmSync(snapDir, { recursive: true, force: true });
    }
  } catch (e) {
    log.error({ err: String(e) }, 'falha ao montar clipe');
  } finally {
    pendingClips.delete(matchId);
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
        // Vazia/bloqueada entra com TTL negativo em vez de rebuscar a cada
        // ciclo — cada rebusca é uma aba nova no browser.
        let streams = streamsCache.get(m.matchId);
        if (!streams) {
          const miss = streamsMiss.get(m.matchId);
          const missTtl = miss?.blocked ? STREAMS_BLOCKED_TTL_MS : STREAMS_MISS_TTL_MS;
          if (miss && Date.now() - miss.at < missTtl) {
            streams = [];
          } else {
            const fetched = await fetchMatchStreams(m.matchPageUrl);
            if (fetched == null) {
              // Bloqueado pelo Cloudflare ≠ sem streams: retry curto, não
              // 10min às cegas (aces desse intervalo ficariam sem buffer).
              streamsMiss.set(m.matchId, { at: Date.now(), blocked: true });
              streams = [];
            } else if (fetched.length > 0) {
              streamsCache.set(m.matchId, fetched);
              streams = fetched;
            } else {
              streamsMiss.set(m.matchId, { at: Date.now(), blocked: false });
              streams = [];
            }
          }
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
      streamsMiss.delete(id);
      refsCache.delete(id);
      if (pendingClips.has(id)) {
        // Ace do round final ainda em construção: o snapshot protege o
        // build, mas apagar o buffer agora mataria recorders legítimos de
        // retomada — sai no próximo ciclo, quando o clipe terminar.
        deferredBufferCleanup.add(id);
        log.info({ matchId: id }, 'partida fora do ar com clipe pendente, buffer preservado');
      } else {
        fs.rmSync(`${cfg.BUFFER_DIR}/${id}`, { recursive: true, force: true });
        log.info({ matchId: id }, 'partida fora do ar, gravação parada');
      }
    }
  }
  // Buffers adiados cujo clipe pendente já terminou.
  for (const id of deferredBufferCleanup) {
    if (!pendingClips.has(id)) {
      fs.rmSync(`${cfg.BUFFER_DIR}/${id}`, { recursive: true, force: true });
      deferredBufferCleanup.delete(id);
      log.info({ matchId: id }, 'buffer de partida encerrada removido');
    }
  }

  // 4) Faxina de abas about:blank presas (navegação que nunca commitou).
  // Best-effort: nunca derruba o poll.
  try {
    const { sweepStaleBlankPages } = await import('./monitor/hltvMonitor.js');
    await sweepStaleBlankPages();
  } catch {
    // segue
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
      avSync: cfg.CLIP_AV_SYNC,
      upload: cfg.YT_UPLOAD,
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
