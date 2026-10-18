/**
 * Tabela "precisava estar visível?": tentativas de thumb IA por
 * provider × modo de janela, lidas do bot.log (Fase 2 do plano gaming).
 *
 * Uso:
 *   npx tsx scripts/diag-thumbs.ts [--file ./logs/bot.log] [--days 7]
 *
 * Linhas novas 'thumb IA: tentativa' trazem modo/causa explícitos; linhas
 * legadas assumem chatgpt/grok = 'visible (legado)' (era o default) e
 * gemini-web = 'headless'.
 */
import fs from 'node:fs';
import {
  formatThumbDiagTable,
  isThumbLogLine,
  parseThumbLogLine,
  summarizeAttempts,
  type ThumbAttemptRow,
} from '../src/clipper/thumbDiag.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

async function main(): Promise<void> {
  const file = arg('file', process.env.LOG_FILE ?? './logs/bot.log')!;
  const days = Number(arg('days', '7'));
  if (!fs.existsSync(file)) {
    console.error(`log não encontrado: ${file}`);
    process.exit(1);
  }
  const cutoff = Number.isFinite(days) ? Date.now() - days * 86_400_000 : 0;
  const rows: ThumbAttemptRow[] = [];
  let scanned = 0;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!isThumbLogLine(line)) continue;
    scanned++;
    const r = parseThumbLogLine(line);
    if (r && (r.time === 0 || r.time >= cutoff)) rows.push(r);
  }
  console.log(`linhas de thumb: ${scanned} | tentativas no período: ${rows.length}\n`);
  console.log(formatThumbDiagTable(summarizeAttempts(rows)));
  console.log(
    '\nLegenda: modo "visible (legado)" = linhas de antes do tagging (default da época);',
  );
  console.log("'api' = sem janela (huggingface/gemini/pollinations). Compare ok% por modo.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
