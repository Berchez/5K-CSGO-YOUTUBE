import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { repoPath } from './paths.js';
import { getConfig, parseStreamOffsets, resolveStaticOffset } from './config.js';
import { loadCalibrations, resolveSessionOffset } from './recorder/avCalibration.js';
import { loadLoggedOut, loginScriptFor } from './clipper/providerStatus.js';
import { notifyWindows } from './notify.js';
import { ensureTray } from './tray.js';
import { getLogger } from './logger.js';
import { discardAce, getDb, hasAce, insertAce, insertClip, recordDiscardedEvent } from './db.js';
import { killAll } from './procRegistry.js';
import {
  closeBrowser,
  fetchLiveMatches,
  fetchMatchStreams,
  minKillsForStars,
  selectStream,
} from './monitor/hltvMonitor.js';
import { loadWatchlistFile, resolveMatchRule, resolvePlayerRule } from './watchlist.js';
import { trackMatch } from './detector/matchTracker.js';
import { buildRoundSummary, describeAce, isAnchorLowConfidence } from './detector/aceDetector.js';
import { evaluateAceCoverage } from './detector/aceCoverage.js';
import { StreamRecorder } from './recorder/streamRecorder.js';
import { buildClip, computeAceEndMs, detectTruncatedStart, newestSegmentEndMs, oldestSegmentStartMs, pickSegments } from './clipper/clipBuilder.js';
import { scanRoundEndForScoreboard } from './clipper/scoreboardSync.js';
import { uploadClip } from './uploader/youtubeUploader.js';
import { getFreeBytes } from './diskSpace.js';
import {
  initTrayStatus,
  patchTrayStatus,
  publishTraySnapshot,
  setTrayStatusClip,
  setTrayStatusError,
  setTrayStatusPhase,
  shutdownTrayStatus,
  startTrayStatusHeartbeat,
} from './trayStatus.js';
import type { TrayMatchState, TrayStatusMatch } from './trayStatus.js';
import type { AceEvent, ClipResult, LiveMatch, StreamInfo } from './types.js';
import type { ReferenceImages } from './clipper/referenceImages.js';
import type { WatchlistDoc } from './watchlist.js';

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
// Todas as URLs do cache falharam: evita um page-load novo a cada poll
// enquanto as mesmas candidatas estão queimadas (TTL de falha = 5 min).
const streamsAllFailedRetry = new Map<string, number>();
const STREAMS_ALL_FAILED_RETRY_MS = 2 * 60_000;
const failedStreams = new Map<string, Map<string, number>>();
const STREAM_FAILED_TTL_MS = 5 * 60_000;

function failedStreamUrls(matchId: string): Set<string> {
  const entries = failedStreams.get(matchId);
  if (!entries) return new Set();
  const now = Date.now();
  const active = new Set<string>();
  for (const [url, at] of entries) {
    if (now - at < STREAM_FAILED_TTL_MS) active.add(url);
    else entries.delete(url);
  }
  if (entries.size === 0) failedStreams.delete(matchId);
  return active;
}

function markStreamFailed(matchId: string, url: string): void {
  const entries = failedStreams.get(matchId) ?? new Map<string, number>();
  entries.set(url, Date.now());
  failedStreams.set(matchId, entries);
}

function clearStreamFailed(matchId: string, url: string): void {
  const entries = failedStreams.get(matchId);
  if (!entries) return;
  entries.delete(url);
  if (entries.size === 0) failedStreams.delete(matchId);
}

/**
 * Instância única: outra cópia viva (pm2 + npm start, por exemplo) duplicaria
 * buffers, ffmpeg e uploads. O heartbeat fresco + pid vivo do próprio status
 * file são a prova; status velho (crash/reboot) não bloqueia o start.
 */
function otherInstanceAlive(): number | null {
  try {
    const raw = fs.readFileSync(repoPath('data', 'tray-status.json'), 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number; heartbeatAt?: string };
    const pid = Number(parsed.pid ?? 0);
    if (!pid || pid === process.pid) return null;
    const heartbeat = Date.parse(parsed.heartbeatAt ?? '');
    if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 90_000) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

// Referências por partida (foto/logos/mapa): busca 1x, reusa nos aces
// seguintes. Evictada quando a partida sai do ar (guarda bytes de imagens).
const refsCache = new Map<string, ReferenceImages>();

// Aces em construção (handleAce pendente): o poll NÃO apaga o buffer de
// partida com clipe em andamento — o ace do round final é justamente o que
// a espera do fim ancorado pode atravessar. O build trabalha sobre um
// SNAPSHOT dos segmentos; o buffer físico sai no ciclo seguinte.
// Contador por partida: dois aces simultâneos não podem liberar o guard
// quando só um clipe terminou.
const pendingClips = new Map<string, number>();
const deferredBufferCleanup = new Set<string>();

// Última versão boa da watchlist vista no poll. Trackers em andamento leem
// daqui a cada round (hot-reload não fica preso ao início da partida).
let activeWatchlist: WatchlistDoc | null = null;

function pendingClipCount(): number {
  let total = 0;
  for (const count of pendingClips.values()) total += count;
  return total;
}

function addPendingClip(matchId: string): void {
  pendingClips.set(matchId, (pendingClips.get(matchId) ?? 0) + 1);
}

function removePendingClip(matchId: string): void {
  const remaining = (pendingClips.get(matchId) ?? 0) - 1;
  if (remaining > 0) pendingClips.set(matchId, remaining);
  else pendingClips.delete(matchId);
}

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
  // Cache por jogador: a mesma partida gera clipes de jogadores diferentes,
  // e as fotos do primeiro não servem para os outros.
  const cacheKey = `${matchId}:${player.toLowerCase()}`;
  const hit = refsCache.get(cacheKey);
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
  refsCache.set(cacheKey, refs);
  return refs;
}

interface MatchRecorders {
  separate: StreamRecorder;
  muxed: StreamRecorder | null;
}

const activeRecorders = new Map<string, MatchRecorders>();
const activeTrackers = new Map<string, symbol>();
const selectedStreams = new Map<string, StreamInfo>();
let stopping = false;

async function ensureDirs(cfg: ReturnType<typeof getConfig>): Promise<void> {
  fs.mkdirSync(cfg.BUFFER_DIR, { recursive: true });
  fs.mkdirSync(cfg.CLIPS_DIR, { recursive: true });
  fs.mkdirSync('./logs', { recursive: true });
  fs.mkdirSync('./data', { recursive: true });
}

function trayMatchState(m: LiveMatch): TrayMatchState {
  const recorders = activeRecorders.get(m.matchId);
  if (recorders?.separate.isRunning) return 'recording';
  if (activeTrackers.has(m.matchId)) return 'tracking';
  const miss = streamsMiss.get(m.matchId);
  if (m.streams.length === 0 && miss && !miss.blocked) return 'no-stream';
  return 'waiting';
}

function trayMatchesFrom(
  matches: LiveMatch[],
  cfg: ReturnType<typeof getConfig>,
): TrayStatusMatch[] {
  return matches.map((m) => {
    const recorders = activeRecorders.get(m.matchId);
    const stream = selectedStreams.get(m.matchId);
    const state = trayMatchState(m);
    return {
      matchId: m.matchId,
      team1: m.team1,
      team2: m.team2,
      event: m.event,
      stars: m.stars,
      minKills: m.minKills ?? minKillsForStars(m.stars, cfg.MIN_KILLS, cfg.MIN_KILLS_NO_STARS),
      matchPageUrl: m.matchPageUrl,
      state,
      stream: stream
        ? { name: stream.name, country: stream.country, viewers: stream.viewers }
        : undefined,
      recorder: recorders
        ? {
            separate: recorders.separate.isRunning,
            muxed: recorders.muxed?.isRunning ?? false,
          }
        : undefined,
      tracker: activeTrackers.has(m.matchId),
    };
  });
}

function publishTrayStatus(
  matches: LiveMatch[] | null,
  cfg: ReturnType<typeof getConfig>,
  opts?: { lastError?: string | null },
): void {
  const now = new Date().toISOString();
  if (!matches) {
    patchTrayStatus({ lastPollAt: now, lastError: opts?.lastError ?? null });
    return;
  }
  const free = getFreeBytes(cfg.CLIPS_DIR);
  publishTraySnapshot({
    matches: trayMatchesFrom(matches, cfg),
    lastPollAt: now,
    lastError: opts?.lastError ?? null,
    diskFreeGb: free == null ? null : Math.round((free / 1024 ** 3) * 10) / 10,
    pendingClips: pendingClipCount(),
  });
}

function twitchUrlFrom(streamUrl: string): string {
  if (/^https?:\/\//.test(streamUrl)) return streamUrl;
  if (/twitch\.tv/.test(streamUrl)) return streamUrl;
  return streamUrl;
}

/** Fim detectado no vídeo + registro persistido (ace.streamSync). */
interface RoundEndMeasurement {
  /** Timestamp wall do frame de virada do placar; null se não encontrado. */
  detectedEndMs: number | null;
  /** Registro gravado no sidecar independentemente de o fim ser aplicado. */
  sync: NonNullable<AceEvent['streamSync']>;
}

/**
 * Procura a virada do placar do round no topo do vídeo e decide se aplica
 * (só em 'auto'). Nunca lança: em erro/indisponibilidade devolve null + motivo.
 */
async function measureRoundEnd(
  ace: AceEvent,
  cfg: ReturnType<typeof getConfig>,
  recorder: StreamRecorder | undefined,
  shouldStop: () => boolean,
  scanFromMs: number,
): Promise<RoundEndMeasurement> {
  const log = getLogger();
  const mode = cfg.CLIP_STREAM_SYNC;
  const totalKills = ace.kills.filter((kill) => Number.isFinite(kill.at)).length;
  const skip = (reason: string): RoundEndMeasurement => ({
    detectedEndMs: null,
    sync: {
      mode,
      applied: false,
      source: 'scoreboard',
      marker: null,
      offsetMs: null,
      matchedKills: 0,
      totalKills,
      medianDeviationMs: null,
      reason,
      roundEndAt: null,
      scoreBefore: ace.scoreBefore ?? null,
      scoreAfter: ace.scoreAfter ?? null,
    },
  });

  if (mode === 'off') return skip('disabled');
  if (!recorder?.isRunning) {
    log.warn(
      { matchId: ace.matchId, stream: recorder?.streamName },
      'calibragem do placar indisponível — mantendo âncora original',
    );
    return skip('recorder-unavailable');
  }

  try {
    const estimate = await scanRoundEndForScoreboard({
      expectedBefore: ace.scoreBefore,
      expectedAfter: ace.scoreAfter,
      expectedRound: ace.round,
      maxLagSec: cfg.CLIP_STREAM_SYNC_MAX_LAG_SEC,
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      scanFromMs,
      crop: cfg.CLIP_SCOREBOARD_CROP,
      listSegments: () => recorder.listSegments(),
      shouldStop,
    });
    const applied = mode === 'auto' && estimate.roundEndMs != null;
    const sync: RoundEndMeasurement['sync'] = {
      mode,
      applied,
      source: 'scoreboard',
      marker: estimate.marker,
      offsetMs: null,
      matchedKills: estimate.roundEndMs != null ? 1 : 0,
      totalKills,
      medianDeviationMs: null,
      reason: estimate.reason,
      roundEndAt: estimate.roundEndMs != null ? new Date(estimate.roundEndMs).toISOString() : null,
      scoreBefore: estimate.scoreBefore,
      scoreAfter: estimate.scoreAfter,
    };
    const details = { matchId: ace.matchId, stream: recorder.streamName, ...sync };
    if (applied) {
      log.info(details, 'fim do round ancorado no placar do vídeo');
    } else {
      log.warn(details, 'placar do round não aplicado — mantendo âncora original');
    }
    return { detectedEndMs: estimate.roundEndMs, sync };
  } catch (e) {
    log.warn(
      { err: String(e), matchId: ace.matchId, stream: recorder.streamName },
      'calibragem do placar falhou — mantendo âncora original',
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
  const recorders = activeRecorders.get(matchId);
  const recorder = recorders?.separate;
  const muxedRecorder = recorders?.muxed;
  const aceStartMs = ace.startedAt ? Date.parse(ace.startedAt) : undefined;
  // Valida ANTES de gravar: stats velhas (repovoamento no break) podem
  // produzir um ace cuja 1ª kill já saiu do buffer — sem isso a linha
  // ficaria no banco e o hasAce bloquearia uma detecção legítima futura.
  const initialStartMs = oldestSegmentStartMs(
    recorder?.listSegments() ?? [],
    cfg.SEGMENT_TIME_SEC,
  );
  const initialCoverage = evaluateAceCoverage({
    kills: ace.kills,
    anchorMs: aceStartMs,
    oldestSegmentStartMs: initialStartMs,
  });
  if (initialCoverage.discard) {
    log.warn(
      {
        matchId,
        player: ace.player,
        map: ace.map,
        round: ace.round,
        kills: initialCoverage.totalKills,
        oldestStart: initialStartMs != null ? new Date(initialStartMs).toISOString() : null,
      },
      'nenhuma kill do ace está no buffer — evento descartado (sem footage)',
    );
    recordDiscardedEvent(cfg.DB_PATH, {
      matchId: ace.matchId,
      map: ace.map,
      round: ace.round,
      player: ace.player,
      reason: 'sem footage no buffer',
      detectedAt: ace.detectedAt,
    });
    return;
  }
  const aceId = insertAce(cfg.DB_PATH, ace);
  addPendingClip(matchId);
  // Guarda de restart (tray/painel) lê o status: publica já, sem esperar
  // o fim do poll — a janela logo após a detecção é a mais crítica.
  patchTrayStatus({ pendingClips: pendingClipCount() });
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
    const { detectedEndMs, sync: streamSync } = await measureRoundEnd(
      ace,
      cfg,
      syncRecorder,
      () => stopping,
      aceDetectedAtMs - 30_000,
    );
    ace.streamSync = streamSync;
    if (streamSync.scoreBefore) ace.score = streamSync.scoreBefore;
    const useScoreboardEnd = streamSync.applied && detectedEndMs != null;
    const useFallback =
      cfg.CLIP_STREAM_SYNC === 'auto' &&
      !streamSync.applied &&
      streamSync.reason !== 'disabled' &&
      streamSync.reason !== 'recorder-unavailable';
    const endMs = useScoreboardEnd
      ? detectedEndMs + cfg.CLIP_END_AFTER_CLOSE_SEC * 1000
      : computeAceEndMs(aceDetectedAtMs, cfg.SCOREBOARD_DELAY_MS, cfg.CLIP_END_AFTER_CLOSE_SEC) +
        (useFallback ? cfg.CLIP_STREAM_SYNC_FALLBACK_SEC * 1000 : 0);
    let endCovered = false;
    let muxedEndCovered = false;
    const waitUntil =
      Date.now() +
      Math.max(150_000, endMs - Date.now() + cfg.SEGMENT_TIME_SEC * 1000 + 20_000);
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
    let coverageDiscards = 0;
    let attemptedVariants = 0;
    const buildVariant = async (
      mode: 'separate' | 'muxed',
      sourceSegments: string[],
      sourceEndMs: number | undefined,
    ): Promise<ClipResult | null> => {
      if (sourceSegments.length === 0) {
        log.warn({ matchId, mode }, 'sem segmentos para esta variante de captura');
        return null;
      }
      attemptedVariants++;
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
      // A 1ª kill já saiu do buffer? Sem ela o clipe não é o ace que o
      // sidecar promete (foi o caso do 5K do jcobbb: round fechou minutos
      // depois e o corte pegou só o intervalo seguinte). Melhor não gerar.
      const oldestStartMs = oldestSegmentStartMs(sourceSegments, cfg.SEGMENT_TIME_SEC);
      const variantCoverage = evaluateAceCoverage({
        kills: ace.kills,
        anchorMs: aceStartMs,
        oldestSegmentStartMs: oldestStartMs,
      });
      if (variantCoverage.discard) {
        log.warn(
          { matchId, mode, kills: variantCoverage.totalKills },
          'nenhuma kill do ace está no buffer — clipe descartado (não conteria o ace)',
        );
        coverageDiscards++;
        return null;
      }
      if (variantCoverage.truncatedStart) {
        log.warn(
          {
            matchId,
            mode,
            aceStart: aceStartMs != null ? new Date(aceStartMs).toISOString() : null,
            oldestStart: oldestStartMs != null ? new Date(oldestStartMs).toISOString() : null,
          },
          'âncora fora do buffer — clipe com abertura incompleta (truncatedStart)',
        );
      }
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
                  geminiWebChromeProfile: cfg.GEMINI_WEB_CHROME_PROFILE || undefined,
                  geminiWebHeadless: cfg.GEMINI_WEB_HEADLESS !== '0',
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
    // Nenhuma variante sobreviveu: só é fantasma se TODAS as variantes
    // tentadas caíram por falta de footage. Falha de ffmpeg/disco mantém o
    // evento no banco (o clipe pode ser refeito manualmente).
    if (
      !separateClip &&
      !muxedClip &&
      attemptedVariants > 0 &&
      coverageDiscards === attemptedVariants
    ) {
      discardAce(cfg.DB_PATH, aceId, {
        matchId: ace.matchId,
        map: ace.map,
        round: ace.round,
        player: ace.player,
        reason: 'nenhuma kill do ace no buffer',
        detectedAt: ace.detectedAt,
      });
      log.warn(
        { matchId, player: ace.player, map: ace.map, round: ace.round },
        'ace fantasma removido do banco (sem footage no buffer)',
      );
    }
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
      setTrayStatusClip({
        at: new Date().toISOString(),
        matchId: ace.matchId,
        player: ace.player,
        map: ace.map,
        round: ace.round,
        filePath: uploadClipResult.filePath,
        videoId,
        uploaded: Boolean(videoId),
        privacy: cfg.YT_PRIVACY,
      });
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
    removePendingClip(matchId);
    patchTrayStatus({ pendingClips: pendingClipCount() });
  }
}

async function pollOnce(): Promise<void> {
  const cfg = getConfig();
  const log = getLogger();
  getDb(cfg.DB_PATH);

  // Watchlist: hot-reload por mtime (barato a cada poll). JSON inválido
  // mantém a última versão boa; arquivo ausente mantém a última versão por
  // até 1 min (save/rename do editor) e depois cai na política por estrelas.
  const watchlist = loadWatchlistFile(repoPath('data', 'watchlist.json'));
  activeWatchlist = watchlist.doc;
  if (watchlist.changed) {
    if (watchlist.error) {
      log.warn({ err: watchlist.error }, 'watchlist inválida - mantendo última versão boa');
    } else if (watchlist.missing && watchlist.stale) {
      log.warn('watchlist ausente - mantendo última versão boa por até 1 min');
    } else if (watchlist.missing) {
      log.info('watchlist não encontrada - usando política por estrelas');
    } else {
      log.info(
        {
          enabled: watchlist.doc.enabled,
          teams: watchlist.doc.teams.length,
          players: watchlist.doc.players.length,
        },
        'watchlist carregada',
      );
    }
  }

  const matches = await fetchLiveMatches(
    cfg.HLTV_MATCHES_URL,
    cfg.MIN_STARS,
    cfg.TOP_TIER_ONLY,
    {
      watchlist: watchlist.doc,
      starredMinKills: cfg.MIN_KILLS,
      unstarredMinKills: cfg.MIN_KILLS_NO_STARS,
    },
  );
  if (!matches) {
    log.warn('listing bloqueado pelo Cloudflare — mantendo recorders/trackers');
    publishTrayStatus(null, cfg, { lastError: 'listing bloqueado pelo Cloudflare' });
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
        selectedStreams.delete(id);
        streamsCache.delete(id);
        streamsMiss.delete(id);
        streamsAllFailedRetry.delete(id);
        log.info({ matchId: id }, 'recorder morto, vai recriar com streams frescas');
      }
    }
    // Recorders mortos (stream caiu/URL expirou) são descartados p/ recriar.
    if (!activeRecorders.has(m.matchId) && activeRecorders.size < cfg.MAX_RECORDINGS) {
      let attemptedStream: StreamInfo | null = null;
      try {
        // Cache: a lista de streams quase não muda mid-match.
        // Vazia/bloqueada entra com TTL negativo em vez de rebuscar a cada
        // ciclo — cada rebusca é uma aba nova no browser.
        let streams = streamsCache.get(m.matchId);
        if (!streams && (streamsAllFailedRetry.get(m.matchId) ?? 0) > Date.now()) {
          streams = [];
        }
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
              streamsMiss.delete(m.matchId);
              streamsAllFailedRetry.delete(m.matchId);
              streams = fetched;
            } else {
              streamsMiss.set(m.matchId, { at: Date.now(), blocked: false });
              streams = [];
            }
          }
        }
        m.streams = streams;
        const failedUrls = failedStreamUrls(m.matchId);
        const available = streams.filter((s) => !failedUrls.has(s.url));
        if (streams.length > 0 && available.length === 0) {
          // Todas as candidatas do cache falharam: a lista pode estar velha
          // (URL expirada). Só agora vale pagar um novo page-load — e não a
          // cada poll enquanto as falhas ainda estão no TTL.
          streamsCache.delete(m.matchId);
          streamsAllFailedRetry.set(m.matchId, Date.now() + STREAMS_ALL_FAILED_RETRY_MS);
        }
        const choice = selectStream(available, cfg.STREAM_PRIORITY, {
          country: cfg.STREAM_PREFERRED_COUNTRY,
          minViewers: cfg.STREAM_PREFERRED_MIN_VIEWERS,
        });
        if (!choice) {
          log.info(
            {
              matchId: m.matchId,
              streams: streams.length,
              withCountry: streams.filter((s) => s.country).length,
              failed: failedUrls.size,
            },
            'sem stream disponível, pulando gravação',
          );
        } else {
          const chosen = choice.stream;
          attemptedStream = chosen;
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
          selectedStreams.set(m.matchId, chosen);
          clearStreamFailed(m.matchId, chosen.url);
          log.info(
            {
              matchId: m.matchId,
              stream: chosen.name,
              country: chosen.country,
              viewers: chosen.viewers,
              reason: choice.reason,
              candidates: available.length,
              muxed: muxedRecorder != null,
            },
            'gravando buffers separados e muxed',
          );
        }
      } catch (e) {
        if (attemptedStream) markStreamFailed(m.matchId, attemptedStream.url);
        selectedStreams.delete(m.matchId);
        // Mantém o cache: a próxima tentativa usa outra candidata sem abrir
        // aba nova (page-load por poll = exposição ao Cloudflare).
        log.warn(
          {
            err: String(e),
            matchId: m.matchId,
            stream: attemptedStream?.name,
          },
          'não foi possível iniciar gravação',
        );
      }
    }

    // 2) Tracker de ace (1 por partida)
    if (!activeRecorders.has(m.matchId)) {
      if (activeTrackers.delete(m.matchId)) {
        log.info({ matchId: m.matchId }, 'sem recorder, tracking encerrado');
      }
    } else if (!activeTrackers.has(m.matchId)) {
      const baseMinKills =
        m.minKills ?? minKillsForStars(m.stars, cfg.MIN_KILLS, cfg.MIN_KILLS_NO_STARS);
      // Recalcula a cada round: hot-reload da watchlist vale para partidas já
      // em andamento. Jogador listado vence o limiar do time/default.
      const minKillsFor = (player: string): number => {
        const live = activeWatchlist;
        const base = resolveMatchRule(
          live,
          [m.team1, m.team2],
          minKillsForStars(m.stars, cfg.MIN_KILLS, cfg.MIN_KILLS_NO_STARS),
        ).minKills;
        return resolvePlayerRule(live, player)?.minKills ?? base;
      };
      const token = Symbol(m.matchId);
      activeTrackers.set(m.matchId, token);
      log.info(
        {
          matchId: m.matchId,
          stars: m.stars,
          minKills: baseMinKills,
          watchlisted: m.watchlisted ?? false,
          teams: m.watchlistedTeams?.join(', ') || undefined,
        },
        'iniciando tracker de multikill',
      );
      trackMatch(m.matchPageUrl, m.matchId, {
        shouldStop: () => stopping || activeTrackers.get(m.matchId) !== token,
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
              scoreBefore: a.scoreBefore,
              scoreAfter: a.scoreAfter,
              score: a.scoreBefore,
              summary,
            },
            m.matchId,
            cfg,
          ).catch((e) => log.error({ err: String(e) }, 'erro no handleAce'));
        },
      }, minKillsFor)
        .catch((e) => log.warn({ err: String(e) }, 'tracker encerrou com erro'))
        .finally(() => {
          if (activeTrackers.get(m.matchId) === token) activeTrackers.delete(m.matchId);
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
      selectedStreams.delete(id);
      activeTrackers.delete(id);
      streamsCache.delete(id);
      streamsMiss.delete(id);
      streamsAllFailedRetry.delete(id);
      failedStreams.delete(id);
      for (const key of refsCache.keys()) {
        if (key === id || key.startsWith(`${id}:`)) refsCache.delete(key);
      }
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

  publishTrayStatus(matches, cfg);

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
  const other = otherInstanceAlive();
  if (other) {
    getLogger().error(
      { pid: other },
      'outra instância do bot já está rodando (status fresco) — encerrando para não duplicar buffers/uploads',
    );
    process.exit(1);
  }
  ensureTray();
  const cfg = getConfig();
  // Bins vendored (.tools/ffmpeg do repo) no PATH — o clipper chama
  // 'ffmpeg' pelo nome (concat, thumb, upscale). Igual ao test-vod.
  process.env.PATH = `${path.resolve('.tools')}${path.delimiter}${process.env.PATH ?? ''}`;
  await ensureDirs(cfg);
  initTrayStatus(cfg);
  startTrayStatusHeartbeat();
  setTrayStatusPhase('monitoring');
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
      streamPreferredCountry: cfg.STREAM_PREFERRED_COUNTRY || '(off)',
      streamPreferredMinViewers: cfg.STREAM_PREFERRED_MIN_VIEWERS,
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
    shutdownTrayStatus();
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
      setTrayStatusError(String(e));
    }
    await new Promise((r) => setTimeout(r, cfg.POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  setTrayStatusError(String(e));
  setTrayStatusPhase('error');
  process.exit(1);
});
