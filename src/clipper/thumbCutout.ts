import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { getLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

/**
 * Recorte do jogador (foto oficial) para a thumb composta.
 *
 * Estratégia: remove-background local (@imgly/background-removal-node,
 * dependência OPCIONAL) devolve o player's PNG com fundo transparente.
 * O recorte roda num PROCESSO SEPARADO (thumbCutoutWorker): o sharp antigo
 * do imgly crasha o processo quando divide a libvips com o sharp do repo.
 * Sem a dependência (ou se ela falhar), cai no retrato "emoldurado"
 * (recorte arredondado) — determinístico e sempre disponível.
 *
 * O resultado é cacheado pelo CONTEÚDO da foto (sha1): o mesmo jogador
 * não é reprocessado a cada partida.
 */

export type PlayerImageKind = 'cutout' | 'framed';

export interface PlayerImage {
  buffer: Buffer;
  kind: PlayerImageKind;
}

const DEFAULT_CACHE_DIR = './data/clips/refs/cutouts';
const REMOVE_TIMEOUT_MS = 120_000;
/** A dependência do recorte (opcional) — sem ela, nem há worker para spawnar. */
const REMOVE_PACKAGE = '@imgly/background-removal-node';
/**
 * Quanto tempo o cache NEGATIVO vale: depois disso o recorte é tentado de
 * novo (a dependência pode ter sido instalada nesse meio-tempo).
 */
const NEGATIVE_CACHE_MIN = 24 * 60;

/** A dependência opcional do recorte está instalada? */
export function removeDependencyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve(REMOVE_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/**
 * O arquivo é um recorte USÁVEL?
 *
 * Um PNG vazio, sem transparência ou minúsculo não serve: cacheado, ele
 * voltaria em toda thumb com a cara errada (ou nenhuma).
 */
export async function isValidCutout(file: string): Promise<boolean> {
  try {
    const meta = await sharp(file).metadata();
    if (!meta.width || !meta.height) return false;
    if (meta.width < 64 || meta.height < 64) return false;
    if (!meta.hasAlpha) return false;
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 16) transparent += 1;
    }
    // Um recorte tem fundo TRANSPARENTE (pelo menos 5% dos pixels).
    return transparent > info.width * info.height * 0.05;
  } catch {
    return false;
  }
}

/**
 * Chave do cache: o CONTEÚDO do arquivo (sha1 dos bytes).
 *
 * A chave antiga (caminho+mtime+tamanho) não servia: o caminho da foto
 * inclui o `matchId`, então o MESMO jogador era reprocessado a cada
 * partida (e o ONNX é caro). Com o hash do conteúdo, a foto baixada de
 * novo (mesmos bytes) reusa o recorte.
 */
export function cutoutCacheKey(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/** Máscara de retângulo arredondado (usada no fallback "emoldurado"). */
export function roundedMask(width: number, height: number, radius: number): Buffer {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/>
</svg>`;
  return Buffer.from(svg);
}

/** Recorte arredondado do retrato (fallback sem background removal). */
export async function framedPortrait(file: string, width: number, height: number): Promise<Buffer> {
  return sharp(file)
    .resize(width, height, { fit: 'cover', position: 'top' })
    .composite([{ input: roundedMask(width, height, Math.round(width * 0.08)), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/** Caminho do worker do recorte (.js no dist, .ts no tsx). */
export function cutoutWorkerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.resolve(here, 'thumbCutoutWorker.js');
  if (fs.existsSync(compiled)) return compiled;
  return path.resolve(here, 'thumbCutoutWorker.ts');
}

/**
 * Recorte em processo separado (isola o crash do native do imgly).
 * Devolve o PNG ou null.
 */
async function removeBackgroundLocal(file: string, outFile: string): Promise<Buffer | null> {
  // Sem a dependência não há o que rodar: nem vale spawnar um node.
  if (!removeDependencyAvailable()) return null;
  const worker = cutoutWorkerPath();
  if (!fs.existsSync(worker)) return null;
  // O node puro só roda `.ts` a partir da 22.18: no src (tsx) o worker
  // entra pelo hook do tsx; no dist ele já é `.js`.
  const args = worker.endsWith('.ts')
    ? ['--import', 'tsx', worker, file, outFile]
    : [worker, file, outFile];
  await execFileAsync(process.execPath, args, {
    timeout: REMOVE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (!fs.existsSync(outFile)) return null;
  const buf = fs.readFileSync(outFile);
  return buf.length > 1_000 ? buf : null;
}

export interface PlayerImageOptions {
  /** Pasta do cache dos recortes (default data/clips/refs/cutouts). */
  cacheDir?: string;
  /** Tamanho do retrato em moldura (fallback). */
  framedWidth?: number;
  framedHeight?: number;
}

/**
 * Foto do jogador pronta para a thumb: recortada (fundo transparente) ou
 * emoldurada (fallback). null se não houver foto.
 */
export async function getPlayerImage(
  playerPath: string | undefined,
  opts: PlayerImageOptions = {},
): Promise<PlayerImage | null> {
  if (!playerPath || !fs.existsSync(playerPath)) return null;
  const log = getLogger().child({ feature: 'thumb-composite' });
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const key = cutoutCacheKey(playerPath);
  const cacheFile = path.join(cacheDir, `${key}.png`);
  const negativeFile = path.join(cacheDir, `${key}.none`);

  if (fs.existsSync(cacheFile)) {
    // O cache só vale se o recorte for aproveitável: um PNG corrompido
    // (ou de uma versão antiga do worker) não pode ficar valendo para
    // sempre.
    if (await isValidCutout(cacheFile)) {
      try {
        return { buffer: fs.readFileSync(cacheFile), kind: 'cutout' };
      } catch {
        // cache corrompido: segue p/ refazer
      }
    } else {
      try {
        fs.rmSync(cacheFile, { force: true });
      } catch {
        // best-effort
      }
    }
  }

  // Cache NEGATIVO: a remoção de fundo já falhou para esta foto (dependência
  // ausente, modelo baixando, ONNX sem memória). Sem ele, cada thumb
  // spawnava um node e tomava o mesmo erro.
  const negative = readNegativeCache(negativeFile);
  if (negative) {
    log.info('remoção de fundo indisponível para esta foto — usando retrato emoldurado');
    return framedPlayerImage(playerPath, opts);
  }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const cutout = await removeBackgroundLocal(playerPath, cacheFile);
    if (cutout && (await isValidCutout(cacheFile))) {
      return { buffer: cutout, kind: 'cutout' };
    }
    // Recorte inútil (vazio/sem transparência): não fica no cache.
    try {
      fs.rmSync(cacheFile, { force: true });
    } catch {
      // best-effort
    }
    writeNegativeCache(negativeFile);
    log.info('remoção de fundo indisponível — usando retrato emoldurado');
  } catch (e) {
    writeNegativeCache(negativeFile);
    log.warn(
      { err: String(e).slice(0, 160) },
      'remoção de fundo falhou — usando retrato emoldurado',
    );
  }

  return framedPlayerImage(playerPath, opts);
}

/** Retrato emoldurado (fallback sem background removal). */
async function framedPlayerImage(
  playerPath: string,
  opts: PlayerImageOptions,
): Promise<PlayerImage> {
  const framed = await framedPortrait(
    playerPath,
    opts.framedWidth ?? 520,
    opts.framedHeight ?? 720,
  );
  return { buffer: framed, kind: 'framed' };
}

/** O cache negativo ainda vale (24h)? */
function readNegativeCache(file: string): boolean {
  try {
    const ageMin = (Date.now() - fs.statSync(file).mtimeMs) / 60_000;
    return ageMin < NEGATIVE_CACHE_MIN;
  } catch {
    return false;
  }
}

/** Marca a remoção de fundo como indisponível para esta foto. */
function writeNegativeCache(file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString());
  } catch {
    // best-effort
  }
}
