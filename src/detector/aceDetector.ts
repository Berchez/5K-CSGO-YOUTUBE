import type { AnchorConfidence, KillEvent, RoundSummary } from '../types.js';

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
 * Selo do multikill pelo nº de kills: ACE (5+), 3K, 4K — mesma convenção
 * em título, thumb, descrição e prompt IA. Sem dado (<3) cai no legado ACE!.
 */
export function killLabel(killCount: number): string {
  return killCount >= 5 ? 'ACE' : killCount >= 3 ? `${killCount}K` : 'ACE';
}

export interface MultiKill {
  player: string;
  kills: KillEvent[];
}

/**
 * Detecta multikill: jogador com mais kills no round, exigindo ao menos
 * minKills (default 3: 3k/4k/5k). Desempate: quem chegou primeiro.
 * Retorna null se ninguém atingir o mínimo.
 */
export function detectMultiKill(kills: KillEvent[], minKills = 3): MultiKill | null {
  const byPlayer = new Map<string, KillEvent[]>();
  const order: string[] = [];
  for (const k of kills) {
    const name = k.killer.trim();
    if (!name || isRoundMarker(name)) continue;
    const key = name.toLowerCase();
    if (!byPlayer.has(key)) {
      byPlayer.set(key, []);
      order.push(key);
    }
    byPlayer.get(key)!.push(k);
  }
  let best: string | null = null;
  for (const key of order) {
    const n = byPlayer.get(key)!.length;
    if (n >= minKills && (!best || n > byPlayer.get(best)!.length)) best = key;
  }
  if (!best) return null;
  const arr = byPlayer.get(best)!;
  return { player: arr[0].killer.trim(), kills: arr };
}

/**
 * Detecta ACE num round já fechado.
 * Retorna o nome do jogador se os 5 kills são do mesmo player (ignora markers).
 * Retorna null caso contrário.
 */
export function detectAceInRound(kills: KillEvent[]): string | null {
  const m = detectMultiKill(kills, 5);
  return m && m.kills.length === 5 ? m.player : null;
}

/** Acumulador de kills do round atual. Substitui a lógica frágil de todosMatadores. */
export class RoundTracker {
  private kills: KillEvent[] = [];
  private seen = new Set<string>();
  /** Última contagem de kills vista por jogador (placar) — base do diff. */
  private lastCounts = new Map<string, number>();
  /** Última contagem de deaths vista por jogador — alimenta as vítimas. */
  private lastDeaths = new Map<string, number>();
  private round = 1;
  private map = 'unknown';
  /**
   * Sinais de (des)confiança na âncora de início, consumidos por round:
   * startedBlind = tracking começou/retomou no meio do round corrente
   * (kills anteriores invisíveis); hadReset = base reancorada (gap) neste
   * round. Lidos ao fechar o round, zerados no round seguinte.
   */
  private startedBlind = false;
  private hadReset = false;

  constructor(map = 'unknown', round = 1) {
    this.map = map;
    this.round = round;
  }

  setContext(map: string, round: number): void {
    if (map !== this.map || round !== this.round) {
      this.map = map;
      this.round = round;
      this.kills = [];
      this.seen.clear();
      // lastCounts NÃO zera aqui: é reancorado no próximo syncBaseline
      // (sem spike falso). round novo começa com os mesmos totais.
    }
    // Flags são consumidas por round: setContext roda 1x por virada —
    // o próximo round começa sem herança de suspeita do anterior.
    this.startedBlind = false;
    this.hadReset = false;
  }

  /** Tracking começou/retomou com o round já em andamento. */
  markJoinedBlind(): void {
    this.startedBlind = true;
  }

  /** Sinais atuais (leitura não consome — setContext zera na virada). */
  anchorFlags(): { joinedMidRound: boolean; resetThisRound: boolean } {
    return { joinedMidRound: this.startedBlind, resetThisRound: this.hadReset };
  }

  addKill(
    killer: string,
    victim: string,
    detail: Partial<Omit<KillEvent, 'killer' | 'victim' | 'round' | 'map'>> = {},
  ): void {
    if (isRoundMarker(killer)) return;
    // Polling relê o mesmo killfeed a cada ciclo: dedup por killer+vítima
    // para a contagem do round ser exata (sem isso um 3k vira 6, 9, 12...).
    // Kills sintetizados do placar (vítima '') nunca repetem — a guarda
    // exata é o lastCounts no syncBaseline — então contam sempre.
    if (victim.trim()) {
      const key = `${killer.trim().toLowerCase()}|${victim.trim().toLowerCase()}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.kills.push({
      killer,
      victim,
      round: this.round,
      map: this.map,
      at: detail.at ?? Date.now(),
      weapon: normWeapon(detail.weapon) || undefined,
      headshot: detail.headshot,
      assistBy: detail.assistBy,
      flashAssistBy: detail.flashAssistBy,
      throughSmoke: detail.throughSmoke,
      wallbang: detail.wallbang,
      noscope: detail.noscope,
    });
  }

  /**
   * Sincroniza contadores do placar (chamado a cada poll, após setContext).
   * Diferenciais da coluna K viram kills sintetizados; os da coluna D
   * (deaths) alimentam o pool de VÍTIMAS do poll — casadas na ordem do
   * scoreboard (conjunto correto; pareamento exato exige killfeed).
   * Nome novo ou contagem menor só reancora (sem spike falso). É a guarda
   * exata contra re-observação — dispensa dedup para sintetizados.
   *
   * Retorna true quando alguma contagem DIMINUIU (o HLTV zerou/reiniciou as
   * stats: troca de mapa ou repopulação durante o break). Nesse caso não
   * sintetiza diffs e deixa o chamador decidir se as kills pendentes ainda
   * valem (virada de round) ou são de outra época (mudança só de stats).
   */
  syncBaseline(players: Array<{ name: string; kills: number; deaths?: number }>): boolean {
    let statsReset = false;
    for (const p of players) {
      const rawName = p.name.trim();
      if (!rawName || isRoundMarker(rawName)) continue;
      const key = rawName.toLowerCase();
      const prevK = this.lastCounts.get(key);
      if (prevK !== undefined && p.kills < prevK) statsReset = true;
      const prevD = this.lastDeaths.get(key);
      if (prevD !== undefined && (p.deaths ?? 0) < prevD) statsReset = true;
    }
    if (statsReset) {
      // Época nova de stats: reancora sem gerar kills. As pendentes ficam
      // com o chamador (round fechando ainda pode emitir o que já viu).
      this.lastCounts.clear();
      this.lastDeaths.clear();
      for (const p of players) {
        const rawName = p.name.trim();
        if (!rawName || isRoundMarker(rawName)) continue;
        const key = rawName.toLowerCase();
        this.lastCounts.set(key, p.kills);
        this.lastDeaths.set(key, p.deaths ?? 0);
      }
      return true;
    }
    const newKills: Array<{ name: string; n: number }> = [];
    const victimPool: string[] = [];
    for (const p of players) {
      const rawName = p.name.trim();
      if (!rawName || isRoundMarker(rawName)) continue;
      const key = rawName.toLowerCase();
      const prevK = this.lastCounts.get(key);
      if (prevK === undefined || p.kills !== prevK) {
        if (prevK !== undefined && p.kills > prevK) {
          newKills.push({ name: rawName, n: p.kills - prevK });
        }
        this.lastCounts.set(key, p.kills);
      }
      const d = p.deaths ?? 0;
      const prevD = this.lastDeaths.get(key);
      if (prevD === undefined || d !== prevD) {
        if (prevD !== undefined && d > prevD) {
          for (let i = 0; i < d - prevD; i++) victimPool.push(rawName);
        }
        this.lastDeaths.set(key, d);
      }
    }
    // Excesso de mortes = bomba/queda (não vira vítima de ninguém);
    // falta = kill sem vítima conhecida ('' — honesto nos textos).
    let vi = 0;
    for (const k of newKills) {
      for (let i = 0; i < k.n; i++) {
        const victim = vi < victimPool.length ? victimPool[vi++] : '';
        this.addKill(k.name, victim);
      }
    }
    return false;
  }

  /**
   * Descarta as kills pendentes do round (stats reiniciaram no meio dele:
   * break/troca de mapa sem virada de placar). Marca hadReset para a próxima
   * âncora nascer suspeita — nada de emitir clipe de kills de outra época.
   */
  discardPending(): void {
    this.kills = [];
    this.seen.clear();
    this.hadReset = true;
  }
  /**
   * Fecha o round e retorna o autor do multikill (3k/4k/5k), se houver —
   * sempre a contagem MÁXIMA do round (um evento por round/jogador, sem
   * duplicar 3k→4k→5k). kills = SÓ os do autor (metadados honestos).
   */
  closeRound(minKills = 3): { player: string | null; kills: KillEvent[] } {
    const m = detectMultiKill(this.kills, minKills);
    const kills = m ? m.kills : [];
    this.kills = [];
    this.seen.clear();
    this.round += 1;
    return { player: m?.player ?? null, kills };
  }

  reset(round = 1): void {
    this.kills = [];
    this.seen.clear();
    this.lastCounts.clear();
    this.lastDeaths.clear();
    this.round = round;
    // Reancoragem (gap) no meio do round: kills anteriores invisíveis —
    // a próxima âncora deste round nasce suspeita.
    this.hadReset = true;
  }

  get pending(): number {
    return this.kills.length;
  }
}

/**
 * Âncora de baixa confiança? Qualquer sinal: entrou no meio do round,
 * resetou a base, ou a 1ª kill foi observada na janela de assentamento
 * (últimos 12s antes do fechamento — cobre o settle de 10s + folga).
 * Ausente = confiança alta (comportamento legado). Puro/testável.
 */
export function isAnchorLowConfidence(
  conf: AnchorConfidence | undefined,
  firstKillAtMs: number | undefined,
  closedAtMs: number,
): boolean {
  if (!conf) return false;
  if (conf.joinedMidRound || conf.resetThisRound) return true;
  if (
    conf.settleKills > 0 &&
    firstKillAtMs != null &&
    closedAtMs - firstKillAtMs < 12_000
  ) {
    return true;
  }
  return false;
}

/** Monta o resumo rico de um round de multikill (3k/4k/5k do mesmo jogador). */
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
 * Narrativa completa do multikill em PT-BR — alimenta descrição do YouTube,
 * prompt da IA de thumbnail e qualquer resumo automático.
 */
export function describeAce(s: RoundSummary, event: string): string {
  const n = s.kills.length;
  const label = killLabel(n);
  const kn = n >= 5 ? '5K' : `${n}K`;
  const head = s.team
    ? `${label}! ${s.player} (${s.team}) fez ${kn} contra ${s.opponents} — ${event}, ${s.map}, round ${s.round}.`
    : `${label}! ${s.player} fez ${kn} em ${s.opponents} — ${event}, ${s.map}, round ${s.round}.`;
  const lines = [head, ...s.kills.map((k, i) => killLine(k, i))];
  if (s.headshots > 0) lines.push(`Headshots: ${s.headshots}/${n}.`);
  if (s.mainWeapon) {
    const mw = s.weapons.filter((w) => w === s.mainWeapon).length;
    lines.push(`Arma principal: ${prettyWeapon(s.mainWeapon)} (${mw}/${n} kills).`);
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
