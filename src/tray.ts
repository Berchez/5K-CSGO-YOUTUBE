import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Garante o ícone do bot na bandeja do Windows mesmo quando o bot é iniciado
 * fora do autostart (npm start / pm2 start). O script do tray tem instância
 * única via mutex nomeado, então chamadas repetidas são baratas e seguras.
 * Best-effort puro: falha nunca derruba o bot.
 */
export function ensureTray(): void {
  if (process.platform !== 'win32') return;
  try {
    const script = path.resolve('scripts', 'bot-tray.ps1');
    if (!fs.existsSync(script)) return;
    // `start` (ShellExecute) desprende o processo do job do bot: um spawn
    // detached puro morre junto quando o shell/PM2 limpa a árvore.
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch {
    // best-effort
  }
}
