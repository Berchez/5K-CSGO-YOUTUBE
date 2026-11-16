import fs from 'node:fs';
import type {
  AceEvent,
  AnchorConfidence,
  GrenadeUse,
  KillEvent,
  RoundSummary,
} from '../types.js';
import { normWeapon } from '../detector/aceDetector.js';
import type { ShortRenderSignature } from './shorts.js';
import type { CaptionStatus } from './shortCaptions.js';
import { normalizeShortOverlaySpec, type ShortOverlaySpec } from './shortOverlayConfig.js';

/**
 * Versão do schema gravado em disco. A leitura aceita v1 (flat) e v2
 * (aninhado); a ESCRITA é sempre v2 (`schemaVersion: SIDECAR_VERSION`
 * espalhado no código). Não existe "voltar atrás" só mudando a
 * constante: o writer continua gravando v2. Para reverter o formato é
 * preciso trocar os writers — por isso a 1ª migração deixa uma cópia
 * `<arquivo>.v1.bak` ao lado.
 */
export const SIDECAR_VERSION = 2;

export interface ClipKillV2 {
  killer: string;
  victim: string;
  /** Instante no relógio do placar (epoch ms); null = desconhecido. */
  atMs: number | null;
  /**
   * Instante da kill no relógio do VOD (s); null = não é material de
   * VOD (ou o VOD não tem epoch).
   */
  atVodSec: number | null;
  /** Posição da kill dentro do clipe (s); null = desconhecida. */
  videoSec: number | null;
  /** A posição foi estimada, não medida no vídeo. */
  estimated: boolean;
  weapon: string | null;
  headshot: boolean | null;
  assistBy: string | null;
  flashAssistBy: string | null;
  /** Ausente no killfeed = null (nunca inventa `false`). */
  throughSmoke: boolean | null;
  wallbang: boolean | null;
  noscope: boolean | null;
  /** De onde veio o `atMs` (hltv-live, killfeed, demo...). */
  atSource: string | null;
}

export interface ClipLatencyV2 {
  configuredMs: number | null;
  startMs: number | null;
  endMs: number | null;
  estimatedStartMs: number | null;
  source: string | null;
  changed: boolean;
  startCapped: boolean;
}

export interface ClipSyncV2 {
  mode: string;
  applied: boolean;
  source: string | null;
  marker: string | null;
  reason: string;
  offsetMs: number | null;
  matchedKills: number | null;
  totalKills: number | null;
  medianDeviationMs: number | null;
  roundEndAt: string | null;
  scoreBefore: string | null;
  scoreAfter: string | null;
  observedLatencyMs: number | null;
  killVideoOffsetMs: number | null;
  latency: ClipLatencyV2;
  anchorSource: string | null;
  crop: string | null;
  killfeed: {
    firstKillVideoMs: number | null;
    reason: string | null;
    crop: string | null;
    replayReads: number | null;
  };
}

export interface ClipWindowV2 {
  truncatedStart: boolean;
  timelineDiscontinuity: boolean;
  timelineMode: string | null;
  concatLenSec: number | null;
  killsSpreadMs: number | null;
  bufferOldestMs: number | null;
  replayAwareEndMs: number | null;
  end: {
    minMs: number | null;
    floorMs: number | null;
    pinnedBy: string | null;
    ocrRejected: boolean | null;
    scoreboardReason: string | null;
  };
  actionResume: unknown;
  freeze: unknown;
  audit: unknown;
}

export interface ClipStatsV2 {
  killCount: number;
  weapons: Array<string | null>;
  headshots: number | null;
  mainWeapon: string | null;
  victims: string[];
  assists: Array<{ by: string; killIndex: number }>;
  flashAssists: Array<{ by: string; killIndex: number }>;
  grenades: GrenadeUse[];
}

export interface ClipVodV2 {
  url: string | null;
  startIso: string | null;
  atSec: number | null;
  gameToVodDeltaSec: number | null;
  note: string | null;
}

export interface ClipPublicationV2 {
  youtubeId: string | null;
  publishedAt: string | null;
  thumbnailAi: boolean;
}

export interface ClipKillfeedV2 {
  /** Origem do detalhe: 'scorebot' (killfeed do HLTV). */
  source: string;
  /** Kills do placar que receberam o detalhe do killfeed. */
  paired: number;
  /** Total de kills do round. */
  total: number;
  /** Kills do killfeed que chegaram para o round. */
  feedKills: number;
  /** `eventId`s do scorebot que entraram no round (depuração). */
  eventIds: string[];
  /**
   * Kills do feed cujo round NÃO bateu com o round do placar.
   *
   * O round do feed é contado por `RoundStart` e o do placar é
   * `ct+t+1`: quando divergem, a kill não pareia (ou fica na fila
   * esperando o round seguinte). O contador separa "o feed atrasou" de
   * "os rounds não batem".
   */
  roundDrift?: number;
  /** Quando o sidecar foi enriquecido pelo script de backfill. */
  enrichedAt?: string | null;
}

export interface ClipSidecarV2 {
  schemaVersion: typeof SIDECAR_VERSION;
  kind: 'clip';
  createdAt: string;
  detectedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  match: {
    id: string;
    event: string;
    team1: string;
    team2: string;
    url: string | null;
  };
  player: {
    name: string;
    team: string | null;
    opponent: string | null;
  };
  round: {
    map: string;
    number: number;
    scoreBefore: string | null;
    scoreAfter: string | null;
    /**
     * Ordem do placar: `ct-t` é o que o tracker grava (o placar do HLTV
     * traz o lado CT e o lado T, e os times TROCAM de lado no
     * halftime).
     *
     * NÃO é `team1-team2`: o placar do tracker nunca sabe qual time
     * estava no CT — e ler isso como time1-time2 nomeia o time errado
     * depois do halftime.
     */
    scoreOrder: 'ct-t';
    endedAtMs: number | null;
    /**
     * Time que ganhou o round — só quando a origem sabe (o VOD, pelo
     * demo). O placar CT-T NÃO permite derivar: sem saber qual time
     * estava no CT, o vencedor seria um chute.
     */
    winner: string | null;
  };
  clip: {
    file: string | null;
    thumbnailFile: string | null;
    startMs: number | null;
    durationSec: number | null;
    captureMode: string | null;
    sourceHeight: number | null;
    outputHeight: number | null;
    streamName: string | null;
    segmentsUsed: string[];
    av: {
      issues: number | null;
      segmentIssues: unknown[];
    } | null;
  };
  kills: ClipKillV2[];
  sync: ClipSyncV2 | null;
  window: ClipWindowV2 | null;
  stats: ClipStatsV2;
  /**
   * Confiança na âncora de início (diagnóstico: o tracker entrou no
   * meio do round, resetou a base, a 1ª kill veio da janela de
   * assentamento).
   */
  anchorConfidence: AnchorConfidence | null;
  /**
   * Telemetria do killfeed do scorebot (arma/headshot/assistência).
   *
   * Sem este bloco, uma kill sem par (feed atrasado, nome divergente)
   * só aparecia como `null` no sidecar — sem nenhuma pista do motivo.
   */
  killfeed: ClipKillfeedV2 | null;
  vod: ClipVodV2 | null;
  publication: ClipPublicationV2 | null;
  note: string | null;
}

export interface ShortWindowV2 {
  startSec: number;
  endSec: number;
  durSec: number;
  /** Posições (s, dentro do clipe) das kills que caem na janela. */
  includedKills: number[];
  /** Posições das kills que ficaram de fora. */
  droppedKills: number[];
}

export interface ShortMarkerV2 {
  schemaVersion: typeof SIDECAR_VERSION;
  kind: 'short';
  createdAt: string;
  source: {
    clipFile: string | null;
    sidecarFile: string | null;
    matchId: string;
    map: string;
    round: number;
    player: string;
    clipStartMs: number | null;
    clipDurationSec: number | null;
  };
  short: {
    file: string | null;
    width: number | null;
    height: number | null;
    startSec: number;
    durationSec: number | null;
    window: ShortWindowV2 | null;
    kills: ClipKillV2[];
    render: ShortRenderSignature | null;
    captions: CaptionStatus | null;
    /**
     * Spec do adesivo PEDIDO (flag de fora): `auto` resolve de novo e o
     * visual do preset vem do código atual. Só é lido quando o render em
     * disco tem adesivo (`render.overlayText` não vazio).
     */
    overlaySpec?: ShortOverlaySpec | null;
  };
  metadata: {
    title: string;
    description: string;
    tags: string[];
    source: string;
    privacy: string;
  } | null;
  publication: {
    youtubeId: string | null;
    publishedAt: string | null;
    privacy: string | null;
  };
  attempts: number;
  lastAttemptAt: string | null;
}

type Obj = Record<string, unknown>;

/**
 * Remove campos desconhecidos (`null`/`undefined`) de um objeto JSON.
 *
 * O modelo em memória usa `null` para "não se sabe"; no disco a chave
 * pode simplesmente não existir. A leitura normaliza os dois casos de
 * volta para `null`. Arrays são POSICIONAIS: seus elementos `null` são
 * preservados para não mudar o alinhamento com as kills.
 */
export function omitNullFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object'
        ? omitNullFields(item)
        : item,
    ) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null || item === undefined) continue;
      out[key] =
        item !== null && typeof item === 'object'
          ? omitNullFields(item)
          : item;
    }
    return out as T;
  }
  return value;
}

/** JSON do sidecar/marker sem campos `null` desnecessários. */
export function stringifyJsonWithoutNulls(value: unknown, indent = 2): string {
  return JSON.stringify(omitNullFields(value), null, indent) ?? '';
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Obj {
  return isObj(value) ? value : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((n) => num(n)).filter((n): n is number => n != null);
  }
  const n = num(value);
  return n != null ? [n] : [];
}

function epochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = str(value);
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  const ms = epochMs(value);
  return ms != null ? new Date(ms).toISOString() : null;
}

function normalizeWeapon(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  // Chave canônica do live (`normWeapon`): `m4a1_silencer` do backfill e
  // `m4a1silencer` do killfeed viram a MESMA arma — senão o enrich não é
  // idempotente e `mostUsedWeapon` conta a mesma arma duas vezes.
  return normWeapon(raw) || null;
}

/** URL de partida da HLTV; URLs de VOD nunca têm esta forma. */
function normalizeHltvMatchUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  return /^https?:\/\/(?:www\.)?hltv\.org\/matches\/\d+(?:\/|$)/i.test(raw) ? raw : null;
}

/** URL canônica da partida a partir do id numérico da HLTV. */
function hltvMatchUrlFromId(matchId: string): string | null {
  return /^\d+$/.test(matchId) ? `https://www.hltv.org/matches/${matchId}` : null;
}

function deriveOpponent(
  team: string | null,
  team1: string | null,
  team2: string | null,
): string | null {
  if (!team) return null;
  const key = team.trim().toLowerCase();
  if (team1 && key === team1.trim().toLowerCase()) return team2;
  if (team2 && key === team2.trim().toLowerCase()) return team1;
  return null;
}

function mostUsedWeapon(kills: ClipKillV2[]): string | null {
  const counts = new Map<string, number>();
  for (const kill of kills) {
    if (!kill.weapon) continue;
    counts.set(kill.weapon, (counts.get(kill.weapon) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Confiança na âncora de início (o v1 gravava no root, via o spread do
 * ace). O v2 mantém no mesmo lugar para não perder o dado na migração:
 * sem ele, o diagnóstico "âncora incerta" (entrou no meio do round,
 * resetou a base) sumia do sidecar.
 */
function normalizeAnchorConfidence(raw: unknown): AnchorConfidence | null {
  if (!isObj(raw)) return null;
  return {
    joinedMidRound: bool(raw.joinedMidRound) ?? false,
    resetThisRound: bool(raw.resetThisRound) ?? false,
    settleKills: num(raw.settleKills) ?? 0,
  };
}

function normalizeKill(
  raw: unknown,
  clipStartMs: number | null,
  killVideoOffsetMs: number | null,
  vodStartMs: number | null,
  vodClipAtSec: number | null = null,
): ClipKillV2 {
  const k = obj(raw);
  // v2 grava `atMs`; v1 grava `at` (epoch ou ISO).
  const atMs = num(k.atMs) ?? epochMs(k.at);
  const atVodSec = num(k.atVodSec);
  const explicitVideoSec = num(k.videoSec);
  let videoSec = explicitVideoSec;
  if (videoSec == null && atMs != null && clipStartMs != null && killVideoOffsetMs != null) {
    videoSec = (atMs + killVideoOffsetMs - clipStartMs) / 1000;
  }
  if (videoSec == null && atVodSec != null && clipStartMs != null && vodStartMs != null) {
    videoSec = atVodSec - (clipStartMs - vodStartMs) / 1000;
  }
  /**
   * VOD sem epoch (`vod.startIso` = null, como no `clips-from-vod`): o
   * instante da kill e o início do clipe estão no mesmo relógio — o do
   * VOD (`vod.atSec`). Sem esta conta, `videoSec` ficava `null` e o
   * clipe saía sem a posição das kills (a janela do Short não tinha
   * onde cortar).
   */
  if (videoSec == null && atVodSec != null && vodClipAtSec != null) {
    videoSec = atVodSec - vodClipAtSec;
  }
  if (videoSec != null && !Number.isFinite(videoSec)) videoSec = null;
  return {
    killer: str(k.killer) ?? '',
    victim: str(k.victim) ?? '',
    atMs,
    atVodSec,
    videoSec,
    estimated: bool(k.estimated) ?? bool(k.appearEstimated) ?? false,
    weapon: normalizeWeapon(k.weapon),
    headshot: bool(k.headshot),
    assistBy: str(k.assistBy),
    flashAssistBy: str(k.flashAssistBy),
    throughSmoke: bool(k.throughSmoke),
    wallbang: bool(k.wallbang),
    noscope: bool(k.noscope),
    atSource: str(k.atSource),
  };
}

function normalizeKills(
  raw: unknown,
  clipStartMs: number | null,
  killVideoOffsetMs: number | null,
  vodStartMs: number | null,
  vodClipAtSec: number | null = null,
): ClipKillV2[] {
  return arr(raw).map((kill) =>
    normalizeKill(kill, clipStartMs, killVideoOffsetMs, vodStartMs, vodClipAtSec),
  );
}

function normalizeStats(raw: unknown, kills: ClipKillV2[]): ClipStatsV2 {
  const s = obj(raw);
  const weaponsRaw = arr(s.weapons);
  /**
   * As kills valem mais que o `summary`: o resumo é calculado no
   * fechamento do round e não sabe da arma (o placar ao vivo não expõe
   * arma) — quando o killfeed chega depois, ele completa as kills, mas
   * o `summary.weapons` fica obsoleto (vazio). Derivar das kills evita
   * gravar `stats.weapons` com `null` ao lado de `kills[].weapon` cheio.
   */
  const killsWeapons = kills.map((k) => k.weapon);
  const killTemArma = killsWeapons.some((w) => w != null && w !== '');
  const weapons = killTemArma
    ? killsWeapons
    : weaponsRaw.length > 0
      ? weaponsRaw.map((w) => normalizeWeapon(w))
      : killsWeapons;
  const summaryHeadshots = num(s.headshots);
  const knownHeadshots = kills.some((k) => k.headshot != null);
  /**
   * As kills valem mais que o `summary.headshots`: o placar ao vivo não
   * expõe headshot, então o v1 gravava `0` (ausência) como se fosse
   * medida. Quando alguma kill traz o flag, a contagem vem delas.
   */
  const headshots =
    s.headshotsKnown === false
      ? null
      : knownHeadshots
        ? kills.filter((k) => k.headshot === true).length
        : summaryHeadshots == null
          ? null
          : summaryHeadshots > 0
            ? summaryHeadshots
            : null;
  const victimsRaw = arr(s.victims).map((v) => str(v)).filter((v): v is string => v != null);
  // Mesma regra das armas: a vítima das kills (corrigida pelo killfeed)
  // vale mais que a do resumo.
  const killsVictims = kills.map((k) => k.victim).filter(Boolean);
  const victims = killsVictims.length > 0 ? killsVictims : victimsRaw;
  const assistsRaw = arr(s.assists);
  const assists =
    assistsRaw.length > 0
      ? assistsRaw
          .map((a) => {
            const item = obj(a);
            const by = str(item.by);
            const killIndex = num(item.killIndex);
            return by && killIndex != null ? { by, killIndex } : null;
          })
          .filter((a): a is { by: string; killIndex: number } => a != null)
      : kills.flatMap((k, i) => (k.assistBy ? [{ by: k.assistBy, killIndex: i + 1 }] : []));
  const flashRaw = arr(s.flashAssists);
  const flashAssists =
    flashRaw.length > 0
      ? flashRaw
          .map((a) => {
            const item = obj(a);
            const by = str(item.by);
            const killIndex = num(item.killIndex);
            return by && killIndex != null ? { by, killIndex } : null;
          })
          .filter((a): a is { by: string; killIndex: number } => a != null)
      : kills.flatMap((k, i) => (k.flashAssistBy ? [{ by: k.flashAssistBy, killIndex: i + 1 }] : []));
  const grenadesRaw = arr(s.grenades);
  const grenades =
    grenadesRaw.length > 0
      ? (grenadesRaw as GrenadeUse[])
      : kills.flatMap((k) =>
          k.weapon && ['hegrenade', 'molotov', 'incgrenade', 'inferno'].includes(k.weapon)
            ? [
                {
                  player: k.killer,
                  kind: k.weapon === 'hegrenade' ? ('he' as const) : ('molotov' as const),
                },
              ]
            : [],
        );
  const mainWeapon = mostUsedWeapon(kills) ?? str(s.mainWeapon);
  return {
    killCount: kills.length,
    weapons,
    headshots,
    mainWeapon,
    victims,
    assists,
    flashAssists,
    grenades,
  };
}

function normalizeSync(raw: Obj): ClipSyncV2 | null {
  // v2 grava `sync`; v1 grava `streamSync` + latências soltas no topo.
  const s = isObj(raw.sync) ? obj(raw.sync) : obj(raw.streamSync);
  const latency = obj(s.latency);
  // O schema v2 aninha a evidência do killfeed. Os campos planos são o
  // fallback legado: sem esta leitura, um patch posterior do sidecar
  // transformava `sync.killfeed` em `{}` e apagava a prova do OCR.
  const killfeed = obj(s.killfeed);
  const hasSync =
    isObj(raw.sync) ||
    isObj(raw.streamSync) ||
    raw.killVideoOffsetMs != null ||
    raw.streamLatencyMs != null ||
    raw.startLatencyMs != null ||
    raw.endLatencyMs != null;
  if (!hasSync) return null;
  return {
    mode: str(s.mode) ?? 'off',
    applied: bool(s.applied) ?? false,
    source: str(s.source),
    marker: str(s.marker),
    reason: str(s.reason) ?? 'unknown',
    offsetMs: num(s.offsetMs),
    matchedKills: num(s.matchedKills),
    totalKills: num(s.totalKills),
    medianDeviationMs: num(s.medianDeviationMs),
    roundEndAt: iso(s.roundEndAt),
    scoreBefore: str(s.scoreBefore),
    scoreAfter: str(s.scoreAfter),
    observedLatencyMs: num(s.observedLatencyMs),
    killVideoOffsetMs: num(s.killVideoOffsetMs) ?? num(raw.killVideoOffsetMs),
    latency: {
      configuredMs: num(latency.configuredMs) ?? num(raw.streamLatencyMs),
      startMs: num(raw.startLatencyMs) ?? num(s.startLatencyMs) ?? num(latency.startMs),
      endMs: num(raw.endLatencyMs) ?? num(s.endLatencyMs) ?? num(latency.endMs),
      estimatedStartMs:
        num(raw.estimatedStartLatencyMs) ??
        num(s.estimatedStartLatencyMs) ??
        num(latency.estimatedStartMs),
      source: str(raw.latencySource) ?? str(s.latencySource) ?? str(latency.source),
      changed: bool(raw.latencyChanged) ?? bool(s.latencyChanged) ?? bool(latency.changed) ?? false,
      startCapped: bool(s.startLatencyCapped) ?? bool(latency.startCapped) ?? false,
    },
    anchorSource: str(s.anchorSource),
    crop: str(s.crop),
    killfeed: {
      firstKillVideoMs:
        num(killfeed.firstKillVideoMs) ?? num(s.killfeedFirstKillVideoMs),
      reason: str(killfeed.reason) ?? str(s.killfeedReason),
      crop: str(killfeed.crop) ?? str(s.killfeedCrop),
      replayReads: num(killfeed.replayReads) ?? num(s.killfeedReplayReads),
    },
  };
}

function normalizeWindow(raw: Obj): ClipWindowV2 | null {
  const w = obj(raw.window);
  const end = obj(w.end);
  const hasWindow =
    isObj(raw.window) ||
    raw.truncatedStart != null ||
    raw.timelineDiscontinuity != null ||
    raw.timelineMode != null ||
    raw.concatLenSec != null ||
    raw.killsSpreadMs != null ||
    raw.bufferOldestMs != null ||
    raw.replayAwareEndMs != null ||
    raw.actionResume != null ||
    raw.freezeDetection != null ||
    raw.clipWindowAudit != null ||
    raw.minEndMs != null ||
    raw.endFloorMs != null;
  if (!hasWindow) return null;
  return {
    truncatedStart: bool(w.truncatedStart) ?? bool(raw.truncatedStart) ?? false,
    timelineDiscontinuity:
      bool(w.timelineDiscontinuity) ?? bool(raw.timelineDiscontinuity) ?? false,
    timelineMode: str(w.timelineMode) ?? str(raw.timelineMode),
    concatLenSec: num(w.concatLenSec) ?? num(raw.concatLenSec),
    killsSpreadMs: num(w.killsSpreadMs) ?? num(raw.killsSpreadMs),
    bufferOldestMs: num(w.bufferOldestMs) ?? num(raw.bufferOldestMs),
    replayAwareEndMs: num(w.replayAwareEndMs) ?? num(raw.replayAwareEndMs),
    end: {
      minMs: num(end.minMs) ?? num(raw.minEndMs),
      floorMs: num(end.floorMs) ?? num(raw.endFloorMs),
      pinnedBy: str(end.pinnedBy) ?? str(raw.endPinnedBy),
      ocrRejected: bool(end.ocrRejected) ?? bool(raw.ocrRejected) ?? bool(raw.ocrEndRejected),
      scoreboardReason: str(end.scoreboardReason) ?? str(raw.scoreboardEndReason),
    },
    actionResume: w.actionResume ?? raw.actionResume ?? null,
    freeze: w.freeze ?? raw.freezeDetection ?? null,
    audit: w.audit ?? raw.clipWindowAudit ?? null,
  };
}

function normalizeClip(raw: Obj): ClipSidecarV2['clip'] {
  const c = obj(raw.clip);
  const av = obj(c.av);
  const hasAv = isObj(c.av) || raw.avIssues != null || raw.avSegmentIssues != null;
  return {
    file: str(c.file) ?? str(raw.clipFile),
    thumbnailFile: str(c.thumbnailFile) ?? str(raw.thumbnailFile),
    startMs: num(c.startMs) ?? num(raw.clipStartMs),
    durationSec: num(c.durationSec) ?? num(raw.clipDurationSec),
    captureMode: str(c.captureMode) ?? str(raw.captureMode),
    sourceHeight: num(c.sourceHeight) ?? num(raw.sourceHeight),
    outputHeight: num(c.outputHeight) ?? num(raw.outputHeight),
    streamName: str(c.streamName) ?? str(raw.streamName),
    segmentsUsed: arr(c.segmentsUsed).length
      ? arr(c.segmentsUsed).map((s) => String(s))
      : arr(raw.segmentsUsed).map((s) => String(s)),
    av: hasAv
      ? {
          issues: num(av.issues) ?? num(raw.avIssues),
          segmentIssues: arr(av.segmentIssues).length
            ? arr(av.segmentIssues)
            : arr(raw.avSegmentIssues),
        }
      : null,
  };
}

function normalizeVod(raw: Obj): ClipVodV2 | null {
  const v = obj(raw.vod);
  const url = str(v.url) ?? str(v.vodUrl);
  const startIso = iso(v.startIso) ?? iso(v.vodStartIso);
  const atSec = num(v.atSec) ?? num(raw.vodAtSec);
  const gameToVodDeltaSec = num(v.gameToVodDeltaSec);
  const note = str(v.note);
  if (!url && !startIso && atSec == null && gameToVodDeltaSec == null && !note) return null;
  return { url, startIso, atSec, gameToVodDeltaSec, note };
}

function normalizePublication(raw: Obj): ClipPublicationV2 | null {
  const p = obj(raw.publication);
  const youtubeId = str(p.youtubeId) ?? str(raw.youtubeId);
  const publishedAt = iso(p.publishedAt) ?? iso(raw.publishedAt);
  const thumbnailAi = bool(p.thumbnailAi) ?? bool(raw.thumbnailAi) ?? false;
  if (!youtubeId && !publishedAt && !thumbnailAi) return null;
  return { youtubeId, publishedAt, thumbnailAi };
}

/** Bloco do killfeed do scorebot (telemetria do pareamento). */
function normalizeKillfeed(raw: Obj): ClipKillfeedV2 | null {
  const k = obj(raw.killfeed);
  const source = str(k.source);
  const paired = num(k.paired);
  const total = num(k.total);
  const feedKills = num(k.feedKills);
  const roundDrift = num(k.roundDrift);
  const eventIds = arr(k.eventIds)
    .map((v) => str(v))
    .filter((v): v is string => Boolean(v));
  const enrichedAt = iso(k.enrichedAt);
  if (
    !source &&
    paired == null &&
    total == null &&
    feedKills == null &&
    roundDrift == null &&
    eventIds.length === 0
  ) {
    return null;
  }
  return {
    source: source ?? 'scorebot',
    paired: paired ?? 0,
    total: total ?? 0,
    feedKills: feedKills ?? 0,
    // Kills cujo round do feed não bateu com o round do placar.
    ...(roundDrift != null ? { roundDrift } : {}),
    eventIds,
    enrichedAt: enrichedAt ?? null,
  };
}

/**
 * Converte qualquer sidecar (v1 flat ou v2) no formato canônico v2.
 * Nunca lança: campos ausentes viram null/default.
 */
export function normalizeClipSidecar(raw: unknown): ClipSidecarV2 {
  const r = obj(raw);
  const summary = obj(r.summary);
  const match = obj(r.match);
  const player = obj(r.player);
  const round = obj(r.round);
  const team1 = str(match.team1) ?? str(r.team1) ?? '';
  const team2 = str(match.team2) ?? str(r.team2) ?? '';
  const matchId = str(match.id) ?? str(r.matchId) ?? '';
  const vod = normalizeVod(r);
  const vodStartMs = vod?.startIso ? Date.parse(vod.startIso) : null;
  const clip = normalizeClip(r);
  const killVideoOffsetMs =
    num(r.killVideoOffsetMs) ??
    num(obj(r.sync).killVideoOffsetMs) ??
    num(obj(r.streamSync).killVideoOffsetMs);
  const roundNumber =
    num(round.number) ?? num(r.round) ?? num(summary.round) ?? num(arr(r.kills)[0] && obj(arr(r.kills)[0]).round) ?? 0;
  const rawMap = str(round.map) ?? str(r.map) ?? str(summary.map);
  const firstKill = obj(arr(r.kills)[0]);
  const killMap = str(firstKill.map);
  const map = rawMap && rawMap !== 'unknown' ? rawMap : killMap && killMap !== 'unknown' ? killMap : (rawMap ?? 'unknown');
  const kills = normalizeKills(
    r.kills,
    clip.startMs,
    killVideoOffsetMs,
    vodStartMs,
    vod?.atSec ?? null,
  );
  const team =
    str(player.team) ?? str(r.playerTeam) ?? str(summary.team) ?? null;
  const summaryOpponents = str(summary.opponents);
  const opponent =
    str(player.opponent) ??
    str(r.opponentTeam) ??
    deriveOpponent(team, team1, team2) ??
    (summaryOpponents && !/ vs /i.test(summaryOpponents) ? summaryOpponents : null);
  const createdAt =
    iso(r.createdAt) ?? iso(r.detectedAt) ?? iso(r.publishedAt) ?? new Date(0).toISOString();
  return {
    schemaVersion: SIDECAR_VERSION,
    kind: 'clip',
    createdAt,
    detectedAt: iso(r.detectedAt) ?? createdAt,
    startedAt: iso(r.startedAt),
    endedAt: iso(r.endedAt),
    match: {
      id: matchId,
      event: str(match.event) ?? str(r.event) ?? '',
      team1,
      team2,
      // `match.url` é a URL da PARTIDA. Sidecars antigos gravavam aqui a
      // URL do VOD; migra pela URL canônica do id e mantém o VOD apenas
      // em `vod.url`.
      url:
        normalizeHltvMatchUrl(match.url) ??
        normalizeHltvMatchUrl(r.matchUrl) ??
        hltvMatchUrlFromId(matchId),
    },
    player: {
      name: str(player.name) ?? str(r.player) ?? '',
      team,
      opponent,
    },
    round: {
      map,
      number: roundNumber,
      scoreBefore:
        str(round.scoreBefore) ?? str(r.scoreBefore) ?? str(r.score) ?? null,
      scoreAfter: str(round.scoreAfter) ?? str(r.scoreAfter) ?? null,
      scoreOrder: 'ct-t',
      endedAtMs: num(round.endedAtMs) ?? epochMs(r.roundEndedAt),
      // O vencedor só vem de quem sabe (o VOD, pelo demo): o placar
      // CT-T não diz qual time estava no CT, então derivar seria chute.
      winner: str(round.winner) ?? str(r.roundWinner) ?? null,
    },
    clip,
    kills,
    anchorConfidence: normalizeAnchorConfidence(r.anchorConfidence),
    sync: normalizeSync(r),
    window: normalizeWindow(r),
    stats: normalizeStats(isObj(r.stats) ? r.stats : r.summary, kills),
    killfeed: normalizeKillfeed(r),
    vod,
    publication: normalizePublication(r),
    note: str(r.note),
  };
}

export interface BuildClipSidecarInput {
  ace: AceEvent;
  clip: {
    file?: string | null;
    thumbnailFile?: string | null;
    startMs?: number | null;
    durationSec?: number | null;
    captureMode?: string | null;
    sourceHeight?: number | null;
    outputHeight?: number | null;
    streamName?: string | null;
    segmentsUsed?: string[];
    avIssues?: number | null;
    avSegmentIssues?: unknown[];
  };
  createdAt?: string;
  killVideoOffsetMs?: number | null;
  streamLatencyMs?: number | null;
  startLatencyMs?: number | null;
  endLatencyMs?: number | null;
  latencySource?: string | null;
  latencyChanged?: boolean;
  timelineDiscontinuity?: boolean;
  freezeDetection?: unknown;
  timelineMode?: string | null;
  concatLenSec?: number | null;
  replayAwareEndMs?: number | null;
  actionResume?: unknown;
  minEndMs?: number | null;
  endFloorMs?: number | null;
  endPinnedBy?: string | null;
  ocrEndRejected?: boolean | null;
  scoreboardEndReason?: string | null;
  killsSpreadMs?: number | null;
  bufferOldestMs?: number | null;
  clipWindowAudit?: unknown;
  team?: string | null;
  opponent?: string | null;
  vod?: ClipVodV2 | null;
  publication?: ClipPublicationV2 | null;
  note?: string | null;
}

/** Monta o sidecar v2 a partir do ace + dados reais do arquivo renderizado. */
export function buildClipSidecar(input: BuildClipSidecarInput): ClipSidecarV2 {
  const { ace } = input;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const clipStartMs = input.clip.startMs ?? ace.clipStartMs ?? null;
  const vodStartMs = input.vod?.startIso ? Date.parse(input.vod.startIso) : null;
  const offset = input.killVideoOffsetMs ?? ace.killVideoOffsetMs ?? null;
  const summary = ace.summary;
  const team = input.team ?? summary?.team ?? null;
  const opponent =
    input.opponent ??
    deriveOpponent(team, ace.team1, ace.team2) ??
    (summary?.opponents && !/ vs /i.test(summary.opponents) ? summary.opponents : null);
  const roundNumber = ace.round || summary?.round || ace.kills[0]?.round || 0;
  const map = ace.map && ace.map !== 'unknown' ? ace.map : (summary?.map ?? ace.map ?? 'unknown');
  const kills = ace.kills.map((kill) => {
    const raw: Obj = {
      killer: kill.killer,
      victim: kill.victim,
      at: kill.at,
      estimated: kill.estimated,
      // VOD grava a estimativa do OCR em `appearEstimated`; sem copiar, a
      // posição estimada era lida como medida (afeta timestamps da
      // descrição e a janela do Short).
      appearEstimated: kill.appearEstimated,
      weapon: kill.weapon,
      headshot: kill.headshot,
      assistBy: kill.assistBy,
      flashAssistBy: kill.flashAssistBy,
      throughSmoke: kill.throughSmoke,
      wallbang: kill.wallbang,
      noscope: kill.noscope,
      ...(kill.atVodSec != null ? { atVodSec: kill.atVodSec } : {}),
      ...(kill.atSource ? { atSource: kill.atSource } : {}),
    };
    return normalizeKill(raw, clipStartMs, offset, vodStartMs, input.vod?.atSec ?? null);
  });
  const stats = normalizeStats(summary, kills);
  const sync = ace.streamSync;
  return {
    schemaVersion: SIDECAR_VERSION,
    kind: 'clip',
    createdAt,
    detectedAt: ace.detectedAt || createdAt,
    startedAt: ace.startedAt ?? null,
    endedAt: ace.endedAt ?? null,
    match: {
      id: ace.matchId,
      event: ace.event,
      team1: ace.team1,
      team2: ace.team2,
      // `match.url` é a URL da PARTIDA monitorada. A URL do VOD vive em
      // `vod.url`; misturar as duas faz a origem do clipe parecer HLTV
      // quando o material veio de uma VOD.
      url: normalizeHltvMatchUrl(ace.matchUrl) ?? hltvMatchUrlFromId(ace.matchId),
    },
    player: { name: ace.player, team, opponent },
    round: {
      map,
      number: roundNumber,
      scoreBefore: ace.scoreBefore ?? ace.score ?? null,
      scoreAfter: ace.scoreAfter ?? null,
      scoreOrder: 'ct-t',
      endedAtMs: epochMs(ace.roundEndedAt),
      // O vencedor só vem de quem sabe: o placar do tracker é CT-T e
      // não diz qual time estava no CT (derivar nomeava o time errado
      // depois do halftime).
      winner: ace.roundWinner ?? null,
    },
    clip: {
      file: input.clip.file ?? null,
      thumbnailFile: input.clip.thumbnailFile ?? null,
      startMs: clipStartMs,
      durationSec: input.clip.durationSec ?? ace.clipDurationSec ?? null,
      captureMode: input.clip.captureMode ?? null,
      sourceHeight: input.clip.sourceHeight ?? null,
      outputHeight: input.clip.outputHeight ?? null,
      streamName: input.clip.streamName ?? null,
      segmentsUsed: input.clip.segmentsUsed ?? [],
      av:
        input.clip.avIssues != null || input.clip.avSegmentIssues != null
          ? {
              issues: input.clip.avIssues ?? null,
              segmentIssues: input.clip.avSegmentIssues ?? [],
            }
          : null,
    },
    kills,
    anchorConfidence: ace.anchorConfidence ?? null,
    sync: {
      mode: sync?.mode ?? 'off',
      applied: sync?.applied ?? false,
      source: sync?.source ?? null,
      marker: sync?.marker ?? null,
      reason: sync?.reason ?? 'unknown',
      offsetMs: sync?.offsetMs ?? null,
      matchedKills: sync?.matchedKills ?? null,
      totalKills: sync?.totalKills ?? null,
      medianDeviationMs: sync?.medianDeviationMs ?? null,
      roundEndAt: sync?.roundEndAt ?? null,
      scoreBefore: sync?.scoreBefore ?? ace.scoreBefore ?? null,
      scoreAfter: sync?.scoreAfter ?? ace.scoreAfter ?? null,
      observedLatencyMs: sync?.observedLatencyMs ?? null,
      killVideoOffsetMs: offset,
      latency: {
        configuredMs: input.streamLatencyMs ?? null,
        startMs: input.startLatencyMs ?? sync?.startLatencyMs ?? null,
        endMs: input.endLatencyMs ?? sync?.endLatencyMs ?? null,
        estimatedStartMs: sync?.estimatedStartLatencyMs ?? null,
        source: input.latencySource ?? sync?.latencySource ?? null,
        changed: input.latencyChanged ?? sync?.latencyChanged ?? false,
        startCapped: sync?.startLatencyCapped ?? false,
      },
      anchorSource: sync?.anchorSource ?? null,
      crop: sync?.crop ?? null,
      killfeed: {
        firstKillVideoMs: sync?.killfeedFirstKillVideoMs ?? null,
        reason: sync?.killfeedReason ?? null,
        crop: sync?.killfeedCrop ?? null,
        replayReads: sync?.killfeedReplayReads ?? null,
      },
    },
    window: {
      truncatedStart: ace.truncatedStart ?? false,
      timelineDiscontinuity: input.timelineDiscontinuity ?? ace.timelineDiscontinuity ?? false,
      timelineMode: input.timelineMode ?? null,
      concatLenSec: input.concatLenSec ?? null,
      killsSpreadMs: input.killsSpreadMs ?? ace.killsSpreadMs ?? null,
      bufferOldestMs: input.bufferOldestMs ?? null,
      replayAwareEndMs: input.replayAwareEndMs ?? null,
      end: {
        minMs: input.minEndMs ?? null,
        floorMs: input.endFloorMs ?? null,
        pinnedBy: input.endPinnedBy ?? null,
        ocrRejected: input.ocrEndRejected ?? null,
        scoreboardReason: input.scoreboardEndReason ?? null,
      },
      actionResume: input.actionResume ?? null,
      freeze: input.freezeDetection ?? null,
      audit: input.clipWindowAudit ?? ace.clipWindowAudit ?? null,
    },
    stats,
    // Telemetria do killfeed do scorebot (arma/headshot/assistência):
    // quantas kills do round receberam o detalhe.
    killfeed: ace.killfeed
      ? {
          source: 'scorebot',
          paired: ace.killfeed.paired,
          total: ace.killfeed.total,
          feedKills: ace.killfeed.feedKills,
          // Kills cujo round do feed não bateu com o round do placar.
          ...(ace.killfeed.roundDrift != null
            ? { roundDrift: ace.killfeed.roundDrift }
            : {}),
          eventIds: [...(ace.killfeed.eventIds ?? [])],
          enrichedAt: null,
        }
      : null,
    vod: input.vod ?? null,
    publication: input.publication ?? null,
    note: input.note ?? null,
  };
}

/** O detalhe do killfeed para cada kill (na ordem das kills do sidecar). */
export interface KillfeedEnrichment {
  kills: Array<{
    victim: string;
    weapon?: string | null;
    headshot?: boolean | null;
    assistBy?: string | null;
    flashAssistBy?: string | null;
    throughSmoke?: boolean | null;
    wallbang?: boolean | null;
    noscope?: boolean | null;
  }>;
  /** Quantas kills do sidecar receberam o detalhe. */
  paired: number;
  /** Quantas kills o killfeed tinha para o round. */
  feedKills: number;
  /** `eventId`s do scorebot que entraram no round. */
  eventIds: string[];
}

/**
 * Aplica o detalhe do killfeed no sidecar (kills, stats e telemetria).
 *
 * PURO: devolve um sidecar NOVO — quem chama grava no disco. É o
 * backfill (`scripts/enrich-clip.ts`): corrige a vítima errada (o
 * placar pareou pela coluna de mortes) e completa arma/headshot/
 * assistência que só o scorebot sabe.
 *
 * Campo ausente no killfeed NÃO sobrescreve o que o sidecar tinha (nada
 * vira `false` por omissão).
 */
export function applyKillfeedToSidecar(
  side: ClipSidecarV2,
  enrichment: KillfeedEnrichment,
  enrichedAt: string,
): ClipSidecarV2 {
  const kills: ClipKillV2[] = side.kills.map((kill, i) => {
    const detail = enrichment.kills[i];
    if (!detail) return kill;
    return {
      ...kill,
      victim: detail.victim?.trim() || kill.victim,
      // A arma entra CANÔNICA (a mesma chave do live: `m4a1silencer`):
      // o feed traz o nome cru (`m4a1_silencer`) e sem normalizar o
      // enrich não era idempotente (a mesma arma contava duas vezes).
      weapon: normalizeWeapon(detail.weapon) ?? kill.weapon,
      headshot: detail.headshot ?? kill.headshot,
      assistBy: detail.assistBy ?? kill.assistBy,
      flashAssistBy: detail.flashAssistBy ?? kill.flashAssistBy,
      throughSmoke: detail.throughSmoke ?? kill.throughSmoke,
      wallbang: detail.wallbang ?? kill.wallbang,
      noscope: detail.noscope ?? kill.noscope,
    };
  });
  const assists = kills.flatMap((k, i) => (k.assistBy ? [{ by: k.assistBy, killIndex: i + 1 }] : []));
  const flashAssists = kills.flatMap((k, i) =>
    k.flashAssistBy ? [{ by: k.flashAssistBy, killIndex: i + 1 }] : [],
  );
  const headshots = kills.some((k) => k.headshot != null)
    ? kills.filter((k) => k.headshot === true).length
    : side.stats.headshots;
  return {
    ...side,
    kills,
    stats: {
      ...side.stats,
      killCount: kills.length,
      weapons: kills.map((k) => k.weapon ?? null),
      victims: kills.map((k) => k.victim).filter(Boolean),
      assists,
      flashAssists,
      headshots,
      mainWeapon: mostUsedWeapon(kills) ?? side.stats.mainWeapon,
    },
    killfeed: {
      source: 'scorebot',
      paired: enrichment.paired,
      total: kills.length,
      feedKills: enrichment.feedKills,
      eventIds: [...enrichment.eventIds],
      enrichedAt,
    },
  };
}

/** Lê e normaliza um sidecar; null quando o arquivo não existe/não é JSON. */
export function readClipSidecar(file: string): ClipSidecarV2 | null {
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeClipSidecar(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Atualiza um sidecar v2 no disco (best-effort; devolve false em erro). */
export function updateClipSidecar(
  file: string,
  mutate: (side: ClipSidecarV2) => void,
): boolean {
  const side = readClipSidecar(file);
  if (!side) return false;
  try {
    mutate(side);
    writeClipSidecar(file, side);
    return true;
  } catch {
    return false;
  }
}

/**
 * Grava o sidecar no disco: backup do v1 (na 1ª migração) + escrita
 * ATÔMICA.
 *
 * A escrita é atômica (`.tmp` + `rename`): um crash no meio da escrita
 * deixaria um JSON pela metade — e o sidecar truncado faz o leitor
 * devolver `null` (o clipe volta a parecer "sem sidecar").
 *
 * O backup do v1 acontece AQUI (e não em cada chamador): o `enrich-clip`
 * reescreve sidecars antigos e, sem a cópia, o v1 (com `roundKills`,
 * `vod.videoId`...) sumia para sempre.
 */
export function writeClipSidecar(file: string, side: ClipSidecarV2): void {
  backupLegacySidecar(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stringifyJsonWithoutNulls(side) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Guarda uma cópia `<arquivo>.v1.bak` antes da 1ª migração v1→v2.
 *
 * A escrita é sempre v2 e a leitura do v1 NÃO preserva todo campo do
 * flat (`roundKills`, `vod.videoId`...): sem o backup, a primeira
 * atualização de um sidecar antigo apagava o original para sempre. O
 * arquivo já v2 (ou um `.bak` existente) não é tocado.
 */
function backupLegacySidecar(file: string): void {
  const backup = `${file}.v1.bak`;
  if (fs.existsSync(backup)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (isObj(raw) && raw.schemaVersion === SIDECAR_VERSION) return;
  fs.copyFileSync(file, backup);
}

/** Reconstrói o ace a partir do sidecar (kills opcionalmente truncadas). */
export function sidecarToAce(side: ClipSidecarV2, killsOverride?: ClipKillV2[]): AceEvent {
  const sideKills = killsOverride ?? side.kills;
  const kills: KillEvent[] = sideKills.map((kill) => ({
    killer: kill.killer,
    victim: kill.victim,
    round: side.round.number,
    map: side.round.map,
    ...(kill.atMs != null ? { at: kill.atMs } : {}),
    ...(kill.atSource != null ? { atSource: kill.atSource } : {}),
    ...(kill.estimated ? { estimated: true } : {}),
    ...(kill.weapon != null ? { weapon: kill.weapon } : {}),
    ...(kill.headshot != null ? { headshot: kill.headshot } : {}),
    ...(kill.assistBy ? { assistBy: kill.assistBy } : {}),
    ...(kill.flashAssistBy ? { flashAssistBy: kill.flashAssistBy } : {}),
    ...(kill.throughSmoke ? { throughSmoke: true } : {}),
    ...(kill.wallbang ? { wallbang: true } : {}),
    ...(kill.noscope ? { noscope: true } : {}),
  }));
  const truncated = killsOverride != null;
  const knownHeadshots = sideKills.some((k) => k.headshot != null);
  const summary: RoundSummary = {
    round: side.round.number,
    map: side.round.map,
    player: side.player.name,
    team: side.player.team ?? '',
    opponents:
      side.player.opponent ??
      [side.match.team1, side.match.team2].filter(Boolean).join(' vs '),
    kills,
    victims:
      sideKills.length > 0
        ? sideKills.map((k) => k.victim).filter(Boolean)
        : side.stats.victims,
    weapons:
      sideKills.length > 0
        ? sideKills.map((k) => k.weapon ?? '')
        : side.stats.weapons.map((w) => w ?? ''),
    headshots:
      knownHeadshots ? sideKills.filter((k) => k.headshot === true).length : (side.stats.headshots ?? 0),
    headshotsKnown: knownHeadshots || side.stats.headshots != null,
    // Assistência/cegada é POSICIONAL: com a janela truncada, só valem as
    // que estão nas kills incluídas (as de fora seriam informação falsa).
    assists: truncated
      ? sideKills.flatMap((k, i) => (k.assistBy ? [{ by: k.assistBy, killIndex: i + 1 }] : []))
      : side.stats.assists,
    flashAssists: truncated
      ? sideKills.flatMap((k, i) =>
          k.flashAssistBy ? [{ by: k.flashAssistBy, killIndex: i + 1 }] : [],
        )
      : side.stats.flashAssists,
    grenades: side.stats.grenades,
    mainWeapon: mostUsedWeapon(sideKills) ?? side.stats.mainWeapon ?? '',
  };
  const sync = side.sync;
  return {
    matchId: side.match.id,
    map: side.round.map,
    round: side.round.number,
    player: side.player.name,
    team1: side.match.team1,
    team2: side.match.team2,
    event: side.match.event,
    ...(side.match.url ? { matchUrl: side.match.url } : {}),
    detectedAt: side.detectedAt,
    ...(side.startedAt ? { startedAt: side.startedAt } : {}),
    ...(side.endedAt ? { endedAt: side.endedAt } : {}),
    ...(side.round.endedAtMs != null
      ? { roundEndedAt: new Date(side.round.endedAtMs).toISOString() }
      : {}),
    kills,
    ...(side.round.scoreBefore != null ? { score: side.round.scoreBefore } : {}),
    ...(side.round.scoreBefore != null ? { scoreBefore: side.round.scoreBefore } : {}),
    ...(side.round.scoreAfter != null ? { scoreAfter: side.round.scoreAfter } : {}),
    ...(side.round.winner != null ? { roundWinner: side.round.winner } : {}),
    ...(side.anchorConfidence ? { anchorConfidence: side.anchorConfidence } : {}),
    ...(side.killfeed
      ? {
          killfeed: {
            paired: side.killfeed.paired,
            total: side.killfeed.total,
            feedKills: side.killfeed.feedKills,
            eventIds: [...(side.killfeed.eventIds ?? [])],
          },
        }
      : {}),
    ...(side.clip.startMs != null ? { clipStartMs: side.clip.startMs } : {}),
    ...(side.clip.durationSec != null ? { clipDurationSec: side.clip.durationSec } : {}),
    ...(side.window?.truncatedStart ? { truncatedStart: true } : {}),
    ...(side.window?.timelineDiscontinuity ? { timelineDiscontinuity: true } : {}),
    ...(side.window?.killsSpreadMs != null ? { killsSpreadMs: side.window.killsSpreadMs } : {}),
    ...(side.window?.audit
      ? { clipWindowAudit: side.window.audit as AceEvent['clipWindowAudit'] }
      : {}),
    ...(sync
      ? {
          streamSync: {
            mode: sync.mode as 'auto' | 'log' | 'off',
            applied: sync.applied,
            ...(sync.source ? { source: sync.source as 'scoreboard' | 'killfeed' } : {}),
            ...(sync.marker ? { marker: sync.marker as 'score' | 'round' } : {}),
            offsetMs: sync.offsetMs,
            matchedKills: sync.matchedKills ?? 0,
            totalKills: sync.totalKills ?? kills.length,
            medianDeviationMs: sync.medianDeviationMs,
            reason: sync.reason,
            roundEndAt: sync.roundEndAt,
            scoreBefore: sync.scoreBefore,
            scoreAfter: sync.scoreAfter,
            observedLatencyMs: sync.observedLatencyMs,
            startLatencyMs: sync.latency.startMs,
            endLatencyMs: sync.latency.endMs,
            latencySource: sync.latency.source,
            latencyChanged: sync.latency.changed,
            startLatencyCapped: sync.latency.startCapped,
            estimatedStartLatencyMs: sync.latency.estimatedStartMs,
            crop: sync.crop,
            anchorSource: sync.anchorSource as
              | 'placar'
              | 'killfeed'
              | 'killfeed+placar'
              | null,
            killfeedFirstKillVideoMs: sync.killfeed.firstKillVideoMs,
            killfeedReason: sync.killfeed.reason,
            killfeedCrop: sync.killfeed.crop,
            killfeedReplayReads: sync.killfeed.replayReads,
          },
        }
      : {}),
    summary,
  };
}

export interface BuildShortMarkerInput {
  createdAt?: string;
  source: ShortMarkerV2['source'];
  short: ShortMarkerV2['short'];
  metadata: ShortMarkerV2['metadata'];
  publication: ShortMarkerV2['publication'];
  attempts: number;
  lastAttemptAt: string | null;
}

export function buildShortMarker(input: BuildShortMarkerInput): ShortMarkerV2 {
  return {
    schemaVersion: SIDECAR_VERSION,
    kind: 'short',
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: input.source,
    short: input.short,
    metadata: input.metadata,
    publication: input.publication,
    attempts: input.attempts,
    lastAttemptAt: input.lastAttemptAt,
  };
}

/** Spec do adesivo gravado no marker (vazio = não tinha). */
function normalizeOverlaySpec(raw: unknown): ShortOverlaySpec | null {
  if (!isObj(raw)) return null;
  const spec = normalizeShortOverlaySpec(raw);
  return Object.keys(spec).length > 0 ? spec : null;
}

/**
 * Converte marker v1 (sidecar spread + campos do Short) no formato v2.
 * Aceita também um v2 já gravado (round-trip).
 */
export function normalizeShortMarker(raw: unknown): ShortMarkerV2 | null {
  if (!isObj(raw)) return null;
  const r = raw;
  if (r.schemaVersion === SIDECAR_VERSION && r.kind === 'short') {
    const source = obj(r.source);
    const short = obj(r.short);
    const publication = obj(r.publication);
    const windowRaw = obj(short.window);
    return {
      schemaVersion: SIDECAR_VERSION,
      kind: 'short',
      createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
      source: {
        clipFile: str(source.clipFile),
        sidecarFile: str(source.sidecarFile),
        matchId: str(source.matchId) ?? '',
        map: str(source.map) ?? '',
        round: num(source.round) ?? 0,
        player: str(source.player) ?? '',
        clipStartMs: num(source.clipStartMs),
        clipDurationSec: num(source.clipDurationSec),
      },
      short: {
        file: str(short.file),
        width: num(short.width),
        height: num(short.height),
        startSec: num(short.startSec) ?? 0,
        durationSec: num(short.durationSec),
        window: isObj(short.window)
          ? {
              startSec: num(windowRaw.startSec) ?? 0,
              endSec: num(windowRaw.endSec) ?? 0,
              durSec: num(windowRaw.durSec) ?? 0,
              includedKills: numArray(windowRaw.includedKills),
              droppedKills: numArray(windowRaw.droppedKills),
            }
          : null,
        kills: normalizeKills(short.kills, null, null, null),
        render: (short.render as ShortRenderSignature | null | undefined) ?? null,
        captions: (short.captions as CaptionStatus | null | undefined) ?? null,
        overlaySpec: normalizeOverlaySpec(short.overlaySpec),
      },
      metadata: isObj(r.metadata)
        ? {
            title: str(obj(r.metadata).title) ?? '',
            description: str(obj(r.metadata).description) ?? '',
            tags: arr(obj(r.metadata).tags).map((t) => String(t)),
            source: str(obj(r.metadata).source) ?? 'template',
            privacy: str(obj(r.metadata).privacy) ?? '',
          }
        : null,
      publication: {
        youtubeId: str(publication.youtubeId),
        publishedAt: iso(publication.publishedAt),
        privacy: str(publication.privacy),
      },
      attempts: num(r.attempts) ?? 0,
      lastAttemptAt: iso(r.lastAttemptAt),
    };
  }
  // v1: o marker era o sidecar espalhado + campos do Short por cima.
  const shortWindow = obj(r.shortWindow);
  const startSec = num(shortWindow.startSec) ?? 0;
  const absoluteStart = num(r.clipStartMs);
  const sourceClipStartMs =
    absoluteStart != null ? absoluteStart - Math.round(startSec * 1000) : null;
  const roundNumber = num(r.round) ?? 0;
  const map = str(r.map) ?? '';
  return {
    schemaVersion: SIDECAR_VERSION,
    kind: 'short',
    createdAt:
      iso(r.createdAt) ?? iso(r.publishedAt) ?? iso(r.lastAttemptAt) ?? new Date(0).toISOString(),
    source: {
      clipFile: str(r.sourceClip) ?? null,
      sidecarFile: null,
      matchId: str(r.matchId) ?? '',
      map,
      round: roundNumber,
      player: str(r.player) ?? '',
      clipStartMs: sourceClipStartMs,
      clipDurationSec: num(r.sourceClipDurationSec),
    },
    short: {
      file: str(r.clipFile),
      width: num(r.width),
      height: num(r.height),
      startSec,
      durationSec: num(r.clipDurationSec) ?? num(shortWindow.durSec),
      window: isObj(r.shortWindow)
        ? {
            startSec,
            endSec: num(shortWindow.endSec) ?? 0,
            durSec: num(shortWindow.durSec) ?? 0,
            includedKills: numArray(shortWindow.includedKills),
            droppedKills: numArray(shortWindow.droppedKills),
          }
        : null,
      kills: normalizeKills(r.kills, null, null, null),
      render: (r.render as ShortRenderSignature | null | undefined) ?? null,
      captions: (r.captionInfo as CaptionStatus | null | undefined) ?? null,
      // v1 não guardava o spec pedido (só o texto resolvido no render).
      overlaySpec: null,
    },
    metadata: isObj(r.metadata)
      ? {
          title: str(obj(r.metadata).title) ?? '',
          description: str(obj(r.metadata).description) ?? '',
          tags: arr(obj(r.metadata).tags).map((t) => String(t)),
          source: str(obj(r.metadata).source) ?? 'template',
          privacy: str(obj(r.metadata).privacy) ?? '',
        }
      : null,
    publication: {
      youtubeId: str(r.youtubeId),
      publishedAt: iso(r.publishedAt),
      privacy: null,
    },
    attempts: num(r.attempts) ?? 0,
    lastAttemptAt: iso(r.lastAttemptAt),
  };
}

export function readShortMarker(file: string): ShortMarkerV2 | null {
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeShortMarker(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Grava o marker do Short (escrita ATÔMICA).
 *
 * O marker guarda o `youtubeId`: um JSON truncado por um crash no meio
 * da escrita faria `readShortMarker` devolver `null` — e o Short
 * republicado (o `youtubeId` do banco não salva o marker).
 */
export function writeShortMarker(file: string, marker: ShortMarkerV2): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stringifyJsonWithoutNulls(marker) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
