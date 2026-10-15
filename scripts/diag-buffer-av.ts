/**
 * Diagnóstico A/V do buffer: varre seg_*.ts e mostra, por segmento, se as
 * trilhas de áudio e vídeo estão alinhadas em CONTEÚDO (não só container).
 *
 * Uso:
 *   npx tsx scripts/diag-buffer-av.ts <bufferDir|matchId> [--slot 10]
 *   npx tsx scripts/diag-buffer-av.ts data/buffer/2399533
 *   npx tsx scripts/diag-buffer-av.ts 2399533        (atalho p/ data/buffer/<id>)
 *   npx tsx scripts/diag-buffer-av.ts data/buffer    (varre todas as partidas)
 *
 * Colunas: kind = ok | short | mismatch | stall | pts-jump | starved | unreadable
 *   starved  = taxa de pacotes colapsada (input travado: 120 frames em 145s)
 *   stall    = gap > 1s numa trilha (imagem congela, áudio anda)
 *   pts-jump = span absurdo (fonte reiniciou/descontinuidade: ads, transcode)
 *   mismatch = trilhas com tamanhos/aberturas diferentes
 *   short    = segmento de abertura com pouco conteúdo (normal nos 1ºs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifySegmentAv, median, probeConcatSpan, probeSegmentPackets, resolveFfprobeBin, slopePerStep, type SegmentAvIssue } from '../src/clipper/segmentProbe.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

function resolveDirs(target: string): string[] {
  const asIs = path.resolve(target);
  if (fs.existsSync(asIs) && fs.statSync(asIs).isDirectory()) {
    const segs = fs.readdirSync(asIs).filter((f) => /^seg_\d+\.ts$/.test(f));
    if (segs.length > 0) return [asIs];
    // Diretório pai (ex: data/buffer): varre subdirs com segmentos.
    const kids = fs.readdirSync(asIs)
      .map((k) => path.join(asIs, k))
      .filter((k) => {
        try {
          return fs.statSync(k).isDirectory() &&
            fs.readdirSync(k).some((f) => /^seg_\d+\.ts$/.test(f));
        } catch {
          return false;
        }
      });
    if (kids.length > 0) return kids;
  }
  // Atalho: matchId -> data/buffer/<id>
  const byId = path.resolve('data', 'buffer', target);
  if (fs.existsSync(byId) && fs.statSync(byId).isDirectory()) return [byId];
  return [];
}

function listSegs(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => /^seg_\d+\.ts$/.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => {
      try {
        return fs.statSync(f).size > 50_000;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target.startsWith('--')) {
    console.error('uso: npx tsx scripts/diag-buffer-av.ts <bufferDir|matchId> [--slot 10]');
    process.exit(2);
  }
  const slot = Number(arg('slot', '10'));
  const ffprobeNullable = resolveFfprobeBin();
  if (!ffprobeNullable) {
    console.error('ffprobe não encontrado (nem em .tools/ nem no PATH).');
    process.exit(2);
  }
  // Narrowing de const não atravessa closures no TS: fixa o tipo.
  const ffprobe: string = ffprobeNullable;
  const dirs = resolveDirs(target);
  if (dirs.length === 0) {
    console.error(`nada para inspecionar em: ${target}`);
    process.exit(1);
  }

  const CONCURRENCY = 4;
  let bad = 0;
  for (const dir of dirs) {
    const segs = listSegs(dir);
    if (segs.length === 0) continue;
    console.log(`\n== ${dir} (${segs.length} segmentos, slot=${slot}s) ==`);
    console.log('seg          kind       vSpan   aSpan   vGap    aGap    vPkts aPkts startΔ');
    const results: Array<{ seg: string; issue: SegmentAvIssue | null; delta: number }> =
      new Array(segs.length).fill(null).map(() => ({ seg: '', issue: null as SegmentAvIssue | null, delta: NaN }));
    let next = 0;
    async function worker(): Promise<void> {
      while (next < segs.length) {
        const i = next++;
        const seg = path.basename(segs[i]);
        try {
          const pkts = await probeSegmentPackets(segs[i], ffprobe);
          if (!pkts) {
            results[i] = { seg, issue: null, delta: NaN };
            continue;
          }
          const verdict = classifySegmentAv(pkts.video, pkts.audio, slot);
          const v0 = Math.min(...pkts.video);
          const a0 = Math.min(...pkts.audio);
          const delta = Number.isFinite(v0) && Number.isFinite(a0) ? v0 - a0 : NaN;
          results[i] = {
            seg,
            issue: verdict ? { file: seg, ...verdict } : null,
            delta,
          };
        } catch {
          results[i] = { seg, issue: null, delta: NaN };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, () => worker()));

    const deltas: number[] = [];
    const kinds: Record<string, number> = {};
    for (const { seg, issue, delta } of results) {
      if (Number.isFinite(delta)) deltas.push(delta);
      const k = issue?.kind ?? 'ok';
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (issue) {
        bad++;
        const f = (n: number | undefined) => (n ?? 0).toFixed(2).padStart(7);
        console.log(
          `${seg.padEnd(12)} ${k.padEnd(10)} ${f(issue.videoSec)}${f(issue.audioSec)}${f(issue.videoGapMaxSec)}${f(issue.audioGapMaxSec)}` +
          `${String(issue.videoCount ?? 0).padStart(6)}${String(issue.audioCount ?? 0).padStart(6)}${f(issue.startDeltaSec)}`,
        );
      } else {
        console.log(`${seg.padEnd(12)} ok`);
      }
    }
    const counted = Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' ');
    let spanTxt = 'concatSpan=n/a';
    try {
      const span = await probeConcatSpan(segs, ffprobe, slot);
      if (span) spanTxt = `concatSpan=${span.spanSec}s(${span.reliable ? 'ok' : 'NÃO-CONFIÁVEL'}) vs ${segs.length * slot}s esperados`;
    } catch {
      // segue sem span
    }
    console.log(`-- resumo: ${counted} | ${spanTxt} | startΔ mediano=${Number.isNaN(median(deltas)) ? 'n/a' : median(deltas).toFixed(2) + 's'} | drift=${slopePerStep(deltas).toFixed(3)}s/seg`);
  }
  console.log(bad === 0 ? '\nOK: nenhum segmento com problema.' : `\n${bad} segmento(s) com problema (detalhe acima).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
