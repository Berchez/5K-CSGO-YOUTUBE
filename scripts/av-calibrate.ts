/**
 * Calibra o offset A/V de um canal (stream) a partir de julgamento humano.
 *
 * Fluxo:
 *   1. npm run fix:av -- <clipe.mp4> 1500 --ms 2000 --ms 2500  (variantes)
 *   2. assista e escolha o delay vencedor
 *   3. npx tsx scripts/av-calibrate.ts --stream "ESL TV" --ms 2000 --by fix20-Umar-r12
 *   4. clipes seguintes do canal saem corrigidos sozinhos; restart do
 *      transcode invalida (offsetUnverified) até recalibrar
 *
 * Uso:
 *   npx tsx scripts/av-calibrate.ts --stream <nome> --ms <0-8000> [--by <texto>]
 *   npx tsx scripts/av-calibrate.ts --clear --stream <nome>
 *   npx tsx scripts/av-calibrate.ts --list
 */
import {
  clearCalibration,
  loadCalibrations,
  saveCalibration,
} from '../src/recorder/avCalibration.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    const store = loadCalibrations();
    const keys = Object.keys(store);
    if (keys.length === 0) {
      console.log('sem calibragens.');
      return;
    }
    for (const k of keys) {
      const c = store[k];
      console.log(`${k}: ${c.offsetMs}ms desde ${new Date(c.calibratedAt).toISOString()}${c.by ? ` (${c.by})` : ''}`);
    }
    return;
  }
  const stream = arg('stream');
  if (!stream) {
    console.error('uso: av-calibrate --stream <nome> --ms <0-8000> [--by <texto>] | --clear --stream <nome> | --list');
    process.exit(2);
  }
  if (process.argv.includes('--clear')) {
    console.log(clearCalibration(stream) ? `calibragem de "${stream}" removida.` : `"${stream}" não tinha calibragem.`);
    return;
  }
  const ms = Number(arg('ms'));
  if (!Number.isFinite(ms) || ms < 0 || ms > 8000) {
    console.error('ms inválido (0-8000). Para desligar um canal, use --clear.');
    process.exit(2);
  }
  saveCalibration(stream, Math.round(ms), { by: arg('by') });
  console.log(`"${stream}" calibrado em ${Math.round(ms)}ms. Vale para a sessão corrente sem restart desde agora.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
