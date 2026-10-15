import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AceEvent, ClipResult } from '../types.js';
import { getLogger } from '../logger.js';
import { makeSmartThumbnail, type SmartThumbOptions } from './thumbnail.js';
import { describeAce, killLabel, prettyWeapon } from '../detector/aceDetector.js';
import { killAll, killStale, track, untrack } from '../procRegistry.js';

const execFileAsync = promisify(execFile);

/**
 * execFile com registro no procRegistry: se o Node morrer no meio
 * (restart/crash), o shutdown/exit mata o ffmpeg — sem deixar encode
 * órfão pegando 100% da CPU (Windows não mata filhos sozinho).
 */
function execTracked(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p: ChildProcess = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    track(p);
    p.on('error', reject);
    p.on('exit', (code) => {
      untrack(p);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Fila de render: NO MÁXIMO 1 encode por vez. Cada render é um x264
 * pegando quase toda a CPU — dois simultâneos travam o PC.
 */
let renderQueue: Promise<unknown> = Promise.resolve();
function enqueueRender<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.catch(() => undefined);
  return run;
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export interface ClipOptions {
  bufferDir: string;
  clipsDir: string;
  preRollSec: number;
  postRollSec: number;
  segmentTimeSec: number;
  /** Contexto antes do 1º kill (default 10s). */
  contextSec?: number;
  /** Epoch ms do 1º kill — ancora o início do clipe. Sem ele, usa últimos N. */
  aceStartMs?: number;
  /** Epoch ms do fim do clipe (win panel parcial). Sem ele, usa cauda pós-detect. */
  aceEndMs?: number;
  /**
   * Span REAL do concat em segundos, medido nos segmentos ORIGINAIS (não
   * no snapshot) pelo chamador. Sem ele, assume n × segmentTimeSec — que
   * mente quando um segmento nunca cortou (input faminto: 1 arquivo cobre
   * minutos e o trim ancora fora do material → clipe gigante).
   */
  concatSpanSec?: number;
  /** Upscale p/ 1440 (default no config): força o pipeline VP9/AV1 do YouTube. */
  upscaleHeight?: number;
  /**
   * Auto-sync A/V por conteúdo. 'auto' mede E aplica a compensação;
   * 'log' (default) mede e registra no log/sidecar SEM aplicar — modo
   * diagnóstico; 'off' pula a medição.
   */
  avSync?: 'auto' | 'off' | 'log';
  /** Thumb: default composed; ai tenta fundo IA com fallback. */
  thumb?: SmartThumbOptions;
}

export interface PickOptions {
  segmentTimeSec: number;
  preRollSec: number;
  postRollSec: number;
  contextSec?: number;
  aceStartMs?: number;
  aceEndMs?: number;
}

/**
 * Checa se o ffmpeg consegue abrir o arquivo (cabeçalho/moov íntegro).
 * Lê SÓ o header (~200ms): sem arquivo de saída o ffmpeg sempre sai != 0,
 * então o veredito vem do stderr (tem Duration + Stream #0? tem erro fatal?).
 */
async function isSegmentReadable(file: string): Promise<boolean> {
  const out = await execFileAsync('ffmpeg', ['-hide_banner', '-i', file], { timeout: 15000 })
    .then((r) => String(r.stderr ?? ''))
    .catch((e: unknown) => String((e as { stderr?: unknown }).stderr ?? e));
  if (/moov atom not found|Invalid data found|No such file|does not contain any stream/i.test(out)) {
    return false;
  }
  return /Duration:\s*\d+:\d+/.test(out) && /Stream #0/.test(out);
}

/**
 * ffmpeg p/ inspeção/concat temporário: vendored em .tools/ ou PATH.
 * (O render usa 'ffmpeg' pelo nome pois main.ts prepend .tools no PATH;
 * aqui o caminho explícito evita depender disso em probes/testes.)
 */
export function resolveFfmpegBin(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  try {
    const vendored = path.join(path.resolve('.tools'), exe);
    if (fs.existsSync(vendored)) return vendored;
  } catch {
    // segue p/ PATH
  }
  return 'ffmpeg';
}

export type { ConcatSpan, SegmentAvIssue } from './segmentProbe.js';
export { classifySegmentAv, inspectSegmentAv, probeConcatSpan, probeSegmentPackets, resolveFfprobeBin } from './segmentProbe.js';
import { inspectSegmentAv, resolveFfprobeBin, type SegmentAvIssue } from './segmentProbe.js';

/**
 * Inspeciona A/V de cada segmento SEM decodificar (só cabeçalhos de pacote,
 * ~1-2s por segmento de 10s): span de PTS por trilha + gaps intra-trilha.
 *
 * Por que existe: skew "áudio 2s na frente" com PTS finais alinhados é
 * invisível em start_time/duration de container — mas aparece aqui como
 * trilhas com conteúdos de tamanhos diferentes (ex: vídeo 1.6s + áudio
 * 10s no mesmo slot, ou abertura de vídeo 2s atrasada), stalls (gap > 1s
 * = imagem congelada com áudio andando) ou saltos de PTS (descontinuidade
 * da fonte). Best-effort puro: NUNCA joga erro — warn no log p/
 * diagnóstico, pipeline segue igual.
 */
export async function verifySegmentAv(
  files: string[],
  segmentTimeSec: number,
): Promise<SegmentAvIssue[]> {
  const issues: SegmentAvIssue[] = [];
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return issues;

  // ffprobe em paralelo (4 por vez): 24 segmentos sequenciais somavam
  // segundos no caminho crítico do clipe.
  const CONCURRENCY = 4;
  const slots: Array<SegmentAvIssue | null> = new Array(files.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const i = next++;
      try {
        slots[i] = await inspectSegmentAv(files[i], ffprobe, segmentTimeSec);
      } catch {
        // arquivo ilegível p/ inspeção — sanitize já cuidou da legibilidade
        slots[i] = null;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
  );
  for (const s of slots) if (s) issues.push(s);
  return issues;
}

/**
 * Correlação cruzada normalizada entre envelopes (onsets) de áudio e vídeo.
 * Convenção de sinal: lag POSITIVO = áudio ADIANTADO (é preciso atrasar o
 * áudio desse tanto p/ alinhar). Retorna o lag do pico + proeminência
 * (pico / 2º melhor fora de ±0.5s — sem pico dominante, não há medida).
 * Puro/testável.
 */
export function correlateOffset(
  audioEnv: number[],
  videoEnv: number[],
  sampleHz: number,
  maxLagSec: number,
): { lagSec: number; prominence: number } {
  const n = Math.min(audioEnv.length, videoEnv.length);
  const lags = Math.round(maxLagSec * sampleHz);
  const mean = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
  const ma = mean(audioEnv.slice(0, n));
  const mv = mean(videoEnv.slice(0, n));
  const scored: Array<{ lag: number; corr: number }> = [];
  for (let lag = -lags; lag <= lags; lag++) {
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = i - lag;
      if (j < 0 || j >= n) continue;
      const x = audioEnv[j] - ma;
      const y = videoEnv[i] - mv;
      sxy += x * y;
      sxx += x * x;
      syy += y * y;
      m++;
    }
    // Exige sobreposição majoritária: janelinhas de puro fundo correlacionam
    // 1.0 entre si e elegeriam lag absurdo (ex: −9.1s p/ impulso real em +2s).
    scored.push({ lag, corr: m > Math.max(16, n / 2) && sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : -2 });
  }
  scored.sort((a, b) => b.corr - a.corr);
  const best = scored[0];
  const runner = scored.find((s) => Math.abs(s.lag - best.lag) / sampleHz > 0.5);
  return {
    lagSec: best.lag / sampleHz,
    prominence: runner && runner.corr > 0 ? best.corr / runner.corr : best.corr > 0 ? 99 : 0,
  };
}

export interface AvOffsetResult {
  /** Segundos (áudio adiantado > 0). Só válido com measured=true. */
  offsetSec: number;
  prominence: number;
  measured: boolean;
  reason: string;
  /** Fim REAL do material de áudio na timeline do concat (loud span). */
  audioLenSec?: number;
  /** Fim REAL do material de vídeo na timeline do concat (frames/5). */
  videoLenSec?: number;
}

/**
 * Mede o desalinhamento A/V por CONTEÚDO (não por container — PTS alinhado
 * com conteúdo deslocado é invisível em start_time/duration; caso real com
 * áudio 5s na frente e arquivo "perfeito").
 *
 * Método: envelopes via FILTER_COMPLEX concat — a MESMA semântica de
 * emenda do render. O concat DEMUXER (.ts -c copy) não serve aqui: ele
 * re-timestampa as trilhas com bases diferentes (mp4→ts: vídeo start
 * 1.423s vs áudio 1.400s, áudio truncado) e a medição sai errada —
 * validado no e2e sintético (lag 4.9s medido vs 1.9s real).
 * Áudio: ebur128 (loudness M a ~10Hz) → envelope de onsets.
 * Vídeo: frames 160px a 5fps → diff médio → envelope de onsets.
 * Correlação ±10s. Gate: |δ|≥0.5s, proeminência ≥1.5, |δ|≤10s.
 * Best-effort: qualquer falha retorna measured=false (pipeline segue igual).
 */
export async function measureAvOffset(
  files: string[],
  ffmpegBin: string,
  opts: { sampleHz?: number; maxLagSec?: number } = {},
): Promise<AvOffsetResult> {
  const no = (reason: string): AvOffsetResult => ({ offsetSec: 0, prominence: 0, measured: false, reason });
  const sampleHz = opts.sampleHz ?? 10;
  const maxLagSec = opts.maxLagSec ?? 10;
  if (files.length === 0) return no('sem segmentos');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avoff-'));
  try {
    const inputs: string[] = [];
    for (const f of files) inputs.push('-i', f);
    const nIn = files.length;
    // Pass 1 — envelope de áudio na timeline do render (concat filter).
    const aPads = files.map((_, i) => `[${i}:a]`).join('');
    const aGraph = `${aPads}concat=n=${nIn}:v=0:a=1,ebur128=peak=true:framelog=info[a]`;
    const audioLog = await execFileAsync(
      ffmpegBin,
      ['-hide_banner', ...inputs, '-filter_complex', aGraph, '-map', '[a]', '-f', 'null', '-'],
      // ebur128 framelog emite ~10 linhas/s: clipes longos passam do
      // maxBuffer default de 1MB e a medição falha em silêncio.
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    )
      .then((r) => String(r.stderr ?? ''))
      .catch((e) => String((e as { stderr?: unknown }).stderr ?? e));
    const loud: Array<{ t: number; m: number }> = [];
    for (const line of audioLog.split('\n')) {
      // Silêncio digital vira M: nan / -inf (91 de 141 linhas num clipe de
      // teste!): sem tratar, o envelope carrega a última loudness pela
      // frente e o span termina cedo — correlação degradada.
      const m = line.match(/t:\s*([\d.]+).*?M:\s*(-?[\d.]+|-inf|nan)/);
      if (!m) continue;
      const mv = m[2] === '-inf' || m[2] === 'nan' ? -70 : Number.parseFloat(m[2]);
      loud.push({ t: Number.parseFloat(m[1]), m: mv });
    }
    if (loud.length < 30) return no(`envelope de áudio curto (${loud.length} amostras)`);
    // Pass 2 — envelope de vídeo (frames 160px a 5fps) na MESMA timeline.
    const framesDir = path.join(tmpRoot, 'vf');
    fs.mkdirSync(framesDir, { recursive: true });
    const vPads = files.map((_, i) => `[${i}:v]`).join('');
    const vGraph = `${vPads}concat=n=${nIn}:v=1:a=0,fps=5,scale=160:-1[v]`;
    await execFileAsync(
      ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', vGraph, '-map', '[v]', path.join(framesDir, 'fr_%04d.png')],
      { timeout: 180_000 },
    );
    const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort();
    if (frames.length < 15) return no(`frames insuficientes (${frames.length})`);
    const sharp = (await import('sharp')).default;
    const means: number[] = [];
    for (const f of frames) {
      const { data, info } = await sharp(path.join(framesDir, f)).raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      const ch = info.channels;
      for (let i = 0; i < data.length; i += ch) sum += data[i];
      means.push(sum / (data.length / ch));
    }
    // Reamostra vídeo (5fps) p/ 10Hz + envelopes de ONSET (transientes).
    const step = 1 / sampleHz;
    const tEnd = Math.min(loud[loud.length - 1].t, frames.length / 5);
    const n = Math.floor(tEnd / step);
    if (n < 30) return no('janela curta demais');
    const aEnv: number[] = [];
    const vEnv: number[] = [];
    let li = 0;
    for (let i = 0; i < n; i++) {
      const t = i * step;
      while (li < loud.length - 1 && loud[li + 1].t <= t) li++;
      const a = loud[li]?.m ?? -70;
      const v = means[Math.min(frames.length - 1, Math.floor(t * 5))] ?? 0;
      aEnv.push(Math.max(-60, a));
      vEnv.push(v);
    }
    const onset = (arr: number[]): number[] => arr.map((v, i) => (i === 0 ? 0 : Math.max(0, v - arr[i - 1])));
    // Tamanhos REAIS do material (concatLen teórico mente com segmento curto
    // ou arquivo único > segmentTimeSec): alimentam o clamp da compensação.
    const audioLenSec = Math.round(loud[loud.length - 1].t * 100) / 100;
    const videoLenSec = Math.round((frames.length / 5) * 100) / 100;
    const aOn = onset(aEnv);
    const vOn = onset(vEnv);
    const { lagSec, prominence } = correlateOffset(aOn, vOn, sampleHz, maxLagSec);
    const done = (offsetSec: number, prom: number, measured: boolean, reason: string): AvOffsetResult =>
      measured
        ? { offsetSec, prominence: prom, measured, reason, audioLenSec, videoLenSec }
        : { offsetSec: 0, prominence: prom, measured, reason, audioLenSec, videoLenSec };
    if (Math.abs(lagSec) < 0.5) return done(0, prominence, false, `alinhado (δ=${lagSec.toFixed(2)}s)`);
    if (prominence < 1.5) return done(0, prominence, false, `sem pico dominante (prom=${prominence.toFixed(2)})`);
    if (Math.abs(lagSec) > maxLagSec) return done(0, prominence, false, 'fora da faixa');
    // Consistência por metades: mídia periódica/ruído correlaciona em lag
    // qualquer — metades independentes concordando é muito mais forte que
    // um pico isolado (testsrc espúrio prom 1.63 vs beep↔flash real 1.73).
    const mid = Math.floor(n / 2);
    const h1 = correlateOffset(aOn.slice(0, mid), vOn.slice(0, mid), sampleHz, maxLagSec);
    const h2 = correlateOffset(aOn.slice(mid), vOn.slice(mid), sampleHz, maxLagSec);
    if (
      Math.abs(h1.lagSec) < 0.5 ||
      Math.abs(h2.lagSec) < 0.5 ||
      Math.abs(h1.lagSec - h2.lagSec) > 1.0
    ) {
      return done(0, prominence, false, `inconsistente entre metades (${h1.lagSec.toFixed(1)}s vs ${h2.lagSec.toFixed(1)}s)`);
    }
    return done(Math.round(lagSec * 100) / 100, Math.round(prominence * 100) / 100, true, 'ok');
  } catch (e) {
    return no(`falha na medição: ${String(e).slice(0, 100)}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export interface AudioCompensation {
  /** Início do áudio na timeline do concat (≥0). */
  startSec: number;
  /** Fim do áudio na timeline do concat (−δ da janela de vídeo). */
  endSec: number;
  /** Silêncio a inserir no início (s): completa o head quando S−δ < 0. */
  padSec: number;
  /** Duração final (= vídeo): atrim de saída depois do adelay. */
  outLenSec: number;
  /** Head faltou material (pad > 0). */
  clamped: boolean;
  /** Cauda além do material de áudio (residual possível no fim). */
  tailShort: boolean;
  /** Janela útil degenerada: NÃO compensar. */
  invalid: boolean;
}

/**
 * Compensação de skew A/V (δ>0 = áudio adiantado) para o áudio, dada a
 * janela de vídeo [S, E] na timeline do concat.
 *
 * A janela natural do áudio é [S−δ, E−δ] (mesma duração, conteúdo
 * realinhado). Quando S−δ < 0 (head fora do material), a janela começa em
 * 0 e o adelay preenche a diferença com SILÊNCIO — sem isso, um clamp
 * simples deixaria o clipe INTEIRO deslocado pelo residual. Quando E−δ
 * passa do material de áudio, a cauda fica curta (residual no fim —
 * material que não existe não dá para inventar).
 * Puro/testável.
 */
export function computeAudioCompensation(
  videoStartSec: number,
  videoEndSec: number,
  deltaSec: number,
  materialEndSec: number,
): AudioCompensation {
  const len = videoEndSec - videoStartSec;
  const rawStart = videoStartSec - deltaSec;
  const rawEnd = videoEndSec - deltaSec;
  const padSec = Math.max(0, -rawStart);
  const startSec = Math.max(0, rawStart);
  const clamped = padSec > 0.005;
  const invalid = rawEnd - startSec < 0.2 || len < 0.2;
  let endSec = rawEnd;
  let tailShort = false;
  if (Number.isFinite(materialEndSec) && endSec > materialEndSec) {
    endSec = materialEndSec;
    tailShort = true;
  }
  return { startSec, endSec, padSec, outLenSec: len, clamped, tailShort, invalid };
}

/**
 * Higieniza segmentos p/ o concat (files em ordem oldest→newest):
 * 1) descarta o MAIS NOVO (está sendo escrito pelo recorder agora);
 * 2) descarta ilegíveis (moov quebrado / parcial de queda de stream).
 * Sem isso um único segmento ruim derruba o concat inteiro (moov atom
 * not found) e o .txt órfão fica para trás.
 */
export async function sanitizeSegments(files: string[]): Promise<{ ok: string[]; dropped: string[] }> {
  const log = getLogger();
  const dropped: string[] = [];
  let rest = [...files];
  if (rest.length > 2) {
    const newest = rest.pop()!;
    dropped.push(newest);
    log.info({ dropped: path.basename(newest) }, 'segmento mais novo descartado (em gravação)');
  }
  const ok: string[] = [];
  for (const f of rest) {
    if (await isSegmentReadable(f)) {
      ok.push(f);
    } else {
      dropped.push(f);
      log.warn({ dropped: path.basename(f) }, 'segmento ilegível descartado (moov quebrado?)');
    }
  }
  return { ok, dropped };
}

/**
 * Upscale com restauração leve (denoise temporal + sharpen adaptativo) e
 * re-encode de alta qualidade (lanczos + CRF 17) para forçar o pipeline
 * VP9/AV1 do YouTube: uploads >=1440p recebem codec superior, e a qualidade
 * percebida sobe muito mesmo assistindo em 1080p. O denoise vem ANTES do
 * scale (não amplia blocos de compressão) e o sharpen DEPOIS (devolve o fio
 * das bordas). A fonte (Twitch ~8 Mbps) continua sendo o teto — isto só
 * preserva o máximo dela e destrava o codec melhor. Opera in-place
 * (via temporário + rename).
 *
 * trimStartSec: corta o COMEÇO com precisão de frame — os segmentos do
 * buffer são atômicos de 10s, então o concat sempre pega segmentos
 * "inteiros" (até 10s de folga antes do momento desejado). O trim aqui
 * é grátis: este passo re-encoda de qualquer forma.
 */
export async function upscaleClip(inPath: string, height: number, trimStartSec = 0): Promise<string> {
  const log = getLogger();
  const tmp = `${inPath}.up${height}.mp4`;
  const cpus = os.cpus().length;
  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
  if (trimStartSec > 0.5) args.push('-ss', trimStartSec.toFixed(2));
  args.push(
    '-i',
    inPath,
    '-vf',
    `hqdn3d=4:3:7:5,scale=-2:${height}:flags=lanczos+accurate_rnd+full_chroma_int,cas=0.6`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-threads',
    String(Math.max(2, cpus - 2)),
    '-crf',
    '17',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    tmp,
  );
  await execTracked('ffmpeg', args);
  fs.renameSync(tmp, inPath);
  const mb = (fs.statSync(inPath).size / 1024 / 1024).toFixed(1);
  log.info({ height, mb, trimStartSec }, 'upscale aplicado (força VP9/AV1 no YouTube)');
  return inPath;
}

/**
 * Âncora de fim do clipe (wall ms): volta ao fechamento REAL do round
 * (detecção − lag do placar) e anda AFTER_CLOSE — mirando ~5s antes da
 * ação do round seguinte (win panel + freeze ≈ 13s). Em timeout/pausa o
 * gap estica e a margem só cresce (nunca sangra p/ o próximo round).
 * Puro/testável.
 */
export function computeAceEndMs(
  detectionWallMs: number,
  scoreboardDelayMs: number,
  afterCloseSec: number,
): number {
  return detectionWallMs - scoreboardDelayMs + afterCloseSec * 1000;
}

/**
 * Teto de duração como ALARME (nunca silencioso): se o trim resultante
 * excede o cap, força o corte e sinaliza que o cálculo falhou. O cap não
 * corrige causa nenhuma — só impede o clipe gigante enquanto o trim real
 * não ancora certo. Puro/testável.
 */
export function applyDurationCap(
  trimStartSec: number,
  trimEndSec: number | null,
  concatLenSec: number,
  capSec: number,
): { trimEndSec: number | null; clamped: boolean } {
  const estDurSec = (trimEndSec ?? concatLenSec) - trimStartSec;
  if (estDurSec > capSec) {
    return { trimEndSec: trimStartSec + capSec, clamped: true };
  }
  return { trimEndSec, clamped: false };
}

/**
 * Offset de trim dentro do clipe concatenado para o corte começar
 * exatamente em (âncora − contexto). O concat entrega segmentos ATÔMICOS
 * (o pick inclui o segmento anterior inteiro p/ garantir material);
 * este cálculo converte a folga atômica em começo exato (aplicado no
 * upscale, que re-encoda de qualquer forma — trim grátis em qualidade).
 * Puro: (mtime do 1º segmento − duração dele) ≈ início real do clipe.
 */
export function computeTrimStartSec(
  firstSegEndMs: number,
  segmentTimeSec: number,
  aceStartMs: number | undefined,
  contextSec: number,
  /** Início real do 1º segmento (span medido). Sem ele, assume mtime − slot. */
  firstSegStartMsReal?: number,
): number {
  if (aceStartMs == null) return 0;
  const firstSegStartMs = firstSegStartMsReal ?? firstSegEndMs - segmentTimeSec * 1000;
  const desiredStartMs = aceStartMs - contextSec * 1000;
  return Math.max(0, (desiredStartMs - firstSegStartMs) / 1000);
}

/**
 * Offset de trim do FIM na timeline concatenada (já descontado o trim do
 * começo). Retorna null quando não há âncora de fim ou ela não corta nada
 * (margem 0.5s) — nesse caso vale a cauda atual (fallback). Puro/testável.
 */
export function computeTrimEndSec(
  firstSegStartMs: number,
  usableCount: number,
  segmentTimeSec: number,
  aceEndMs: number | undefined,
  trimStartSec: number,
  /** Span real do concat (medido). Sem ele, assume n × slot (legado). */
  concatLenSec?: number,
): number | null {
  if (aceEndMs == null) return null;
  const e = (aceEndMs - firstSegStartMs) / 1000 - trimStartSec;
  // Fim antes/até o começo: âncora inconsistente — fallback (cauda atual),
  // nunca um clipe de 1s de conteúdo errado.
  if (e <= 0.5) return null;
  const concatLen = (concatLenSec ?? usableCount * segmentTimeSec) - trimStartSec;
  if (e < concatLen - 0.5) return e;
  return null;
}

/**
 * CAUDA CONTÍGUA: mantém apenas a sequência cronológica do fim do buffer.
 * Se dois ffmpegs escreveram no mesmo diretório (fantasma de restart), os
 * mtimes ficam intercalados e o clipe "volta no tempo" (sidecar real:
 * [005, 016, 017, 000, 001, 002, 003]). Aqui, um gap > maxGapSec corta
 * tudo anterior — a cauda contígua é sempre uma única timeline coerente.
 */
export function contiguousTail(files: string[], maxGapSec: number): { ok: string[]; dropped: string[] } {
  if (files.length <= 1) return { ok: [...files], dropped: [] };
  const timed = files.map((f) => {
    let m = 0;
    try {
      m = fs.statSync(f).mtimeMs;
    } catch {
      m = 0;
    }
    return { f, m };
  });
  let start = 0;
  for (let i = timed.length - 2; i >= 0; i--) {
    // arquivo com mtime 0 (stat falhou): não é sinal de intercalação
    const gapSec = (timed[i + 1].m - timed[i].m) / 1000;
    if (timed[i].m > 0 && timed[i + 1].m > 0 && gapSec > maxGapSec) {
      start = i + 1;
      break;
    }
  }
  return {
    ok: timed.slice(start).map((t) => t.f),
    dropped: timed.slice(0, start).map((t) => t.f),
  };
}

/**
 * Escolhe segmentos por TEMPO (mtime do arquivo ≈ fim do segmento).
 * Com aceStartMs: tudo que termina depois de (1º kill − contexto).
 * Com aceEndMs: só o que começa antes do fim (o trim corta o excedente).
 * Sem âncoras: últimos N cobrindo pre+post. Sempre retorna ≥1 se houver entrada.
 */
export function pickSegments(segments: string[], opts: PickOptions): string[] {
  if (segments.length === 0) return [];
  const contextSec = opts.contextSec ?? 10;
  if (opts.aceStartMs == null) {
    const wantSec = opts.preRollSec + opts.postRollSec;
    const needFiles = Math.max(2, Math.ceil(wantSec / opts.segmentTimeSec) + 1);
    const tail = segments.slice(-needFiles);
    return opts.aceEndMs != null ? cutAfterEnd(tail, opts) : tail;
  }
  const cutFrom = opts.aceStartMs - contextSec * 1000;
  const timed = segments.map((f) => {
    let endMs = 0;
    try {
      endMs = fs.statSync(f).mtimeMs;
    } catch {
      endMs = 0;
    }
    return { f, endMs, startMs: endMs > 0 ? endMs - opts.segmentTimeSec * 1000 : 0 };
  });
  // -1 segmento de margem: o kill pode estar no início do seu segmento,
  // e o contexto precisa existir ANTES dele (segmentos são atômicos).
  const threshold = cutFrom - opts.segmentTimeSec * 1000;
  const picked = timed.filter((s) => s.endMs <= 0 || s.endMs > threshold).map((s) => s.f);
  if (picked.length === 0) {
    // ace mais velho que o buffer (ou relógio torto): usa o buffer todo
    return segments;
  }
  return opts.aceEndMs != null ? cutAfterEnd(picked, opts) : picked;
}

/**
 * Corte pós-fim: descarta segmentos que começam depois de aceEndMs
 * (+1s de tolerância — o trim exato corta o excedente do último válido).
 * Se sobrar vazio (fim fora do buffer), mantém tudo (fallback: cauda atual).
 */
function cutAfterEnd(files: string[], opts: PickOptions): string[] {
  const endMs = opts.aceEndMs!;
  const kept = files.filter((f) => {
    let startMs = 0;
    try {
      startMs = fs.statSync(f).mtimeMs - opts.segmentTimeSec * 1000;
    } catch {
      return true;
    }
    return startMs < endMs + 1000;
  });
  if (kept.length === 0) {
    getLogger().warn('fim do clipe fora do buffer, usando cauda atual (fallback)');
    return files;
  }
  return kept;
}

/** Maior mtime dos segmentos (fim do buffer). 0 se vazio/ilegível. */
export function newestSegmentEndMs(files: string[]): number {
  let max = 0;
  for (const f of files) {
    try {
      max = Math.max(max, fs.statSync(f).mtimeMs);
    } catch {
      // ignora
    }
  }
  return max;
}

/**
 * Concatena os últimos segmentos do buffer circular.
 * Usa `-c copy` (sem re-encode) para ser instantâneo em PC modesto.
 * MVP: só 16:9 horizontal, sem vertical/Shorts.
 */
export async function buildClip(
  ace: AceEvent,
  segments: string[],
  opts: ClipOptions,
): Promise<ClipResult> {
  const log = getLogger();
  if (segments.length === 0) {
    throw new Error(`sem segmentos no buffer ${opts.bufferDir} — stream caiu?`);
  }
  fs.mkdirSync(opts.clipsDir, { recursive: true });

  const wantSec = opts.preRollSec + opts.postRollSec;
  const picked = pickSegments(segments, {
    segmentTimeSec: opts.segmentTimeSec,
    preRollSec: opts.preRollSec,
    postRollSec: opts.postRollSec,
    contextSec: opts.contextSec,
    aceStartMs: opts.aceStartMs,
    aceEndMs: opts.aceEndMs,
  });
  log.info(
    {
      picked: picked.length,
      wantSec,
      anchored: opts.aceStartMs != null,
      endAnchored: opts.aceEndMs != null,
      contextSec: opts.contextSec ?? 10,
      aceStart: opts.aceStartMs != null ? new Date(opts.aceStartMs).toISOString() : undefined,
      aceEnd: opts.aceEndMs != null ? new Date(opts.aceEndMs).toISOString() : undefined,
    },
    'montando clipe',
  );

  const base = `${ace.matchId}_${slug(ace.map)}_r${ace.round}_${slug(ace.player)}`;
  const outPath = path.join(opts.clipsDir, `${base}.mp4`);
  const sidecarPath = path.join(opts.clipsDir, `${base}.json`);

  // Primeiro a cauda contígua (joga fora intercalação de fantasma),
  // depois a sanitização (legibilidade). Nessa ordem o trim e a duração
  // trabalham sobre uma única timeline coerente.
  const tail = contiguousTail(picked, opts.segmentTimeSec * 2.5);
  if (tail.dropped.length > 0) {
    log.warn(
      { dropped: tail.dropped.map((d) => path.basename(d)) },
      'segmentos intercalados (fantasma?) descartados — usando cauda contígua',
    );
  }
  const { ok: usable, dropped } = await sanitizeSegments(tail.ok);
  if (usable.length === 0) {
    throw new Error(
      `sem segmentos legíveis no buffer (descartados: ${dropped.map((d) => path.basename(d)).join(', ') || 'nenhum'})`,
    );
  }
  // Cálculos PUROS fora da fila (statSync + aritmética). Tudo que decodifica
  // mídia (diagnóstico, medição A/V, encode) entra na FILA de render junto
  // com o próprio encode — fora dela competia com o render anterior por CPU.
  const firstSegMtimeMs = fs.statSync(usable[0]).mtimeMs;
  let firstSegStartMs = firstSegMtimeMs - opts.segmentTimeSec * 1000;
  let concatLenSec = usable.length * opts.segmentTimeSec;
  // Span MEDIDO (handleAce mediu nos segmentos originais, com birthtime
  // intacto): quando um segmento nunca cortou, ele cobre minutos, não
  // `slot` segundos — ancorar o trim em `mtime − slot` desloca tudo para
  // fora do material e o fallback renderiza o arquivo inteiro (clipe de
  // 7min/1GB). Sem medição, vale o legado (n × slot).
  if (opts.concatSpanSec != null && Number.isFinite(opts.concatSpanSec) && opts.concatSpanSec > 0) {
    firstSegStartMs = fs.statSync(usable[usable.length - 1]).mtimeMs - opts.concatSpanSec * 1000;
    concatLenSec = opts.concatSpanSec;
    log.info({ spanSec: opts.concatSpanSec, files: usable.length }, 'trim ancorado no span medido (não em n×slot)');
  }
  const trimStartSec = computeTrimStartSec(
    firstSegMtimeMs,
    opts.segmentTimeSec,
    opts.aceStartMs,
    opts.contextSec ?? 10,
    firstSegStartMs,
  );
  // Fim EXATO: aceEndMs na timeline concatenada (menos o trim do começo).
  // Só aplica se cortar de verdade (margem 0.5s) — senão é a cauda atual.
  let trimEndSec = computeTrimEndSec(
    firstSegStartMs,
    usable.length,
    opts.segmentTimeSec,
    opts.aceEndMs,
    trimStartSec,
    concatLenSec,
  );
  const height = opts.upscaleHeight ?? 0;
  // Teto de duração como ALARME (nunca silencioso): se o trim resultante
  // excede o cap, força o corte e sinaliza — o cap não corrige causa, só
  // impede o clipe gigante enquanto o trim não ancora certo.
  const LEN_CAP_SEC = opts.preRollSec + opts.postRollSec + 30;
  const capped = applyDurationCap(trimStartSec, trimEndSec, concatLenSec, LEN_CAP_SEC);
  if (capped.clamped) {
    log.error(
      { trimStartSec, trimEndSec, concatLenSec, capSec: LEN_CAP_SEC },
      'teto de duração atingido — corte forçado (revisar trim/âncoras)',
    );
    trimEndSec = capped.trimEndSec;
  }
  // Preenchidos DENTRO da fila (job abaixo); lidos no log/sidecar depois.
  let avMeasuredMs: number | null = null;
  let avAppliedMs = 0;
  const avMode = opts.avSync ?? 'log';
  let avReason = avMode === 'off' ? 'desligado (CLIP_AV_SYNC=off)' : 'não executado';
  let avIssuesCount = 0;
  let avSegmentIssues: SegmentAvIssue[] = [];

  // PASSADA ÚNICA com FILTRO concat: emenda realinhando A/V arquivo a
  // arquivo. O concat demuxer com -c copy alinhava cada segmento pelo
  // início e acumulava ~20-40ms de desync por emenda — centenas de ms no
  // fim do clipe. Trim + restauração + upscale entram no MESMO filtro:
  // o re-encode que o upscale exigiria já processa a emenda, então o
  // custo total é o mesmo de antes (uma re-encode, não duas).
  await enqueueRender(async () => {
    // Render fantasma de sessão anterior para ESTE clipe (crash/restart no
    // meio do encode): mata antes de começar outro.
    const stale = killStale(path.resolve(outPath));
    if (stale > 0) log.warn({ stale }, 'render fantasma morto');

    // Diagnóstico A/V (nunca quebra o pipeline): divergência de conteúdo
    // entre trilhas no MESMO segmento (ex: vídeo 1.6s + áudio 10s) vira skew
    // no clipe que start_time/duration de container não mostra — idem para
    // stalls (gap > 1s = imagem congelada) e saltos de PTS (fonte reiniciou).
    try {
      const avIssues = await verifySegmentAv(usable, opts.segmentTimeSec);
      avSegmentIssues = avIssues;
      avIssuesCount = avIssues.length;
      for (const issue of avIssues) {
        log.warn(issue, 'divergência A/V no segmento (possível skew no clipe)');
      }
    } catch {
      // inspeção é best-effort
    }

    // Auto-sync A/V por CONTEÚDO: 'auto' mede E aplica; 'log' mede e só
    // registra (modo diagnóstico); 'off' pula. Sem medida válida, tudo
    // abaixo equivale ao comportamento antigo (janelas idênticas).
    let avDeltaSec = 0;
    let avAudioMaterialSec: number | undefined;
    let avVideoMaterialSec: number | undefined;
    if (avMode !== 'off') {
      try {
        const r = await measureAvOffset(usable, resolveFfmpegBin());
        avReason = r.reason;
        avAudioMaterialSec = r.audioLenSec;
        avVideoMaterialSec = r.videoLenSec;
        log.info(
          { avMode, avOffsetMs: r.measured ? Math.round(r.offsetSec * 1000) : null, prom: r.prominence, reason: r.reason },
          'auto-sync A/V medido',
        );
        if (r.measured) avMeasuredMs = Math.round(r.offsetSec * 1000);
      } catch {
        avReason = 'falha na medição';
      }
    }
    if (avMode === 'auto' && avMeasuredMs != null && Math.abs(avMeasuredMs) >= 500 && Math.abs(avMeasuredMs) <= 8000) {
      avDeltaSec = avMeasuredMs / 1000;
    } else if (avMeasuredMs != null && avMode === 'auto') {
      log.info({ avOffsetMs: avMeasuredMs }, 'offset fora da faixa de atuação (±0.5s..8s), sem compensação');
    } else if (avMeasuredMs != null) {
      log.info({ avMode, avOffsetMs: avMeasuredMs }, 'offset medido (modo log: sem compensação)');
    }
    avAppliedMs = Math.round(avDeltaSec * 1000);

    const pads = usable.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
    // ATENÇÃO à timeline: trim/end do filtro são posições NO CONCAT. O
    // trimEndSec é DURAÇÃO (relativo ao trim) — o fim absoluto é S+dur.
    // (Bug real corrigido: end=duração cortava o clipe ~S segundos antes.)
    const videoEndSec = trimEndSec != null ? trimStartSec + trimEndSec : null;
    const trimParts: string[] = [];
    if (trimStartSec > 0.05) trimParts.push(`start=${trimStartSec.toFixed(2)}`);
    if (videoEndSec != null) trimParts.push(`end=${videoEndSec.toFixed(2)}`);
    const doTrim = trimParts.length > 0;
    // Compensação de skew no áudio: janela [S−δ, E−δ] + adelay quando o head
    // cai fora do material + corte final na duração do vídeo. Sem offset
    // (ou medição inválida), as duas trilhas usam a MESMA janela.
    // Fins REAIS do material vêm da medição (concatLen teórico mente com
    // segmento curto — janela beyond-material = clipe com cauda esticada).
    let acomp: AudioCompensation | null = null;
    if (avDeltaSec !== 0) {
      acomp = computeAudioCompensation(
        trimStartSec,
        videoEndSec ?? avVideoMaterialSec ?? concatLenSec,
        avDeltaSec,
        avAudioMaterialSec ?? concatLenSec,
      );
      if (acomp.invalid) {
        log.warn({ avAppliedMs, acomp }, 'janela de áudio degenerada, sem compensação');
        acomp = null;
      } else if (acomp.clamped) {
        log.warn({ padSec: acomp.padSec, avAppliedMs }, 'head do áudio fora do material: silêncio inserido');
      }
      if (acomp?.tailShort) {
        log.warn({ endSec: acomp.endSec, avAppliedMs }, 'cauda do áudio além do material: residual no fim');
      }
    }
    const aTrimParts: string[] = acomp
      ? [
          ...(acomp.startSec > 0.05 ? [`start=${acomp.startSec.toFixed(2)}`] : []),
          ...(acomp.endSec < (avAudioMaterialSec ?? concatLenSec) - 0.5 ? [`end=${acomp.endSec.toFixed(2)}`] : []),
        ]
      : trimParts;
    const aPadMs = acomp && acomp.padSec > 0.005 ? Math.round(acomp.padSec * 1000) : 0;
    const doATrim = aTrimParts.length > 0;
    const aparts = [
      doATrim ? `atrim=${aTrimParts.join(':')},asetpts=PTS-STARTPTS` : '',
      aPadMs > 0 ? `adelay=delays=${aPadMs}:all=1` : '',
      acomp && aPadMs > 0 ? `atrim=end=${acomp.outLenSec.toFixed(2)},asetpts=PTS-STARTPTS` : '',
    ]
      .filter(Boolean)
      .join(',');
    const vparts = [
      doTrim ? `trim=${trimParts.join(':')},setpts=PTS-STARTPTS` : '',
      'hqdn3d=4:3:7:5',
      height > 0 ? `scale=-2:${height}:flags=lanczos+accurate_rnd+full_chroma_int` : '',
      'cas=0.6',
    ]
      .filter(Boolean)
      .join(',');
    const filter = `${pads}concat=n=${usable.length}:v=1:a=1[vc][ac];[vc]${vparts}[v];[ac]${aparts || 'anull'}[a]`;

    const cpus = os.cpus().length;
    const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-y'];
    for (const f of usable) args.push('-i', f);
    args.push(
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      // veryfast: mesma qualidade visual do medium em CRF 17 e ~2-3x mais
      // rápido — medium em 1440p60 sozinho já saturava a CPU do PC.
      'veryfast',
      // Deixa ~2 cores livres p/ o sistema (recorders, Chrome, uso diário).
      '-threads',
      String(Math.max(2, cpus - 2)),
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    );
    await execTracked('ffmpeg', args);
  });
  log.info(
    { segments: usable.length, trimStartSec, trimEndSec, height, avAppliedMs, avIssues: avIssuesCount },
    'clipe montado (passada única: emenda A/V realinhada + upscale)',
  );

  const stat = fs.statSync(outPath);
  const durationSec =
    trimEndSec != null
      ? Math.max(5, Math.round(trimEndSec))
      : Math.max(
          5,
          Math.min(wantSec, usable.length * opts.segmentTimeSec) - Math.round(trimStartSec),
        );

  // Thumbnail estilo canal de cortes: frame + selo ACE!/jogador/confronto.
  // Frame de ~3s antes do 5º kill (meio do ace) — meio do clipe costuma ser break/torcida.
  const thumbPath = path.join(opts.clipsDir, `${base}.jpg`);
  try {
    await makeSmartThumbnail(outPath, thumbPath, ace, Math.max(1, opts.preRollSec - 3), opts.thumb);
  } catch {
    log.warn('falha ao gerar thumbnail, seguindo sem ela');
  }

  fs.writeFileSync(
    sidecarPath,
    JSON.stringify(
      buildSidecar(ace, {
        clipFile: path.basename(outPath),
        segmentsUsed: usable.map((p) => path.basename(p)),
        createdAt: new Date().toISOString(),
        avMode,
        avOffsetMs: avMeasuredMs,
        avAppliedMs,
        avReason,
        avIssues: avIssuesCount,
        avSegmentIssues,
      }),
      null,
      2,
    ),
  );

  return {
    filePath: outPath,
    sidecarPath,
    thumbnailPath: fs.existsSync(thumbPath) ? thumbPath : undefined,
    durationSec,
  };
}

export function buildTitle(ace: AceEvent): string {
  const label = killLabel(ace.kills.length);
  const weapon = ace.summary?.mainWeapon
    ? ` (${prettyWeapon(ace.summary.mainWeapon)})`
    : '';
  return `${label}! ${ace.player}${weapon} — ${ace.team1} vs ${ace.team2} | ${ace.event} ${ace.map} R${ace.round}`.slice(0, 100);
}

export function buildDescription(ace: AceEvent, tags: string): string {
  const head = ace.summary
    ? describeAce(ace.summary, ace.event)
    : [
        buildTitle(ace),
        '',
        `5 kills no mesmo round por ${ace.player} em ${ace.team1} vs ${ace.team2}.`,
        `Evento: ${ace.event} | Mapa: ${ace.map} | Round: ${ace.round}`,
        `Detectado em: ${ace.detectedAt}`,
      ].join('\n');
  return [
    head,
    '',
    'Corte automático para revisão. Publicado como privado.',
    '',
    `Tags: ${tags}`,
  ].join('\n');
}

/**
 * Payload do sidecar .json: kills UMA vez (top-level) + summary SEM a cópia
 * dos kills (só metadados agregados). Evita o array duplicado.
 */
export function buildSidecar(ace: AceEvent, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // JSON.stringify omite chaves undefined: kills aparece 1x (top-level).
  const summary = ace.summary
    ? { ...ace.summary, kills: undefined, killCount: ace.summary.kills.length }
    : undefined;
  return { ...ace, summary, ...extra };
}
