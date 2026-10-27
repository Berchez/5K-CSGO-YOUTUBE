import '../src/env.js';
import path from 'node:path';
import { repoPath } from '../src/paths.js';
import { loadWatchlistFile, resolveMatchRule, resolvePlayerRule } from '../src/watchlist.js';

function argValue(prefix: string): string | undefined {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 2 && n <= 5 ? n : fallback;
}

const fileArg = argValue('--file=');
const file = fileArg ? path.resolve(fileArg) : repoPath('data', 'watchlist.json');
const starsRaw = Number(argValue('--stars=') ?? '0');
const stars = Number.isFinite(starsRaw) ? Math.max(0, Math.min(5, Math.trunc(starsRaw))) : 0;
const teams = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const player = argValue('--player=');
const starredMinKills = envInt(process.env.MIN_KILLS, 4);
const unstarredMinKills = envInt(process.env.MIN_KILLS_NO_STARS, 5);

const loaded = loadWatchlistFile(file);
console.log(`arquivo: ${path.relative(process.cwd(), file) || file}`);
console.log(
  `status: ${
    loaded.missing
      ? 'ausente (watchlist desligada)'
      : loaded.error
        ? `inválida — ${loaded.error}`
        : 'ok'
  } | enabled=${loaded.doc.enabled} times=${loaded.doc.teams.length} jogadores=${loaded.doc.players.length}`,
);
if (loaded.error) process.exitCode = 1;

if (loaded.doc.teams.length > 0) {
  console.log('times:');
  for (const team of loaded.doc.teams) {
    const minKills = team.minKills ?? `herda ${loaded.doc.defaults.minKills}`;
    console.log(
      `  - ${team.names.join(' / ')} | minKills=${minKills} | enabled=${team.enabled}`,
    );
  }
}

if (teams.length > 0) {
  const fallback = stars >= 1 ? starredMinKills : unstarredMinKills;
  const rule = resolveMatchRule(loaded.doc, teams, fallback);
  console.log('');
  console.log(
    `partida: ${teams.join(' vs ')} | ${stars}★ | fallback=${fallback}k (MIN_KILLS=${starredMinKills}, MIN_KILLS_NO_STARS=${unstarredMinKills})`,
  );
  console.log(
    `resultado: ${rule.watchlisted ? 'GRAVA' : 'filtro por estrelas'} | minKills=${rule.minKills}${
      rule.matchedTeams.length > 0 ? ` | times=${rule.matchedTeams.join(', ')}` : ''
    }`,
  );
}

if (player) {
  const rule = resolvePlayerRule(loaded.doc, player);
  console.log('');
  console.log(
    `jogador "${player}": ${
      rule
        ? `minKills=${rule.minKills} clutch=${rule.clutch ? 'on' : 'off'} (${rule.matchedName})`
        : 'fora da watchlist (usa o limiar da partida)'
    }`,
  );
}
