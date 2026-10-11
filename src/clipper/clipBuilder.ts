import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { AceEvent, ClipResult } from '../types.js';
import { getLogger } from '../logger.js';

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
  const needFiles = Math.max(
    2,
    Math.ceil(wantSec / opts.segmentTimeSec) + 1,
  );
  const picked = segments.slice(-needFiles);
  log.info({ picked: picked.length, wantSec }, 'montando clipe');

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

  // Thumbnail: frame do meio do clipe
  const thumbPath = path.join(opts.clipsDir, `${base}.jpg`);
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(Math.max(1, Math.floor(opts.preRollSec / 2))),
      '-i',
      outPath,
      '-frames:v',
      '1',
      thumbPath,
    ]);
  } catch {
    log.warn('falha ao gerar thumbnail, seguindo sem ela');
  }

  fs.writeFileSync(
    sidecarPath,
    JSON.stringify(
      {
        ...ace,
        clipFile: path.basename(outPath),
        segmentsUsed: picked.map((p) => path.basename(p)),
        createdAt: new Date().toISOString(),
      },
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
  return `ACE! ${ace.player} (5K) — ${ace.team1} vs ${ace.team2} | ${ace.event} ${ace.map} R${ace.round}`;
}

export function buildDescription(ace: AceEvent, tags: string): string {
  return [
    `${buildTitle(ace)}`,
    '',
    `5 kills no mesmo round por ${ace.player} em ${ace.team1} vs ${ace.team2}.`,
    `Evento: ${ace.event} | Mapa: ${ace.map} | Round: ${ace.round}`,
    `Detectado em: ${ace.detectedAt}`,
    '',
    'Corte automático para revisão. Publicado como privado.',
    '',
    `Tags: ${tags}`,
  ].join('\n');
}
