/**
 * Publica Shorts verticais (9:16) a partir dos clipes já gravados pelo bot.
 *
 * O material é o clipe 16:9 do ao vivo (`data/clips/<pasta>/<pasta>.mp4`
 * + sidecar `.json`). Aqui:
 * 1. a janela do Short é calculada (da 1ª à última kill, 60-90s);
 * 2. o vertical é renderizado (cam do streamer no topo + jogo embaixo,
 *    crop centralizado) — o YouTube só mostra vídeo VERTICAL no feed
 *    Shorts;
 * 3. os metadados são gerados no formato Shorts (título curto, #Shorts);
 * 4. o vídeo sobe pelo MESMO pipeline do bot (API do YouTube).
 *
 * A legenda é QUEIMADA no mp4 (transcrição do áudio da janela + libass):
 * não depende do caption do YouTube (que pediria o scope
 * `youtube.force-ssl`).
 *
 * Uso:
 *   npx tsx scripts/publish-shorts.ts --dry-run
 *   npx tsx scripts/publish-shorts.ts --publish --clip data/clips/2399958_Inferno_r12_doc
 *   npx tsx scripts/publish-shorts.ts --publish --last 3
 *
 * Flags:
 *   --dry-run          (padrão) só calcula e renderiza, NÃO publica
 *   --publish          sobe o Short no YouTube (exige SHORTS_ENABLED=true)
 *   --clip <pasta>     processa só essa pasta de clipe (repetível)
 *   --last <n>         processa os n clipes mais recentes AINDA NÃO publicados
 *   --privacy <p>      private|unlisted|public (default: SHORTS_PRIVACY)
 *   --no-ai            não chama a IA de metadados (usa o gerador local)
 *   --no-captions      não transcreve a legenda (o Short sai sem ela)
 *   --allow-no-captions  publica mesmo com a legenda quebrada (sem isso o
 *                      Short fica para a próxima rodada tentar de novo)
 *   --force            re-renderiza mesmo com o vertical já existente
 *                      (e publica Shorts com a abertura limitada pelo
 *                      teto de latência — as posições das kills não são
 *                      confiáveis)
 *   --retry-captions   processa SÓ os Shorts que falharam na legenda
 *                      (tradução/erro/libass): os que estão OK ficam de
 *                      fora, e o backoff é ignorado — sem liberar a
 *                      janela com posição não confiável
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, validateConfigCrossFields, type AppConfig } from '../src/config.js';
import {
  aceKey,
  countPublishedClips,
  findPublishedShorts,
  insertAce,
  insertClip,
} from '../src/db.js';
import { gb, getFreeBytes, isFreeSpaceOk } from '../src/diskSpace.js';
import {
  camBoxToString,
  isStaleRender,
  isStaleWindow,
  killPositionsByKill,
  parseShortCamBox,
  planShortWindow,
  renderShortClip,
  shortRenderSignature,
  hasAudioStream,
  type ShortRenderSignature,
  type ShortTopMode,
} from '../src/clipper/shorts.js';
import { configuredCropForStream } from '../src/clipper/scoreboardSync.js';
import {
  buildCaptionLines,
  buildCaptionsAss,
  captionCrosshairTopY,
  captionMaxChars,
  canPublishShortWithCaptions,
  isCaptionFilterError,
  isRetryableCaptionFailure,
  shortRetryDecision,
  type CaptionLine,
  type CaptionStatus,
} from '../src/clipper/shortCaptions.js';
import {
  captionContextFromAce,
  captionProviderFrom,
  createCaptionTranscriber,
  extractAudioWindow,
  type CaptionContext,
  type CaptionTranscript,
  type CaptionTranscriber,
} from '../src/clipper/shortCaptionsAi.js';
import { loadThumbFont, measureThumbText } from '../src/clipper/thumbText.js';
import { uploadClip } from '../src/uploader/youtubeUploader.js';
import { buildVideoMetadataSafe, type VideoMetadata } from '../src/uploader/videoMetadata.js';
import { createMetadataAi } from '../src/uploader/metadataAi.js';
import type { MetadataAiFn } from '../src/uploader/videoMetadata.js';
import type { AceEvent, KillEvent, RoundSummary } from '../src/types.js';

interface Sidecar {
  matchId: string;
  map: string;
  round: number;
  player: string;
  team1: string;
  team2: string;
  event: string;
  detectedAt: string;
  kills: KillEvent[];
  summary?: RoundSummary;
  score?: string;
  scoreBefore?: string;
  scoreAfter?: string;
  clipFile?: string;
  clipStartMs?: number;
  clipDurationSec?: number;
  killVideoOffsetMs?: number;
  streamName?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface Candidate {
  dir: string;
  name: string;
  sidecarPath: string;
  mp4Path: string;
  sidecar: Sidecar;
}

interface Args {
  publish: boolean;
  clips: string[];
  last: number | null;
  privacy: string | null;
  force: boolean;
  /** Refazer SÓ a legenda dos Shorts que falharam nela (sem `--force`). */
  retryCaptions: boolean;
  noAi: boolean;
  noCaptions: boolean;
  allowNoCaptions: boolean;
}

const PRIVACY_VALUES = ['private', 'unlisted', 'public'];

/** Cota diária do YouTube (units do projeto de API). */
const QUOTA_UNITS_PER_UPLOAD = 1600;
const QUOTA_UNITS_PER_DAY = 10_000;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    publish: false,
    clips: [],
    last: null,
    privacy: null,
    force: false,
    retryCaptions: false,
    noAi: false,
    noCaptions: false,
    allowNoCaptions: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Aceita `--flag valor` e `--flag=valor`.
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const next = (): string => {
      if (inline != null) {
        if (!inline) throw new Error(`faltou o valor de ${name}`);
        return inline;
      }
      const value = argv[++i];
      if (value == null || value.startsWith('--')) {
        throw new Error(`faltou o valor de ${name}`);
      }
      return value;
    };
    if (name === '--publish') args.publish = true;
    else if (name === '--dry-run') args.publish = false;
    else if (name === '--force') args.force = true;
    else if (name === '--retry-captions') args.retryCaptions = true;
    else if (name === '--no-ai') args.noAi = true;
    else if (name === '--no-captions') args.noCaptions = true;
    else if (name === '--allow-no-captions') args.allowNoCaptions = true;
    else if (name === '--clip') args.clips.push(next());
    else if (name === '--last') {
      const raw = next();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--last precisa de um inteiro positivo (recebido: ${raw})`);
      }
      args.last = n;
    } else if (name === '--privacy') {
      const raw = next();
      if (!PRIVACY_VALUES.includes(raw)) {
        throw new Error(`--privacy inválido: ${raw} (use ${PRIVACY_VALUES.join('|')})`);
      }
      args.privacy = raw;
    } else {
      throw new Error(`flag desconhecida: ${arg}`);
    }
  }
  return args;
}

/**
 * Reconstrói o ace a partir do sidecar (o sidecar É o ace gravado).
 *
 * A lista de kills é a DO VÍDEO: quando a janela do Short corta a
 * jogada, o resumo é refeito com as kills que ficaram (o título de um
 * Short com 4 kills não pode dizer "5 kills").
 */
function sidecarToAce(side: Sidecar, truncated = false): AceEvent {
  const kills = side.kills ?? [];
  const summary = side.summary
    ? {
        ...side.summary,
        kills,
        victims: kills.map((k) => k.victim),
        weapons: kills.map((k) => k.weapon ?? ''),
        headshots: kills.filter((k) => k.headshot).length,
        mainWeapon: mostUsedWeapon(kills) || side.summary.mainWeapon,
        // Assistências e cegadas são POSICIONADAS por kill: sem o
        // timestamp de cada uma, não dá para saber se caíram dentro da
        // janela do Short. Com a janela truncada, cites fora da janela
        // seriam informação falsa → saem.
        assists: truncated ? [] : side.summary.assists,
        flashAssists: truncated ? [] : side.summary.flashAssists,
      }
    : undefined;
  return {
    matchId: side.matchId,
    map: side.map,
    round: side.round,
    player: side.player,
    team1: side.team1,
    team2: side.team2,
    event: side.event,
    detectedAt: side.detectedAt,
    kills,
    score: side.score,
    scoreBefore: side.scoreBefore,
    scoreAfter: side.scoreAfter,
    summary,
  };
}

/** Arma mais usada na lista de kills. */
function mostUsedWeapon(kills: KillEvent[]): string {
  const counts = new Map<string, number>();
  for (const k of kills) counts.set(k.weapon ?? '', (counts.get(k.weapon ?? '') ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function readSidecar(dir: string): { sidecarPath: string; side: Sidecar } | null {
  const name = path.basename(dir);
  // O sidecar novo é `<pasta>.json`; o antigo (muxed) é `<pasta>_muxed.json`.
  const candidates = [path.join(dir, `${name}.json`), path.join(dir, `${name}_muxed.json`)];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const side = JSON.parse(fs.readFileSync(p, 'utf8')) as Sidecar;
      if (side && Array.isArray(side.kills)) return { sidecarPath: p, side };
    } catch {
      // sidecar quebrado: o próximo candidato (ou a pasta) é ignorado
    }
  }
  return null;
}

/** Instante do clipe (ms): `createdAt` do sidecar ou mtime do arquivo. */
function candidateTime(candidate: Candidate): number {
  const created = candidate.sidecar.createdAt ? Date.parse(String(candidate.sidecar.createdAt)) : NaN;
  if (Number.isFinite(created)) return created;
  try {
    return fs.statSync(candidate.mp4Path).mtimeMs;
  } catch {
    return 0;
  }
}

function discoverCandidates(clipsDir: string, args: Args): Candidate[] {
  const out: Candidate[] = [];
  const dirs = args.clips.length
    ? args.clips.map((d) => path.resolve(d))
    : fs
        .readdirSync(clipsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => path.join(path.resolve(clipsDir), d.name));

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const found = readSidecar(dir);
    if (!found) continue;
    const { sidecarPath, side } = found;
    const name = path.basename(dir);
    const mp4 = path.join(dir, side.clipFile ?? `${name}.mp4`);
    if (!fs.existsSync(mp4)) continue;
    out.push({ dir, name, sidecarPath, mp4Path: mp4, sidecar: side });
  }

  // Mais recentes primeiro (`createdAt` do sidecar; mtime do mp4 como
  // fallback). O mtime era o que mandava antes: o sidecar de um clipe
  // antigo pode ter `createdAt` ausente e a ordenação virava alfabética.
  out.sort((a, b) => candidateTime(b) - candidateTime(a));
  return out;
}

interface ShortMarker {
  youtubeId?: string;
  publishedAt?: string;
  /** Janela que o vertical já gravado cobre. */
  shortWindow?: { startSec?: number; durSec?: number };
  /** Layout/geometria com que o vertical gravado foi gerado. */
  render?: ShortRenderSignature;
  /** Legenda queimada no vertical gravado. */
  captionInfo?: CaptionInfo | null;
  /** Kills dentro da janela que o vertical gravado cobre. */
  kills?: KillEvent[];
  clipStartMs?: number;
  clipDurationSec?: number;
  /** Metadados já gerados (reaproveitados na publicação). */
  metadata?: {
    title: string;
    description: string;
    tags: string[];
    source: string;
    privacy: string;
  };
  /** Quantas vezes a publicação já falhou (tente de novo depois). */
  attempts?: number;
  /** Quando foi a última tentativa que falhou (ISO). */
  lastAttemptAt?: string | null;
}

function readShortMarker(file: string): ShortMarker | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ShortMarker;
  } catch {
    return null;
  }
}

/**
 * Relatório da execução: o histórico das rodadas é preservado (o arquivo
 * anterior era sobrescrito a cada run e a comparação entre rodadas
 * ficava impossível).
 */
function writeReport(
  shortsDir: string,
  items: Array<Record<string, unknown>>,
  publishedCount: number,
): string {
  const reportPath = path.join(shortsDir, 'report.json');
  let previous: { runs?: unknown[] } = {};
  if (fs.existsSync(reportPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { runs?: unknown[] };
    } catch {
      previous = {};
    }
  }
  const runs = Array.isArray(previous.runs) ? previous.runs.slice(-19) : [];
  const at = new Date().toISOString();
  runs.push({ at, published: publishedCount, items });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ at, published: publishedCount, items, runs }, null, 2) + '\n',
  );
  return reportPath;
}

/**
 * Trava de execução: duas rodadas simultâneas publicariam o MESMO Short
 * duas vezes (o dedupe é por marker/DB, mas as duas leriam o estado
 * antes de qualquer uma gravar).
 *
 * A trava envelhece: ela vale `staleMs` a partir do último toque. Um
 * lote longo (3 chamadas de IA por Short, com 180s cada) passaria do
 * prazo e a segunda rodada tomaria a trava no meio — daí o `touch`
 * a cada Short processado.
 */
function acquireLock(lockPath: string): { release: () => void; touch: () => void } | null {
  const staleMs = 30 * 60_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      const touch = (): void => {
        // Renova a idade da trava (o mtime é o que manda).
        try {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          // best-effort
        }
      };
      return {
        touch,
        release: () => {
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // best-effort
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Trava antiga (processo morreu sem liberar): toma posse.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // best-effort
      }
      return null;
    }
  }
  return null;
}

/** Erro de cota do YouTube (a cota é do projeto de API, compartilhada). */
function isQuotaError(error: unknown): boolean {
  return /quotaExceeded|dailyLimitExceeded|uploadLimitExceeded|rateLimitExceeded/i.test(
    String((error as { message?: string })?.message ?? error),
  );
}

/** Início do dia (UTC) no formato do SQLite. */
function startOfUtcDaySql(): string {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return day.toISOString().slice(0, 19).replace('T', ' ');
}

interface BatchContext {
  cfg: AppConfig;
  args: Args;
  privacy: 'private' | 'unlisted' | 'public';
  published: Map<string, string>;
  useAi: boolean;
  metadataAi?: MetadataAiFn;
  /** Transcrição da legenda queimada (criado uma vez por rodada). */
  captionTranscriber: CaptionTranscriber;
  shortsDir: string;
  /** Units de cota já consumidas hoje (vídeos enviados). */
  quotaUsed: number;
}

interface CandidateResult {
  report: Record<string, unknown>;
  published: boolean;
}

/** O que a legenda queimada gravou no vertical (e de onde veio). */
type CaptionInfo = CaptionStatus;

/**
 * Largura MÉDIA por caractere da fonte da legenda.
 *
 * A fonte da legenda é a versão no repo (Barlow Condensed Bold): a
 * largura é medida nela, então a linha cabe de verdade. Se o dono
 * apontar outra fonte, o valor conservador (0.62) é usado — com uma
 * fonte mais larga a linha estoura e o libass re-quebra sozinho.
 */
function captionAvgCharWidth(fontFamily: string): number {
  if (!/barlow/i.test(String(fontFamily ?? ''))) return 0.62;
  const font = loadThumbFont('ui');
  if (!font) return 0.62;
  const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz0123456789,.!?';
  const width = measureThumbText(font, sample, 100);
  return width > 0 ? width / sample.length / 100 : 0.62;
}

/**
 * Despejo da legenda em texto (`[início → fim] fala`), um por linha.
 *
 * Fica ao lado do mp4 (`<name>_legenda.txt`) para o dono revisar o que
 * foi ao ar e (`<name>_legenda.orig.txt`) guardar o idioma original
 * quando a fala foi traduzida.
 *
 * A fala é quebrada em uma linha por bloco: se o modelo devolveu uma
 * quebra de linha no meio, ela viraria uma linha sem tempo no arquivo.
 */
function captionTextDump(lines: CaptionLine[]): string {
  return (
    (lines ?? [])
      .map((line) => {
        const text = String(line.text ?? '')
          .replace(/[\r\n]+/g, ' ')
          .trim();
        return `[${line.startSec.toFixed(2)} → ${line.endSec.toFixed(2)}] ${text}`;
      })
      .join('\n') + '\n'
  );
}

/** Apaga o despejo de texto de uma legenda anterior (órfão). */
function removeCaptionTextFiles(txtBase: string): void {
  for (const suffix of ['.txt', '.orig.txt']) {
    try {
      fs.rmSync(`${txtBase}${suffix}`, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Transcreve o áudio da JANELA do Short e monta o `.ass` da legenda
 * queimada.
 *
 * Devolve `null` quando não há legenda (sem áudio, IA falhou, áudio
 * mudo): o Short sai sem ela — melhor do que perder o vídeo.
 */
async function buildCaptionsForShort(
  mp4Path: string,
  startSec: number,
  durSec: number,
  cfg: AppConfig,
  topMode: ShortTopMode,
  transcriber: CaptionTranscriber,
  context: CaptionContext,
  cached?: CaptionTranscript | null,
): Promise<{ assPath: string; info: CaptionInfo; text: string; originalText: string | null } | null> {
  const base = path.join(
    os.tmpdir(),
    `5k-short-captions-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  const wavPath = `${base}.wav`;
  const assPath = `${base}.ass`;
  try {
    await extractAudioWindow(mp4Path, startSec, durSec, wavPath);
    const transcript = await transcriber(wavPath, durSec, context, cached ?? null);
    if (!transcript) return null;
    const lines = buildCaptionLines(transcript.lines, {
      durSec,
      maxCharsPerLine: captionMaxChars(
        cfg.SHORTS_WIDTH,
        cfg.SHORTS_CAPTION_FONT_SIZE,
        captionAvgCharWidth(cfg.SHORTS_CAPTION_FONT_FAMILY),
      ),
      maxLines: 2,
    });
    if (lines.length === 0) return null;
    const topY =
      cfg.SHORTS_CAPTION_POSITION === 'below-crosshair'
        ? captionCrosshairTopY(
            cfg.SHORTS_HEIGHT,
            topMode === 'center' ? 0 : cfg.SHORTS_CAM_HEIGHT,
          )
        : topMode === 'center'
          ? 40
          : cfg.SHORTS_CAM_HEIGHT + 8;
    const ass = buildCaptionsAss(lines, {
      width: cfg.SHORTS_WIDTH,
      height: cfg.SHORTS_HEIGHT,
      topY,
      fontSize: cfg.SHORTS_CAPTION_FONT_SIZE,
      fontFamily: cfg.SHORTS_CAPTION_FONT_FAMILY,
      position: cfg.SHORTS_CAPTION_POSITION,
    });
    fs.writeFileSync(assPath, ass, 'utf8');
    // O texto (`.txt`/`.orig.txt`) é escrito pelo CHAMADOR, depois do
    // render: só o que foi ao ar merece um arquivo ao lado do mp4.
    return {
      assPath,
      info: {
        applied: true,
        provider: transcript.provider,
        language: transcript.language,
        lines: lines.length,
        translated: transcript.translated,
        ...(transcript.degraded?.length ? { degraded: transcript.degraded } : {}),
        ...(transcript.untranslated ? { reason: 'untranslated' as const } : {}),
        ...(transcript.correctionsApplied?.length
          ? { correctionsApplied: transcript.correctionsApplied }
          : {}),
        // A transcrição vai no marker: a próxima rodada refaz só o
        // passe que falhou (tradução/revisão) sem transcrever de novo
        // (cota do Gemini + tempo do whisper).
        transcript: {
          provider: transcript.provider,
          language: transcript.language,
          translated: transcript.translated,
          lines: transcript.lines,
          ...(transcript.originalLines?.length
            ? { originalLines: transcript.originalLines }
            : {}),
        },
      },
      text: captionTextDump(lines),
      originalText:
        transcript.translated && transcript.originalLines?.length
          ? captionTextDump(transcript.originalLines)
          : null,
    };
  } catch (e) {
    try {
      fs.rmSync(assPath, { force: true });
    } catch {}
    // Repropaga: o chamador marca o Short para nova tentativa (motivo
    // 'error'). Engolir aqui transformaria FALHA em "sem fala" (estado
    // final) e a legenda nunca mais seria tentada.
    throw e;
  } finally {
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      // best-effort
    }
  }
}

/** Processa um clipe: render, metadados, upload, marker e banco. */
async function processCandidate(
  ctx: BatchContext,
  candidate: Candidate,
): Promise<CandidateResult | null> {
  const { cfg, args, privacy, published, shortsDir } = ctx;
  const { sidecar: side, name, mp4Path } = candidate;
  const kills = side.kills?.length ?? 0;
  if (kills < cfg.SHORTS_MIN_KILLS) return null;
  if (side.clipStartMs == null || side.clipDurationSec == null) {
    console.log(`- ${name}: ignorado (sidecar sem âncora — clipe anterior ao clipStartMs)`);
    return null;
  }
  if (side.killVideoOffsetMs == null || !Number.isFinite(Number(side.killVideoOffsetMs))) {
    console.log(
      `- ${name}: ignorado (sidecar sem killVideoOffsetMs — as posições das kills ficariam deslocadas)`,
    );
    return null;
  }
  const positioned = killPositionsByKill(side.kills ?? [], {
    clipStartMs: side.clipStartMs,
    clipDurationSec: side.clipDurationSec,
    killVideoOffsetMs: side.killVideoOffsetMs,
  });
  if (positioned.length < cfg.SHORTS_MIN_KILLS) {
    console.log(
      `- ${name}: ignorado (${positioned.length} kill(s) dentro do clipe — mínimo ${cfg.SHORTS_MIN_KILLS})`,
    );
    return null;
  }
  const positions = positioned.map((p) => p.sec);
  const plan = planShortWindow(positions, side.clipDurationSec, {
    maxSec: cfg.SHORTS_MAX_SEC,
    minSec: cfg.SHORTS_MIN_SEC,
    headSec: cfg.SHORTS_HEAD_SEC,
    tailSec: cfg.SHORTS_TAIL_SEC,
  });
  if (plan.durSec < 5) {
    console.log(`- ${name}: ignorado (janela de ${plan.durSec}s)`);
    return null;
  }

  // Só as kills DENTRO da janela entram no Short: um título/descrição
  // que promete 5 kills num Short com 3 é informação falsa.
  const included = positioned.filter(
    (p) => p.sec >= plan.startSec - 0.01 && p.sec <= plan.endSec + 0.01,
  );
  if (included.length < cfg.SHORTS_MIN_KILLS) {
    console.log(
      `- ${name}: ignorado (${included.length} kill(s) dentro da janela de ${cfg.SHORTS_MAX_SEC}s — mínimo ${cfg.SHORTS_MIN_KILLS})`,
    );
    return null;
  }
  const includedKills = included.map((p) => side.kills[p.index]);

  const outDir = path.join(shortsDir, name);
  const outMp4 = path.join(outDir, `${name}_short.mp4`);
  const outSidecar = path.join(outDir, `${name}_short.json`);

  const previous = readShortMarker(outSidecar);
  const key = aceKey(side.matchId, side.map, side.round, side.player);
  const publishedId = published.get(key);
  if (previous?.youtubeId || publishedId) {
    console.log(
      `- ${name}: já publicado (${previous?.youtubeId ?? publishedId}) — pulando`,
    );
    return null;
  }
  /**
   * Backoff: um Short que falhou (legenda quebrada, ffmpeg caiu) não é
   * tentado a cada rodada — o provedor pode ainda estar fora e o
   * `--last N` ficaria preso no mesmo clipe. Depois de
   * MAX_SHORT_ATTEMPTS, só o dono manda de novo (`--force`).
   *
   * `--retry-captions` é a exceção: ele refaz SÓ a legenda dos Shorts
   * que falharam nela (tradução/erro/libass) e NÃO libera a janela
   * limitada pelo teto de latência (que o `--force` libera).
   */
  const captionFailure = isRetryableCaptionFailure(previous?.captionInfo);
  // `--retry-captions` é SÓ para quem falhou na legenda: os Shorts sem
  // falha de legenda ficam de fora (o help promete "refaz SÓ a legenda
  // dos que falharam").
  if (args.retryCaptions && !captionFailure) {
    console.log(
      `- ${name}: pulado (--retry-captions: a legenda deste Short não falhou)`,
    );
    return null;
  }
  const retryCaptions = args.retryCaptions && captionFailure;
  if (!args.force && !retryCaptions) {
    const decision = shortRetryDecision({
      attempts: previous?.attempts ?? 0,
      lastAttemptAt: previous?.lastAttemptAt ?? null,
    });
    if (decision.skip) {
      console.log(`- ${name}: ignorado (${decision.reason})`);
      return null;
    }
  }
  /**
   * Abertura limitada pelo TETO de latência: o bot desconfiou da
   * latência estimada (abriu o clipe pelo teto) e as posições das kills
   * vêm dessa mesma estimativa — elas podem estar deslocadas, e a
   * janela do Short (montada em cima delas) cortaria o começo do ace.
   * Publicar assim é afirmar horários que ninguém mediu: o Short só sai
   * com `--force` (a decisão é do dono).
   */
  const capped =
    (side.streamSync as { startLatencyCapped?: boolean } | undefined)?.startLatencyCapped ===
    true;
  if (capped && !args.force) {
    console.log(
      `- ${name}: ignorado (abertura limitada pelo teto de latência — as posições das kills não são confiáveis; use --force para publicar assim)`,
    );
    return null;
  }
  if (capped) {
    console.log(
      `- ${name}: ATENÇÃO (--force) — a abertura foi limitada pelo teto de latência; as posições das kills podem estar deslocadas`,
    );
  }

  console.log(`\n== ${name} ==`);
  console.log(
    `  janela: ${plan.startSec}s → ${plan.endSec}s (${plan.durSec}s) | kills ${positions.length} (${included.length} na janela)`,
  );
  if (plan.droppedKills.length > 0) {
    console.log(
      `  ATENÇÃO: ${plan.droppedKills.length} kill(s) fora da janela de ${cfg.SHORTS_MAX_SEC}s: ${plan.droppedKills
        .map((p) => `${p}s`)
        .join(', ')}`,
    );
  } else if (plan.truncated) {
    console.log(`  (cauda cortada para caber em ${cfg.SHORTS_MAX_SEC}s — todas as kills dentro)`);
  }

  // Layout do topo: cam do canal (caixa medida) ou a faixa com o título.
  // O `SHORTS_TOP` manda; no `cam` sem caixa mapeada, o título assume em
  // vez de cortar uma região qualquer do quadro.
  let durSec = plan.durSec;
  const streamName = typeof side.streamName === 'string' ? side.streamName : '';
  const camCrop =
    configuredCropForStream(cfg.SHORTS_CAM_BOX_BY_STREAM, streamName) ??
    (cfg.SHORTS_CAM_BOX.trim() || null);
  const camBox = parseShortCamBox(camCrop);
  if (camCrop && !camBox) {
    // A caixa existe mas está MAL DIGITADA: sem este aviso o dono
    // achava que o canal não tinha mapa de cam.
    console.log(
      `  ATENÇÃO: caixa de cam inválida ("${camCrop}") — o topo vai como faixa com o título (formato: x:y:w:h)`,
    );
  }
  const topMode: ShortTopMode =
    cfg.SHORTS_TOP === 'center'
      ? 'center'
      : cfg.SHORTS_TOP === 'text'
        ? 'text'
        : camBox
          ? 'cam'
          : 'text';
  if (cfg.SHORTS_TOP === 'cam' && !camBox) {
    console.log(
      `  topo: faixa com o título (canal ${streamName ? `"${streamName}"` : 'sem nome'} sem caixa de cam no SHORTS_CAM_BOX_BY_STREAM)`,
    );
  } else if (topMode === 'cam') {
    console.log(
      `  topo: cam do canal (${camBoxToString(camBox)}, ${cfg.SHORTS_CAM_FIT}) — jogo ${cfg.SHORTS_GAME_FIT}${
        cfg.SHORTS_GAME_FIT === 'cover'
          ? ` (crop ${cfg.SHORTS_GAME_CROP}, y ${cfg.SHORTS_GAME_Y})`
          : ` (proporção ${cfg.SHORTS_GAME_ASPECT} centralizado sobre o fundo desfocado)`
      }`,
    );
  } else {
    console.log(`  topo: ${topMode}`);
  }

  const ace = sidecarToAce({ ...side, kills: includedKills }, plan.truncated);
  // O vertical só serve se cobrir A MESMA janela E tiver sido gerado com
  // o MESMO layout: com a folga/limite/topo mudados no .env, o mp4 antigo
  // é de outro trecho/corte (e ia ao ar com o título da janela nova).
  const staleWindow = isStaleWindow(previous?.shortWindow, plan, fs.existsSync(outMp4));
  // A faixa mostra o título do vídeo; ele é gerado ANTES do render para
  // a imagem não sair com texto velho (o marker guarda o texto usado).
  // Os metadados já gerados (dry-run) são REUTILIZADOS: publicar o que
  // o dono viu no dry-run evita o título surpresa no canal.
  const reusable =
    !args.force &&
    !staleWindow &&
    previous?.metadata?.title &&
    previous.metadata.privacy === privacy
      ? previous.metadata
      : null;
  const metadata: VideoMetadata | undefined = reusable
    ? {
        title: reusable.title,
        description: reusable.description,
        tags: reusable.tags,
        source: reusable.source === 'ai' ? 'ai' : 'template',
      }
    : await buildVideoMetadataSafe(ace, {
        mode: metadataMode(cfg, args),
        ai: ctx.metadataAi,
        brand: cfg.YT_BRAND,
        cta: cfg.YT_DESC_CTA,
        privacy,
        defaultTags: cfg.YT_DEFAULT_TAGS,
        format: 'shorts',
        shortsHashtag: cfg.SHORTS_HASHTAG,
        // O Short começa no meio do clipe 16:9: os timestamps (se houver)
        // contam a partir do INÍCIO do Short, não do clipe original.
        clipStartMs: side.clipStartMs + Math.round(plan.startSec * 1000),
        clipDurationSec: durSec,
        killTimeOffsetMs: side.killVideoOffsetMs,
      });

  console.log(`  título: ${metadata?.title ?? '(legado)'}`);
  console.log(`  descrição: ${(metadata?.description ?? '').split('\n')[0]?.slice(0, 120)}...`);

  const banner =
    topMode === 'text'
      ? {
          title:
            metadata?.title ??
            `${side.player} — ${side.map} R${side.round} | ${side.event}`,
          subtitle: `${side.team1} vs ${side.team2} • ${side.event}`,
        }
      : null;
  const captionsOn = cfg.SHORTS_CAPTIONS === true && !args.noCaptions;
  const signature = shortRenderSignature({
    top: topMode,
    camBox,
    camHeight: cfg.SHORTS_CAM_HEIGHT,
    camFit: cfg.SHORTS_CAM_FIT,
    camAnchor: cfg.SHORTS_CAM_ANCHOR,
    gameCrop: cfg.SHORTS_GAME_CROP,
    gameY: cfg.SHORTS_GAME_Y,
    gameFit: cfg.SHORTS_GAME_FIT,
    gameAspect: cfg.SHORTS_GAME_ASPECT,
    width: cfg.SHORTS_WIDTH,
    height: cfg.SHORTS_HEIGHT,
    bannerText: banner?.title ?? null,
    captions: captionsOn ? 'on' : 'off',
    cropX: cfg.SHORTS_CROP_X,
    captionFontSize: cfg.SHORTS_CAPTION_FONT_SIZE,
    captionPosition: cfg.SHORTS_CAPTION_POSITION,
    captionFontFamily: cfg.SHORTS_CAPTION_FONT_FAMILY,
  });
  const staleLayout = isStaleRender(previous?.render, signature);
  // A legenda pedida NÃO entrou no arquivo (a transcrição ou o libass
  // falharam na rodada anterior): o vertical precisa ser refeito — senão
  // o Short ficaria sem legenda para sempre.
  const staleCaptions =
    captionsOn &&
    ((previous?.captionInfo?.applied !== true &&
      isRetryableCaptionFailure(previous?.captionInfo)) ||
      // A legenda queimada ficou no idioma original: ela tem que ser
      // refeita (traduzida) antes do Short ir ao ar.
      previous?.captionInfo?.reason === 'untranslated') &&
    fs.existsSync(outMp4);
  const rendered =
    args.force ||
    retryCaptions ||
    staleWindow ||
    staleLayout ||
    staleCaptions ||
    !fs.existsSync(outMp4);
  /**
   * Transcrição guardada no marker da rodada anterior: com a JANELA
   * igual, ela é reaproveitada e só a tradução/revisão rodam de novo
   * (o provider de transcrição não é chamado — economiza cota do
   * Gemini e o tempo do whisper).
   *
   * Só quando a legenda FALHOU: aí o objetivo é retomar do passo que
   * falhou. Um Short que já tem legenda vai de transcrição nova (o
   * dono pode querer o textomelhor depois de mexer nas regras).
   */
  const cachedTranscript: CaptionTranscript | null =
    !staleWindow &&
    isRetryableCaptionFailure(previous?.captionInfo) &&
    previous?.captionInfo?.transcript?.lines?.length
      ? {
          provider: captionProviderFrom(previous.captionInfo.transcript.provider),
          language: previous.captionInfo.transcript.language ?? null,
          translated: previous.captionInfo.transcript.translated === true,
          lines: previous.captionInfo.transcript.lines,
          ...(previous.captionInfo.transcript.originalLines?.length
            ? { originalLines: previous.captionInfo.transcript.originalLines }
            : {}),
        }
      : null;
  let captionInfo: CaptionInfo | null = null;
  if (rendered) {
    if (staleWindow) {
      console.log('  (a janela mudou — re-renderizando o vertical)');
    } else if (staleLayout) {
      console.log('  (o layout mudou — re-renderizando o vertical)');
    } else if (staleCaptions) {
      console.log('  (a legenda não entrou no vertical anterior — re-renderizando)');
    }
    // A legenda é transcrita só quando o vertical vai ser refeito: um
    // Short já pronto não gasta IA.
    let captionsAssPath: string | null = null;
    // O texto da legenda só é gravado depois do render (o arquivo
    // descreve o que foi ao ar).
    let captionText: string | null = null;
    let captionOriginalText: string | null = null;
    if (captionsOn) {
      const hasAudio = await hasAudioStream(mp4Path).catch(() => true);
      if (!hasAudio) {
        console.log('  legenda: clipe sem trilha de áudio — sem legenda');
        captionInfo = { applied: false, reason: 'no-audio' };
      } else {
        console.log('  (transcrevendo a legenda da janela...)');
        try {
          const built = await buildCaptionsForShort(
            mp4Path,
            plan.startSec,
            plan.durSec,
            cfg,
            topMode,
            ctx.captionTranscriber,
            // O contexto (nomes do clipe + gíria) segura a grafia:
            // sem ele o modelo escreve "molodoij" e "é quinho".
            captionContextFromAce({
              player: side.player,
              team1: side.team1,
              team2: side.team2,
              event: side.event,
              map: side.map,
              round: side.round,
              kills: includedKills,
            }),
            cachedTranscript,
          );
          if (built) {
            captionsAssPath = built.assPath;
            captionInfo = built.info;
            captionText = built.text;
            captionOriginalText = built.originalText;
            console.log(
              `  legenda: ${built.info.lines} linhas (${built.info.provider}${
                built.info.translated ? ', traduzida' : ''
              }${built.info.language ? `, ${built.info.language}` : ''}${
                built.info.degraded?.length
                  ? `, degradada: ${built.info.degraded.join('+')}`
                  : ''
              })`,
            );
          } else {
            console.log('  legenda: transcrição vazia — o Short sai sem ela');
            captionInfo = { applied: false, reason: 'no-speech' };
          }
        } catch (e) {
          console.log(`  legenda: falha na transcrição/ASS — o Short sai sem ela (${String(e).slice(0, 200)})`);
          captionInfo = { applied: false, reason: 'error' };
        }
      }
    }
    try {
      const out = await renderShortClip(mp4Path, outMp4, {
        startSec: plan.startSec,
        durSec: plan.durSec,
        width: cfg.SHORTS_WIDTH,
        height: cfg.SHORTS_HEIGHT,
        cropX: cfg.SHORTS_CROP_X,
        top: topMode,
        camBox,
        camHeight: cfg.SHORTS_CAM_HEIGHT,
        camFit: cfg.SHORTS_CAM_FIT,
        camAnchor: cfg.SHORTS_CAM_ANCHOR,
        gameCrop: cfg.SHORTS_GAME_CROP,
        gameY: cfg.SHORTS_GAME_Y,
        gameFit: cfg.SHORTS_GAME_FIT,
        gameAspect: cfg.SHORTS_GAME_ASPECT,
        banner,
        captionsAssPath,
      });
      durSec = out.durSec;
      console.log(`  vertical: ${path.relative(process.cwd(), outMp4)} (${durSec}s)`);
    } catch (renderErr) {
      if (captionsAssPath && isCaptionFilterError(renderErr)) {
        // A falha é do FILTRO de legenda (fonte/ASS): o vertical sem
        // legenda ainda vale (o Short vai ao ar na próxima rodada com a
        // legenda refeita).
        console.log('  (falha do filtro ass — re-tentando sem legenda)');
        try {
          const out = await renderShortClip(mp4Path, outMp4, {
            startSec: plan.startSec,
            durSec: plan.durSec,
            width: cfg.SHORTS_WIDTH,
            height: cfg.SHORTS_HEIGHT,
            cropX: cfg.SHORTS_CROP_X,
            top: topMode,
            camBox,
            camHeight: cfg.SHORTS_CAM_HEIGHT,
            camFit: cfg.SHORTS_CAM_FIT,
            camAnchor: cfg.SHORTS_CAM_ANCHOR,
            gameCrop: cfg.SHORTS_GAME_CROP,
            gameY: cfg.SHORTS_GAME_Y,
            gameFit: cfg.SHORTS_GAME_FIT,
            gameAspect: cfg.SHORTS_GAME_ASPECT,
            banner,
            captionsAssPath: null,
          });
          durSec = out.durSec;
          // A transcrição que deu certo continua guardada: a próxima
          // rodada refaz só o render (e a legenda), sem transcrever.
          captionInfo = {
            applied: false,
            reason: 'failed',
            ...(captionInfo?.transcript ? { transcript: captionInfo.transcript } : {}),
          };
          console.log(`  vertical (sem legenda): ${path.relative(process.cwd(), outMp4)} (${durSec}s)`);
        } catch (secondErr) {
          console.log(`  (render falhou mesmo sem legenda — descartando): ${String(secondErr).slice(0, 200)}`);
          throw secondErr;
        }
      } else {
        // Falha de OUTRA coisa (disco cheio, timeout, crop inválido): o
        // erro sobe como está — repetir sem a legenda só gastaria um
        // render e esconderia a causa.
        throw renderErr;
      }
    } finally {
      if (captionsAssPath) {
        try {
          fs.rmSync(captionsAssPath, { force: true });
        } catch {
          // best-effort
        }
      }
    }
    // O despejo de texto (.txt/.orig.txt) descreve o mp4 que vai subir:
    // só é gravado quando a legenda foi queimada nele, e o arquivo de
    // uma rodada anterior que NÃO entrou no vertical é apagado (órfão).
    const txtBase = path.join(outDir, `${name}_legenda`);
    try {
      if (captionInfo?.applied && captionText) {
        fs.mkdirSync(path.dirname(txtBase), { recursive: true });
        fs.writeFileSync(`${txtBase}.txt`, captionText, 'utf8');
        if (captionOriginalText) {
          fs.writeFileSync(`${txtBase}.orig.txt`, captionOriginalText, 'utf8');
        } else {
          fs.rmSync(`${txtBase}.orig.txt`, { force: true });
        }
      } else {
        removeCaptionTextFiles(txtBase);
      }
    } catch {
      // best-effort: o Short vale mais do que o dump de texto.
    }
  } else {
    console.log(`  vertical: já existe (${path.relative(process.cwd(), outMp4)})`);
  }

  // O status da legenda que DESCREVE o arquivo que vai subir: quando o
  // vertical foi refeito agora, é o de agora; quando já existia, é o do
  // marker anterior (o mp4 não mudou).
  const captionStatus = rendered ? captionInfo : (previous?.captionInfo ?? null);
  const verdict = canPublishShortWithCaptions({
    captionsOn,
    status: captionStatus,
    allowNoCaptions: args.allowNoCaptions,
  });
  /**
   * A rodada falhou de verdade? (a legenda quebrou e o Short ficou
   * para a próxima) — conta como tentativa, para o backoff agir.
   */
  const failedNow = captionsOn && isRetryableCaptionFailure(captionStatus) && !verdict.publish;

  let videoId: string | null = null;
  if (args.publish && !verdict.publish) {
    // A legenda foi pedida e QUEBROU: publicar assim entrega ao canal um
    // Short sem legenda que nunca mais seria refeito (o marker recebe o
    // `youtubeId` e a próxima rodada pula o clipe). O Short fica para a
    // próxima rodada tentar de novo.
    console.log(
      `  (${verdict.reason}) — o Short NÃO vai ao ar; rode de novo para tentar a legenda de novo (ou --allow-no-captions para publicar sem ela)`,
    );
  } else if (args.publish) {
    // Guarda de cota: cada `videos.insert` custa 1600 units do limite
    // diário (10000) do projeto de API — o mesmo que o bot live usa.
    const units = ctx.quotaUsed + QUOTA_UNITS_PER_UPLOAD;
    if (units > QUOTA_UNITS_PER_DAY) {
      throw new Error(
        `cota diária do YouTube esgotada (${ctx.quotaUsed} units usados; cada upload custa ${QUOTA_UNITS_PER_UPLOAD} de ${QUOTA_UNITS_PER_DAY})`,
      );
    }
    videoId = await uploadClip(ace, outMp4, {
      clientSecretsPath: cfg.YT_CLIENT_SECRETS,
      tokenPath: cfg.YT_TOKEN_PATH,
      privacy,
      categoryId: cfg.YT_CATEGORY_ID,
      defaultTags: cfg.YT_DEFAULT_TAGS,
      metadata,
      isShorts: true,
      shortsHashtag: cfg.SHORTS_HASHTAG,
      madeForKids: false,
    });
    ctx.quotaUsed = units;
    console.log(`  ✓ https://youtu.be/${videoId} (${privacy})`);
  } else {
    console.log('  (dry-run: nada publicado)');
  }

  const marker = {
    ...side,
    // O marker descreve o ARQUIVO GRAVADO: quando o vertical não foi
    // re-renderizado, a janela e as kills continuam as do mp4 em disco
    // (reescrever com a janela nova faria o marker mentir).
    ...(rendered
      ? {
          kills: includedKills,
          clipStartMs: side.clipStartMs + Math.round(plan.startSec * 1000),
          clipDurationSec: durSec,
          shortWindow: {
            startSec: plan.startSec,
            endSec: plan.endSec,
            durSec: plan.durSec,
            includedKills: plan.includedKills,
            droppedKills: plan.droppedKills,
          },
        }
      : {
          kills: previous?.kills ?? includedKills,
          clipStartMs: previous?.clipStartMs ?? side.clipStartMs + Math.round(plan.startSec * 1000),
          clipDurationSec: previous?.clipDurationSec ?? durSec,
          shortWindow: previous?.shortWindow ?? {
            startSec: plan.startSec,
            endSec: plan.endSec,
            durSec: plan.durSec,
            includedKills: plan.includedKills,
            droppedKills: plan.droppedKills,
          },
        }),
    clipFile: path.basename(outMp4),
    sourceClip: path.basename(mp4Path),
    format: 'shorts',
    width: cfg.SHORTS_WIDTH,
    height: cfg.SHORTS_HEIGHT,
    // O marker descreve o ARQUIVO em disco: quando não houve render, o
    // layout é o do marker anterior (o mp4 não mudou).
    render: rendered ? signature : (previous?.render ?? signature),
    // A legenda queimada descreve o ARQUIVO em disco: quando não houve
    // render, é a do vertical anterior.
    captionInfo: rendered
      ? (captionInfo ?? { applied: false })
      : (previous?.captionInfo ?? { applied: false }),
    title: metadata?.title ?? null,
    metadata: {
      title: metadata?.title ?? '',
      description: metadata?.description ?? '',
      tags: metadata?.tags ?? [],
      source: metadata?.source ?? 'template',
      privacy,
    },
    youtubeId: videoId ?? previous?.youtubeId ?? null,
    publishedAt: videoId ? new Date().toISOString() : previous?.publishedAt ?? null,
    /**
     * Contador de tentativas: uma legenda que quebrou (ou um render que
     * falhou) conta como tentativa — a próxima rodada espera o backoff
     * em vez de reprocessar o mesmo clipe. Published/ok zera o contador.
     */
    attempts: failedNow ? (previous?.attempts ?? 0) + 1 : 0,
    lastAttemptAt: failedNow ? new Date().toISOString() : null,
  };
  // A pasta do Short só nasce quando há algo para gravar nela.
  fs.mkdirSync(outDir, { recursive: true });
  // O marker é gravado ANTES do banco: se o insert falhar, o youtubeId
  // já está no disco e o script não republica o Short.
  fs.writeFileSync(outSidecar, JSON.stringify(marker, null, 2) + '\n');

  if (videoId) {
    // `insertAce` é idempotente: registra o ace se ainda não existir e
    // devolve o id (o Short sempre fica registrado no banco).
    const aceId = insertAce(cfg.DB_PATH, ace);
    insertClip(cfg.DB_PATH, aceId, outMp4, privacy, videoId, {
      format: 'shorts',
      width: cfg.SHORTS_WIDTH,
      height: cfg.SHORTS_HEIGHT,
      durationSec: durSec,
      isShorts: true,
      title: metadata?.title ?? null,
      publishedAt: new Date().toISOString(),
    });
  }

  return {
    published: videoId != null,
    report: {
      name,
      window: plan,
      top: topMode,
      durationSec: durSec,
      kills: includedKills.length,
      title: metadata?.title ?? null,
      youtubeId: videoId ?? null,
      captions: captionStatus?.reason ?? (captionStatus?.applied ? 'on' : 'off'),
      ...(verdict.publish ? {} : { notPublishedReason: verdict.reason ?? null }),
    },
  };
}

/** Modo dos metadados: `legacy` é o kill switch e vale para o Short. */
function metadataMode(cfg: AppConfig, args: Args): 'ai' | 'template' | 'legacy' {
  if (cfg.YT_META_MODE === 'legacy') return 'legacy';
  return cfg.YT_META_MODE === 'ai' && !args.noAi ? 'ai' : 'template';
}

/**
 * Grava a tentativa que falhou no marker do Short (o contador alimenta
 * o backoff). Um marker que não existe ainda é criado: a falha aconteceu
 * antes do marker ser gravado.
 */
function recordFailedAttempt(shortsDir: string, name: string): void {
  try {
    const outDir = path.join(shortsDir, name);
    const markerPath = path.join(outDir, `${name}_short.json`);
    const marker = readShortMarker(markerPath) ?? {};
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          ...marker,
          attempts: (marker.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
  } catch {
    // best-effort: sem contador, o clipe é tentado de novo (o pior caso
    // é repetir uma tentativa).
  }
}

async function runBatch(
  ctx: BatchContext,
  candidates: Candidate[],
  touchLock?: () => void,
): Promise<void> {
  const { shortsDir } = ctx;
  const report: Array<Record<string, unknown>> = [];
  let publishedCount = 0;
  try {
    for (const candidate of candidates) {
      // A trava é renovada a cada Short: um lote com várias chamadas de
      // IA pode passar do prazo de 30min e a segunda rodada tomaria a
      // trava no meio (upload duplicado).
      touchLock?.();
      try {
        const result = await processCandidate(ctx, candidate);
        if (!result) continue;
        report.push(result.report);
        if (result.published) publishedCount += 1;
      } catch (e) {
        // Uma falha (ffmpeg, upload, IA) NÃO pode abortar o lote: os
        // clipes seguintes ainda podem ser processados e o relatório
        // precisa registrar o que deu errado.
        const message = String((e as { message?: string })?.message ?? e).slice(0, 300);
        console.error(`  ✗ ${candidate.name}: ${message}`);
        report.push({ name: candidate.name, error: message });
        // A falha conta como tentativa: o backoff segura o clipe nas
        // próximas rodadas (e o `--last N` não fica preso nele).
        recordFailedAttempt(shortsDir, candidate.name);
        if (isQuotaError(e)) {
          console.error('  (cota do YouTube esgotada — o lote para aqui)');
          break;
        }
      }
    }
  } finally {
    // O relatório é SEMPRE gravado — é o registro do que já foi
    // publicado (e do que não foi).
    const reportPath = writeReport(shortsDir, report, publishedCount);
    console.log(
      `\n${report.length} Short(s) processado(s), ${publishedCount} publicado(s). Relatório: ${path.relative(process.cwd(), reportPath)}`,
    );
  }
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const args = parseArgs(process.argv.slice(2));
  // A config dos Shorts é do SCRIPT: se estiver inconsistente, o script
  // recusa (o bot live não depende dela — ver shortsCrossFieldErrors).
  validateConfigCrossFields(cfg);
  const privacy = (args.privacy ?? cfg.SHORTS_PRIVACY) as 'private' | 'unlisted' | 'public';

  if (args.publish && !cfg.SHORTS_ENABLED) {
    throw new Error(
      'publicar Shorts exige SHORTS_ENABLED=true (no .env ou no painel). Use --dry-run para calcular e renderizar sem publicar.',
    );
  }

  const clipsDir = path.resolve(cfg.CLIPS_DIR);
  const shortsDir = path.resolve(cfg.SHORTS_DIR);
  fs.mkdirSync(shortsDir, { recursive: true });

  // Sem espaço o render morre no meio e deixa lixo: melhor recusar.
  const free = getFreeBytes(shortsDir);
  const minFree = cfg.DISK_MIN_FREE_GB * 1024 ** 3;
  if (!isFreeSpaceOk(free, minFree)) {
    throw new Error(
      `espaço livre insuficiente em ${shortsDir}: ${free != null ? gb(free) : 'n/d'} (mínimo ${gb(minFree)}) — libere espaço antes de renderizar`,
    );
  }

  const lock = acquireLock(path.join(shortsDir, 'publish-shorts.lock'));
  if (!lock) {
    throw new Error(
      'outra execução do publish-shorts está em andamento (trava em data/shorts/publish-shorts.lock) — rode de novo depois',
    );
  }

  try {
    const published = findPublishedShorts(cfg.DB_PATH);
    const all = discoverCandidates(clipsDir, args);
    // `--last N` conta os clipes AINDA NÃO publicados: sem isso, os N
    // mais recentes saíam todos no lote anterior e o comando não
    // publicava nada. Clipe no BACKOFF também não conta: senão o `--last
    // N` fica preso no mesmo clipe quebrado e o lote novo não sai.
    const pending = args.last
      ? all
          .filter((candidate) => {
            const key = aceKey(
              candidate.sidecar.matchId,
              candidate.sidecar.map,
              candidate.sidecar.round,
              candidate.sidecar.player,
            );
            if (published.has(key)) return false;
            const marker = readShortMarker(
              path.join(shortsDir, candidate.name, `${candidate.name}_short.json`),
            );
            if (marker?.youtubeId) return false;
            // `--retry-captions`: só entram os Shorts que falharam na
            // legenda — e o backoff NÃO vale (é o que o flag promete).
            if (args.retryCaptions) {
              return isRetryableCaptionFailure(marker?.captionInfo);
            }
            if (args.force) return true;
            return !shortRetryDecision({
              attempts: marker?.attempts ?? 0,
              lastAttemptAt: marker?.lastAttemptAt ?? null,
            }).skip;
          })
          .slice(0, args.last)
      : all;

    const useAi = metadataMode(cfg, args) === 'ai';
    const metadataAi = useAi
      ? createMetadataAi({
          order: cfg.YT_META_AI_ORDER,
          timeoutMs: cfg.YT_META_AI_TIMEOUT_MS,
          geminiApiKey: cfg.GEMINI_API_KEY || undefined,
          geminiModel: cfg.YT_META_GEMINI_MODEL,
          hfToken: cfg.HF_TOKEN || undefined,
          hfModel: cfg.YT_META_HF_MODEL,
        })
      : undefined;

    const captionTranscriber = createCaptionTranscriber({
      order: cfg.SHORTS_CAPTION_AI_ORDER,
      timeoutMs: cfg.SHORTS_CAPTION_TIMEOUT_MS,
      geminiApiKey: cfg.GEMINI_API_KEY || undefined,
      geminiModel: cfg.SHORTS_CAPTION_GEMINI_MODEL,
      hfToken: cfg.HF_TOKEN || undefined,
      hfModel: cfg.SHORTS_CAPTION_HF_MODEL,
      whisperModel: cfg.SHORTS_CAPTION_WHISPER_MODEL,
      dedicatedModel: cfg.SHORTS_CAPTION_DEDICATED_MODEL,
      silenceFinal: cfg.SHORTS_CAPTION_SILENCE_FINAL,
      refine: cfg.SHORTS_CAPTION_REFINE,
      translate: cfg.SHORTS_CAPTION_TRANSLATE,
    });

    const ctx: BatchContext = {
      cfg,
      args,
      privacy,
      published,
      useAi,
      metadataAi,
      captionTranscriber,
      shortsDir,
      quotaUsed: countPublishedClips(cfg.DB_PATH, startOfUtcDaySql()) * QUOTA_UNITS_PER_UPLOAD,
    };
    if (ctx.quotaUsed > 0) {
      console.log(
        `cota do dia: ${ctx.quotaUsed} units já usadas (${ctx.quotaUsed / QUOTA_UNITS_PER_UPLOAD} vídeo(s))`,
      );
    }
    await runBatch(ctx, pending, lock.touch);
  } finally {
    lock.release();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
