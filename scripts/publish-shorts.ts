/**
 * Publica Shorts verticais (9:16) a partir dos clipes já gravados pelo bot.
 *
 * O material é o clipe 16:9 do ao vivo (`data/clips/<pasta>/<pasta>.mp4`
 * + sidecar `.json`). Aqui:
 * 1. a janela do Short é calculada (da 1ª à última kill, 30-60s);
 * 2. o vertical é renderizado (crop 9:16 + scale) — o YouTube só mostra
 *    vídeo VERTICAL no feed Shorts;
 * 3. os metadados são gerados no formato Shorts (título curto, #Shorts);
 * 4. o vídeo sobe pelo MESMO pipeline do bot (API do YouTube).
 *
 * A legenda fica por conta do YouTube (auto-caption PT-BR): subir uma
 * faixa própria exige `captions.insert`, que pede o scope
 * `youtube.force-ssl` (o token atual tem só `youtube.upload`).
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
 *   --force            re-renderiza mesmo com o vertical já existente
 *                      (e publica Shorts com a abertura limitada pelo
 *                      teto de latência — as posições das kills não são
 *                      confiáveis)
 */
import fs from 'node:fs';
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
  isStaleWindow,
  killPositionsByKill,
  planShortWindow,
  renderShortClip,
} from '../src/clipper/shorts.js';
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
  noAi: boolean;
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
    noAi: false,
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
    else if (name === '--no-ai') args.noAi = true;
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
 */
function acquireLock(lockPath: string): { release: () => void } | null {
  const staleMs = 30 * 60_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return {
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
  shortsDir: string;
  /** Units de cota já consumidas hoje (vídeos enviados). */
  quotaUsed: number;
}

interface CandidateResult {
  report: Record<string, unknown>;
  published: boolean;
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

  let durSec = plan.durSec;
  // O vertical já gravado só serve se cobrir A MESMA janela: com a
  // folga/limite mudados no .env, o mp4 antigo é de outro trecho do
  // clipe (e ia ao ar com o título da janela nova).
  const staleWindow = isStaleWindow(previous?.shortWindow, plan, fs.existsSync(outMp4));
  const rendered = args.force || staleWindow || !fs.existsSync(outMp4);
  if (rendered) {
    if (staleWindow) {
      console.log('  (a janela mudou — re-renderizando o vertical)');
    }
    const out = await renderShortClip(mp4Path, outMp4, {
      startSec: plan.startSec,
      durSec: plan.durSec,
      width: cfg.SHORTS_WIDTH,
      height: cfg.SHORTS_HEIGHT,
      cropX: cfg.SHORTS_CROP_X,
    });
    durSec = out.durSec;
    console.log(`  vertical: ${path.relative(process.cwd(), outMp4)} (${durSec}s)`);
  } else {
    console.log(`  vertical: já existe (${path.relative(process.cwd(), outMp4)})`);
  }

  const ace = sidecarToAce({ ...side, kills: includedKills }, plan.truncated);
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

  let videoId: string | null = null;
  if (args.publish) {
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
      durationSec: durSec,
      kills: includedKills.length,
      title: metadata?.title ?? null,
      youtubeId: videoId ?? null,
    },
  };
}

/** Modo dos metadados: `legacy` é o kill switch e vale para o Short. */
function metadataMode(cfg: AppConfig, args: Args): 'ai' | 'template' | 'legacy' {
  if (cfg.YT_META_MODE === 'legacy') return 'legacy';
  return cfg.YT_META_MODE === 'ai' && !args.noAi ? 'ai' : 'template';
}

async function runBatch(ctx: BatchContext, candidates: Candidate[]): Promise<void> {
  const { shortsDir } = ctx;
  const report: Array<Record<string, unknown>> = [];
  let publishedCount = 0;
  try {
    for (const candidate of candidates) {
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
    // publicava nada.
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
            return !marker?.youtubeId;
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

    const ctx: BatchContext = {
      cfg,
      args,
      privacy,
      published,
      useAi,
      metadataAi,
      shortsDir,
      quotaUsed: countPublishedClips(cfg.DB_PATH, startOfUtcDaySql()) * QUOTA_UNITS_PER_UPLOAD,
    };
    if (ctx.quotaUsed > 0) {
      console.log(
        `cota do dia: ${ctx.quotaUsed} units já usadas (${ctx.quotaUsed / QUOTA_UNITS_PER_UPLOAD} vídeo(s))`,
      );
    }
    await runBatch(ctx, pending);
  } finally {
    lock.release();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
