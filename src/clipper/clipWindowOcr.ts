import { spawn } from 'node:child_process';
import type { KillEvent } from '../types.js';
import { matchKillfeedText } from './killfeedSync.js';
import { looksLikeReplay } from './killfeedSync.js';
import { resolveFfmpegBin } from './segmentProbe.js';

/**
 * MEDIÇÃO DA JANELA NO CLIPE RENDERIZADO (OCR).
 *
 * A lógica pura da auditoria está em `clipWindowAudit.ts`; aqui é a
 * medição: ler o MP4 já pronto e dizer o que ele mostra.
 *
 * Duas leituras:
 *
 * 1. **o killfeed** — em que segundo do clipe cada kill do ace
 *    aparece. É o que prova se o clipe contém o ace ao vivo;
 * 2. **o banner "REPLAY"** — se o clipe abre DENTRO de uma reexibição
 *    (o round já tinha acabado quando o clipe começou). É a medição
 *    INDEPENDENTE que a estimativa não dá: nenhuma conta de latência
 *    prova que o primeiro segundo do clipe é o round ao vivo.
 *
 * O pré-processamento é o MESMO do bot (`resize 2400 + grayscale +
 * normalize`): um OCR diferente do de produção mediria outra coisa.
 */

/** Uma leitura do killfeed do clipe renderizado. */
export interface ClipKillfeedHit {
  /** Segundo do clipe (relativo ao início do arquivo). */
  atSec: number;
  /** Índices das kills do ace casadas com o texto lido. */
  killIndexes: number[];
  /** Texto lido no frame (para o olho humano). */
  text: string;
}

/** Resultado da medição do MP4. */
export interface ClipWindowOcr {
  /** Frames lidos. */
  frames: number;
  /** Ocorrências do killfeed do ace. */
  hits: ClipKillfeedHit[];
  /** Segundos em que o banner "REPLAY" foi visto. */
  replayAtSec: number[];
  /** Erro (se a leitura não deu certo). */
  error?: string;
}

/** Opções da medição. */
export interface ClipWindowOcrOptions {
  /** Arquivo MP4. */
  file: string;
  /** Crop do killfeed (x:y:w:h em fração) — `null` = não lê o killfeed. */
  killfeedCrop: string | null;
  /** Crop do banner "REPLAY" (vazio = não lê o banner). */
  replayCrop?: string | null;
  /** Kills do ace (para casar as linhas). */
  kills: KillEvent[];
  /** Segundo inicial (default 0). */
  fromSec?: number;
  /** Segundo final (default: o fim do arquivo). */
  toSec?: number;
  /** Fração de um segundo (default 1 = 1 frame por segundo). */
  sampleFps?: number;
}

/** Lê a fração de um crop no formato "x:y:w:h". */
export function parseFractionCrop(raw: string): { x: number; y: number; w: number; h: number } | null {
  const parts = raw.split(':').map((part) => Number.parseFloat(part));
  if (
    parts.length !== 4 ||
    !parts.every(Number.isFinite) ||
    parts[0] < 0 ||
    parts[1] < 0 ||
    parts[2] <= 0 ||
    parts[3] <= 0 ||
    parts[0] + parts[2] > 1 ||
    parts[1] + parts[3] > 1
  ) {
    return null;
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Separa os PNGs colados no stdout do ffmpeg.
 *
 * O ffmpeg com `-f image2pipe` escreve a sequência de PNGs sem
 * separador. Cada PNG é a assinatura de 8 bytes + uma cadeia de chunks
 * (comprimento + tipo + dados + CRC); o frame termina no chunk IEND.
 * Procurar a sequência "IEND" nos bytes crus não funciona: os dados
 * comprimidos podem conter esses bytes no meio (e o frame saía
 * truncado — o sharp reclamava "unsupported image format").
 *
 * Exportado para teste.
 */
export function splitPngFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) break;
    if (!buffer.subarray(offset, offset + 8).equals(SIGNATURE)) {
      // Bytes que não são o começo de um PNG: descarta até a próxima
      // assinatura (o ffmpeg pode escrever algo fora da sequência).
      const next = buffer.indexOf(SIGNATURE, offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    let cursor = offset + 8;
    let end = -1;
    while (cursor + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(cursor);
      const type = buffer.subarray(cursor + 4, cursor + 8).toString('latin1');
      const next = cursor + 8 + length + 4;
      if (next > buffer.length) break;
      cursor = next;
      if (type === 'IEND') {
        end = cursor;
        break;
      }
    }
    if (end < 0) break;
    frames.push(buffer.subarray(offset, end));
    offset = end;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Converte o rectângulo do ffmpeg (em pixels) no filtro do sharp. */
function extractRect(
  width: number,
  height: number,
  crop: { x: number; y: number; w: number; h: number },
): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.min(width - 1, Math.round(crop.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(crop.y * height)));
  const w = Math.max(1, Math.min(width - left, Math.round(crop.w * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(crop.h * height)));
  return { left, top, width: w, height: h };
}

/**
 * Mede o clipe renderizado: killfeed do ace + banner de replay.
 *
 * Só o trecho pedido é lido (`fromSec`..`toSec`) — a medição de
 * produção olha os primeiros segundos (o banner), e o harness olha o
 * clipe inteiro.
 */
export async function ocrClipWindow(options: ClipWindowOcrOptions): Promise<ClipWindowOcr> {
  const killfeed =
    options.killfeedCrop != null ? parseFractionCrop(options.killfeedCrop) : null;
  if (options.killfeedCrop != null && killfeed == null) {
    return {
      frames: 0,
      hits: [],
      replayAtSec: [],
      error: `crop de killfeed inválido: ${options.killfeedCrop}`,
    };
  }
  const replay = options.replayCrop != null ? parseFractionCrop(options.replayCrop) : null;
  if (options.replayCrop != null && options.replayCrop.trim() !== '' && replay == null) {
    return {
      frames: 0,
      hits: [],
      replayAtSec: [],
      error: `crop de replay inválido: ${options.replayCrop}`,
    };
  }
  if (killfeed == null && replay == null) {
    return { frames: 0, hits: [], replayAtSec: [], error: 'nenhum crop informado' };
  }
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg) {
    return { frames: 0, hits: [], replayAtSec: [], error: 'ffmpeg indisponível' };
  }
  const fps = options.sampleFps ?? 1;
  const from = Math.max(0, options.fromSec ?? 0);
  const to = options.toSec ?? undefined;
  const frames: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(from),
      ];
      if (to != null) args.push('-to', String(to));
      args.push(
        '-i',
        options.file,
        '-vf',
        `fps=${fps}`,
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-',
      );
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let buffer: Buffer = Buffer.alloc(0);
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const split = splitPngFrames(buffer);
        frames.push(...split.frames);
        buffer = split.rest;
      });
      proc.on('error', reject);
      proc.on('close', () => resolve());
    });
  } catch (e) {
    return { frames: frames.length, hits: [], replayAtSec: [], error: `ffmpeg: ${String(e).slice(0, 160)}` };
  }
  if (frames.length === 0) {
    return {
      frames: 0,
      hits: [],
      replayAtSec: [],
      error: 'nenhum frame lido (arquivo vazio ou ffmpeg ausente?)',
    };
  }
  try {
    const { default: sharp } = await import('sharp');
    const { createWorker, PSM } = await import('tesseract.js');
    const worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const hits: ClipKillfeedHit[] = [];
    const replayAtSec: number[] = [];
    try {
      for (let i = 0; i < frames.length; i++) {
        const atSec = from + i / fps;
        const image = sharp(frames[i]);
        const meta = await image.metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        if (width === 0 || height === 0) continue;
        /**
         * O MESMO pré-processamento do bot: sem ele o harness mediria
         * um OCR diferente do de produção.
         */
        if (killfeed != null) {
          const killfeedImage = await image
            .clone()
            .extract(extractRect(width, height, killfeed))
            .resize({ width: 2400 })
            .grayscale()
            .normalize()
            .png()
            .toBuffer();
          const { data } = await worker.recognize(killfeedImage);
          const text = String(data.text ?? '');
          const killIndexes = matchKillfeedText(text, options.kills);
          if (killIndexes.length > 0) {
            hits.push({ atSec, killIndexes, text: text.replace(/\s+/g, ' ').trim() });
          }
        }
        if (replay != null) {
          const replayImage = await image
            .clone()
            .extract(extractRect(width, height, replay))
            .resize({ width: 1600 })
            .grayscale()
            .normalize()
            .png()
            .toBuffer();
          const replayRead = await worker.recognize(replayImage);
          if (looksLikeReplay(String(replayRead.data.text ?? ''))) replayAtSec.push(atSec);
        }
      }
    } finally {
      await worker.terminate();
    }
    return { frames: frames.length, hits, replayAtSec };
  } catch (e) {
    return { frames: frames.length, hits: [], replayAtSec: [], error: `ocr: ${String(e).slice(0, 160)}` };
  }
}

/** Resumo de uma linha (log do harness). */
export function summarizeKillfeedOcr(ocr: ClipWindowOcr): string {
  if (ocr.error != null) return `erro: ${ocr.error}`;
  const kills = ocr.hits.map((hit) => hit.killIndexes.map((index) => index + 1).join(','));
  return `${ocr.hits.length} ocorrência(s) (${kills.join(' | ')}) em ${ocr.frames} frames${
    ocr.replayAtSec.length > 0 ? `, REPLAY em ${ocr.replayAtSec.map((sec) => `${sec.toFixed(1)}s`).join(', ')}` : ''
  }`;
}
