import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { AceEvent, ClipResult } from '../types.js';
import { getLogger } from '../logger.js';
import { makeSmartThumbnail, type SmartThumbOptions } from './thumbnail.js';
import { describeAce, prettyWeapon } from '../detector/aceDetector.js';

const execFileAsync = promisify(execFile);

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
  const listPath = path.join(opts.clipsDir, `${base}.txt`);
  const sidecarPath = path.join(opts.clipsDir, `${base}.json`);

  fs.writeFileSync(
    listPath,
    picked.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
  );

  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    outPath,
  ]);
  fs.rmSync(listPath, { force: true });

  const stat = fs.statSync(outPath);
  const durationSec = Math.min(
    wantSec,
    Math.round((picked.length * opts.segmentTimeSec * stat.size) / Math.max(1, stat.size)),
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
        segmentsUsed: picked.map((p) => path.basename(p)),
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
  const weapon = ace.summary?.mainWeapon
    ? ` (${prettyWeapon(ace.summary.mainWeapon)})`
    : '';
  return `ACE! ${ace.player}${weapon} (5K) — ${ace.team1} vs ${ace.team2} | ${ace.event} ${ace.map} R${ace.round}`.slice(0, 100);
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
