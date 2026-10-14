import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AceEvent, ClipResult } from '../types.js';
import { getLogger } from '../logger.js';
import { makeSmartThumbnail, type SmartThumbOptions } from './thumbnail.js';
import { describeAce, killLabel, prettyWeapon } from '../detector/aceDetector.js';
import { killAll, killStale, track, untrack } from '../procRegistry.js';

const execFileAsync = promisify(execFile);

/**
 * execFile com registro no procRegistry: se o Node morrer no meio
 * (restart/crash), o shutdown/exit mata o ffmpeg — sem deixar encode
 * órfão pegando 100% da CPU (Windows não mata filhos sozinho).
 */
function execTracked(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p: ChildProcess = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    track(p);
    p.on('error', reject);
    p.on('exit', (code) => {
      untrack(p);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Fila de render: NO MÁXIMO 1 encode por vez. Cada render é um x264
 * pegando quase toda a CPU — dois simultâneos travam o PC.
 */
let renderQueue: Promise<unknown> = Promise.resolve();
function enqueueRender<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.catch(() => undefined);
  return run;
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export interface ClipOptions {
  bufferDir: string;
  clipsDir: string;
  preRollSec: number;
  postRollSec: number;
  segmentTimeSec: number;
  /** Contexto antes do 1º kill (default 10s). */
  contextSec?: number;
  /** Epoch ms do 1º kill — ancora o início do clipe. Sem ele, usa últimos N. */
  aceStartMs?: number;
  /** Upscale p/ 1440 (default no config): força o pipeline VP9/AV1 do YouTube. */
  upscaleHeight?: number;
  /** Thumb: default composed; ai tenta fundo IA com fallback. */
  thumb?: SmartThumbOptions;
}

export interface PickOptions {
  segmentTimeSec: number;
  preRollSec: number;
  postRollSec: number;
  contextSec?: number;
  aceStartMs?: number;
}

/**
 * Checa se o ffmpeg consegue abrir o arquivo (cabeçalho/moov íntegro).
 * Lê SÓ o header (~200ms): sem arquivo de saída o ffmpeg sempre sai != 0,
 * então o veredito vem do stderr (tem Duration + Stream #0? tem erro fatal?).
 */
async function isSegmentReadable(file: string): Promise<boolean> {
  const out = await execFileAsync('ffmpeg', ['-hide_banner', '-i', file], { timeout: 15000 })
    .then((r) => String(r.stderr ?? ''))
    .catch((e: unknown) => String((e as { stderr?: unknown }).stderr ?? e));
  if (/moov atom not found|Invalid data found|No such file|does not contain any stream/i.test(out)) {
    return false;
  }
  return /Duration:\s*\d+:\d+/.test(out) && /Stream #0/.test(out);
}

/**
 * Higieniza segmentos p/ o concat (files em ordem oldest→newest):
 * 1) descarta o MAIS NOVO (está sendo escrito pelo recorder agora);
 * 2) descarta ilegíveis (moov quebrado / parcial de queda de stream).
 * Sem isso um único segmento ruim derruba o concat inteiro (moov atom
 * not found) e o .txt órfão fica para trás.
 */
export async function sanitizeSegments(files: string[]): Promise<{ ok: string[]; dropped: string[] }> {
  const log = getLogger();
  const dropped: string[] = [];
  let rest = [...files];
  if (rest.length > 2) {
    const newest = rest.pop()!;
    dropped.push(newest);
    log.info({ dropped: path.basename(newest) }, 'segmento mais novo descartado (em gravação)');
  }
  const ok: string[] = [];
  for (const f of rest) {
    if (await isSegmentReadable(f)) {
      ok.push(f);
    } else {
      dropped.push(f);
      log.warn({ dropped: path.basename(f) }, 'segmento ilegível descartado (moov quebrado?)');
    }
  }
  return { ok, dropped };
}

/**
 * Upscale com restauração leve (denoise temporal + sharpen adaptativo) e
 * re-encode de alta qualidade (lanczos + CRF 17) para forçar o pipeline
 * VP9/AV1 do YouTube: uploads >=1440p recebem codec superior, e a qualidade
 * percebida sobe muito mesmo assistindo em 1080p. O denoise vem ANTES do
 * scale (não amplia blocos de compressão) e o sharpen DEPOIS (devolve o fio
 * das bordas). A fonte (Twitch ~8 Mbps) continua sendo o teto — isto só
 * preserva o máximo dela e destrava o codec melhor. Opera in-place
 * (via temporário + rename).
 *
 * trimStartSec: corta o COMEÇO com precisão de frame — os segmentos do
 * buffer são atômicos de 10s, então o concat sempre pega segmentos
 * "inteiros" (até 10s de folga antes do momento desejado). O trim aqui
 * é grátis: este passo re-encoda de qualquer forma.
 */
export async function upscaleClip(inPath: string, height: number, trimStartSec = 0): Promise<string> {
  const log = getLogger();
  const tmp = `${inPath}.up${height}.mp4`;
  const cpus = os.cpus().length;
  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
  if (trimStartSec > 0.5) args.push('-ss', trimStartSec.toFixed(2));
  args.push(
    '-i',
    inPath,
    '-vf',
    `hqdn3d=4:3:7:5,scale=-2:${height}:flags=lanczos+accurate_rnd+full_chroma_int,cas=0.6`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-threads',
    String(Math.max(2, cpus - 2)),
    '-crf',
    '17',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    tmp,
  );
  await execTracked('ffmpeg', args);
  fs.renameSync(tmp, inPath);
  const mb = (fs.statSync(inPath).size / 1024 / 1024).toFixed(1);
  log.info({ height, mb, trimStartSec }, 'upscale aplicado (força VP9/AV1 no YouTube)');
  return inPath;
}

/**
 * Offset de trim dentro do clipe concatenado para o corte começar
 * exatamente em (âncora − contexto). O concat entrega segmentos ATÔMICOS
 * (o pick inclui o segmento anterior inteiro p/ garantir material);
 * este cálculo converte a folga atômica em começo exato (aplicado no
 * upscale, que re-encoda de qualquer forma — trim grátis em qualidade).
 * Puro: (mtime do 1º segmento − duração dele) ≈ início real do clipe.
 */
export function computeTrimStartSec(
  firstSegEndMs: number,
  segmentTimeSec: number,
  aceStartMs: number | undefined,
  contextSec: number,
): number {
  if (aceStartMs == null) return 0;
  const firstSegStartMs = firstSegEndMs - segmentTimeSec * 1000;
  const desiredStartMs = aceStartMs - contextSec * 1000;
  return Math.max(0, (desiredStartMs - firstSegStartMs) / 1000);
}

/**
 * CAUDA CONTÍGUA: mantém apenas a sequência cronológica do fim do buffer.
 * Se dois ffmpegs escreveram no mesmo diretório (fantasma de restart), os
 * mtimes ficam intercalados e o clipe "volta no tempo" (sidecar real:
 * [005, 016, 017, 000, 001, 002, 003]). Aqui, um gap > maxGapSec corta
 * tudo anterior — a cauda contígua é sempre uma única timeline coerente.
 */
export function contiguousTail(files: string[], maxGapSec: number): { ok: string[]; dropped: string[] } {
  if (files.length <= 1) return { ok: [...files], dropped: [] };
  const timed = files.map((f) => {
    let m = 0;
    try {
      m = fs.statSync(f).mtimeMs;
    } catch {
      m = 0;
    }
    return { f, m };
  });
  let start = 0;
  for (let i = timed.length - 2; i >= 0; i--) {
    // arquivo com mtime 0 (stat falhou): não é sinal de intercalação
    const gapSec = (timed[i + 1].m - timed[i].m) / 1000;
    if (timed[i].m > 0 && timed[i + 1].m > 0 && gapSec > maxGapSec) {
      start = i + 1;
      break;
    }
  }
  return {
    ok: timed.slice(start).map((t) => t.f),
    dropped: timed.slice(0, start).map((t) => t.f),
  };
}

/**
 * Escolhe segmentos por TEMPO (mtime do arquivo ≈ fim do segmento).
 * Com aceStartMs: tudo que termina depois de (1º kill − contexto).
 * Sem: últimos N cobrindo pre+post. Sempre retorna ≥1 se houver entrada.
 */
export function pickSegments(segments: string[], opts: PickOptions): string[] {
  if (segments.length === 0) return [];
  const contextSec = opts.contextSec ?? 10;
  if (opts.aceStartMs == null) {
    const wantSec = opts.preRollSec + opts.postRollSec;
    const needFiles = Math.max(2, Math.ceil(wantSec / opts.segmentTimeSec) + 1);
    return segments.slice(-needFiles);
  }
  const cutFrom = opts.aceStartMs - contextSec * 1000;
  const timed = segments.map((f) => {
    let endMs = 0;
    try {
      endMs = fs.statSync(f).mtimeMs;
    } catch {
      endMs = 0;
    }
    return { f, endMs };
  });
  // -1 segmento de margem: o kill pode estar no início do seu segmento,
  // e o contexto precisa existir ANTES dele (segmentos são atômicos).
  const threshold = cutFrom - opts.segmentTimeSec * 1000;
  const picked = timed.filter((s) => s.endMs <= 0 || s.endMs > threshold).map((s) => s.f);
  if (picked.length === 0) {
    // ace mais velho que o buffer (ou relógio torto): usa o buffer todo
    return segments;
  }
  return picked;
}

/**
 * Concatena os últimos segmentos do buffer circular.
 * Usa `-c copy` (sem re-encode) para ser instantâneo em PC modesto.
 * MVP: só 16:9 horizontal, sem vertical/Shorts.
 */
export async function buildClip(
  ace: AceEvent,
  segments: string[],
  opts: ClipOptions,
): Promise<ClipResult> {
  const log = getLogger();
  if (segments.length === 0) {
    throw new Error(`sem segmentos no buffer ${opts.bufferDir} — stream caiu?`);
  }
  fs.mkdirSync(opts.clipsDir, { recursive: true });

  const wantSec = opts.preRollSec + opts.postRollSec;
  const picked = pickSegments(segments, {
    segmentTimeSec: opts.segmentTimeSec,
    preRollSec: opts.preRollSec,
    postRollSec: opts.postRollSec,
    contextSec: opts.contextSec,
    aceStartMs: opts.aceStartMs,
  });
  log.info(
    {
      picked: picked.length,
      wantSec,
      anchored: opts.aceStartMs != null,
      contextSec: opts.contextSec ?? 10,
    },
    'montando clipe',
  );

  const base = `${ace.matchId}_${slug(ace.map)}_r${ace.round}_${slug(ace.player)}`;
  const outPath = path.join(opts.clipsDir, `${base}.mp4`);
  const sidecarPath = path.join(opts.clipsDir, `${base}.json`);

  // Primeiro a cauda contígua (joga fora intercalação de fantasma),
  // depois a sanitização (legibilidade). Nessa ordem o trim e a duração
  // trabalham sobre uma única timeline coerente.
  const tail = contiguousTail(picked, opts.segmentTimeSec * 2.5);
  if (tail.dropped.length > 0) {
    log.warn(
      { dropped: tail.dropped.map((d) => path.basename(d)) },
      'segmentos intercalados (fantasma?) descartados — usando cauda contígua',
    );
  }
  const { ok: usable, dropped } = await sanitizeSegments(tail.ok);
  if (usable.length === 0) {
    throw new Error(
      `sem segmentos legíveis no buffer (descartados: ${dropped.map((d) => path.basename(d)).join(', ') || 'nenhum'})`,
    );
  }
  // Começo EXATO: (âncora − contexto), aplicado como trim por filtro.
  const trimStartSec = computeTrimStartSec(
    fs.statSync(usable[0]).mtimeMs,
    opts.segmentTimeSec,
    opts.aceStartMs,
    opts.contextSec ?? 10,
  );

  // PASSADA ÚNICA com FILTRO concat: emenda realinhando A/V arquivo a
  // arquivo. O concat demuxer com -c copy alinhava cada segmento pelo
  // início e acumulava ~20-40ms de desync por emenda — centenas de ms no
  // fim do clipe. Trim + restauração + upscale entram no MESMO filtro:
  // o re-encode que o upscale exigiria já processa a emenda, então o
  // custo total é o mesmo de antes (uma re-encode, não duas).
  const height = opts.upscaleHeight ?? 0;
  const pads = usable.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
  const doTrim = trimStartSec > 0.05;
  const vparts = [
    doTrim ? `trim=start=${trimStartSec.toFixed(2)},setpts=PTS-STARTPTS` : '',
    'hqdn3d=4:3:7:5',
    height > 0 ? `scale=-2:${height}:flags=lanczos+accurate_rnd+full_chroma_int` : '',
    'cas=0.6',
  ]
    .filter(Boolean)
    .join(',');
  const aparts = doTrim
    ? `atrim=start=${trimStartSec.toFixed(2)},asetpts=PTS-STARTPTS`
    : 'anull';
  const filter = `${pads}concat=n=${usable.length}:v=1:a=1[vc][ac];[vc]${vparts}[v];[ac]${aparts}[a]`;

  await enqueueRender(async () => {
    // Render fantasma de sessão anterior para ESTE clipe (crash/restart no
    // meio do encode): mata antes de começar outro.
    const stale = killStale(path.resolve(outPath));
    if (stale > 0) log.warn({ stale }, 'render fantasma morto');
    const cpus = os.cpus().length;
    const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-y'];
    for (const f of usable) args.push('-i', f);
    args.push(
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      // veryfast: mesma qualidade visual do medium em CRF 17 e ~2-3x mais
      // rápido — medium em 1440p60 sozinho já saturava a CPU do PC.
      'veryfast',
      // Deixa ~2 cores livres p/ o sistema (recorders, Chrome, uso diário).
      '-threads',
      String(Math.max(2, cpus - 2)),
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    );
    await execTracked('ffmpeg', args);
  });
  log.info(
    { segments: usable.length, trimStartSec, height },
    'clipe montado (passada única: emenda A/V realinhada + upscale)',
  );

  const stat = fs.statSync(outPath);
  const durationSec = Math.max(
    5,
    Math.min(wantSec, usable.length * opts.segmentTimeSec) - Math.round(trimStartSec),
  );

  // Thumbnail estilo canal de cortes: frame + selo ACE!/jogador/confronto.
  // Frame de ~3s antes do 5º kill (meio do ace) — meio do clipe costuma ser break/torcida.
  const thumbPath = path.join(opts.clipsDir, `${base}.jpg`);
  try {
    await makeSmartThumbnail(outPath, thumbPath, ace, Math.max(1, opts.preRollSec - 3), opts.thumb);
  } catch {
    log.warn('falha ao gerar thumbnail, seguindo sem ela');
  }

  fs.writeFileSync(
    sidecarPath,
    JSON.stringify(
      buildSidecar(ace, {
        clipFile: path.basename(outPath),
        segmentsUsed: usable.map((p) => path.basename(p)),
        createdAt: new Date().toISOString(),
      }),
      null,
      2,
    ),
  );

  return {
    filePath: outPath,
    sidecarPath,
    thumbnailPath: fs.existsSync(thumbPath) ? thumbPath : undefined,
    durationSec,
  };
}

export function buildTitle(ace: AceEvent): string {
  const label = killLabel(ace.kills.length);
  const weapon = ace.summary?.mainWeapon
    ? ` (${prettyWeapon(ace.summary.mainWeapon)})`
    : '';
  return `${label}! ${ace.player}${weapon} — ${ace.team1} vs ${ace.team2} | ${ace.event} ${ace.map} R${ace.round}`.slice(0, 100);
}

export function buildDescription(ace: AceEvent, tags: string): string {
  const head = ace.summary
    ? describeAce(ace.summary, ace.event)
    : [
        buildTitle(ace),
        '',
        `5 kills no mesmo round por ${ace.player} em ${ace.team1} vs ${ace.team2}.`,
        `Evento: ${ace.event} | Mapa: ${ace.map} | Round: ${ace.round}`,
        `Detectado em: ${ace.detectedAt}`,
      ].join('\n');
  return [
    head,
    '',
    'Corte automático para revisão. Publicado como privado.',
    '',
    `Tags: ${tags}`,
  ].join('\n');
}

/**
 * Payload do sidecar .json: kills UMA vez (top-level) + summary SEM a cópia
 * dos kills (só metadados agregados). Evita o array duplicado.
 */
export function buildSidecar(ace: AceEvent, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // JSON.stringify omite chaves undefined: kills aparece 1x (top-level).
  const summary = ace.summary
    ? { ...ace.summary, kills: undefined, killCount: ace.summary.kills.length }
    : undefined;
  return { ...ace, summary, ...extra };
}
