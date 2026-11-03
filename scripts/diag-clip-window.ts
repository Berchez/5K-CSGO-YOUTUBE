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
  trustedRoundEndVideoMs,
} from '../src/clipper/clipWindowAudit.js';
import { ocrClipWindow, summarizeKillfeedOcr } from '../src/clipper/clipWindowOcr.js';
import type { KillEvent } from '../src/types.js';

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

interface Sidecar {
  matchId?: string;
  map?: string;
  round?: number;
  player?: string;
  clipFile?: string;
  kills?: KillEvent[];
  clipStartMs?: number;
  clipDurationSec?: number;
  startLatencyMs?: number;
  endLatencyMs?: number;
  estimatedStartLatencyMs?: number;
  latencySource?: string;
  /** Fim do round rejeitado pelos anchors (implausível). */
  ocrEndRejected?: boolean | null;
  streamSync?: {
    startLatencyMs?: number | null;
    endLatencyMs?: number | null;
    estimatedStartLatencyMs?: number | null;
    latencySource?: string | null;
    /** Âncora do killfeed: instante no vídeo da 1ª kill. */
    killfeedFirstKillVideoMs?: number | null;
    /** Motivo da medição do killfeed. */
    killfeedReason?: string | null;
    /** Crop do killfeed que leu a linha. */
    killfeedCrop?: string | null;
    /** Leituras do killfeed descartadas por serem reexibição. */
    killfeedReplayReads?: number | null;
    /** Fim do round no VÍDEO (ISO 8601) — medido pelo placar. */
    roundEndAt?: string | null;
    /** Motivo da medição do placar (confident/after-only/gap-inferred). */
    reason?: string | null;
    /** De onde veio a âncora que abriu o clipe. */
    anchorSource?: string | null;
  };
  /** Auditoria da janela gravada pelo bot. */
  clipWindowAudit?: {
    action?: string;
    violations?: string[];
    reason?: string;
  };
  /** Início do material mais antigo disponível quando o clipe foi feito. */
  bufferOldestMs?: number | null;
}

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
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
  const folder = path.dirname(sidecarPath);
  const video = path.join(folder, sidecar.clipFile ?? path.basename(sidecarPath).replace(/\.json$/, '.mp4'));
  const sync = sidecar.streamSync ?? {};
  const kills = sidecar.kills ?? [];

  /**
   * Fim do round CONFIAVEL: só `confident` (placar com o antes e o
   * depois legíveis) serve — `after-only` e `gap-inferred` não são
   * medida do fim do round (o `gap-inferred` é um limite INFERIDO).
   */
  const roundEndVideoMs = trustedRoundEndVideoMs({
    reason: sync.reason,
    roundEndAt: sync.roundEndAt,
    ocrEndRejected: sidecar.ocrEndRejected,
  });
  const roundEndRaw = sync.roundEndAt != null ? Date.parse(sync.roundEndAt) : null;

  const verdict = auditClipWindow({
    kills,
    clipStartMs: sidecar.clipStartMs ?? null,
    clipDurationSec: sidecar.clipDurationSec ?? null,
    startLatencyMs: sidecar.startLatencyMs ?? sync.startLatencyMs ?? null,
    estimatedStartLatencyMs: sidecar.estimatedStartLatencyMs ?? sync.estimatedStartLatencyMs ?? null,
    endLatencyMs: sidecar.endLatencyMs ?? sync.endLatencyMs ?? null,
    latencySource: sidecar.latencySource ?? sync.latencySource ?? null,
    scoreboardDelayMs: SCOREBOARD_DELAY_MS,
    killfeedFirstKillVideoMs: sync.killfeedFirstKillVideoMs ?? null,
    killfeedReason: sync.killfeedReason ?? null,
    roundEndVideoMs,
    bufferOldestMs: sidecar.bufferOldestMs ?? null,
    killsSpreadMaxMs: Number(process.env.CLIP_KILLS_SPREAD_MAX_SEC ?? 120) * 1000,
    killsGapMaxMs: Number(process.env.CLIP_KILLS_GAP_MAX_SEC ?? 90) * 1000,
  });

  console.log('='.repeat(78));
  console.log(`${path.basename(folder)}  (${sidecar.matchId ?? '?'} ${sidecar.map ?? '?'} r${sidecar.round ?? '?'} ${sidecar.player ?? '?'})`);
  console.log('-'.repeat(78));
  console.log(
    `kills            : ${kills.length} (spread ${Math.round((killSpreadMs(kills) ?? 0) / 1000)}s, maior intervalo ${Math.round((killMaxGapMs(kills) ?? 0) / 1000)}s)`,
  );
  console.log(`latência         : ${Math.round((sidecar.startLatencyMs ?? 0) / 1000)}s aplicada, ${Math.round((sidecar.estimatedStartLatencyMs ?? 0) / 1000)}s estimada, fonte=${sidecar.latencySource ?? sync.latencySource ?? '?'}`);
  console.log(`clipe            : ${iso(sidecar.clipStartMs)} → +${Math.round(sidecar.clipDurationSec ?? 0)}s (fim ${iso((sidecar.clipStartMs ?? 0) + (sidecar.clipDurationSec ?? 0) * 1000)})`);
  console.log(`1ª kill esperada : ${iso(verdict.expectedFirstKillVideoMs)}   última: ${iso(verdict.expectedLastKillVideoMs)}`);
  console.log(`killfeed         : âncora ${iso(sync.killfeedFirstKillVideoMs)} motivo=${sync.killfeedReason ?? '—'} replay lidos=${sync.killfeedReplayReads ?? '—'}`);
  console.log(`âncora do corte  : ${sync.anchorSource ?? '—'}`);
  console.log(
    `fim do round     : ${iso(roundEndVideoMs)}${roundEndVideoMs == null && roundEndRaw != null ? ` (medido: ${iso(roundEndRaw)}, motivo=${sync.reason ?? '—'} — NÃO confiável para descarte)` : ` (motivo=${sync.reason ?? '—'})`}`,
  );
  console.log(`material antigo  : ${iso(sidecar.bufferOldestMs)}`);
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
  if (sync.killfeedFirstKillVideoMs == null && sync.roundEndAt == null) {
    console.log(
      'atenção          : sidecar sem evidência de janela (gerado antes das correções) — o veredito é inconclusivo; use --ocr',
    );
  }

  if (wantOcr && fs.existsSync(video)) {
    const crop = sync.killfeedCrop ?? DEFAULT_KILLFEED_CROP;
    const ocr = await ocrClipWindow({
      file: video,
      killfeedCrop: crop,
      replayCrop: DEFAULT_REPLAY_CROP,
      kills,
    });
    console.log(`OCR              : ${summarizeKillfeedOcr(ocr)} (crop ${crop})`);
    for (const hit of ocr.hits) {
      const absolute = (sidecar.clipStartMs ?? 0) + hit.atSec * 1000;
      console.log(`   t=${hit.atSec}s (${iso(absolute)}) kills#${hit.killIndexes.map((i) => i + 1).join(',')} | ${hit.text}`);
    }
    if (ocr.hits.length > 0) {
      const first = ocr.hits[0];
      const firstAt = (sidecar.clipStartMs ?? 0) + first.atSec * 1000;
      const beforeFirst = verdict.expectedFirstKillVideoMs != null ? firstAt <= verdict.expectedFirstKillVideoMs + 15_000 : null;
      console.log(
        `   leitura       : 1ª linha do ace em ${iso(firstAt)} (${beforeFirst === true ? 'dentro da janela esperada' : beforeFirst === false ? 'TARDE para a janela esperada' : 'janela estimada desconhecida'})`,
      );
    }
    if (ocr.replayAtSec.length > 0) {
      console.log(
        `   REPLAY        : banner visto em ${ocr.replayAtSec.map((sec) => `${sec.toFixed(1)}s`).join(', ')} — o clipe abre DENTRO de uma reexibição`,
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
