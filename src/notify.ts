import { spawn } from 'node:child_process';
import { getLogger } from './logger.js';

/**
 * Notificação nativa do Windows (balloon tip via PowerShell NotifyIcon).
 * Best-effort PURO: falha silenciosa (log.debug) — o canal garantido de
 * alerta segue sendo o ERROR no log; isto é o que aparece na TELA sem
 * precisar olhar log (Focus Assist do Windows pode suprimir).
 */

/**
 * Texto pronto para uma string de PowerShell entre aspas simples.
 *
 * A ordem importa: o CORTE vem ANTES do escape. Escapar primeiro e
 * cortar depois pode deixar uma aspa simples desbalanceada no fim (o par
 * `''` cortado ao meio) — a string do PowerShell fecharia ali e o resto
 * do texto viraria código. O texto vem do DOM/Playwright (erro de
 * extração), então não é confiável.
 *
 * Dentro de aspas simples o PowerShell só interpreta a aspa simples
 * ( escapada por duplicação); barra invertida e crase são literais.
 */
export function psLiteral(value: string, max: number): string {
  const flat = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (max <= 0) return '';
  return flat.slice(0, max).replace(/'/g, "''");
}

/** Dispara o balloon. Nunca joga; não bloqueia (processo detachado). */
export function notifyWindows(title: string, message: string): void {
  if (process.platform !== 'win32') return;
  try {
    const t = psLiteral(title, 60);
    const m = psLiteral(message, 220);
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
      // -WindowStyle Hidden: sem ele cada toast pisca um console na tela
      // (justamente o que o modo gaming tenta eliminar).
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch (e) {
    getLogger().debug({ err: String(e) }, 'notificação Windows falhou (best-effort)');
  }
}
