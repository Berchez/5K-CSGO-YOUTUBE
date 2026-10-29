import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { repoPath } from './paths.js';
import { deprecatedEnvVars, divergentLatencyEnvs, getConfig, invalidBoolEnvs } from './config.js';
import { loadLoggedOut, loginScriptFor } from './clipper/providerStatus.js';
import { notifyWindows } from './notify.js';
import { ensureTray } from './tray.js';
import { getLogger } from './logger.js';
import { discardAce, getDb, hasAce, insertAce, insertClip, recordDiscardedEvent } from './db.js';
import { killAll } from './procRegistry.js';
import {
  closeBrowser,
  fetchMatchListing,
  fetchMatchStreams,
  minKillsForStars,
  selectNextUpcoming,
  selectStream,
  shouldStopRecorder,
  type UpcomingMatch,
} from './monitor/hltvMonitor.js';
import {
  computePollDecision,
  pollForceReasons,
  POLL_START_GRACE_MS,
} from './monitor/pollSchedule.js';
import {
  createWatchlistSignal,
  notifyWatchlistChanged,
  pollSleepDeadline,
  sleepUntilPoll,
} from './monitor/pollSleep.js';
import {
  gameRoundEndMs,
  latencyMapProblem,
  observedLatencyMs,
  RECENT_SAMPLE_LIMIT,
  RECENT_SAMPLE_MAX_AGE_MS,
  resolveAdaptiveLatency,
  resolveStreamLatencyMs,
  shouldApplyAdaptive,
  StreamLatencyTracker,
} from './monitor/streamLatency.js';
import { loadLatencyState, saveLatencyState } from './monitor/latencyStore.js';
import { detectionEvents } from './monitor/liveTelemetry.js';
import { loadWatchlistFile, resolveMatchRule, resolvePlayerRule } from './watchlist.js';
import { trackMatch } from './detector/matchTracker.js';
import { buildRoundSummary, describeAce, isAnchorLowConfidence } from './detector/aceDetector.js';
import { evaluateAceCoverage } from './detector/aceCoverage.js';
import { StreamRecorder, MuxedFormatUnavailableError } from './recorder/streamRecorder.js';
import { buildClip, detectTruncatedStart, newestSegmentEndMs, oldestSegmentStartMs, pickSegments } from './clipper/clipBuilder.js';
import { computeClipAnchors } from './clipper/clipAnchors.js';
import { cropCandidatesForStream, scanRoundEndForScoreboard } from './clipper/scoreboardSync.js';
import { scanKillfeedForLatency } from './clipper/killfeedSync.js';
import { uploadClip } from './uploader/youtubeUploader.js';
import { buildVideoMetadataSafe, buildMetadataContext } from './uploader/videoMetadata.js';
import { createMetadataAi } from './uploader/metadataAi.js';
import type { MetadataAiFn } from './uploader/videoMetadata.js';
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

// Watcher da watchlist: com o poll adaptativo o bot pode dormir 30min, mas
// salvar a watchlist precisa ter efeito rápido (hot-reload). O watcher só
// stat'a o arquivo (sem page-load) e acorda o sleep quando ele muda.
// O sinal guarda a versão (contador) e a hora da última mudança: o loop
// consome a versão no topo de cada iteração (nada de "flag sujo" zerada
// dentro do poll — um poll que lança exceção não vira hot-loop) e o
// sleep usa a hora para debounce (um salvamento = um poll, não um por
// toque de arquivo).
const WATCHLIST_FILE = repoPath('data', 'watchlist.json');
const watchlistSignal = createWatchlistSignal();

function startWatchlistWatcher(): void {
  fs.watchFile(WATCHLIST_FILE, { interval: 2000, persistent: false }, () => {
    notifyWatchlistChanged(watchlistSignal);
  });
}

function stopWatchlistWatcher(): void {
  fs.unwatchFile(WATCHLIST_FILE);
}

// Agenda conhecida (matchId → horário marcado no HLTV): serve para medir
// a latência de detecção (a live apareceu quanto tempo depois do previsto?).
const knownUpcoming = new Map<string, number>();
// Lives elegíveis já detectadas (evita repetir o log a cada poll).
const detectedLive = new Set<string>();
// matchId da próxima partida prevista no poll anterior (telemetria).
let predictedMatchId: string | null = null;
// Última próxima partida conhecida: mantida no painel quando o listing
// é bloqueado (o Cloudflare não deve apagar a informação da fila).
let lastKnownNextMatch: UpcomingMatch | null = null;

/**
 * Falhas CONSECUTIVAS de extração do listing. O aviso no log se repete
 * a cada ciclo (45s) e some no ruído — depois de N falhas seguidas um
 * toast avisa o dono (o HLTV mudou o markup e o bot pode estar cego
 * para novas partidas).
 */
let listingFailures = 0;
let listingFailureNotified = false;
const LISTING_FAILURE_NOTIFY_AFTER = 3;

function notifyListingFailure(reason: string, detail?: string): void {
  listingFailures++;
  if (listingFailures < LISTING_FAILURE_NOTIFY_AFTER || listingFailureNotified) return;
  listingFailureNotified = true;
  notifyWindows(
    '5K Bot: listing do HLTV quebrado',
    `${reason} há ${listingFailures} ciclos seguidos${detail ? ` (${detail})` : ''}. O bot continua rodando, mas pode estar cego para novas partidas.`,
  );
}

/**
 * Cliente de metadados (IA): UMA instância por sessão. Recriá-lo a cada
 * ace zerava o circuit breaker — o contador de falhas e o provider
 * desligado morriam com o objeto, e um provider fora do ar era tentado
 * de novo em todo ace (2 tentativas × timeout).
 */
let metadataAiFn: MetadataAiFn | null = null;

/**
 * Latência OBSERVADA por canal: quando o OCR acha a virada do placar
 * no vídeo, o instante medido é a latência real da stream (o instante
 * do round no vídeo menos o instante estimado no relógio do jogo).
 *
 * O estado guarda as medições COM TIMESTAMP (não só a mediana): a
 * latência muda dentro da partida (pausa do streamer, buffering,
 * catch-up) e o início do clipe precisa da amostra que estava em vigor
 * na 1ª kill — não da média do canal nem da do round atual (medida
 * depois da kill).
 *
 * O estado é persistido entre reinícios: é o que faz a sincronização
 * "entre partidas" ser fácil (o 1º round da partida nova já começa com
 * a latência medida na partida anterior).
 */
let latencyTracker = new StreamLatencyTracker();

/** Grava o estado de latência em disco (best-effort, mas avisa a falha). */
function persistLatencyState(cfg: ReturnType<typeof getConfig>): void {
  if (saveLatencyState(cfg.CLIP_STREAM_SYNC_STATE_PATH, latencyTracker)) return;
  getLogger().warn(
    { arquivo: cfg.CLIP_STREAM_SYNC_STATE_PATH },
    'falha ao salvar o estado de latência (a medição volta no próximo round)',
  );
}

function getMetadataAi(): MetadataAiFn {
  if (metadataAiFn) return metadataAiFn;
  const cfg = getConfig();
  metadataAiFn = createMetadataAi({
    order: cfg.YT_META_AI_ORDER,
    timeoutMs: cfg.YT_META_AI_TIMEOUT_MS,
    geminiApiKey: cfg.GEMINI_API_KEY || undefined,
    geminiModel: cfg.YT_META_GEMINI_MODEL,
    hfToken: cfg.HF_TOKEN || undefined,
    hfModel: cfg.YT_META_HF_MODEL,
  });
  return metadataAiFn;
}

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

const activeRecorders = new Map<string, StreamRecorder>();
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
  const recorder = activeRecorders.get(m.matchId);
  if (recorder?.isRunning) return 'recording';
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
            recording: recorders.isRunning,
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
  aceDetectedAtMs: number,
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
      observedLatencyMs: null,
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
    /**
     * Crops do placar: o configurado para o canal, o que funcionou da
     * última vez (memorizado) e o global — nessa ordem. Os fallbacks
     * só entram na fila se os anteriores não lerem nada (o custo do
     * fallback é pago só quando o crop principal falha).
     */
    const crops = cropCandidatesForStream({
      globalCrop: cfg.CLIP_SCOREBOARD_CROP,
      byStream: cfg.CLIP_SCOREBOARD_CROP_BY_STREAM,
      streamName: recorder.streamName,
      remembered: latencyTracker.crop(recorder.streamName),
      fallbacks: cfg.CLIP_SCOREBOARD_CROP_FALLBACKS,
    });
    const estimate = await scanRoundEndForScoreboard({
      expectedBefore: ace.scoreBefore,
      expectedAfter: ace.scoreAfter,
      expectedRound: ace.round,
      maxLagSec: cfg.CLIP_STREAM_SYNC_MAX_LAG_SEC,
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      scanFromMs,
      crop: crops[0],
      crops: crops.slice(1),
      listSegments: () => recorder.listSegments(),
      shouldStop,
    });
    const applied = mode === 'auto' && estimate.roundEndMs != null;
    /**
     * Latência OBSERVADA do round: a virada do placar vista no vídeo
     * menos o fechamento do round no relógio do jogo. É a MEDIÇÃO (não
     * a aplicação): entra no estado por canal e alimenta a âncora
     * adaptativa dos rounds seguintes.
     *
     * O instante do ace (NÃO o "agora") é a referência: a varredura
     * espera o material do round chegar ao buffer — e esse tempo de
     * espera É a latência que estamos medindo. Usar o "agora" mediria a
     * própria espera.
     *
     * O fim do round no relógio do jogo é o "Round over" do placar do
     * HLTV (o timer real do round) quando disponível; senão a estimativa
     * (detecção − atraso do placar), que carrega o erro de
     * CLIP_SCORE_DELAY_MS.
     */
    const roundEndedAtMs = ace.roundEndedAt ? Date.parse(ace.roundEndedAt) : null;
    const gameEndMs = gameRoundEndMs({
      aceDetectedAtMs,
      scoreDelayMs: cfg.CLIP_SCORE_DELAY_MS,
      roundEndedAtMs,
    });
    const observed =
      estimate.roundEndMs != null
        ? observedLatencyMs(estimate.roundEndMs, gameEndMs)
        : null;
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
      observedLatencyMs: observed,
      crop: estimate.crop ?? null,
    };
    const details = { matchId: ace.matchId, stream: recorder.streamName, ...sync };
    if (applied) {
      log.info(details, 'fim do round ancorado no placar do vídeo');
    } else {
      log.warn(details, 'placar do round não aplicado — mantendo âncora original');
    }
    // O crop que leu vira o principal do canal: o próximo round não
    // precisa redescobrir onde o placar está.
    if (estimate.crop) latencyTracker.setCrop(recorder.streamName, estimate.crop);
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
  const recorder = activeRecorders.get(matchId);
  const aceStartMs = ace.startedAt ? Date.parse(ace.startedAt) : undefined;
  const streamName = recorder?.streamName;
  /**
   * Latência CONFIGURADA do canal: o valor do canal quando existe
   * (CLIP_STREAM_LATENCY_BY_STREAM), senão o global. É o FALLBACK —
   * quando existe medição por round (OCR do placar no vídeo), ela é que
   * manda, porque a latência muda dentro da partida (pausa do streamer,
   * buffering, catch-up) e um valor fixo erra dezenas de segundos.
   */
  const streamLatencyMs = resolveStreamLatencyMs(
    cfg.CLIP_STREAM_LATENCY_MS,
    cfg.CLIP_STREAM_LATENCY_BY_STREAM,
    streamName,
  );
  /**
   * Amostras do canal medidas ANTES deste evento (a base da latência
   * adaptativa). Sem filtro de idade: a última amostra do canal — mesmo
   * de uma partida anterior — é o ponto de partida do 1º round da
   * partida nova.
   */
  const eventAtMs = Date.parse(ace.detectedAt) || Date.now();
  const priorSamples = latencyTracker
    .allSamples(streamName)
    .filter((sample) => sample.measuredAtMs < eventAtMs)
    .slice(-RECENT_SAMPLE_LIMIT);
  /**
   * Janela RECENTE (idade limitada): base do fim estimado. Medição
   * antiga não descreve o regime atual.
   */
  const recentSamples = latencyTracker.recent(
    streamName,
    RECENT_SAMPLE_LIMIT,
    RECENT_SAMPLE_MAX_AGE_MS,
    Date.now(),
  );
  /**
   * Latência CONSERVADORA para o teste rápido de cobertura: o MAIOR
   * valor plausível. Descartar um ace é DESTRUTIVO (some do banco e
   * nunca mais é processado); manter um ace sem footage só gera um
   * clipe marcado como truncado.
   */
  const conservativeLatencyMs = Math.max(
    streamLatencyMs,
    ...priorSamples.map((sample) => sample.latencyMs),
  );
  /**
   * Âncora na TIMELINE DO VÍDEO (a mesma dos mtimes dos segmentos).
   *
   * A âncora do tracker vem do placar do HLTV (relógio do jogo), mas o
   * conteúdo gravado chega atrasado: o HLS do recorder entrega o que
   * aconteceu há ~CLIP_STREAM_LATENCY_MS. Sem empurrar a âncora para a
   * frente, o corte aponta para um instante que ainda não foi gravado e o
   * clipe abre no round ANTERIOR (medido: 30s antes da 1ª kill real).
   *
   * O valor final (adaptativo) só é conhecido depois da medição do
   * round — até lá, esta âncora serve ao teste rápido de cobertura.
   */
  let videoStartMs =
    aceStartMs != null ? aceStartMs + conservativeLatencyMs : undefined;
  // Valida ANTES de gravar: stats velhas (repovoamento no break) podem
  // produzir um ace cuja 1ª kill já saiu do buffer — sem isso a linha
  // ficaria no banco e o hasAce bloquearia uma detecção legítima futura.
  const initialStartMs = oldestSegmentStartMs(
    recorder?.listSegments() ?? [],
    cfg.SEGMENT_TIME_SEC,
  );
  const initialCoverage = evaluateAceCoverage({
    kills: ace.kills,
    anchorMs: videoStartMs,
    oldestSegmentStartMs: initialStartMs,
    streamLatencyMs: conservativeLatencyMs,
    scoreboardDelayMs: cfg.SCOREBOARD_DELAY_MS,
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
    const { detectedEndMs, sync: streamSync } = await measureRoundEnd(
      ace,
      cfg,
      recorder,
      () => stopping,
      aceDetectedAtMs - 30_000,
      aceDetectedAtMs,
    );
    ace.streamSync = streamSync;
    if (streamSync.scoreBefore) ace.score = streamSync.scoreBefore;
    /** Fim REAL do round no relógio do jogo (timer do HLTV) ou null. */
    const roundEndedAtMs = ace.roundEndedAt ? Date.parse(ace.roundEndedAt) : null;
    const roundEndReference =
      roundEndedAtMs != null && Number.isFinite(roundEndedAtMs)
        ? 'timer-hltv'
        : 'estimada';
    /**
     * AMOSTRA do round atual: a latência medida no fim do round. Ela
     * entra no estado do canal (para os rounds seguintes) e serve para
     * detectar troca de regime. No início só pode ANTECIPAR a abertura
     * (quando é menor que a amostra anterior): foi medida DEPOIS da 1ª
     * kill e, se for maior, a subida pode ter acontecido depois do kill.
     */
    const currentSample =
      streamSync.observedLatencyMs != null
        ? latencyTracker.record(streamName, streamSync.observedLatencyMs, {
            measuredAtMs: Date.now(),
            source: 'scoreboard',
            quality:
              streamSync.marker === 'score' && streamSync.reason === 'confident'
                ? 'confident'
                : 'after-only',
            reference: roundEndReference,
          })
        : null;
    if (currentSample) persistLatencyState(cfg);
    /**
     * Aumento do atraso CONHECIDO entre a medição anterior e a 1ª kill:
     * o relógio de origem da playlist HLS mostra quando a stream "pulou"
     * (pausa do streamer/buffering). Sem isso, um salto no meio da
     * partida só apareceria no round seguinte.
     */
    const priorSample = priorSamples.length > 0 ? priorSamples[priorSamples.length - 1] : null;
    const killEstimateMs =
      aceStartMs != null ? aceStartMs + (priorSample?.latencyMs ?? streamLatencyMs) : eventAtMs;
    const pendingShiftMs = recorder
      ? recorder.delayShiftSince(priorSample?.measuredAtMs ?? eventAtMs - 60_000, killEstimateMs)
      : 0;
    if (pendingShiftMs > 0) {
      log.info(
        { matchId, stream: streamName, atrasoExtraMs: pendingShiftMs },
        'atraso da stream cresceu antes da 1ª kill (salto no relógio de origem)',
      );
    }
    /**
     * Decisão da latência adaptativa:
     * - início: a amostra em vigor na 1ª kill (a anterior ao evento),
     *   ajustada pelo salto conhecido; se o round trocou de regime, vale
     *   o MENOR valor (abrir mais cedo nunca tira a 1ª kill do clipe);
     * - fim estimado: o MÁXIMO da janela recente (fechar mais tarde
     *   nunca tira a última kill).
     */
    const adaptive = resolveAdaptiveLatency({
      configuredMs: streamLatencyMs,
      priorSamples,
      recentSamples,
      current: currentSample,
      pendingShiftMs,
      maxStepMs: cfg.CLIP_STREAM_SYNC_MAX_STEP_MS,
      eventAtMs,
      nowMs: Date.now(),
    });
    /**
     * A latência adaptativa só é APLICADA no modo 'auto'. Em 'log' a
     * varredura continua medindo e persistindo (shadow), mas o corte é
     * idêntico ao antigo — é o modo para comparar o comportamento com e
     * sem a medição. Em 'off' não há varredura.
     */
    const applyAdaptive = shouldApplyAdaptive(
      cfg.CLIP_STREAM_SYNC,
      cfg.CLIP_STREAM_SYNC_ADAPTIVE,
    );
    /**
     * Modo shadow do sync: mede e LOGA, sem alterar nenhuma âncora
     * (inclusive a do killfeed). É a garantia de que 'log' não muda o
     * corte.
     */
    const applyVisualSync = cfg.CLIP_STREAM_SYNC !== 'log';
    const startLatencyMs = applyAdaptive ? adaptive.startLatencyMs : streamLatencyMs;
    const endLatencyMs = applyAdaptive ? adaptive.endLatencyMs : streamLatencyMs;
    /**
     * Segunda medição: OCR do KILLFEED (o nome do jogador no vídeo).
     * Ela dá o instante do kill DENTRO do vídeo — não depende de
     * nenhuma latência estimada. Entra só quando precisa: o placar do
     * vídeo não pôde ser lido, ou o round trocou de regime.
     */
    let killfeedStartMs: number | null = null;
    let killfeedOffsetMs: number | null = null;
    const needKillfeed =
      cfg.CLIP_KILLFEED_SYNC !== 'off' &&
      recorder?.isRunning === true &&
      (cfg.CLIP_KILLFEED_SYNC === 'always' ||
        streamSync.reason === 'no-scoreboard' ||
        streamSync.reason === 'no-transition' ||
        // O salto do relógio de origem é ambíguo e não move a âncora:
        // ele DISPARA a medição exata (killfeed), que é independente.
        pendingShiftMs > 0 ||
        adaptive.changed);
    if (needKillfeed) {
      try {
        const killfeedCrops = cropCandidatesForStream({
          globalCrop: cfg.CLIP_KILLFEED_CROP,
          byStream: cfg.CLIP_KILLFEED_CROP_BY_STREAM,
          streamName,
          remembered: null,
          fallbacks: cfg.CLIP_KILLFEED_CROP_FALLBACKS,
        });
        const killfeed = await scanKillfeedForLatency({
          kills: ace.kills,
          scoreboardDelayMs: cfg.SCOREBOARD_DELAY_MS,
          // A janela é só ONDE PROCURAR no vídeo: usa a faixa medida
          // (adaptive) mesmo em shadow — em shadow ela não altera o
          // corte, só a qualidade da medição. No modo 'auto' é a mesma
          // faixa que foi aplicada no corte.
          latencyHintMs: Math.min(adaptive.startLatencyMs, startLatencyMs),
          // A janela cobre a faixa: o killfeed é acionado justamente
          // quando o regime pode ter subido, e o hint do início é o
          // valor ANTIGO (por regra, só antecipa).
          latencyMaxMs: Math.max(adaptive.endLatencyMs, endLatencyMs),
          segmentTimeSec: cfg.SEGMENT_TIME_SEC,
          listSegments: () => recorder?.listSegments() ?? [],
          crops: killfeedCrops,
          shouldStop: () => stopping,
        });
        log.info(
          {
            matchId,
            stream: streamName,
            motivo: killfeed.reason,
            casadas: killfeed.matchedKills,
            total: killfeed.totalKills,
            primeiraCasada: killfeed.firstKillMatched,
            desvioMedianoMs: killfeed.medianDeviationMs,
            crop: killfeed.crop,
          },
          'calibração pelo killfeed do vídeo',
        );
        if (
          applyVisualSync &&
          killfeed.reason === 'confident' &&
          killfeed.firstKillVideoMs != null
        ) {
          killfeedStartMs = killfeed.firstKillVideoMs;
          killfeedOffsetMs = killfeed.killVideoOffsetMs;
        }
      } catch (e) {
        log.warn(
          { err: String(e).slice(0, 200), matchId, stream: streamName },
          'calibração pelo killfeed falhou — mantendo a âncora do placar',
        );
      }
    }
    /**
     * Âncora final do início: o instante da 1ª kill no vídeo quando o
     * killfeed respondeu (exato), senão a âncora do placar convertida
     * com a latência adaptativa.
     */
    videoStartMs =
      killfeedStartMs != null
        ? killfeedStartMs
        : aceStartMs != null
          ? aceStartMs + startLatencyMs
          : undefined;
    streamSync.startLatencyMs = startLatencyMs;
    streamSync.endLatencyMs = endLatencyMs;
    /**
     * A fonte reportada tem que ser a que foi APLICADA: em shadow
     * (`log`) ou com `CLIP_STREAM_SYNC_ADAPTIVE=false` o corte usa o
     * configurado, mesmo que a decisão adaptativa tenha escolhido uma
     * amostra. O killfeed, quando aplicado, continua sendo a fonte exata.
     */
    const appliedStartSource = applyAdaptive ? adaptive.startSource : 'config';
    streamSync.latencySource =
      killfeedStartMs != null ? 'killfeed' : appliedStartSource;
    streamSync.latencyChanged = adaptive.changed;
    ace.streamSync = streamSync;
    // Contexto adaptativo (mesma conta do corte): âncora de início incerta =
    // a kill pode não ser a 1ª real do round → abre mais cedo.
    const lowAnchor = isAnchorLowConfidence(
      ace.anchorConfidence,
      ace.kills[0]?.at,
      Date.now(),
    );
    const contextSec = lowAnchor ? cfg.CLIP_CONTEXT_UNCERTAIN_SEC : cfg.CLIP_CONTEXT_SEC;
    /**
     * Margem do início: o erro de latência é assimétrico (latência real
     * menor que a configurada = 1ª kill FORA do clipe). A margem abre o
     * corte antes, pagando o erro pelo lado barato.
     */
    const startMarginSec = cfg.CLIP_START_MARGIN_SEC;
    /**
     * Âncoras do clipe (do relógio do placar para a timeline do vídeo).
     * Puro/testável em clipAnchors.ts.
     */
    const anchors = computeClipAnchors({
      aceStartedAtMs: aceStartMs,
      streamLatencyMs,
      startLatencyMs,
      endLatencyMs,
      scoreboardDelayMs: cfg.SCOREBOARD_DELAY_MS,
      scoreDelayMs: cfg.CLIP_SCORE_DELAY_MS,
      endAfterCloseSec: cfg.CLIP_END_AFTER_CLOSE_SEC,
      endTailSec: cfg.CLIP_END_TAIL_SEC,
      contextSec,
      startMarginSec,
      aceDetectedAtMs,
      scoreboardEndMs: detectedEndMs,
      syncApplied: streamSync.applied,
      syncScanned:
        cfg.CLIP_STREAM_SYNC === 'auto' &&
        streamSync.reason !== 'disabled' &&
        streamSync.reason !== 'recorder-unavailable',
    });
    /**
     * Offset dos timestamps: latência − atraso do placar. Quando o
     * killfeed mediu o instante das kills no vídeo, ele é a fonte mais
     * precisa (não depende de latência estimada).
     */
    const killVideoOffsetMs = killfeedOffsetMs ?? anchors.killVideoOffsetMs;
    const { endMs } = anchors;
    // Metadados: a CHAMADA da IA começa aqui (EM PARALELO ao corte do
    // clipe — só ela depende da rede, então não soma latência no
    // upload). A composição final espera o clipe real: o sidecar sabe o
    // início exato do vídeo, enquanto a estimativa (1ª kill − contexto)
    // erra quando a abertura foi truncada pelo buffer. Falha aqui cai
    // no gerador determinístico (ou no título legado, se tudo falhar).
    const estimatedClipStartMs = anchors.estimatedClipStartMs;
    const metadataDraftPromise =
      cfg.YT_META_MODE === 'ai' && cfg.YT_UPLOAD
        ? getMetadataAi()(
            buildMetadataContext(ace, estimatedClipStartMs, undefined, killVideoOffsetMs),
          ).catch((e) => {
            log.warn(
              { err: String(e).slice(0, 200) },
              'falha ao gerar metadados — upload segue com o caminho legado',
            );
            return null;
          })
        : undefined;
    /**
     * Alvo de espera: o mesmo fim com folga. A folga NÃO entra no corte —
     * ela só dá tempo do round fechar (e do material chegar) antes de
     * medir. Sem essa separação, o fallback empurrava o fim do clipe
     * 35s e o vídeo guardava o bloco de anúncios do fim da transmissão.
     */
    const waitTargetMs =
      endMs + (anchors.usedFallback ? cfg.CLIP_STREAM_SYNC_FALLBACK_SEC * 1000 : 0);
    /**
     * Telemetria da latência: o que foi MEDIDO no round (virada do
     * placar no vídeo) e o que foi APLICADO nas âncoras. A diferença
     * entre as duas é o ajuste que o dono faria no .env — e o log mostra
     * se a latência está VARIANDO dentro da partida (o caso que um
     * valor fixo não resolve).
     */
    if (streamSync.observedLatencyMs != null) {
      const median = latencyTracker.median(streamName);
      log.info(
        {
          matchId,
          stream: streamName,
          latenciaObservadaMs: streamSync.observedLatencyMs,
          latenciaMedianaMs: median,
          latenciaConfiguradaMs: streamLatencyMs,
          latenciaAplicadaInicioMs: startLatencyMs,
          latenciaAplicadaFimMs: endLatencyMs,
          fonteLatencia: streamSync.latencySource,
          roundMudouRegime: adaptive.changed,
          deltaAnteriorMs: adaptive.deltaMs,
          idadeAmostraMs: adaptive.priorAgeMs,
          deltaMs: streamSync.observedLatencyMs - streamLatencyMs,
          // A referência do fim do round: o timer real do placar do HLTV
          // ("Round over") ou a estimativa (detecção − atraso do placar,
          // que carrega o erro de CLIP_SCORE_DELAY_MS).
          referenciaFimRound: roundEndedAtMs != null ? 'timer-hltv' : 'estimada',
          fimRoundReal: roundEndedAtMs != null ? new Date(roundEndedAtMs).toISOString() : null,
          scoreDelayMs: cfg.CLIP_SCORE_DELAY_MS,
          amostras: latencyTracker.samplesCount(streamName),
        },
        'latência observada da stream (virada do placar no vídeo)',
      );
    }
    // Trilha de calibração: com o clipe pronto, estes instantes mostram
    // se a latência configurada bate com o material gravado.
    log.info(
      {
        matchId,
        player: ace.player,
        round: ace.round,
        stream: recorder?.streamName,
        aceStart: aceStartMs != null ? new Date(aceStartMs).toISOString() : null,
        videoStart: videoStartMs != null ? new Date(videoStartMs).toISOString() : null,
        end: new Date(endMs).toISOString(),
        streamLatencyMs,
        latenciaAplicadaInicioMs: startLatencyMs,
        latenciaAplicadaFimMs: endLatencyMs,
        fonteLatencia: streamSync.latencySource,
        scoreboardDelayMs: cfg.SCOREBOARD_DELAY_MS,
        scoreDelayMs: cfg.CLIP_SCORE_DELAY_MS,
        endAnchored: anchors.usedScoreboardEnd,
        contextSec,
      },
      'âncoras do clipe (placar → vídeo)',
    );
    /**
     * Quebra de continuidade da timeline dentro da janela do clipe: a
     * fonte reiniciou a base de PTS (ou o probe viu salto/stall) e o
     * material pode ter um buraco. O clipe é MARCADO — não é prova de
     * que faltou conteúdo, mas a omissão silenciosa seria pior.
     */
    const timelineEvents =
      recorder?.timelineEventsInWindow(
        // O clipe começa no contexto ANTES da 1ª kill (e o pick inclui
        // pré-roll atômico); a janela de eventos tem que cobrir o
        // material que realmente entra no vídeo.
        anchors.estimatedClipStartMs ?? videoStartMs ?? endMs,
        endMs,
      ) ?? [];
    const timelineDiscontinuity = timelineEvents.length > 0;
    if (timelineDiscontinuity) {
      ace.timelineDiscontinuity = true;
      log.warn(
        {
          matchId,
          eventos: timelineEvents.length,
          tipos: [...new Set(timelineEvents.map((event) => event.kind))],
        },
        'clipe com quebra de continuidade da timeline (material pode ter buraco)',
      );
    }
    let endCovered = false;
    const waitUntil =
      Date.now() +
      Math.max(
        150_000,
        waitTargetMs - Date.now() + cfg.SEGMENT_TIME_SEC * 1000 + 20_000,
      );
    while (!stopping && Date.now() < waitUntil) {
      segments = recorder?.listSegments() ?? [];
      if (segments.length === 0) break;
      endCovered =
        newestSegmentEndMs(segments) >= endMs + cfg.SEGMENT_TIME_SEC * 1000 + 5_000;
      if (endCovered) {
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

    // Contexto adaptativo: âncora de início incerta (tracker entrou no meio
    // do round, resetou a base, ou a 1ª kill veio da janela de assentamento)
    // = a kill pode não ser a 1ª real — começa mais cedo para não perder a
    // abertura. Confiança alta mantém os 10s da especificação.
    // (lowAnchor/contextSec já calculados acima, para os metadados.)
    if (lowAnchor) {
      log.warn({ conf: ace.anchorConfidence }, 'âncora de início incerta — contexto alargado');
    }
    // R2: âncora mais velha que o buffer = abertura real fora do alcance.
    // Sinaliza no sidecar (via ace) em vez de cair no fallback silencioso.
    ace.truncatedStart = detectTruncatedStart(segments, {
      segmentTimeSec: cfg.SEGMENT_TIME_SEC,
      contextSec,
      startMarginSec,
      aceStartMs: videoStartMs,
    });
    if (ace.truncatedStart) {
      log.warn('âncora precede o buffer (truncatedStart): abertura incompleta');
    }

    // SNAPSHOT dos segmentos escolhidos: o buffer é CIRCULAR (SEGMENT_WRAP
    // sobrescreve os arquivos) e a partida pode sair do ar (poll para o
    // recorder e apaga o buffer) enquanto refs/render/thumb ainda rodam —
    // minutos. Copia preservando mtime (seleção/trim são mtime-driven) e
    // constrói o clipe a partir da cópia imune ao churn do buffer.
    let coverageDiscarded = false;
    const buildClipFromBuffer = async (): Promise<ClipResult | null> => {
      const sourceSegments = segments;
      const sourceEndMs = aceEndMs;
      if (sourceSegments.length === 0) {
        log.warn({ matchId }, 'sem segmentos para montar o clipe');
        return null;
      }
      const clipAce: AceEvent = {
        ...ace,
        endedAt: sourceEndMs != null ? new Date(sourceEndMs).toISOString() : undefined,
        truncatedStart: detectTruncatedStart(sourceSegments, {
          segmentTimeSec: cfg.SEGMENT_TIME_SEC,
          contextSec,
          startMarginSec,
          aceStartMs: videoStartMs,
        }),
      };
      // A 1ª kill já saiu do buffer? Sem ela o clipe não é o ace que o
      // sidecar promete (foi o caso do 5K do jcobbb: round fechou minutos
      // depois e o corte pegou só o intervalo seguinte). Melhor não gerar.
      const oldestStartMs = oldestSegmentStartMs(sourceSegments, cfg.SEGMENT_TIME_SEC);
      /**
       * Régua da cobertura: quando o killfeed mediu o offset, ele é
       * EXATO (o `at` da kill + offset do vídeo) — usar a latência do
       * início aqui misturaria duas réguas e poderia esconder que a 1ª
       * kill já saiu do buffer. Sem killfeed, vale a latência aplicada.
       */
      const coverageLatencyMs =
        killfeedOffsetMs != null
          ? killfeedOffsetMs + cfg.SCOREBOARD_DELAY_MS
          : startLatencyMs;
      const coverage = evaluateAceCoverage({
        kills: ace.kills,
        anchorMs: videoStartMs,
        oldestSegmentStartMs: oldestStartMs,
        // A latência que ancorou o início (medida quando existe): é a
        // mesma régua do corte — as duas sides na MESMA timeline.
        streamLatencyMs: coverageLatencyMs,
        scoreboardDelayMs: cfg.SCOREBOARD_DELAY_MS,
      });
      if (coverage.discard) {
        log.warn(
          { matchId, kills: coverage.totalKills },
          'nenhuma kill do ace está no buffer — clipe descartado (não conteria o ace)',
        );
        coverageDiscarded = true;
        return null;
      }
      if (coverage.truncatedStart) {
        log.warn(
          {
            matchId,
            aceStart: aceStartMs != null ? new Date(aceStartMs).toISOString() : null,
            oldestStart: oldestStartMs != null ? new Date(oldestStartMs).toISOString() : null,
          },
          'âncora fora do buffer — clipe com abertura incompleta (truncatedStart)',
        );
      }
      const picked = pickSegments(sourceSegments, {
        segmentTimeSec: cfg.SEGMENT_TIME_SEC,
        preRollSec: cfg.CLIP_PRE_ROLL_SEC,
        postRollSec: cfg.CLIP_POST_ROLL_SEC,
        contextSec: contextSec + startMarginSec,
        aceStartMs: videoStartMs,
        aceEndMs: sourceEndMs,
      });
      const snapDir = path.join(
        cfg.CLIPS_DIR,
        '.build',
        `${matchId}-r${ace.round}-${Date.now()}`,
      );
      snapDirs.push(snapDir);
      const snapshot = snapshotSegments(picked, snapDir);
      log.info(
        { picked: picked.length, snap: path.basename(snapDir) },
        'segmentos congelados (snapshot)',
      );
      try {
        const references = await refsPromise;
        return await buildClip(clipAce, snapshot, {
          bufferDir: snapDir,
          clipsDir: cfg.CLIPS_DIR,
          preRollSec: cfg.CLIP_PRE_ROLL_SEC,
          postRollSec: cfg.CLIP_POST_ROLL_SEC,
          segmentTimeSec: cfg.SEGMENT_TIME_SEC,
          contextSec,
          startMarginSec,
          aceStartMs: videoStartMs,
          aceEndMs: sourceEndMs,
          replayAware: cfg.REPLAY_AWARE,
          diskMinFreeBytes: cfg.DISK_MIN_FREE_GB * 1024 ** 3,
          upscaleHeight: cfg.CLIP_UPSCALE_HEIGHT,
          streamName: recorder?.streamName,
          streamLatencyMs,
          startLatencyMs,
          endLatencyMs,
          latencySource: streamSync.latencySource ?? undefined,
          latencyChanged: adaptive.changed,
          timelineDiscontinuity,
          killVideoOffsetMs,
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
              geminiWebChromeProfile: cfg.GEMINI_WEB_CHROME_PROFILE || undefined,
              geminiWebHeadless: cfg.GEMINI_WEB_HEADLESS,
              chatgptProfileDir: cfg.CHATGPT_PROFILE,
              chatgptMinimized: cfg.CHATGPT_MINIMIZED,
              grokProfileDir: cfg.GROK_PROFILE,
              grokMinimized: cfg.GROK_MINIMIZED,
              references: references ?? {},
            },
          },
        });
      } catch (e) {
        log.error({ err: String(e), matchId }, 'falha ao montar o clipe');
        return null;
      } finally {
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
    };

    const clip = await buildClipFromBuffer();
    // Nenhum clipe sobreviveu: só é fantasma se caiu por falta de footage.
    // Falha de ffmpeg/disco mantém o evento no banco (o clipe pode ser
    // refeito manualmente).
    if (!clip && coverageDiscarded) {
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
    if (clip) {
      let videoId: string | undefined;
      if (!cfg.YT_UPLOAD) {
        log.info({ clip: clip.filePath }, 'upload desativado (YT_UPLOAD=false) — clipe mantido local');
      } else {
        try {
          // Composição final: usa o clipe REAL (início e duração do
          // sidecar) para os timestamps e a linha de duração.
          // A composição tem fallback PRÓPRIO (buildVideoMetadataSafe):
          // uma exceção aqui (sidecar nulo, regex, dado inesperado) NÃO
          // pode derrubar o upload — sem metadados o upload segue pelo
          // caminho legado.
          const metadata =
            cfg.YT_META_MODE === 'legacy' || !cfg.YT_UPLOAD
              ? undefined
              : await buildVideoMetadataSafe(ace, {
                  mode: cfg.YT_META_MODE,
                  ai: metadataDraftPromise ? async () => metadataDraftPromise : undefined,
                  brand: cfg.YT_BRAND,
                  cta: cfg.YT_DESC_CTA,
                  privacy: cfg.YT_PRIVACY,
                  defaultTags: cfg.YT_DEFAULT_TAGS,
                  clipStartMs: clip.clipStartMs ?? estimatedClipStartMs,
                  clipDurationSec: clip.clipDurationSec,
                  // O `at` da kill é o momento em que o placar a mostrou:
                  // no vídeo o kill aparece (latência da stream − atraso
                  // do placar) depois. É esse offset que alinha os
                  // timestamps da descrição com a tela.
                  killTimeOffsetMs: killVideoOffsetMs,
                });
          videoId = await uploadClip(ace, clip.filePath, {
            clientSecretsPath: cfg.YT_CLIENT_SECRETS,
            tokenPath: cfg.YT_TOKEN_PATH,
            privacy: cfg.YT_PRIVACY,
            categoryId: cfg.YT_CATEGORY_ID,
            defaultTags: cfg.YT_DEFAULT_TAGS,
            thumbnailPath: clip.thumbnailPath,
            metadata,
          });
        } catch (e) {
          log.error({ err: String(e) }, 'falha no upload YT — clipe mantido local para retry manual');
        }
      }
      insertClip(cfg.DB_PATH, aceId, clip.filePath, cfg.YT_PRIVACY, videoId);
      setTrayStatusClip({
        at: new Date().toISOString(),
        matchId: ace.matchId,
        player: ace.player,
        map: ace.map,
        round: ace.round,
        filePath: clip.filePath,
        videoId,
        uploaded: Boolean(videoId),
        privacy: cfg.YT_PRIVACY,
      });
    }
  } catch (e) {
    log.error({ err: String(e) }, 'falha ao montar clipe');
  } finally {
    for (const dir of snapDirs) fs.rmSync(dir, { recursive: true, force: true });
    removePendingClip(matchId);
    patchTrayStatus({ pendingClips: pendingClipCount() });
  }
}

/** Resultado de um poll: o que define o próximo intervalo de checagem. */
interface PollOutcome {
  /** Próxima partida elegível (horário marcado), se houver. */
  nextMatch: UpcomingMatch | null;
  /** Partidas live que passaram no filtro. */
  liveMatches: number;
  /** Listing bloqueado pelo Cloudflare. */
  blocked: boolean;
  /**
   * Listing DEGRADADO (algum card live quebrou): os cards bons valem,
   * mas a lista pode estar incompleta → não para recorders que sumiram
   * e repete o poll no intervalo base.
   */
  degraded: boolean;
  /** A agenda futura do listing é confiável (extração funcionou)? */
  scheduleReliable: boolean;
  /** Watchlist ausente mas ainda segurando a última versão boa. */
  watchlistStale: boolean;
  /** A watchlist mudou durante este poll (reprocessa no próximo ciclo). */
  watchlistChanged: boolean;
}

async function pollOnce(watchlistVersion: number): Promise<PollOutcome> {
  const cfg = getConfig();
  const log = getLogger();
  getDb(cfg.DB_PATH);

  // Watchlist: hot-reload por mtime (barato a cada poll). JSON inválido
  // mantém a última versão boa; arquivo ausente mantém a última versão por
  // até 1 min (save/rename do editor) e depois cai na política por estrelas.
  const watchlist = loadWatchlistFile(WATCHLIST_FILE);
  activeWatchlist = watchlist.doc;
  const watchlistStale = watchlist.missing && watchlist.stale;
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

  const result = await fetchMatchListing(
    cfg.HLTV_MATCHES_URL,
    cfg.MIN_STARS,
    cfg.TOP_TIER_ONLY,
    {
      watchlist: watchlist.doc,
      starredMinKills: cfg.MIN_KILLS,
      unstarredMinKills: cfg.MIN_KILLS_NO_STARS,
    },
  );
  if (!result.ok) {
    // Bloqueio do Cloudflare e erro de extração são coisas diferentes:
    // a mensagem precisa dizer qual foi (diagnóstico), mas o efeito é o
    // mesmo — manter recorders/trackers e pollar no intervalo base.
    const lastError =
      result.reason === 'blocked'
        ? 'listing bloqueado pelo Cloudflare'
        : 'falha ao extrair o listing';
    log.warn(
      { reason: result.reason, detail: result.detail },
      `${lastError} — mantendo recorders/trackers`,
    );
    if (result.reason === 'extraction-error') {
      notifyListingFailure(lastError, result.detail);
    }
    publishTrayStatus(null, cfg, { lastError });
    return {
      // Mantém a última partida conhecida no painel (o bloqueio não
      // apaga a fila) — o intervalo base já vem do motivo 'blocked'.
      nextMatch: lastKnownNextMatch,
      liveMatches: 0,
      blocked: result.reason === 'blocked',
      degraded: false,
      scheduleReliable: false,
      watchlistStale,
      // Mudou durante este poll? (a versão consumida no topo do loop é a
      // de antes do poll — se o watcher mexeu no arquivo agora, o próximo
      // ciclo precisa do intervalo base para aplicar a versão nova).
      watchlistChanged: watchlistSignal.version !== watchlistVersion,
    };
  }
  const listing = result.listing;
  const matches = listing.live;
  // Listing degradado: um card live quebrou. Os cards bons valem (o
  // poll continua), mas a lista pode estar incompleta: NENHUM recorder
  // pode ser parado por "sumir do listing" e o poll volta no intervalo
  // base (o markup pode estar consertado no próximo ciclo).
  const degraded = result.degraded;
  if (degraded) {
    notifyListingFailure('listing degradado', result.detail);
  } else {
    listingFailures = 0;
    listingFailureNotified = false;
  }

  // Telemetria de detecção: quando a live elegível aparece pela 1ª vez,
  // mede a latência contra o horário previsto (e avisa se ela nem estava
  // na agenda — sinal de que o backoff dormiu por cima da partida).
  for (const ev of detectionEvents({
    liveMatchIds: matches.map((m) => m.matchId),
    knownUpcoming,
    predictedMatchId,
    now: Date.now(),
    seen: detectedLive,
  })) {
    const base = {
      matchId: ev.matchId,
      latencyMs: ev.latencyMs,
      latencyMin: ev.latencyMs === null ? null : Math.round(ev.latencyMs / 60_000),
      predicted: ev.predicted,
    };
    if (ev.latencyMs === null) {
      // Agenda vazia = o bot ainda não viu um listing válido (startup):
      // "fora da agenda" é o estado normal, não um sintoma do backoff.
      if (knownUpcoming.size > 0) {
        log.warn(base, 'live detectada fora da agenda conhecida');
      } else {
        log.info(base, 'live detectada (agenda ainda desconhecida)');
      }
    } else {
      log.info(base, 'live detectada');
    }
  }

  for (const m of matches) {
    if (stopping) break;

    // 1) Recorder (máx MAX_RECORDINGS, stream por STREAM_PRIORITY)
    // Recorders mortos (stream caiu/URL expirou) são descartados p/ recriar.
    for (const [id, recorder] of activeRecorders) {
      if (!recorder.isRunning) {
        await recorder.stop().catch(() => undefined);
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
          const recorder = new StreamRecorder({
            streamUrl,
            bufferDir: `${cfg.BUFFER_DIR}/${m.matchId}/muxed`,
            segmentTimeSec: cfg.SEGMENT_TIME_SEC,
            segmentWrap: cfg.SEGMENT_WRAP,
            captureFormat: cfg.CAPTURE_FORMAT,
            streamName: chosen.name,
            diskMinFreeBytes: cfg.DISK_MIN_FREE_GB * 1024 ** 3,
          });
          try {
            await recorder.start();
          } catch (e) {
            await recorder.stop().catch(() => undefined);
            fs.rmSync(recorder.segmentDir, { recursive: true, force: true });
            // Sem gravação não há o que cortar: a partida é ignorada
            // (sem recorder → sem tracker → sem clipe). A stream é
            // marcada como falhada p/ o próximo poll tentar outra
            // candidata.
            throw e;
          }
          activeRecorders.set(m.matchId, recorder);
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
            },
            'gravando buffer muxed',
          );
        }
      } catch (e) {
        if (attemptedStream) markStreamFailed(m.matchId, attemptedStream.url);
        selectedStreams.delete(m.matchId);
        // Mantém o cache: a próxima tentativa usa outra candidata sem abrir
        // aba nova (page-load por poll = exposição ao Cloudflare).
        // "Sem formato muxed" (limitação da fonte) e "falha na gravação"
        // (rede/ffmpeg/disco) são coisas diferentes: o primeiro não é
        // culpa da máquina e a partida fica sem footage mesmo com a
        // stream no ar.
        const semMuxed = e instanceof MuxedFormatUnavailableError;
        log.warn(
          {
            err: String(e).slice(0, 300),
            matchId: m.matchId,
            stream: attemptedStream?.name,
            causa: semMuxed ? 'fonte-sem-formato-muxed' : 'falha-operacional',
          },
          semMuxed
            ? 'fonte sem formato combinado (muxed) — partida ignorada (sem gravação e sem clipe)'
            : 'falha ao iniciar a gravação — partida ignorada (sem gravação e sem clipe)',
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
              roundEndedAt: a.roundEndedAt,
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

  // 3) Limpa recorders de partidas que saíram do filtro.
  // Listing DEGRADADO = algum card live quebrou. A partida desse card
  // pode ter "sumido" do listing: parar o recorder dela mataria a
  // gravação (e apagaria o buffer) sem motivo. A proteção é POR ID (os
  // cards quebrados), não para toda a limpeza — suspender tudo deixava
  // recorders de partidas encerradas ocupando os slots de MAX_RECORDINGS
  // para sempre (partidas novas deixavam de ser gravadas).
  const liveIds = new Set(matches.map((m) => m.matchId));
  if (degraded) {
    log.warn(
      { recorders: activeRecorders.size, cardsQuebrados: result.brokenLiveIds },
      'listing degradado — recorders dos cards quebrados preservados',
    );
  }
  for (const [id, recorder] of activeRecorders) {
    if (shouldStopRecorder(id, liveIds, result.brokenLiveIds)) {
      await recorder.stop().catch(() => undefined);
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

  // Próxima partida elegível (horário marcado): define o backoff do poll.
  // A grace mantém no topo a partida já iniciada que ainda não aparece
  // como live (adiamento) — assim o bot não "dorme" no meio do jogo.
  const nextMatch = selectNextUpcoming(listing.upcoming, Date.now(), POLL_START_GRACE_MS);
  lastKnownNextMatch = nextMatch;
  predictedMatchId = nextMatch?.matchId ?? null;
  // Atualiza a agenda conhecida (usada na telemetria do próximo poll).
  knownUpcoming.clear();
  for (const m of listing.upcoming) knownUpcoming.set(m.matchId, m.startsAt);
  return {
    nextMatch,
    liveMatches: matches.length,
    blocked: false,
    degraded,
    scheduleReliable: listing.scheduleReliable,
    watchlistStale,
    // Mudou durante este poll (o fetch do listing leva segundos: a versão
    // é conferida no fim, não no começo).
    watchlistChanged: watchlistSignal.version !== watchlistVersion,
  };
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
  startWatchlistWatcher();
  setTrayStatusPhase('monitoring');
  const log = getLogger();
  /**
   * Estado de latência por canal (persistido entre reinícios): o 1º
   * round de uma partida nova já começa com a latência medida na
   * partida anterior — a primeira transição de placar corrige o valor.
   */
  const latencyState = loadLatencyState(cfg.CLIP_STREAM_SYNC_STATE_PATH);
  latencyTracker = latencyState.state;
  if (latencyState.problem) {
    log.warn(
      { arquivo: cfg.CLIP_STREAM_SYNC_STATE_PATH, problema: latencyState.problem },
      'estado de latência inválido — recomeçando do zero',
    );
  } else if (latencyTracker.channels().length > 0) {
    log.info(
      {
        arquivo: cfg.CLIP_STREAM_SYNC_STATE_PATH,
        canais: latencyTracker.channels().map((canal) => ({
          canal,
          medianaMs: latencyTracker.median(canal),
          amostras: latencyTracker.samplesCount(canal),
          crop: latencyTracker.crop(canal),
        })),
      },
      'estado de latência carregado',
    );
  }
  // Faxina de snapshots órfãos: renders só existem com o bot vivo — qualquer
  // conteúdo em .build no startup é cadáver de sessão morta (kill/restart no
  // meio do handleAce). Já acumulou 20GB antes desta faxina.
  try {
    fs.rmSync(`${cfg.CLIPS_DIR}/.build`, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  // Buffers órfãos do modo de captura DUPLA (removido): as pastas
  // `separate` não são lidas por nada desde a captura única muxed e só
  // ocupam disco.
  try {
    for (const entry of fs.readdirSync(cfg.BUFFER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const separate = path.join(cfg.BUFFER_DIR, entry.name, 'separate');
      if (!fs.existsSync(separate)) continue;
      fs.rmSync(separate, { recursive: true, force: true });
      log.info({ matchId: entry.name }, 'buffer do modo separado (obsoleto) removido');
    }
  } catch {
    // best-effort
  }
  // Arquivo órfão do subsistema de calibração A/V (removido): nada o lê
  // mais — sai no startup para não parecer configuração viva.
  try {
    const staleCalibration = repoPath('data', 'av-calibration.json');
    if (fs.existsSync(staleCalibration)) {
      fs.rmSync(staleCalibration, { force: true });
      log.info('calibração A/V obsoleta removida (subsistema desativado)');
    }
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
      replayAware: cfg.REPLAY_AWARE,
      diskMinFreeGb: cfg.DISK_MIN_FREE_GB,
      thumbLogin: Object.keys(loggedOut).length > 0
        ? Object.keys(loggedOut).map((p) => `${p}=LOGOUT!`).join(',')
        : 'ok',
      upload: cfg.YT_UPLOAD,
      maxRec: cfg.MAX_RECORDINGS,
    },
    `bot iniciado (multikills ${cfg.MIN_KILLS}k+ com estrela / ${cfg.MIN_KILLS_NO_STARS}k sem estrela live, 16:9, log em arquivo)`,
  );
  // Envs que o bot IGNORA: o zod aceita qualquer coisa e o dono acaba
  // achando que a configuração velha ainda vale (a depreciação silenciosa
  // já custou um .env inteiro de ajustes de A/V).
  const deprecated = deprecatedEnvVars();
  if (deprecated.length > 0) {
    log.warn(
      { vars: deprecated },
      'envs depreciadas no .env — ignoradas pelo bot (remova do arquivo)',
    );
  }
  const invalidBools = invalidBoolEnvs();
  if (invalidBools.length > 0) {
    log.warn(
      { vars: invalidBools },
      'valor de env não reconhecido (ligado/desligado) — usando o default',
    );
  }
  // Mapa de latência por canal: JSON inválido era aceitado em silêncio
  // (o bot caía na latência global sem avisar).
  const latencyMapIssue = latencyMapProblem(process.env.CLIP_STREAM_LATENCY_BY_STREAM);
  if (latencyMapIssue) {
    log.warn(
      { env: 'CLIP_STREAM_LATENCY_BY_STREAM', problema: latencyMapIssue },
      'mapa de latência por canal inválido — usando CLIP_STREAM_LATENCY_MS',
    );
  }
  // Latência/atraso do placar com valor DIFERENTE do default no .env:
  // só a DIFERENÇA (CLIP_STREAM_LATENCY_MS − SCOREBOARD_DELAY_MS) move o
  // início do clipe, a cobertura e os timestamps — os dois valores não
  // são identificáveis separadamente. Um .env antigo (SCOREBOARD_DELAY_MS
  // =10000) desloca o corte em segundos sem nenhuma pista no log.
  const latencyEnvs = divergentLatencyEnvs();
  if (latencyEnvs.length > 0) {
    log.warn(
      {
        vars: latencyEnvs,
        offsetPlacarVideoMs: cfg.CLIP_STREAM_LATENCY_MS - cfg.SCOREBOARD_DELAY_MS,
      },
      'latência/atraso do placar com valor diferente do default no .env — o corte usa só a diferença (CLIP_STREAM_LATENCY_MS - SCOREBOARD_DELAY_MS)',
    );
  }
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
  const bins = StreamRecorder.checkBinaries();
  if (!bins.ffmpeg || !bins.ytdlp) {
    log.warn(
      'ffmpeg/yt-dlp ausentes (nem no PATH nem em .tools/). Sem eles não há buffer local — o bot só detecta, sem cortar clipes.',
    );
  }

  const shutdown = async (): Promise<void> => {
    stopping = true;
    stopWatchlistWatcher();
    shutdownTrayStatus();
    for (const recorder of activeRecorders.values()) {
      await recorder.stop().catch(() => undefined);
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

  // Último motivo registrado do agendamento (log só na mudança: o poll
  // pode repetir o mesmo motivo a cada ciclo).
  let lastDecisionReason: string | null = null;
  /**
   * Ciclos seguidos com a agenda do listing não confiável (card futuro
   * quebrado / sem horário): o poll fica no intervalo base (fail-open).
   * Um único card quebrado mantém o bot checando o listing o dia
   * inteiro — o contador deixa isso visível no log em vez de silencioso.
   */
  let unreliableScheduleCycles = 0;

  while (!stopping) {
    const pollStartedAt = Date.now();
    // Consome a versão da watchlist ANTES do poll: se o arquivo mudar
    // durante o poll, o fim do poll percebe (watchlistChanged → intervalo
    // base no próximo ciclo). Se o poll lançar, o sleep abaixo ainda
    // espera — nada de hot-loop por "flag sujo" não consumida.
    const watchlistVersion = watchlistSignal.version;
    let delay = cfg.POLL_INTERVAL_MS;
    try {
      const outcome = await pollOnce(watchlistVersion);
      if (outcome.blocked || outcome.scheduleReliable) {
        unreliableScheduleCycles = 0;
      } else {
        unreliableScheduleCycles++;
        if (unreliableScheduleCycles === 1 || unreliableScheduleCycles % 20 === 0) {
          log.warn(
            { ciclos: unreliableScheduleCycles },
            'agenda do listing não confiável — poll no intervalo base',
          );
        }
      }
      // Live elegível, gravação/tracker ativo, clipe em andamento ou buffer
      // adiado: o poll tem que continuar no intervalo base (buffer/stream/
      // cleanup). Cada motivo vira uma linha no log do agendamento.
      const forceReasons = pollForceReasons({
        liveMatches: outcome.liveMatches,
        recorders: activeRecorders.size,
        trackers: activeTrackers.size,
        pendingClips: pendingClips.size,
        deferredCleanup: deferredBufferCleanup.size,
        blocked: outcome.blocked,
        listingDegraded: outcome.degraded,
        watchlistChanged: outcome.watchlistChanged,
        watchlistStale: outcome.watchlistStale,
      });
      const now = Date.now();
      const decision = computePollDecision({
        now,
        nextMatchAt: outcome.nextMatch?.startsAt ?? null,
        baseIntervalMs: cfg.POLL_INTERVAL_MS,
        forceReasons,
        scheduleReliable: outcome.scheduleReliable,
        adaptive: cfg.POLL_ADAPTIVE,
      });
      delay = decision.delayMs;
      patchTrayStatus({
        nextPollAt: new Date(now + delay).toISOString(),
        nextMatch: outcome.nextMatch
          ? {
              matchId: outcome.nextMatch.matchId,
              team1: outcome.nextMatch.team1,
              team2: outcome.nextMatch.team2,
              startsAt: new Date(outcome.nextMatch.startsAt).toISOString(),
              watchlisted: Boolean(outcome.nextMatch.watchlisted),
            }
          : null,
      });
      if (decision.reason !== lastDecisionReason) {
        const previous = lastDecisionReason;
        lastDecisionReason = decision.reason;
        if (decision.reason === 'schedule-unreliable') {
          log.warn(
            { reason: decision.reason, previous },
            'agenda do listing não confiável — poll no intervalo base',
          );
        } else {
          log.info(
            { reason: decision.reason, previous, delayMs: delay },
            'decisão do agendamento do poll',
          );
        }
      }
      if (delay > cfg.POLL_INTERVAL_MS) {
        log.info(
          {
            reason: decision.reason,
            nextMatch: outcome.nextMatch
              ? `${outcome.nextMatch.team1} vs ${outcome.nextMatch.team2}`
              : null,
            startsAt: outcome.nextMatch
              ? new Date(outcome.nextMatch.startsAt).toISOString()
              : null,
            delayMs: delay,
          },
          'poll adiado — próxima partida longe',
        );
        // Ocioso de verdade (sem live/gravação/tracker/clip pendente — esses
        // forçam o intervalo base): fecha o browser e libera RAM/CPU
        // durante a espera. O perfil persistente guarda o clearance do
        // Cloudflare; o próximo poll relança o browser.
        //
        // Só fecha quando a espera é LONGA: relançar o Chrome a cada
        // espera curta pisca na tela e pode roubar o foco de um jogo em
        // fullscreen (o Chrome real às vezes ignora a flag de minimizar).
        if (cfg.HLTV_CLOSE_BROWSER_IDLE && delay >= cfg.HLTV_CLOSE_BROWSER_MIN_IDLE_MS) {
          try {
            await closeBrowser();
          } catch {
            // best-effort: fechar o browser é conveniência, não parte do poll
          }
        }
      }
    } catch (e) {
      log.error({ err: String(e) }, 'erro no ciclo de poll');
      setTrayStatusError(String(e));
      delay = cfg.POLL_INTERVAL_MS;
      patchTrayStatus({
        nextPollAt: new Date(Date.now() + delay).toISOString(),
        nextMatch: null,
      });
    }
    // Dorme até o próximo poll. Uma mudança da watchlist antecipa a
    // espera (hot-reload), mas nunca antes de um intervalo base após o
    // poll anterior (debounce) — e nunca zera a espera (hot-loop).
    // seenVersion = a versão que ESTE poll já consumiu: uma mudança
    // antiga (o contador nunca volta a 0) não pode continuar
    // antecipando o deadline e matar o backoff.
    // O deadline é calculado UMA vez: o sleep usa este valor e o wake
    // publica o MESMO (recalcular com um "agora" novo mostrava um
    // horário diferente do poll real).
    const sleepTargetAt = Date.now() + delay;
    await sleepUntilPoll(
      {
        targetAt: sleepTargetAt,
        signal: watchlistSignal,
        seenVersion: watchlistVersion,
        lastPollAt: pollStartedAt,
        baseIntervalMs: cfg.POLL_INTERVAL_MS,
        shouldStop: () => stopping,
      },
      {
        // A mudança da watchlist antecipa o poll: o horário publicado no
        // painel (nextPollAt) ficava no deadline antigo, mentindo sobre
        // quando o próximo poll acontece.
        onWake: () => {
          const deadline = pollSleepDeadline({
            now: Date.now(),
            targetAt: sleepTargetAt,
            signal: watchlistSignal,
            seenVersion: watchlistVersion,
            lastPollAt: pollStartedAt,
            baseIntervalMs: cfg.POLL_INTERVAL_MS,
          });
          patchTrayStatus({ nextPollAt: new Date(deadline).toISOString() });
        },
      },
    );
  }
}

main().catch((e) => {
  console.error(e);
  setTrayStatusError(String(e));
  setTrayStatusPhase('error');
  process.exit(1);
});
