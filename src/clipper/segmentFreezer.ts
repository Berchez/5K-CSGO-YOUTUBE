import fs from 'node:fs';
import path from 'node:path';
import { getFreeBytes } from '../diskSpace.js';
import { getLogger } from '../logger.js';

export interface SegmentFreezerOptions {
  /** Segmentos do recorder, ordenados por mtime (o mesmo `listSegments()`). */
  listSegments: () => string[];
  /** Diretório privado onde as cópias ficam (limpo pelo chamador). */
  destDir: string;
  segmentTimeSec: number;
  /** Intervalo de congelamento (ms). */
  pollIntervalMs?: number;
  shouldStop?: () => boolean;
  /** Abaixo disto (bytes) o freezer para de copiar. */
  minFreeBytes?: number;
}

interface FrozenCopy {
  file: string;
  mtimeMs: number;
  size: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Congela o buffer CIRCULAR do recorder enquanto os OCRs rodam.
 *
 * O anel (`SEGMENT_WRAP`) reescreve os mesmos nomes a cada volta: um
 * snapshot tirado DEPOIS de minutos de OCR pode não conter mais o
 * começo do round (caso 2399949_Mirage_r13_biguzera — o killfeed de 83s
 * comeu a abertura). O freezer copia os segmentos FECHADOS (nunca o que
 * ainda está sendo escrito) para um diretório privado, então o material
 * do clipe fica imune à rotação e à queda da stream.
 *
 * O nome da cópia carrega o mtime em segundos: quando o anel reescreve
 * `seg_7.ts`, a volta nova vira `seg_7-<stamp2>.ts` e a antiga é
 * preservada. O mtime é mantido (seleção/trim são mtime-driven).
 */
export class SegmentFreezer {
  private readonly listSegments: () => string[];
  private readonly destDir: string;
  private readonly segmentTimeSec: number;
  private readonly pollIntervalMs: number;
  private readonly shouldStop?: () => boolean;
  private readonly minFreeBytes: number;
  private readonly frozen = new Map<string, FrozenCopy>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private scanning = false;
  private lowDiskWarned = false;
  private copyErrorWarned = false;
  private failures = 0;

  constructor(options: SegmentFreezerOptions) {
    this.listSegments = options.listSegments;
    this.destDir = options.destDir;
    this.segmentTimeSec = options.segmentTimeSec;
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_500);
    this.shouldStop = options.shouldStop;
    this.minFreeBytes = options.minFreeBytes ?? 0;
    fs.mkdirSync(this.destDir, { recursive: true });
  }

  /** Total de cópias que falharam (diagnóstico do handleAce). */
  get copyFailures(): number {
    return this.failures;
  }

  start(): void {
    if (this.timer != null) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Copia os segmentos que já fecharam (o mais novo pode estar em escrita).
   *
   * A cópia é ASSÍNCRONA de propósito: são centenas de MB por passada e o
   * `copyFileSync` travava o event loop (polls do HLTV, recorder e outros
   * OCRs) por segundos a cada 1,5s. As passadas não se sobrepõem
   * (`scanning`): uma varredura lenta pula as seguintes em vez de
   * empilhar I/O.
   */
  async scan(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      await this.scanOnce();
    } finally {
      this.scanning = false;
    }
  }

  private async scanOnce(): Promise<void> {
    let listed: string[];
    try {
      listed = this.listSegments();
    } catch {
      return;
    }
    if (listed.length <= 1) return;
    const closed = listed.slice(0, -1);
    const free = getFreeBytes(this.destDir);
    if (free != null && free < this.minFreeBytes) {
      if (!this.lowDiskWarned) {
        this.lowDiskWarned = true;
        getLogger().warn(
          { livreBytes: free, minimoBytes: this.minFreeBytes },
          'freezer do buffer sem espaço — congelamento interrompido',
        );
      }
      return;
    }
    for (const file of closed) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!(stat.size > 0)) continue;
      const ext = path.extname(file) || '.ts';
      const base = path.basename(file, ext);
      const stamp = Math.round(stat.mtimeMs / 1_000);
      const key = `${base}-${stamp}`;
      const existing = this.frozen.get(key);
      if (existing != null && existing.size === stat.size) continue;
      const dest = path.join(this.destDir, `${base}-${stamp}${ext}`);
      try {
        await fs.promises.copyFile(file, dest);
        // TOCTOU: o anel reescreve o MESMO nome — se a volta aconteceu
        // durante a cópia, o arquivo copiado é uma mistura de duas voltas
        // carimbado com o mtime antigo (listFrozen teria um segmento
        // truncado "antes" do completo). Reconferir a origem: mudou
        // tamanho/mtime = descarta a cópia (a próxima passada recongela).
        const after = fs.statSync(file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
          fs.rmSync(dest, { force: true });
          continue;
        }
        fs.utimesSync(dest, stat.atime, stat.mtime);
        this.frozen.set(key, { file: dest, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch (e) {
        this.failures += 1;
        if (!this.copyErrorWarned) {
          this.copyErrorWarned = true;
          getLogger().warn(
            { err: String(e).slice(0, 200), file },
            'falha ao congelar segmento do buffer',
          );
        }
      }
    }
  }

  /** Cópias congeladas, oldest→newest (timeline do clipe). */
  listFrozen(): string[] {
    return [...this.frozen.values()]
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))
      .map((copy) => copy.file);
  }

  newestEndMs(): number | null {
    let newest: number | null = null;
    for (const copy of this.frozen.values()) {
      if (newest == null || copy.mtimeMs > newest) newest = copy.mtimeMs;
    }
    return newest;
  }

  /**
   * Espera o material fechar o alvo (fim + um segmento + folga). É a
   * substituição do loop que relia `listSegments()`: a cobertura agora é
   * medida nas cópias congeladas, não no anel que pode rotacionar.
   */
  async waitForCoverage(targetEndMs: number, timeoutMs: number): Promise<boolean> {
    const target = targetEndMs + this.segmentTimeSec * 1_000 + 5_000;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (!this.stopped && !(this.shouldStop?.() ?? false) && Date.now() < deadline) {
      const newest = this.newestEndMs();
      if (newest != null && newest >= target) return true;
      await delay(this.pollIntervalMs);
      await this.scan();
    }
    const newest = this.newestEndMs();
    return newest != null && newest >= target;
  }
}
