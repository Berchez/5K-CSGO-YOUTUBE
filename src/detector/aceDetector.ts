import type { KillEvent, RoundSummary } from '../types.js';

/** Nomes que indicam fim de round / reset no killfeed (não são killers). */
const ROUND_MARKERS = new Set(['T', 'CT', 'ROUND STARTED', 'ROUND OVER', 'PLANTED']);

export function isRoundMarker(name: string): boolean {
  return ROUND_MARKERS.has(name.trim().toUpperCase());
}

/** Normaliza nome de arma para chave canônica minúscula. */
export function normWeapon(w: string | undefined): string {
  if (!w) return '';
  return w
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^weapon/, '');
}

const PRETTY: Record<string, string> = {
  ak47: 'AK-47',
  awp: 'AWP',
  m4a1: 'M4A1-S',
  m4a4: 'M4A4',
  deagle: 'Desert Eagle',
  usp: 'USP-S',
  glock: 'Glock',
  famas: 'FAMAS',
  galil: 'Galil',
  aug: 'AUG',
  sg553: 'SG 553',
  ssg08: 'SSG 08',
  g3sg1: 'G3SG1',
  scar20: 'SCAR-20',
  mac10: 'MAC-10',
  mp9: 'MP9',
  mp7: 'MP7',
  ump45: 'UMP-45',
  p90: 'P90',
  nova: 'Nova',
  xm1014: 'XM1014',
  mag7: 'MAG-7',
  sawedoff: 'Sawed-Off',
  negev: 'Negev',
  m249: 'M249',
  tec9: 'Tec-9',
  cz75: 'CZ75',
  fiveseven: 'Five-SeveN',
  p250: 'P250',
  elite: 'Dual Berettas',
  deagle2: 'Desert Eagle',
  revolver: 'R8 Revolver',
  hegrenade: 'HE Grenade',
  molotov: 'Molotov',
  incgrenade: 'Incendiary',
  flashbang: 'Flashbang',
  smokegrenade: 'Smoke',
  knife: 'Knife',
  taser: 'Zeus',
  inferno: 'Molotov/Incendiary',
  // aliases pós-normalização (espaços/hífens removidos)
  deserteagle: 'Desert Eagle',
  dualberettas: 'Dual Berettas',
  r8revolver: 'R8 Revolver',
  usps: 'USP-S',
};

export function prettyWeapon(w: string): string {
  const k = normWeapon(w);
  if (!k) return '';
  return PRETTY[k] ?? w;
}

/**
 * Detecta ACE num round já fechado.
 * Retorna o nome do jogador se os 5 kills são do mesmo player (ignora markers).
 * Retorna null caso contrário.
 */
export function detectAceInRound(kills: KillEvent[]): string | null {
  const killers = kills
    .map((k) => k.killer.trim())
    .filter((n) => n.length > 0 && !isRoundMarker(n));
  if (killers.length !== 5) return null;
  const first = killers[0].toLowerCase();
  if (killers.every((k) => k.toLowerCase() === first)) return killers[0];
  return null;
}

/** Acumulador de kills do round atual. Substitui a lógica frágil de todosMatadores. */
export class RoundTracker {
  private kills: KillEvent[] = [];
  private round = 1;
  private map = 'unknown';

  constructor(map = 'unknown', round = 1) {
    this.map = map;
    this.round = round;
  }

  setContext(map: string, round: number): void {
    this.map = map;
    this.round = round;
  }

  addKill(
    killer: string,
    victim: string,
    detail: Partial<Omit<KillEvent, 'killer' | 'victim' | 'round' | 'map'>> = {},
  ): void {
    if (isRoundMarker(killer)) return;
    this.kills.push({
      killer,
      victim,
      round: this.round,
      map: this.map,
      at: Date.now(),
      weapon: normWeapon(detail.weapon) || undefined,
      headshot: detail.headshot,
      assistBy: detail.assistBy,
      flashAssistBy: detail.flashAssistBy,
      throughSmoke: detail.throughSmoke,
      wallbang: detail.wallbang,
      noscope: detail.noscope,
    });
  }

  /** Fecha o round e retorna o nome do autor do ace, se houver. */
  closeRound(): { ace: string | null; kills: KillEvent[] } {
    const ace = detectAceInRound(this.kills);
    const kills = [...this.kills];
    this.kills = [];
    this.round += 1;
    return { ace, kills };
  }

  reset(round = 1): void {
    this.kills = [];
    this.round = round;
  }

  get pending(): number {
    return this.kills.length;
  }
}

/** Monta o resumo rico de um round de ace (5 kills do mesmo jogador). */
export function buildRoundSummary(
  player: string,
  team: string,
  opponents: string,
  kills: KillEvent[],
): RoundSummary {
  const weapons = kills.map((k) => normWeapon(k.weapon));
  const headshots = kills.filter((k) => k.headshot).length;
  const assists = kills.flatMap((k, i) =>
    k.assistBy ? [{ by: k.assistBy, killIndex: i + 1 }] : [],
  );
  const flashAssists = kills.flatMap((k, i) =>
    k.flashAssistBy ? [{ by: k.flashAssistBy, killIndex: i + 1 }] : [],
  );
  const grenades = kills.flatMap((k) =>
    k.weapon && ['hegrenade', 'molotov', 'incgrenade', 'inferno'].includes(k.weapon)
      ? [{ player: k.killer, kind: k.weapon === 'hegrenade' ? 'he' as const : 'molotov' as const }]
      : [],
  );
  const counts = new Map<string, number>();
  for (const w of weapons) {
    if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const mainWeapon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return {
    round: kills[0]?.round ?? 0,
    map: kills[0]?.map ?? 'unknown',
    player,
    team,
    opponents,
    kills,
    victims: kills.map((k) => k.victim).filter(Boolean),
    weapons,
    headshots,
    assists,
    flashAssists,
    grenades,
    mainWeapon,
  };
}

function killLine(k: KillEvent, i: number): string {
  const w = prettyWeapon(k.weapon ?? '');
  const bits = [
    `${i + 1}. ${k.killer} matou ${k.victim || '?'}`,
    w ? `de ${w}` : '',
    k.headshot ? '(HS)' : '',
    k.noscope ? '(no-scope)' : '',
    k.wallbang ? '(wallbang)' : '',
    k.assistBy ? `[assist: ${k.assistBy}]` : '',
    k.flashAssistBy ? `[flash: ${k.flashAssistBy}]` : '',
  ].filter(Boolean);
  return bits.join(' ');
}

/**
 * Narrativa completa do ace em PT-BR — alimenta descrição do YouTube,
 * prompt da IA de thumbnail e qualquer resumo automático.
 */
export function describeAce(s: RoundSummary, event: string): string {
  const head = s.team
    ? `ACE! ${s.player} (${s.team}) fez 5K contra ${s.opponents} — ${event}, ${s.map}, round ${s.round}.`
    : `ACE! ${s.player} fez 5K em ${s.opponents} — ${event}, ${s.map}, round ${s.round}.`;
  const lines = [head, ...s.kills.map((k, i) => killLine(k, i))];
  if (s.headshots > 0) lines.push(`Headshots: ${s.headshots}/5.`);
  if (s.mainWeapon) {
    const n = s.weapons.filter((w) => w === s.mainWeapon).length;
    lines.push(`Arma principal: ${prettyWeapon(s.mainWeapon)} (${n}/5 kills).`);
  }
  if (s.flashAssists.length > 0) {
    lines.push(
      `Flashes decisivas de: ${[...new Set(s.flashAssists.map((f) => f.by))].join(', ')}.`,
    );
  }
  if (s.grenades.length > 0) {
    lines.push(
      `Granadas de dano no round: ${s.grenades.map((g) => `${g.player} (${g.kind.toUpperCase()})`).join(', ')}.`,
    );
  }
  return lines.join('\n');
}
