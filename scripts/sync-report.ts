/**
 * Relatório de SINCRONIZAÇÃO: como a latência da stream varia por canal
 * e por round.
 *
 * A latência da stream gravada NÃO é constante (pausa do streamer,
 * buffering, catch-up, restart da fonte). Um valor fixo por canal erra
 * dezenas de segundos — e o erro do INÍCIO é o pior: a 1ª kill fica
 * fora do clipe. Este script mostra a MEDIDA de cada round (o que o
 * bot registrou), a variação dentro do canal e a taxa de acerto do OCR
 * do placar (o sensor da medição).
 *
 * Uso:
 *   npx tsx scripts/sync-report.ts [--log logs/bot.log] [--state data/stream-latency.json]
 *
 * Saída: por canal, o número de medições, min/mediana/max, o maior
 * salto entre rounds consecutivos e a taxa de leitura do placar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

export interface Sample {
  at: number;
  stream: string;
  latencyMs: number;
  matchId?: string;
  round?: number;
  /** 'timer-hltv' (fim real) ou 'estimada' (detecção − atraso do placar). */
  reference?: string;
  /** De onde veio a amostra (log do bot ou estado persistido). */
  origem?: string;
}

/** Chave canônica do canal (mesma regra do estado persistido). */
export function normalizeStream(stream: string): string {
  return stream.trim().toLowerCase() || 'desconhecida';
}

/**
 * Duas medições são a MESMA quando o canal, o valor e o instante batem.
 * O log e o estado gravam a mesma medição em momentos ligeiramente
 * diferentes (o log acontece depois da calibração do killfeed), por
 * isso a comparação é por janela — sem isso a amostra do round seria
 * contada duas vezes.
 */
const DEDUPE_MAX_LATENCY_DIFF_MS = 1_000;
const DEDUPE_MAX_TIME_DIFF_MS = 20 * 60_000;

/**
 * Junta as medições do log com as do estado persistido, normalizando o
 * canal e removendo as duplicatas entre as duas fontes. O log vence
 * (carrega mais contexto: partida, round, referência do fim do round).
 */
export function mergeMeasurements(logSamples: Sample[], stateSamples: Sample[]): Sample[] {
  const merged: Sample[] = logSamples.map((sample) => ({
    ...sample,
    stream: normalizeStream(sample.stream),
    origem: 'log',
  }));
  for (const sample of stateSamples) {
    const stream = normalizeStream(sample.stream);
    const duplicate = merged.some(
      (entry) =>
        entry.origem === 'log' &&
        entry.stream === stream &&
        Math.abs(entry.latencyMs - sample.latencyMs) <= DEDUPE_MAX_LATENCY_DIFF_MS &&
        Math.abs(entry.at - sample.at) <= DEDUPE_MAX_TIME_DIFF_MS,
    );
    if (!duplicate) merged.push({ ...sample, stream, origem: 'estado' });
  }
  return merged;
}

interface OcrOutcome {
  at: number;
  stream: string;
  ok: boolean;
  reason: string;
}

/** Salto do relógio de origem (aumento do atraso detectado sem OCR). */
interface OriginShift {
  at: number;
  stream: string;
  shiftSec: number;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function readLog(file: string): { samples: Sample[]; ocr: OcrOutcome[]; shifts: OriginShift[] } {
  const samples: Sample[] = [];
  const ocr: OcrOutcome[] = [];
  const shifts: OriginShift[] = [];
  if (!fs.existsSync(file)) return { samples, ocr, shifts };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    // BOM no começo do arquivo (ou da 1ª linha) quebraria o 1º registro.
    const line = raw.replace(/^\uFEFF/, '');
    if (!line.trim().startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = String(entry.msg ?? '');
    const stream = normalizeStream(String(entry.stream ?? 'desconhecida'));
    const at = Number(entry.time ?? 0);
    if (msg.includes('latência observada da stream')) {
      const latency = Number(entry.latenciaObservadaMs);
      if (!Number.isFinite(latency)) continue;
      samples.push({
        at,
        stream,
        latencyMs: latency,
        matchId: entry.matchId == null ? undefined : String(entry.matchId),
        round: entry.round == null ? undefined : Number(entry.round),
        reference: entry.referenciaFimRound == null ? undefined : String(entry.referenciaFimRound),
      });
    } else if (msg.includes('salto no relógio de origem')) {
      const shiftSec = Number(entry.shiftSec);
      if (!Number.isFinite(shiftSec)) continue;
      shifts.push({ at, stream, shiftSec });
    } else if (msg.includes('ancorado no placar do vídeo')) {
      ocr.push({ at, stream, ok: true, reason: String(entry.reason ?? '') });
    } else if (msg.includes('placar do round não aplicado')) {
      ocr.push({ at, stream, ok: false, reason: String(entry.reason ?? '') });
    }
  }
  return { samples, ocr, shifts };
}

function readState(file: string): { stream: string; latencyMs: number; at: number; reference?: string }[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      streams?: Record<
        string,
        {
          samples?: {
            measuredAtMs?: number;
            latencyMs?: number;
            reference?: string;
          }[];
        }
      >;
    };
    const out: { stream: string; latencyMs: number; at: number; reference?: string }[] = [];
    for (const [stream, entry] of Object.entries(parsed.streams ?? {})) {
      for (const sample of entry.samples ?? []) {
        const latencyMs = Number(sample.latencyMs);
        const at = Number(sample.measuredAtMs);
        if (!Number.isFinite(latencyMs) || !Number.isFinite(at)) continue;
        out.push({
          stream: normalizeStream(stream),
          latencyMs,
          at,
          reference:
            sample.reference === 'timer-hltv' || sample.reference === 'estimada'
              ? sample.reference
              : undefined,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function main(): void {
  const logFile = path.resolve(arg('log', 'logs/bot.log') ?? 'logs/bot.log');
  const stateFile = path.resolve(arg('state', 'data/stream-latency.json') ?? 'data/stream-latency.json');
  const { samples, ocr, shifts } = readLog(logFile);
  const state = readState(stateFile);

  const all = mergeMeasurements(samples, state);
  if (all.length === 0) {
    console.log(`sem medições: nem ${logFile} nem ${stateFile} têm dados de latência`);
    console.log('o bot só passa a medir quando o OCR acha a virada do placar no vídeo (CLIP_STREAM_SYNC=auto|log)');
    return;
  }

  const byStream = new Map<string, typeof all>();
  for (const sample of all) {
    const list = byStream.get(sample.stream) ?? [];
    list.push(sample);
    byStream.set(sample.stream, list);
  }

  console.log(`latência observada por canal (${all.length} medições)\n`);
  for (const [stream, list] of [...byStream].sort()) {
    const values = list.map((s) => s.latencyMs).sort((a, b) => a - b);
    const ordered = [...list].sort((a, b) => a.at - b.at);
    let biggestJump = 0;
    for (let i = 1; i < ordered.length; i++) {
      const jump = Math.abs(ordered[i].latencyMs - ordered[i - 1].latencyMs);
      if (jump > biggestJump) biggestJump = jump;
    }
    const outcomes = ocr.filter((o) => o.stream === stream);
    const ok = outcomes.filter((o) => o.ok).length;
    const reasons = new Map<string, number>();
    for (const outcome of outcomes.filter((o) => !o.ok)) {
      reasons.set(outcome.reason, (reasons.get(outcome.reason) ?? 0) + 1);
    }
    const channelShifts = shifts.filter((shift) => shift.stream === stream);
    console.log(
      `${stream}: n=${values.length} min=${(values[0] / 1000).toFixed(1)}s ` +
        `med=${(median(values) / 1000).toFixed(1)}s max=${(values[values.length - 1] / 1000).toFixed(1)}s ` +
        `saltoMaior=${(biggestJump / 1000).toFixed(1)}s`,
    );
    if (outcomes.length > 0) {
      const falhas = [...reasons].map(([motivo, n]) => `${motivo}=${n}`).join(' ');
      console.log(
        `  OCR do placar: ${ok}/${outcomes.length} leituras` + (falhas ? ` (falhas: ${falhas})` : ''),
      );
    }
    if (channelShifts.length > 0) {
      const total = channelShifts.reduce((acc, shift) => acc + shift.shiftSec, 0);
      console.log(
        `  saltos do relógio de origem: ${channelShifts.length} (+${total.toFixed(1)}s de atraso)`,
      );
    }
    const comTimer = list.filter((s) => s.reference === 'timer-hltv').length;
    if (comTimer > 0) {
      console.log(
        `  referência do fim do round: ${comTimer}/${list.length} pelo timer real do HLTV` +
          `${comTimer < list.length ? ` (${list.length - comTimer} pela estimativa)` : ''}`,
      );
    }
  }

  const configRaw = process.env.CLIP_STREAM_LATENCY_MS?.trim();
  const config = configRaw ? Number(configRaw) : NaN;
  if (configRaw && Number.isFinite(config)) {
    console.log(`\nconfigurado: CLIP_STREAM_LATENCY_MS=${(config / 1000).toFixed(1)}s`);
    for (const [stream, list] of byStream) {
      const med = median(list.map((s) => s.latencyMs));
      const diff = (med - config) / 1000;
      if (Math.abs(diff) > 5) {
        console.log(`  ${stream}: mediana ${(med / 1000).toFixed(1)}s (${diff > 0 ? '+' : ''}${diff.toFixed(1)}s do configurado)`);
      }
    }
  }
}

const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
