import '../src/env.js';
import path from 'node:path';
import { repoPath } from '../src/paths.js';
import { matchPassesFilter } from '../src/monitor/hltvMonitor.js';
import {
  loadWatchlistFile,
  resolveKillerMinKills,
  resolveMatchRule,
  resolvePlayerRule,
} from '../src/watchlist.js';

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
const playerTeam = argValue('--player-team=');
const starredMinKills = envInt(process.env.MIN_KILLS, 4);
const unstarredMinKills = envInt(process.env.MIN_KILLS_NO_STARS, 5);
// A política geral é CALCULADA (MIN_STARS/TOP_TIER_ONLY), não digitada:
// `--general` só força o "sim" para simular uma partida que passa.
const minStarsEnv = Number(process.env.MIN_STARS ?? '0');
const minStars = Number.isFinite(minStarsEnv) ? Math.max(0, Math.min(5, Math.trunc(minStarsEnv))) : 0;
const topTierOnly = /^(1|true|on|yes)$/i.test(String(process.env.TOP_TIER_ONLY ?? '').trim());
const generalByFilter = matchPassesFilter(stars, false, minStars, topTierOnly);
const passesGeneral = process.argv.includes('--general') ? true : generalByFilter;

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
    const minStars = team.minStars ?? `herda ${loaded.doc.defaults.minStars}`;
    console.log(
      `  - ${team.names.join(' / ')} | minKills=${minKills} | minStars=${minStars} | enabled=${team.enabled}`,
    );
  }
}

/** O override da watchlist está ativo na partida simulada? */
let overrideActive = false;

if (teams.length > 0) {
  const fallback = stars >= 1 ? starredMinKills : unstarredMinKills;
  const rule = resolveMatchRule(loaded.doc, teams, fallback, stars);
  // O override é POR TIME: vale se ALGUM time da partida atendeu o piso
  // DELE (não o menor piso da partida).
  overrideActive = rule.watchlisted && rule.teams.some((team) => team.floorMet);
  console.log('');
  console.log(
    `partida: ${teams.join(' vs ')} | ${stars}★ | fallback=${fallback}k (MIN_KILLS=${starredMinKills}, MIN_KILLS_NO_STARS=${unstarredMinKills})`,
  );
  console.log(
    `política geral (MIN_STARS=${minStars}, TOP_TIER_ONLY=${topTierOnly}): ${
      passesGeneral ? 'passa' : 'NÃO passa'
    }`,
  );
  console.log(
    `resultado: ${
      overrideActive
        ? 'GRAVA (override da watchlist)'
        : passesGeneral
          ? 'grava pela política geral (sem override da watchlist)'
          : 'não entra'
    } | minKills=${overrideActive ? rule.minKills : fallback}${
      rule.matchedTeams.length > 0 ? ` | times=${rule.matchedTeams.join(', ')}` : ''
    }`,
  );
  if (rule.watchlisted) {
    for (const team of rule.teams) {
      console.log(
        `piso de estrelas do time ${team.team}: minStars=${team.minStars} | ${stars}★ ${
          team.floorMet ? 'atende' : 'NÃO atende'
        } o piso`,
      );
    }
  }
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
  const killer = resolveKillerMinKills({
    doc: loaded.doc,
    player,
    playerTeam: playerTeam,
    passesGeneral: passesGeneral,
    generalMinKills: stars >= 1 ? starredMinKills : unstarredMinKills,
    // O override vem da PARTIDA (times + estrelas), não de `false` fixo:
    // sem ele o limiar do time nunca aparecia no diagnóstico.
    watchlistOverride: overrideActive,
    stars,
  });
  console.log(
    `decisão do round (time=${playerTeam || 'desconhecido'}, partida passa no filtro geral=${passesGeneral}): ${
      killer.minKills === null
        ? 'BLOQUEADO (não gera clipe)'
        : `minKills=${killer.minKills} (${killer.source})`
    }`,
  );
}
