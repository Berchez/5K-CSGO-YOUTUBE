import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { AceEvent } from '../types.js';

const execFileAsync = promisify(execFile);

const W = 1280;
const H = 720;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 48);
}

/**
 * Thumbnail "estilo canal de cortes": frame real do clipe + faixa com
 * selo ACE!, jogador, confronto e evento. Determinístico, grátis e
 * instantâneo — sem API de IA, sem custo, sem risco de rosto/logo
 * alucinado (problema comum de thumbnail 100% gerada por IA).
 */
export function thumbnailOverlay(ace: AceEvent): Buffer {
  const player = esc(ace.player);
  const match = esc(`${ace.team1} vs ${ace.team2}`);
  // esc por campo (não na linha toda) para não decepar o nº do round
  const scoreBit = ace.score ? ` • ${esc(ace.score)}` : '';
  const meta = `${esc(ace.event)} • ${esc(ace.map)} • Round ${ace.round}${scoreBit}`;
  const svg = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="black" stop-opacity="0"/>
      <stop offset="1" stop-color="black" stop-opacity="0.82"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="48" y="470" width="230" height="92" rx="14" fill="#e10600"/>
  <text x="163" y="537" font-family="Arial Black, Arial, sans-serif" font-size="62"
        font-weight="900" fill="white" text-anchor="middle">ACE!</text>
  <text x="300" y="537" font-family="Arial Black, Arial, sans-serif" font-size="64"
        font-weight="900" fill="white">${player}</text>
  <text x="48" y="600" font-family="Arial, sans-serif" font-size="40"
        font-weight="bold" fill="#ffd400">${match}</text>
  <text x="48" y="652" font-family="Arial, sans-serif" font-size="28"
        fill="#e8e8e8">${meta}</text>
</svg>`;
  return Buffer.from(svg);
}

export interface ThumbOptions {
  width?: number;
  height?: number;
}

/** Extrai 1 frame do vídeo (retorna caminho temporário; quem chama apaga). */
export async function extractFrame(videoPath: string, atSec: number): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `5k-frame-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`,
  );
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(Math.max(0, atSec)),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    tmp,
  ]);
  return tmp;
}

/** Compõe frame + overlay e salva 1280x720 pronta para o YouTube. */
export async function buildThumbnail(
  framePath: string,
  outPath: string,
  ace: AceEvent,
  opts: ThumbOptions = {},
): Promise<string> {
  const w = opts.width ?? W;
  const h = opts.height ?? H;
  await sharp(framePath)
    .resize(w, h, { fit: 'cover' })
    .composite([{ input: thumbnailOverlay(ace), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outPath);
  return outPath;
}

/** Atalho: frame do vídeo + composição em um passo (apaga o temporário). */
export async function makeThumbnail(
  videoPath: string,
  outPath: string,
  ace: AceEvent,
  atSec: number,
): Promise<string> {
  const frame = await extractFrame(videoPath, atSec);
  try {
    return await buildThumbnail(frame, outPath, ace);
  } finally {
    fs.rmSync(frame, { force: true });
  }
}

export interface SmartThumbOptions {
  mode?: 'composed' | 'ai';
  ai?: import('./aiThumbnail.js').AiThumbOptions;
}

/**
 * Thumb inteligente:
 * - modo 'ai' + provider de FUNDO (gemini-web/hf/gemini/pollinations):
 *   fundo IA + frame real em destaque + overlay (híbrida).
 * - modo 'ai' + provider `chatgpt`: a imagem IA JÁ É a thumb completa
 *   (só resize p/ 1280x720) — o prompt dela já inclui textos e layout.
 * - qualquer falha: cai para a composta. Default: composta (zero custo).
 */
export async function makeSmartThumbnail(
  videoPath: string,
  outPath: string,
  ace: AceEvent,
  atSec: number,
  opts: SmartThumbOptions = {},
): Promise<string> {
  if (opts.mode === 'ai') {
    try {
      const { buildAiBackground } = await import('./aiThumbnail.js');
      const result = await buildAiBackground(ace, opts.ai);
      if (result) {
        if (result.fullThumb) {
          // Thumb completa gerada pela IA (com texto do layout do canal):
          // só redimensiona — overlay sharp duplicaria os textos.
          const sharp = (await import('sharp')).default;
          await sharp(result.image)
            .resize(1280, 720, { fit: 'cover' })
            .jpeg({ quality: 90 })
            .toFile(outPath);
          return outPath;
        }
        const { buildAiThumbnail } = await import('./aiThumbnail.js');
        const frame = await extractFrame(videoPath, atSec);
        try {
          return await buildAiThumbnail(frame, outPath, ace, result.image);
        } finally {
          fs.rmSync(frame, { force: true });
        }
      }
    } catch {
      // fallback silencioso para a composta
    }
  }
  return makeThumbnail(videoPath, outPath, ace, atSec);
}
