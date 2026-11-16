/**
 * Explica por que uma partida (ou um round) não gerou clipe.
 *
 * POR QUE: o limiar de kills depende de quatro camadas (política geral por
 * estrelas, time da watchlist, jogador da watchlist e bloqueio do
 * adversário). Antes era preciso ler o código para saber se um 4k do time
 * monitorado ficou de fora por limiar, por piso de estrelas ou porque o
 * time do killer não casou com o listing.
 *
 * Lê `logs/bot.log` (JSON por linha) e imprime a política resolvida no
 * início do tracking + o que aconteceu em cada round. Também lista os
 * clipes já gravados da partida (e se o killfeed preencheu a arma).
 *
 * Uso:
 *   npm run explain -- --match 2400208
 *   npx tsx scripts/explain.ts --match 2400208 --log logs/bot.log
 *   npx tsx scripts/explain.ts            # última partida do log
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { explainMatchLog, formatExplain, type ExplainLogLine } from '../src/diag/explainLog.js';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

const logFile = path.resolve(flagValue('--log') ?? path.join('logs', 'bot.log'));
if (!fs.existsSync(logFile)) {
  console.error(`log não encontrado: ${logFile}`);
  process.exit(1);
}

const lines: ExplainLogLine[] = [];
for (const raw of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  if (!raw.trim()) continue;
  try {
    lines.push(JSON.parse(raw) as ExplainLogLine);
  } catch {
    // linha truncada no meio de uma escrita — ignora
  }
}

/** Última partida com tracker iniciado (o log é cronológico). */
function lastMatchId(): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.msg === 'iniciando tracker de multikill' && line.matchId) return String(line.matchId);
  }
  return null;
}

const matchId = flagValue('--match') ?? lastMatchId();
if (!matchId) {
  console.error('nenhuma partida encontrada no log — passe --match <id>');
  process.exit(1);
}

console.log(formatExplain(explainMatchLog(lines, matchId)));

/** Clipes da partida no disco: existe clipe? o killfeed preencheu a arma? */
function clipReport(): void {
  const clipsDir = path.resolve(getConfig().CLIPS_DIR);
  if (!fs.existsSync(clipsDir)) return;
  const folders = fs
    .readdirSync(clipsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${matchId}_`))
    .map((entry) => entry.name)
    .sort();
  if (folders.length === 0) {
    console.log('clipes: nenhum no disco para esta partida');
    return;
  }
  console.log(`clipes no disco (${folders.length}):`);
  for (const folder of folders) {
    const sidecar = path.join(clipsDir, folder, `${folder}.json`);
    if (!fs.existsSync(sidecar)) {
      console.log(`  ${folder} | sem sidecar`);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as {
        kills?: Array<{ weapon?: string | null }>;
        stats?: { mainWeapon?: string | null };
      };
      const kills = data.kills ?? [];
      const comArma = kills.filter((kill) => Boolean(kill.weapon)).length;
      const arma = data.stats?.mainWeapon ?? 'sem arma';
      console.log(`  ${folder} | ${kills.length} kill(s) | ${comArma} com arma | principal: ${arma}`);
    } catch (error) {
      console.log(`  ${folder} | sidecar ilegível: ${String(error)}`);
    }
  }
}

clipReport();
