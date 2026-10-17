/**
 * Probe Fase 2: cravar o 1º kill no RELÓGIO DA STREAM via killfeed OCR.
 *
 * Por que: o tracker ancora o início em (kill observado − SCOREBOARD_DELAY),
 * um chute fixo. Se o OCR achar o nome do jogador no killfeed com ±1s, o
 * trim de início vira exato e o delay fixo deixa de importar.
 *
 * Uso:
 *   npx tsx scripts/ocr-probe.ts --clip data/clips/X.mp4 --player Wicadia --at 5 --pre 10 --post 5
 *   npx tsx scripts/ocr-probe.ts --clip <mp4> --player donk --at 01:02:03 --crop 0.55:0:0.45:0.35
 *
 * --at = instante aproximado do 5º kill (HH:MM:SS ou segundos); a janela
 * varrida é [at-pre, at+post] a 1fps. --crop = frações x:y:w:h do killfeed
 * (default canto superior-direito). Pré-processa com sharp (2x + cinza +
 * threshold) e roda tesseract.js (WASM, devDependency — o bot nunca carrega).
 * Sai com relatório JSON + frames salvos p/ inspeção visual.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const FFMPEG = path.join(
  path.resolve('.'),
  '.tools',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

function parseTs(s: string): number {
  if (/^\d+(\.\d+)?$/.test(s)) return Number.parseFloat(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`timestamp inválido: ${s}`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main(): Promise<void> {
  const clip = arg('clip');
  const player = arg('player');
  const atRaw = arg('at');
  if (!clip || !player || !atRaw) {
    console.error(
      'Uso: npx tsx scripts/ocr-probe.ts --clip <mp4> --player <nome> --at <HH:MM:SS|s> [--pre 10] [--post 5] [--crop x:y:w:h] [--fps 1]',
    );
    process.exit(2);
  }
  if (!fs.existsSync(clip)) throw new Error(`clipe não encontrado: ${clip}`);
  if (!fs.existsSync(FFMPEG)) throw new Error(`ffmpeg não encontrado em ${FFMPEG}`);
  const at = parseTs(atRaw);
  const pre = Number(arg('pre', '10'));
  const post = Number(arg('post', '5'));
  const fps = Number(arg('fps', '1'));
  const [cx, cy, cw, ch] = (arg('crop', '0.70:0.05:0.30:0.25') ?? '0.70:0.05:0.30:0.25')
    .split(':')
    .map(Number);
  const upscaleWidth = Number(arg('upscale', '2400'));
  const psmRaw = arg('psm', '6') ?? '6';
  const PSM_BY_NUMBER: Record<string, string> = {
    '3': 'AUTO',
    '4': 'SINGLE_COLUMN',
    '6': 'SINGLE_BLOCK',
    '11': 'SPARSE_TEXT',
  };
  if (!PSM_BY_NUMBER[psmRaw]) throw new Error('--psm: use 3, 4, 6 ou 11');
  if ([cx, cy, cw, ch].some((v) => Number.isNaN(v) || v < 0 || v > 1)) {
    throw new Error('--crop usa frações x:y:w:h entre 0 e 1');
  }
  const start = Math.max(0, at - pre);
  const frames = Math.max(1, Math.round((pre + post) * fps));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-probe-'));
  console.log(`Extraindo ${frames} frames (${fps}fps) de ${start.toFixed(1)}s — killfeed x=${cx} y=${cy} w=${cw} h=${ch}`);

  await execFileAsync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(start),
    '-i',
    clip,
    '-frames:v',
    String(frames),
    '-vf',
    `fps=${fps},crop=iw*${cw}:ih*${ch}:iw*${cx}:ih*${cy}`,
    path.join(dir, 'fr_%03d.png'),
  ], { windowsHide: true });

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  console.log(`${files.length} crops em ${dir}`);

  const { default: sharp } = await import('sharp');
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng');
  await worker.setParameters({ tessedit_pageseg_mode: PSM[PSM_BY_NUMBER[psmRaw] as keyof typeof PSM] });
  const want = norm(player);
  const wantRaw = player.toLowerCase();
  let ocrCalls = 0;
  let ocrMs = 0;
  async function ocrFrame(file: string): Promise<{ text: string; conf: number }> {
    let pipeline = sharp(path.join(dir, file)).resize({ width: upscaleWidth }).grayscale().normalize();
    const th = Number(arg('threshold', '0'));
    if (th > 0) pipeline = pipeline.threshold(th);
    const pre2 = await pipeline.png().toBuffer();
    const t0 = Date.now();
    const { data } = await worker.recognize(pre2);
    ocrCalls++;
    ocrMs += Date.now() - t0;
    return { text: String(data.text ?? ''), conf: Number(data.confidence ?? 0) };
  }
  function isHit(text: string): boolean {
    const flat = text.replace(/\s+/g, ' ');
    return norm(text).includes(want) || flat.toLowerCase().includes(wantRaw);
  }
  const items = files.map((f, i) => ({ f, t: start + i / fps }));
  const hits: Array<{ t: number; conf: number; text: string }> = [];
  const samples: string[] = [];
  try {
    // Passada 1 (grossa, ~0.33fps): acha a região do primeiro hit.
    let roughHit: (typeof items)[number] | null = null;
    for (let i = 0; i < items.length; i += 3) {
      const { text } = await ocrFrame(items[i].f);
      if (i < 3) samples.push(`[${items[i].t.toFixed(1)}s] ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      if (isHit(text)) {
        roughHit = items[i];
        break;
      }
      if (i % 12 === 0) console.log(`ocr grossa ${i + 1}/${items.length}...`);
    }
    // Passada 2 (fina, 1fps): refina de 6s antes do hit grosso até ele.
    // Sem hit grosso, varre tudo a 1fps (caro — último recurso).
    const refine = roughHit
      ? items.filter((it) => it.t >= roughHit.t - 6 && it.t <= roughHit.t)
      : items;
    for (const it of refine) {
      const { text, conf } = await ocrFrame(it.f);
      if (isHit(text)) {
        hits.push({ t: it.t, conf, text: text.replace(/\s+/g, ' ').slice(0, 160) });
        break; // só o PRIMEIRO interessa (âncora do início)
      }
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }

  const report = {
    clip: path.resolve(clip),
    player,
    window: { start, end: start + files.length / fps },
    crop: { cx, cy, cw, ch },
    frames: files.length,
    ocrCalls,
    avgOcrMs: ocrCalls > 0 ? Math.round(ocrMs / ocrCalls) : 0,
    samples,
    hits,
    firstHitSec: hits.length > 0 ? hits[0].t : null,
    verdict:
      hits.length > 0
        ? `1º kill ≈ ${hits[0].t.toFixed(1)}s no relógio do clipe (±1s) — âncora exata viável`
        : 'nome não achado: ajuste --crop/--pre/--post ou confira os frames salvos',
    framesDir: dir,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('FALHOU: ' + (e as Error).message);
  process.exit(1);
});
