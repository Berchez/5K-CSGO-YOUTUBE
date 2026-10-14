/**
 * Registry de processos ffmpeg do bot (recorder + render).
 *
 * No Windows, child processes NÃO morrem quando o pai morre (sem death
 * signal) — restart/kill do Node deixa ffmpegs órfãos em pleno encode
 * (x264 pegando 100% da CPU sozinho). Este módulo fecha o ciclo:
 * track() no spawn, killAll() no shutdown/exit do processo, e
 * killStale() varre fantasmas de sessão anterior pela linha de comando.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';

const pids = new Set<number>();

export function track(child: ChildProcess): void {
  if (child.pid) pids.add(child.pid);
}

export function untrack(child: ChildProcess): void {
  if (child.pid) pids.delete(child.pid);
}

function killPid(pid: number): void {
  try {
    // /T: também mata a árvore do processo (se houver)
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // já morreu — ok
  }
}

/** Mata TODOS os ffmpegs conhecidos (shutdown/exit). Síncrono e best-effort. */
export function killAll(): void {
  for (const pid of pids) killPid(pid);
  pids.clear();
}

interface ProcInfo {
  ProcessId: number;
  CommandLine?: string | null;
}

function listFfmpegs(): ProcInfo[] | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"name='ffmpeg.exe'\" | " +
            'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000 },
      );
      const j = JSON.parse(out) as ProcInfo | ProcInfo[];
      return Array.isArray(j) ? j : [j];
    } catch {
      // tenta de novo; na 2ª falha avisa o chamador (null = não confie)
    }
  }
  return null;
}

/**
 * Mata ffmpegs fantasmas (de sessão morta) cuja linha de comando contém
 * o needle — ex: o bufferDir de um recorder novo, ou o caminho de saída
 * de um render novo. Não toca nos PIDs já trackeados desta sessão.
 */
export function killStale(needle: string): number {
  let killed = 0;
  const safe = needle.replace(/'/g, "''");
  const all = listFfmpegs();
  if (all === null) return 0;
  for (const p of all) {
    if (!p.CommandLine || !p.CommandLine.includes(safe)) continue;
    if (pids.has(p.ProcessId)) continue; // nosso — não mata
    killPid(p.ProcessId);
    killed++;
  }
  return killed;
}
