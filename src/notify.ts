import { spawn } from 'node:child_process';
import { getLogger } from './logger.js';

/**
 * Notificação nativa do Windows (balloon tip via PowerShell NotifyIcon).
 * Best-effort PURO: falha silenciosa (log.debug) — o canal garantido de
 * alerta segue sendo o ERROR no log; isto é o que aparece na TELA sem
 * precisar olhar log (Focus Assist do Windows pode suprimir).
 */

function oneLine(s: string, max: number): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/'/g, "''").slice(0, max);
}

/** Dispara o balloon. Nunca joga; não bloqueia (processo detachado). */
export function notifyWindows(title: string, message: string): void {
  if (process.platform !== 'win32') return;
  try {
    const t = oneLine(title, 60);
    const m = oneLine(message, 220);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$i = New-Object System.Windows.Forms.NotifyIcon',
      '$i.Icon = [System.Drawing.SystemIcons]::Exclamation',
      '$i.Visible = $true',
      `$i.BalloonTipTitle = '${t}'`,
      `$i.BalloonTipText = '${m}'`,
      '$i.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning',
      '$i.ShowBalloonTip(15000)',
      'Start-Sleep -Seconds 16',
      '$i.Dispose()',
    ].join('\n');
    // -EncodedCommand (base64 UTF-16LE): imune a escape de aspas.
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (e) {
    getLogger().debug({ err: String(e) }, 'notificação Windows falhou (best-effort)');
  }
}
