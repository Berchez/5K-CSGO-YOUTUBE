/**
 * Gera variante(s) de um clipe com o áudio atrasado — para julgar de ouvido
 * qual correção de skew aplicar (workflow do AV_STATIC_OFFSET_MS).
 *
 * Uso:
 *   npx tsx scripts/shift-audio.ts <clip.mp4> <ms> [--ms <ms2> ...] [--suffix fix]
 *
 * Ex:
 *   npx tsx scripts/shift-audio.ts data/clips/ace.mp4 2000
 *   npx tsx scripts/shift-audio.ts data/clips/ace.mp4 1500 --ms 2000 --ms 2500
 *
 * Saída: <base>_fix<ms>.mp4 ao lado do original (vídeo copiado, só o áudio
 * re-encoda — segundos por variante). Assista e escolha; depois sete
 * AV_STATIC_OFFSET_MS (+ AV_STATIC_MATCHES) com o valor vencedor.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function ffmpegBin(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const vendored = path.join(path.resolve('.tools'), exe);
  if (fs.existsSync(vendored)) return vendored;
  return 'ffmpeg';
}

async function main(): Promise<void> {
  const clip = process.argv[2];
  if (!clip || clip.startsWith('--')) {
    console.error('uso: npx tsx scripts/shift-audio.ts <clip.mp4> <ms> [--ms <ms2> ...]');
    process.exit(2);
  }
  if (!fs.existsSync(clip)) {
    console.error(`arquivo não encontrado: ${clip}`);
    process.exit(1);
  }
  const delays: number[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--ms') continue;
    const ms = Number(a);
    if (!Number.isFinite(ms) || ms < 0 || ms > 8000) {
      console.error(`delay inválido (0-8000ms): ${a}`);
      process.exit(2);
    }
    delays.push(Math.round(ms));
  }
  if (delays.length === 0) {
    console.error('informe ao menos um delay em ms');
    process.exit(2);
  }
  const ff = ffmpegBin();
  const ext = path.extname(clip);
  const base = clip.slice(0, -ext.length);
  for (const ms of delays) {
    const out = `${base}_fix${ms}${ext}`;
    await execFileAsync(ff, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', clip,
      '-c:v', 'copy',
      '-af', `adelay=delays=${ms}:all=1`,
      '-c:a', 'aac', '-b:a', '192k',
      out,
    ], { timeout: 300_000 });
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`ok: ${out} (${mb}MB, áudio atrasado ${ms}ms)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
