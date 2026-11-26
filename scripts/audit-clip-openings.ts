/** Auditoria somente leitura do placar nos 10s iniciais dos clipes locais. */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { ocrClipWindow, focusedScoreCrop } from '../src/clipper/clipWindowOcr.js';
import { cropCandidatesForStream } from '../src/clipper/scoreboardSync.js';
import { assessOpeningScoreCoverage } from '../src/clipper/clipWindowAudit.js';
import { readClipSidecar } from '../src/clipper/sidecar.js';

const config = getConfig();
const clipsDir = path.resolve('data/clips');
const clipFolders = fs.readdirSync(clipsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(clipsDir, entry.name));
const totals = { verified: 0, late: 0, unverifiable: 0, missing: 0 };

console.log('status\tclipe\texpectedBefore\texpectedAfter\tobserved\tcrop');
for (const folder of clipFolders) {
  const basename = path.basename(folder);
  const sidecarPath = path.join(folder, `${basename}.json`);
  const sidecar = readClipSidecar(sidecarPath);
  if (!sidecar) {
    totals.missing++;
    console.log(`missing\t${basename}\t-\t-\t-\t-`);
    continue;
  }
  const video = sidecar.clip.file ? path.join(folder, sidecar.clip.file) : '';
  if (!video || !fs.existsSync(video) || !sidecar.round.scoreBefore || !sidecar.round.scoreAfter) {
    totals.missing++;
    console.log(`missing\t${basename}\t${sidecar.round.scoreBefore ?? '-'}\t${sidecar.round.scoreAfter ?? '-'}\t-\t-`);
    continue;
  }
  const broadCrop = cropCandidatesForStream({
    globalCrop: config.CLIP_SCOREBOARD_CROP,
    byStream: config.CLIP_SCOREBOARD_CROP_BY_STREAM,
    streamName: sidecar.clip.streamName ?? undefined,
    fallbacks: config.CLIP_SCOREBOARD_CROP_FALLBACKS,
  })[0];
  const crop = focusedScoreCrop(broadCrop) ?? broadCrop;
  const ocr = await ocrClipWindow({
    file: video,
    killfeedCrop: null,
    replayCrop: null,
    scoreboardCrop: crop,
    kills: [],
    fromSec: 0,
    toSec: 10,
    sampleFps: 1,
  });
  const result = assessOpeningScoreCoverage({
    expectedBefore: sidecar.round.scoreBefore,
    expectedAfter: sidecar.round.scoreAfter,
    observations: ocr.scoreboard ?? [],
    error: ocr.error,
  });
  totals[result.status]++;
  console.log(`${result.status}\t${basename}\t${sidecar.round.scoreBefore}\t${sidecar.round.scoreAfter}\t${result.observedScores.join(',') || '-'}\t${crop}`);
}
console.log(`TOTALS\tverified=${totals.verified}\tlate=${totals.late}\tunverifiable=${totals.unverifiable}\tmissing=${totals.missing}`);
