/**
 * DIAGNÓSTICO DA JANELA DO CLIPE.
 *
 * Responde, para um clipe já renderizado: "a janela está certa?".
 *
 * É a ferramenta que faltava: até agora cada vez que a janela saiu
 * errada a gente olhava o vídeo na mão e a leitura dos logs — sem uma
 * medição repetível, cada "corrigi" era um palpite. Aqui:
 *
 * 1. lê o sidecar (kills, âncoras, latências, origem);
 * 2. confere as INVARIANTES da janela (abre antes da 1ª kill? fecha
 *    depois da última? a lista de kills é de um round só? o clipe abre
 *    depois do fim do round?);
 * 3. com `--ocr`, lê o killfeed do próprio MP4 (ffmpeg em pipe +
 *    tesseract, sem escrever arquivo) e diz EM QUE SEGUNDO cada kill do
 *    ace aparece no clipe — é o que separa "round ao vivo" de "replay"
 *    (o replay reaparece o killfeed). O banner "REPLAY" é lido no
 *    mesmo passe;
 * 4. imprime o veredito e a ação sugerida (publicar / descartar /
 *    publicar marcado como replay).
 *
 * A MEDIÇÃO é o MESMO código do bot (`clipWindowOcr.ts`, com o mesmo
 * pré-processamento) — um OCR diferente mediria outra coisa.
 *
 * Uso:
 *   npx tsx scripts/diag-clip-window.ts data/clips/2399858_Mirage_r15_makazze
 *   npx tsx scripts/diag-clip-window.ts --match 2399858 --ocr
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  auditClipWindow,
  killMaxGapMs,
  killSpreadMs,
  replayStartsWithinOpening,
  trustedRoundEndVideoMs,
} from '../src/clipper/clipWindowAudit.js';
import { ocrClipWindow, summarizeKillfeedOcr } from '../src/clipper/clipWindowOcr.js';
import { readClipSidecar, sidecarToAce } from '../src/clipper/sidecar.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return undefined;
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const CLIPS_DIR = arg('clips') ?? path.join('data', 'clips');
/** Crop do killfeed usado quando o sidecar não registra um. */
const DEFAULT_KILLFEED_CROP = '0.70:0.05:0.30:0.25';
/** Crop do banner "REPLAY" (mesmo default do bot). */
const DEFAULT_REPLAY_CROP = '0.00:0.00:0.35:0.10';
/** Atraso do placar (ms) — o `at` da kill é o instante do poll. */
const SCOREBOARD_DELAY_MS = Number(process.env.SCOREBOARD_DELAY_MS ?? 5_000);

/** Data segura (valor inválido não derruba o diagnóstico). */
const iso = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
};

function findSidecars(matchId?: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(CLIPS_DIR)) return out;
  for (const name of fs.readdirSync(CLIPS_DIR)) {
    const folder = path.join(CLIPS_DIR, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folder);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const json = path.join(folder, `${name}.json`);
    if (!fs.existsSync(json)) continue;
    if (matchId != null && !name.includes(matchId)) continue;
    out.push(json);
  }
  return out.sort();
}

async function auditOne(sidecarPath: string, wantOcr: boolean): Promise<void> {
  const sidecar = readClipSidecar(sidecarPath);
  if (!sidecar) {
    console.error(`sidecar inválido: ${sidecarPath}`);
    return;
  }
  const folder = path.dirname(sidecarPath);
  const video = path.join(
    folder,
    sidecar.clip.file ?? path.basename(sidecarPath).replace(/\.json$/, '.mp4'),
  );
  const sync = sidecar.sync;
  const kills = sidecarToAce(sidecar).kills;
  const clipStartMs = sidecar.clip.startMs;
  const clipDurationSec = sidecar.clip.durationSec;
  const startLatencyMs = sync?.latency.startMs ?? null;
  const estimatedStartLatencyMs = sync?.latency.estimatedStartMs ?? null;
  const endLatencyMs = sync?.latency.endMs ?? null;
  const latencySource = sync?.latency.source ?? null;
  const killfeedFirstKillVideoMs = sync?.killfeed.firstKillVideoMs ?? null;
  const killfeedReason = sync?.killfeed.reason ?? null;
  const killfeedCrop = sync?.killfeed.crop ?? null;
  const killfeedReplayReads = sync?.killfeed.replayReads ?? null;
  const roundEndAt = sync?.roundEndAt ?? null;
  const roundEndReason = sync?.reason ?? null;
  const ocrEndRejected = sidecar.window?.end.ocrRejected ?? null;
  const bufferOldestMs = sidecar.window?.bufferOldestMs ?? null;

  /**
   * Fim do round CONFIAVEL: só `confident` (placar com o antes e o
   * depois legíveis) serve — `after-only` e `gap-inferred` não são
   * medida do fim do round (o `gap-inferred` é um limite INFERIDO).
   */
  const roundEndVideoMs = trustedRoundEndVideoMs({
    reason: roundEndReason,
    roundEndAt,
    ocrEndRejected,
  });
  const roundEndRaw = roundEndAt != null ? Date.parse(roundEndAt) : null;

  const verdict = auditClipWindow({
    kills,
    clipStartMs,
    clipDurationSec,
    startLatencyMs,
    estimatedStartLatencyMs,
    endLatencyMs,
    latencySource,
    scoreboardDelayMs: SCOREBOARD_DELAY_MS,
    killfeedFirstKillVideoMs,
    killfeedReason,
    roundEndVideoMs,
    bufferOldestMs,
    killsSpreadMaxMs: Number(process.env.CLIP_KILLS_SPREAD_MAX_SEC ?? 120) * 1000,
    killsGapMaxMs: Number(process.env.CLIP_KILLS_GAP_MAX_SEC ?? 90) * 1000,
  });

  console.log('='.repeat(78));
  console.log(`${path.basename(folder)}  (${sidecar.match.id || '?'} ${sidecar.round.map || '?'} r${sidecar.round.number || '?'} ${sidecar.player.name || '?'})`);
  console.log('-'.repeat(78));
  console.log(
    `kills            : ${kills.length} (spread ${Math.round((killSpreadMs(kills) ?? 0) / 1000)}s, maior intervalo ${Math.round((killMaxGapMs(kills) ?? 0) / 1000)}s)`,
  );
  console.log(`latência         : ${Math.round((startLatencyMs ?? 0) / 1000)}s aplicada, ${Math.round((estimatedStartLatencyMs ?? 0) / 1000)}s estimada, fonte=${latencySource ?? '?'}`);
  console.log(`clipe            : ${iso(clipStartMs)} → +${Math.round(clipDurationSec ?? 0)}s (fim ${iso((clipStartMs ?? 0) + (clipDurationSec ?? 0) * 1000)})`);
  console.log(`1ª kill esperada : ${iso(verdict.expectedFirstKillVideoMs)}   última: ${iso(verdict.expectedLastKillVideoMs)}`);
  console.log(`killfeed         : âncora ${iso(killfeedFirstKillVideoMs)} motivo=${killfeedReason ?? '—'} replay lidos=${killfeedReplayReads ?? '—'}`);
  console.log(`âncora do corte  : ${sync?.anchorSource ?? '—'}`);
  console.log(
    `fim do round     : ${iso(roundEndVideoMs)}${roundEndVideoMs == null && roundEndRaw != null ? ` (medido: ${iso(roundEndRaw)}, motivo=${roundEndReason ?? '—'} — NÃO confiável para descarte)` : ` (motivo=${roundEndReason ?? '—'})`}`,
  );
  console.log(`material antigo  : ${iso(bufferOldestMs)}`);
  console.log(
    `invariantes      : 1ª kill dentro=${verdict.coversFirstKill}  última dentro=${verdict.coversLastKill}  abre após fim do round=${verdict.startsAfterRoundEnd}  material ao vivo=${verdict.liveMaterialAvailable}`,
  );
  console.log(`violações        : ${verdict.violations.length > 0 ? verdict.violations.join(', ') : 'nenhuma'}`);
  console.log(`veredito         : ${verdict.action.toUpperCase()}`);
  /**
   * Sidecar antigo (gerado antes das correções da janela): sem a âncora
   * do killfeed e sem o fim do round medido, o veredito é
   * INCONCLUSIVO — "OK" aqui só quer dizer "não há violação visível".
   */
  if (killfeedFirstKillVideoMs == null && roundEndAt == null) {
    console.log(
      'atenção          : sidecar sem evidência de janela (gerado antes das correções) — o veredito é inconclusivo; use --ocr',
    );
  }

  if (wantOcr && fs.existsSync(video)) {
    const crop = killfeedCrop ?? DEFAULT_KILLFEED_CROP;
    const ocr = await ocrClipWindow({
      file: video,
      killfeedCrop: crop,
      replayCrop: DEFAULT_REPLAY_CROP,
      kills,
    });
    console.log(`OCR              : ${summarizeKillfeedOcr(ocr)} (crop ${crop})`);
    for (const hit of ocr.hits) {
      const absolute = (clipStartMs ?? 0) + hit.atSec * 1000;
      console.log(`   t=${hit.atSec}s (${iso(absolute)}) kills#${hit.killIndexes.map((i) => i + 1).join(',')} | ${hit.text}`);
    }
    if (ocr.hits.length > 0) {
      const first = ocr.hits[0];
      const firstAt = (clipStartMs ?? 0) + first.atSec * 1000;
      const beforeFirst = verdict.expectedFirstKillVideoMs != null ? firstAt <= verdict.expectedFirstKillVideoMs + 15_000 : null;
      console.log(
        `   leitura       : 1ª linha do ace em ${iso(firstAt)} (${beforeFirst === true ? 'dentro da janela esperada' : beforeFirst === false ? 'TARDE para a janela esperada' : 'janela estimada desconhecida'})`,
      );
    }
    if (ocr.replayAtSec.length > 0) {
      const opensInsideReplay = replayStartsWithinOpening(ocr.replayAtSec);
      console.log(
        `   REPLAY        : banner visto em ${ocr.replayAtSec.map((sec) => `${sec.toFixed(1)}s`).join(', ')} — ${opensInsideReplay ? 'abertura dentro de uma reexibição' : 'banner posterior; abertura fora do replay detectado'}`,
      );
    }
  } else if (wantOcr) {
    console.log('OCR              : vídeo não encontrado');
  }
}

async function main(): Promise<void> {
  const matchId = arg('match');
  const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  const wantOcr = hasFlag('ocr');

  if (target != null && fs.existsSync(path.join(target, `${path.basename(target)}.json`))) {
    await auditOne(path.join(target, `${path.basename(target)}.json`), wantOcr);
    return;
  }
  if (target != null && fs.existsSync(target) && target.endsWith('.json')) {
    await auditOne(target, wantOcr);
    return;
  }
  const sidecars = findSidecars(matchId);
  if (sidecars.length === 0) {
    console.error(
      `nenhum clipe encontrado (${matchId ? `match ${matchId} ` : ''}em ${CLIPS_DIR}). Use: npx tsx scripts/diag-clip-window.ts data/clips/<pasta> [--ocr]`,
    );
    process.exitCode = 1;
    return;
  }
  for (const sidecar of sidecars) await auditOne(sidecar, wantOcr);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
