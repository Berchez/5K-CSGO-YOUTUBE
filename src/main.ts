import fs from 'node:fs';
import path from 'node:path';
import { getConfig, parseStreamOffsets, resolveStaticOffset } from './config.js';
import { loadCalibrations, resolveSessionOffset } from './recorder/avCalibration.js';
import { loadLoggedOut, loginScriptFor } from './clipper/providerStatus.js';
import { notifyWindows } from './notify.js';
import { getLogger } from './logger.js';
import { getDb, hasAce, insertAce, insertClip } from './db.js';
import { killAll } from './procRegistry.js';
import {
  closeBrowser,
  fetchLiveMatches,
  fetchMatchStreams,
  minKillsForStars,
  pickPreferredStream,
} from './monitor/hltvMonitor.js';
import { trackMatch } from './detector/matchTracker.js';
import { buildRoundSummary, describeAce, isAnchorLowConfidence } from './detector/aceDetector.js';
import { StreamRecorder } from './recorder/streamRecorder.js';
import { buildClip, computeAceEndMs, detectTruncatedStart, newestSegmentEndMs, pickSegments } from './clipper/clipBuilder.js';
import { scanKillfeedForStreamOffset } from './clipper/killfeedSync.js';
import { uploadClip } from './uploader/youtubeUploader.js';
import type { AceEvent, ClipResult, StreamInfo } from './types.js';
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

interface MatchRecorders {
  separate: StreamRecorder;
  muxed: StreamRecorder | null;
}

const activeRecorders = new Map<string, MatchRecorders>();
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

/** Offset aplicável + registro persistido (ace.streamSync) da calibração OCR. */
interface StreamSyncMeasurement {
  /** Offset a somar às âncoras; 0 quando não aplicado (log/off/sem confiança). */
  offsetMs: number;
  /** Registro gravado no sidecar independentemente de o offset ser aplicado. */
  sync: NonNullable<AceEvent['streamSync']>;
}

/**
 * Mede o atraso da fonte comparando as kills do placar com o killfeed OCR e
 * decide se aplica (só em 'auto' e com confiança). Nunca lança: em erro ou
 * indisponibilidade devolve offset 0 + motivo. (Extraído de handleAce para
 * manter o fluxo do clipe legível.)
 */
async function measureStreamOffset(
  ace: AceEvent,
  cfg: ReturnType<typeof getConfig>,
  recorder: StreamRecorder | undefined,
  shouldStop: () => boolean,
): Promise<StreamSyncMeasurement> {
  const log = getLogger();
  const mode = cfg.CLIP_STREAM_SYNC;
  const totalKills = ace.kills.filter((kill) => Number.isFinite(kill.at)).length;
  const skip = (reason: string): StreamSyncMeasurement => ({
    offsetMs: 0,
    sync: { mode, applied: false, offsetMs: null, matchedKills: 0, totalKills, medianDeviationMs: null, reason },
  });

  if (mode === 'off') return skip('disabled');
  if (!recorder?.isRunning) {
    log.warn(
      { matchId: ace.matchId, stream: recorder?.streamName },
      'calibragem OCR indisponível — mantendo âncoras originais',
    );
    return skip('recorder-unavailable');
  }

  try {
    const estimate = await scanKillfeedForStreamOffset({
      kills: ace.kills,
      scoreboardDelayMs: cfg.SCOREBOARD_DELAY_MS,
      maxLagSec: cfg.CLIP_STREAM_SYNC_MAX_LAG_SEC,
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      listSegments: () => recorder.listSegments(),
      shouldStop,
    });
    const applied = mode === 'auto' && estimate.offsetMs != null;
    const sync: StreamSyncMeasurement['sync'] = {
      mode,
      applied,
      offsetMs: estimate.offsetMs,
      matchedKills: estimate.matchedKills,
      totalKills: estimate.totalKills,
      medianDeviationMs: estimate.medianDeviationMs,
      reason: estimate.reason,
    };
    const details = { matchId: ace.matchId, stream: recorder.streamName, ...sync };
    if (applied) {
      log.info(details, 'atraso da fonte medido por OCR');
    } else {
      log.warn(details, 'calibragem OCR sem confiança — mantendo âncoras originais');
    }
    return { offsetMs: applied ? estimate.offsetMs! : 0, sync };
  } catch (e) {
    log.warn(
      { err: String(e), matchId: ace.matchId, stream: recorder.streamName },
      'calibragem OCR falhou — mantendo âncoras originais',
    );
    return skip('scan-error');
  }
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
  const recorders = activeRecorders.get(matchId);
  const recorder = recorders?.separate;
  const muxedRecorder = recorders?.muxed;
  pendingClips.add(matchId);
  const snapDirs: string[] = [];
  try {
    let segments = recorder?.listSegments() ?? [];
    let muxedSegments = muxedRecorder?.listSegments() ?? [];
    if (segments.length === 0) {
      log.warn('sem buffer para cortar (stream caiu ou iniciou agora), evento salvo sem clipe');
      return;
    }
    // Referências visuais rodam EM PARALELO à espera do buffer (browser
    // + downloads podem levar minutos; antes somavam na latência do clipe).
    const refsPromise = getRefs(matchId, ace.player, ace.team1, ace.team2, ace.map, cfg.CLIPS_DIR, cfg.HLTV_PROFILE).catch(
      () => ({}) as ReferenceImages,
    );
    const aceDetectedAtMs = Date.now();
    const syncRecorder = muxedRecorder ?? recorder;
    const { offsetMs: streamOffsetMs, sync: streamSync } = await measureStreamOffset(
      ace,
      cfg,
      syncRecorder,
      () => stopping,
    );
    ace.streamSync = streamSync;
    const uncorrectedStartMs = ace.startedAt ? Date.parse(ace.startedAt) : undefined;
    const aceStartMs =
      uncorrectedStartMs != null ? uncorrectedStartMs + streamOffsetMs : undefined;
    if (aceStartMs != null && streamOffsetMs !== 0) {
      ace.startedAt = new Date(aceStartMs).toISOString();
    }
    // Fim ancorado no PRÓXIMO round: volta ao fechamento REAL do round
    // (detecção − lag do placar) e anda CLIP_END_AFTER_CLOSE_SEC — mirando
    // ~5s antes da ação do round seguinte (win panel + freeze ≈ 13s). A
    // âncora antiga (detecção + delay + cauda) caía 10-20s DENTRO do próximo
    // round por causa do lag do placar — clipe sangrava rounds seguintes.
    // Em timeout/pausa tática o gap estica e a margem só cresce (seguro).
    const endMs =
      computeAceEndMs(aceDetectedAtMs, cfg.SCOREBOARD_DELAY_MS, cfg.CLIP_END_AFTER_CLOSE_SEC) +
      streamOffsetMs;
    let endCovered = false;
    let muxedEndCovered = false;
    const waitUntil =
      Date.now() +
      Math.max(150_000, Math.max(0, streamOffsetMs) + cfg.SEGMENT_TIME_SEC * 1000 + 20_000);
    while (!stopping && Date.now() < waitUntil) {
      segments = recorder?.listSegments() ?? [];
      muxedSegments = muxedRecorder?.listSegments() ?? [];
      if (segments.length === 0) break;
      endCovered =
        newestSegmentEndMs(segments) >= endMs + cfg.SEGMENT_TIME_SEC * 1000 + 5_000;
      muxedEndCovered =
        muxedRecorder != null &&
        newestSegmentEndMs(muxedSegments) >= endMs + cfg.SEGMENT_TIME_SEC * 1000 + 5_000;
      const muxedReady =
        muxedRecorder == null || !muxedRecorder.isRunning || muxedEndCovered;
      if (endCovered && muxedReady) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (segments.length === 0) {
      log.warn('sem buffer para cortar (stream caiu ou iniciou agora), evento salvo sem clipe');
      return;
    }
    const aceEndMs = endCovered ? endMs : undefined;
    const muxedAceEndMs = muxedEndCovered ? endMs : undefined;
    if (endCovered) {
      ace.endedAt = new Date(endMs).toISOString();
    } else {
      log.warn('buffer não alcançou o fim a tempo, cortando cauda atual (fallback)');
    }

    // Contexto adaptativo: âncora de início incerta (tracker entrou no meio
    // do round, resetou a base, ou a 1ª kill veio da janela de assentamento)
    // = a kill pode não ser a 1ª real — começa mais cedo para não perder a
    // abertura. Confiança alta mantém os 10s da especificação.
    const lowAnchor = isAnchorLowConfidence(
      ace.anchorConfidence,
      ace.kills[0]?.at,
      Date.now(),
    );
    const contextSec = lowAnchor ? cfg.CLIP_CONTEXT_UNCERTAIN_SEC : cfg.CLIP_CONTEXT_SEC;
    if (lowAnchor) {
      log.warn({ conf: ace.anchorConfidence }, 'âncora de início incerta — contexto alargado');
    }
    // R2: âncora mais velha que o buffer = abertura real fora do alcance.
    // Sinaliza no sidecar (via ace) em vez de cair no fallback silencioso.
    ace.truncatedStart = detectTruncatedStart(segments, {
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      contextSec,
      aceStartMs,
    });
    if (ace.truncatedStart) {
      log.warn('âncora precede o buffer (truncatedStart): abertura incompleta');
    }
    // Correção A/V do clipe, decidida por sessão (log por clipe):
    // override manual > calibragem do canal válida > nada.
    // A calibragem vale para a sessão corrente sem restart desde então
    // (offset re-rola a cada restart do transcode — r4 sync vs r12 +2s).
    // Sem calibragem aplicável: 0 + flag (spot-check, não revisão total).
    // (recorder vem do início do handleAce.)
    const streamOffsets = parseStreamOffsets(cfg.AV_STREAM_OFFSETS);
    const { ms: staticMs, rule: staticRule } = resolveStaticOffset(
      cfg.AV_STATIC_OFFSET_MS,
      cfg.AV_STATIC_MATCHES,
      matchId,
      streamOffsets,
      recorder?.streamName,
    );
    const calibrations = loadCalibrations();
    const calibration = recorder?.streamName ? calibrations[recorder.streamName] : undefined;
    // Era compartilhada: restart visto por OUTRO recorder do canal também
    // invalida (mesma fonte). Junta ao array local antes de decidir.
    const restarts: number[] = [...(recorder?.discontinuities ?? [])];
    if (calibration?.lastRestartAt) restarts.push(calibration.lastRestartAt);
    const sess = resolveSessionOffset({
      staticMs,
      staticRule,
      calibration,
      streamName: recorder?.streamName,
      sessionStartMs: recorder?.sessionStart,
      discontinuities: restarts,
      winStartMs: aceStartMs,
      winEndMs: aceEndMs,
    });
    ace.offsetUnverified = sess.unverified;
    if (sess.ms > 0) {
      log.info(
        { matchId, staticMs: sess.ms, source: sess.source, rule: staticRule, stream: recorder?.streamName },
        'offset A/V ativo p/ este clipe',
      );
    } else if (sess.unverified) {
      log.warn(
        { matchId, reason: sess.reason, stream: recorder?.streamName },
        'sem correção A/V — conferir sync (spot-check)',
      );
    }

    // SNAPSHOT dos segmentos escolhidos: o buffer é CIRCULAR (SEGMENT_WRAP
    // sobrescreve os arquivos) e a partida pode sair do ar (poll para o
    // recorder e apaga o buffer) enquanto refs/render/thumb ainda rodam —
    // minutos. Copia preservando mtime (seleção/trim são mtime-driven) e
    // constrói o clipe a partir da cópia imune ao churn do buffer.
    const buildVariant = async (
      mode: 'separate' | 'muxed',
      sourceSegments: string[],
      sourceEndMs: number | undefined,
    ): Promise<ClipResult | null> => {
      if (sourceSegments.length === 0) {
        log.warn({ matchId, mode }, 'sem segmentos para esta variante de captura');
        return null;
      }
      const variantAce: AceEvent = {
        ...ace,
        endedAt: sourceEndMs != null ? new Date(sourceEndMs).toISOString() : undefined,
        truncatedStart: detectTruncatedStart(sourceSegments, {
          segmentTimeSec: cfg.SEGMENT_TIME_SEC,
          contextSec,
          aceStartMs,
        }),
        offsetUnverified: mode === 'separate' ? ace.offsetUnverified : undefined,
      };
      const variantPicked = pickSegments(sourceSegments, {
        segmentTimeSec: cfg.SEGMENT_TIME_SEC,
        preRollSec: cfg.CLIP_PRE_ROLL_SEC,
        postRollSec: cfg.CLIP_POST_ROLL_SEC,
        contextSec,
        aceStartMs,
        aceEndMs: sourceEndMs,
      });
      const variantSnapDir = path.join(
        cfg.CLIPS_DIR,
        '.build',
        `${matchId}-r${ace.round}-${Date.now()}-${mode}`,
      );
      snapDirs.push(variantSnapDir);
      const snapshot = snapshotSegments(variantPicked, variantSnapDir);
      log.info(
        { picked: variantPicked.length, snap: path.basename(variantSnapDir), mode },
        'segmentos congelados (snapshot)',
      );
      try {
        const references = mode === 'separate' ? await refsPromise : undefined;
        return await buildClip(variantAce, snapshot, {
          bufferDir: variantSnapDir,
          clipsDir: cfg.CLIPS_DIR,
          preRollSec: cfg.CLIP_PRE_ROLL_SEC,
          postRollSec: cfg.CLIP_POST_ROLL_SEC,
          segmentTimeSec: cfg.SEGMENT_TIME_SEC,
          contextSec,
          aceStartMs,
          aceEndMs: sourceEndMs,
          replayAware: cfg.REPLAY_AWARE,
          avSync: mode === 'separate' ? cfg.CLIP_AV_SYNC : 'off',
          staticAvOffsetMs: mode === 'separate' ? sess.ms : 0,
          diskMinFreeBytes: cfg.DISK_MIN_FREE_GB * 1024 ** 3,
          // The muxed capture is already the source's best format; preserve
          // its native resolution instead of forcing the separate-feed cap.
          upscaleHeight: mode === 'separate' ? cfg.CLIP_UPSCALE_HEIGHT || undefined : undefined,
          outputSuffix: mode === 'muxed' ? '_muxed' : undefined,
          generateThumbnail: mode === 'separate',
          captureMode: mode,
          thumb: mode === 'separate'
            ? {
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
                  references: references ?? {},
                },
              }
            : undefined,
        });
      } catch (e) {
        log.error({ err: String(e), matchId, mode }, 'falha ao montar variante do clipe');
        return null;
      } finally {
        fs.rmSync(variantSnapDir, { recursive: true, force: true });
      }
    };

    const [separateClip, muxedClip] = await Promise.all([
      buildVariant('separate', segments, aceEndMs),
      muxedRecorder
        ? buildVariant('muxed', muxedSegments, muxedAceEndMs)
        : Promise.resolve(null),
    ]);
    const uploadClipResult = muxedClip ?? separateClip;
    if (muxedClip) {
      log.info(
        { clip: muxedClip.filePath, fallback: separateClip?.filePath },
        'preferindo a fonte muxed para upload (A/V da mesma variante de origem)',
      );
    }
    if (uploadClipResult) {
      let videoId: string | undefined;
      if (!cfg.YT_UPLOAD) {
        log.info({ clip: uploadClipResult.filePath }, 'upload desativado (YT_UPLOAD=false) — clipe mantido local');
      } else {
        try {
          videoId = await uploadClip(ace, uploadClipResult.filePath, {
            clientSecretsPath: cfg.YT_CLIENT_SECRETS,
            tokenPath: cfg.YT_TOKEN_PATH,
            privacy: cfg.YT_PRIVACY,
            categoryId: cfg.YT_CATEGORY_ID,
            defaultTags: cfg.YT_DEFAULT_TAGS,
            thumbnailPath: separateClip?.thumbnailPath,
          });
        } catch (e) {
          log.error({ err: String(e) }, 'falha no upload YT — clipe mantido local para retry manual');
        }
      }
      insertClip(cfg.DB_PATH, aceId, uploadClipResult.filePath, cfg.YT_PRIVACY, videoId);
    }
    if (separateClip && separateClip.filePath !== uploadClipResult?.filePath) {
      insertClip(cfg.DB_PATH, aceId, separateClip.filePath, cfg.YT_PRIVACY);
    }
    if (muxedClip && muxedClip.filePath !== uploadClipResult?.filePath) {
      insertClip(cfg.DB_PATH, aceId, muxedClip.filePath, cfg.YT_PRIVACY);
    }
  } catch (e) {
    log.error({ err: String(e) }, 'falha ao montar clipe');
  } finally {
    for (const dir of snapDirs) fs.rmSync(dir, { recursive: true, force: true });
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
    for (const [id, recorders] of activeRecorders) {
      if (!recorders.separate.isRunning) {
        await Promise.all([
          recorders.separate.stop().catch(() => undefined),
          recorders.muxed?.stop().catch(() => undefined),
        ]);
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
          const streamUrl = twitchUrlFrom(chosen.url);
          const separate = new StreamRecorder({
            streamUrl,
            bufferDir: `${cfg.BUFFER_DIR}/${m.matchId}/separate`,
            segmentTimeSec: cfg.SEGMENT_TIME_SEC,
            segmentWrap: cfg.SEGMENT_WRAP,
            captureMode: 'separate',
            streamName: chosen.name,
            diskMinFreeBytes: cfg.DISK_MIN_FREE_GB * 1024 ** 3,
          });
          const muxed = new StreamRecorder({
            streamUrl,
            bufferDir: `${cfg.BUFFER_DIR}/${m.matchId}/muxed`,
            segmentTimeSec: cfg.SEGMENT_TIME_SEC,
            segmentWrap: cfg.SEGMENT_WRAP,
            captureMode: 'muxed',
            streamName: chosen.name,
            diskMinFreeBytes: cfg.DISK_MIN_FREE_GB * 1024 ** 3,
          });
          const [separateStart, muxedStart] = await Promise.allSettled([
            separate.start(),
            muxed.start(),
          ]);
          if (separateStart.status === 'rejected') {
            await Promise.all([
              separate.stop().catch(() => undefined),
              muxed.stop().catch(() => undefined),
            ]);
            throw separateStart.reason;
          }
          let muxedRecorder: StreamRecorder | null = null;
          if (muxedStart.status === 'fulfilled') {
            muxedRecorder = muxed;
          } else {
            await muxed.stop().catch(() => undefined);
            fs.rmSync(muxed.segmentDir, { recursive: true, force: true });
            log.warn(
              { err: String(muxedStart.reason), matchId: m.matchId, stream: chosen.name },
              'fonte sem variante muxed acessível; mantendo captura separada',
            );
          }
          activeRecorders.set(m.matchId, { separate, muxed: muxedRecorder });
          log.info(
            { matchId: m.matchId, stream: chosen.name, muxed: muxedRecorder != null },
            'gravando buffers separados e muxed',
          );
        }
      } catch (e) {
        log.warn({ err: String(e), matchId: m.matchId }, 'não foi possível iniciar gravação');
      }
    }

    // 2) Tracker de ace (1 por partida)
    if (!activeTrackers.has(m.matchId)) {
      const minKills = minKillsForStars(m.stars, cfg.MIN_KILLS, cfg.MIN_KILLS_NO_STARS);
      activeTrackers.add(m.matchId);
      log.info({ matchId: m.matchId, stars: m.stars, minKills }, 'iniciando tracker de multikill');
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
              anchorConfidence: a.anchorConfidence,
              summary,
            },
            m.matchId,
            cfg,
          ).catch((e) => log.error({ err: String(e) }, 'erro no handleAce'));
        },
      }, minKills)
        .catch((e) => log.warn({ err: String(e) }, 'tracker encerrou com erro'))
        .finally(() => {
          activeTrackers.delete(m.matchId);
          log.info({ matchId: m.matchId }, 'tracking encerrado');
        });
    }
  }

  // 3) Limpa recorders de partidas que saíram do filtro
  const liveIds = new Set(matches.map((m) => m.matchId));
  for (const [id, recorders] of activeRecorders) {
    if (!liveIds.has(id)) {
      await Promise.all([
        recorders.separate.stop().catch(() => undefined),
        recorders.muxed?.stop().catch(() => undefined),
      ]);
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
  // Faxina de snapshots órfãos: renders só existem com o bot vivo — qualquer
  // conteúdo em .build no startup é cadáver de sessão morta (kill/restart no
  // meio do handleAce). Já acumulou 20GB antes desta faxina.
  try {
    fs.rmSync(`${cfg.CLIPS_DIR}/.build`, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  const loggedOut = loadLoggedOut();
  log.info(
    {
      minStars: cfg.MIN_STARS,
      minKills: cfg.MIN_KILLS,
      minKillsNoStars: cfg.MIN_KILLS_NO_STARS,
      stream: cfg.STREAM_PRIORITY,
      privacy: cfg.YT_PRIVACY,
      avSync: cfg.CLIP_AV_SYNC,
      replayAware: cfg.REPLAY_AWARE,
      avStaticMs: cfg.AV_STATIC_OFFSET_MS,
      avStaticMatches: cfg.AV_STATIC_MATCHES || '(nenhum)',
      avStreamOffsets: [...parseStreamOffsets(cfg.AV_STREAM_OFFSETS).entries()].map(([k, v]) => `${k}=${v}`).join(',') || '(nenhum)',
      diskMinFreeGb: cfg.DISK_MIN_FREE_GB,
      thumbLogin: Object.keys(loggedOut).length > 0
        ? Object.keys(loggedOut).map((p) => `${p}=LOGOUT!`).join(',')
        : 'ok',
      upload: cfg.YT_UPLOAD,
      maxRec: cfg.MAX_RECORDINGS,
    },
    `bot iniciado (multikills ${cfg.MIN_KILLS}k+ com estrela / ${cfg.MIN_KILLS_NO_STARS}k sem estrela live, 16:9, log em arquivo)`,
  );
  if (Object.keys(loggedOut).length > 0) {
    const providers = Object.keys(loggedOut);
    log.error(
      { providers, cmd: providers.map((p) => loginScriptFor(p)).filter(Boolean) },
      'LOGIN EXPIRADO pendente — rode o script de relogin de cada provider (pulados até lá)',
    );
    notifyWindows(
      '5K Bot: login expirado',
      `Providers sem login: ${providers.join(', ')}. Rode os scripts de relogin (ex: ${loginScriptFor(providers[0]) ?? 'npx tsx scripts/chatgpt-login.ts'}).`,
    );
  }
  if (cfg.AV_STATIC_OFFSET_MS > 0 && !cfg.AV_STATIC_MATCHES.trim()) {
    log.warn(
      { avStaticMs: cfg.AV_STATIC_OFFSET_MS },
      'offset estático GLOBAL: aplica em todas as partidas, inclusive sem skew — escopete com AV_STATIC_MATCHES',
    );
  }

  const bins = StreamRecorder.checkBinaries();
  if (!bins.ffmpeg || !bins.ytdlp) {
    log.warn(
      'ffmpeg/yt-dlp ausentes (nem no PATH nem em .tools/). Sem eles não há buffer local — o bot só detecta, sem cortar clipes.',
    );
  }

  const shutdown = async (): Promise<void> => {
    stopping = true;
    for (const recorders of activeRecorders.values()) {
      await Promise.all([
        recorders.separate.stop().catch(() => undefined),
        recorders.muxed?.stop().catch(() => undefined),
      ]);
    }
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
