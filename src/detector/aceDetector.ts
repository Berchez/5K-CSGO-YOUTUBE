import type { AnchorConfidence, KillEvent, KillfeedTelemetry, RoundSummary } from '../types.js';
import { normalizeMapName, type ScorebotKill } from './scorebotLog.js';

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
  // aliases do scorebot (o nome vem com o sufixo do silenciador/estilo)
  uspsilencer: 'USP-S',
  m4a1silencer: 'M4A1-S',
  knifebutterfly: 'Butterfly Knife',
  knifeflip: 'Flip Knife',
  knifegut: 'Gut Knife',
  knifekukri: 'Kukri Knife',
  knifekarambit: 'Karambit',
  knifeclassic: 'Classic Knife',
  knifebayonet: 'Bayonet',
  flash: 'Flashbang',
  smoke: 'Smoke',
  decoy: 'Decoy',
  decoygrenade: 'Decoy',
  molly: 'Molotov',
  incendiary: 'Incendiary',
  scout: 'SSG 08',
  mp5sd: 'MP5-SD',
  sg556: 'SG 556',
  galilar: 'Galil AR',
  cz75auto: 'CZ75',
  r8: 'R8 Revolver',
};

export function prettyWeapon(w: string): string {
  const k = normWeapon(w);
  if (!k) return '';
  return PRETTY[k] ?? w;
}

/**
 * O placar ainda não sabe o mapa (placeholder) — nesse caso o detalhe do
 * killfeed não pode ser descartado por divergência de mapa.
 */
export function isPlaceholderMap(map: string): boolean {
  const v = (map ?? '').trim().toLowerCase();
  return !v || v === 'unknown' || /^map\d*$/.test(v);
}

/**
 * Selo do multikill pelo nº de kills: ACE (5+), 2K, 3K, 4K — mesma
 * convenção em título, thumb, descrição e prompt IA. Sem dado (<2) cai no
 * legado ACE!.
 */
export function killLabel(killCount: number): string {
  if (killCount >= 5) return 'ACE';
  if (killCount >= 2) return `${killCount}K`;
  return 'ACE';
}

export interface MultiKill {
  player: string;
  kills: KillEvent[];
}

/** Limiar fixo ou por jogador (watchlist de jogadores). */
export type MinKillsRule = number | ((player: string) => number);

export function requiredKills(rule: MinKillsRule, player: string): number {
  if (typeof rule !== 'function') return rule;
  const n = rule(player);
  // Infinity = bloqueio explícito (ex.: adversário em partida que só
  // entrou pela watchlist): nunca gera clipe.
  if (n === Number.POSITIVE_INFINITY) return n;
  // Resolver quebrado não pode virar clipe a torto: exige o máximo.
  return Number.isFinite(n) ? n : 5;
}

/**
 * Agrupa as kills do round por matador, preservando a ordem de chegada
 * (desempate do multikill: quem apareceu primeiro). Markers de round
 * ("Round over" e afins) não são jogadores.
 */
function groupByKiller(kills: KillEvent[]): {
  order: string[];
  byPlayer: Map<string, KillEvent[]>;
} {
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
  return { order, byPlayer };
}

/**
 * Candidato do round para DIAGNÓSTICO: quem fez mais kills, sem olhar o
 * limiar (empate fica com quem apareceu primeiro). Existe porque "round
 * fechado sem multikill" não distinguia "ninguém chegou perto" de "fez 4 e
 * o limiar era 5" — a dúvida que mais aparece no painel (watchlist ×
 * estrelas × sem avaliação).
 */
export function topKiller(kills: KillEvent[]): { player: string; kills: number } | null {
  const { order, byPlayer } = groupByKiller(kills);
  let best: string | null = null;
  for (const key of order) {
    const n = byPlayer.get(key)!.length;
    if (!best || n > byPlayer.get(best)!.length) best = key;
  }
  if (!best) return null;
  const arr = byPlayer.get(best)!;
  return { player: arr[0].killer.trim(), kills: arr.length };
}

/**
 * Detecta multikill: jogador com mais kills no round, exigindo ao menos
 * minKills (default 3: 3k/4k/5k). Desempate: quem chegou primeiro.
 * minKills pode ser um número ou uma função por jogador (watchlist).
 * Retorna null se ninguém atingir o mínimo.
 */
export function detectMultiKill(
  kills: KillEvent[],
  minKills: MinKillsRule = 3,
): MultiKill | null {
  const { order, byPlayer } = groupByKiller(kills);
  let best: string | null = null;
  for (const key of order) {
    const arr = byPlayer.get(key)!;
    const n = arr.length;
    if (n < requiredKills(minKills, arr[0].killer.trim())) continue;
    if (!best || n > byPlayer.get(best)!.length) best = key;
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
  /**
   * Kills do killfeed do scorebot (arma/headshot/assist) que ainda não
   * têm uma kill do placar para parear. O placar só conta K/D; o detalhe
   * entra nesta fila e é copiado para a kill correspondente.
   */
  private feedQueue: ScorebotKill[] = [];
  /** Kills já enriquecidas (o scorebot pode chegar antes ou depois). */
  private readonly fed = new WeakSet<KillEvent>();
  /**
   * Contadores do pareamento do round CORRENTE (quanto do placar já foi
   * completado pelo killfeed). Viram a telemetria do sidecar.
   */
  private feedState: KillfeedTelemetry = { paired: 0, total: 0, feedKills: 0, eventIds: [] };
  /**
   * Último DRIFT de round seen (feed × placar) — diagnóstico do porquê
   * de uma kill não ter pareado.
   */
  private lastRoundDrift: {
    feedRound: number;
    placarRound: number;
    killer: string;
  } | null = null;
  /**
   * Round já FECHADO, mantido vivo por uma carência: o killfeed às vezes
   * chega depois da virada do placar e, sem isto, a última kill ficaria
   * sem arma/headshot para sempre (o sidecar é escrito minutos depois).
   */
  private closedRound: {
    kills: KillEvent[];
    round: number;
    map: string;
    atMs: number;
    state: KillfeedTelemetry;
  } | null = null;
  /** Carência do enriquecimento tardio (ms). */
  private readonly lateEnrichMs: number;
  /**
   * Candidato do último round fechado (quem fez mais kills, sem limiar).
   * Diagnóstico: o chamador loga junto do "sem multikill" para dizer
   * QUANTO faltou e para quem.
   */
  private lastBest: { player: string; kills: number } | null = null;
  /**
   * Mapa/round do último round FECHADO. `snap.round` já é o round seguinte
   * quando o placar vira: sem isto o log do round fechado saía com o número
   * de UM round à frente (dificultava casar com o "multikill detectado").
   */
  private lastClosed: { map: string; round: number } | null = null;

  constructor(map = 'unknown', round = 1, opts: { lateEnrichMs?: number } = {}) {
    this.map = map;
    this.round = round;
    this.lateEnrichMs = Math.max(0, opts.lateEnrichMs ?? 60_000);
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
    // O killfeed do round anterior não pareia mais nada.
    this.pruneFeed();
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
    const stored: KillEvent = {
      killer,
      victim,
      round: this.round,
      map: this.map,
      at: detail.at ?? Date.now(),
      // A origem e a qualidade do instante são parte do dado, não
      // decoração: o placar sintetiza a kill, enquanto uma leitura
      // direta (killfeed/demo) tem precisão e origem diferentes.
      ...(detail.atSource ? { atSource: detail.atSource } : {}),
      ...(detail.atVodSec != null ? { atVodSec: detail.atVodSec } : {}),
      ...(detail.appearEstimated != null ? { appearEstimated: detail.appearEstimated } : {}),
      ...(detail.estimated != null ? { estimated: detail.estimated } : {}),
      weapon: normWeapon(detail.weapon) || undefined,
      headshot: detail.headshot,
      assistBy: detail.assistBy,
      flashAssistBy: detail.flashAssistBy,
      throughSmoke: detail.throughSmoke,
      wallbang: detail.wallbang,
      noscope: detail.noscope,
    };
    this.kills.push(stored);
    // Se o killfeed já tinha chegado, completa a kill agora (vítima,
    // arma, headshot, assistência) em vez de perder o detalhe.
    this.pairFeed(stored);
  }

  /**
   * Kill vinda do killfeed do scorebot (fonte canônica de arma/headshot/
   * assistência). Se a kill do placar correspondente já está no round, o
   * detalhe é aplicado na hora; senão fica na fila para quando ela chegar.
   *
   * O pareamento prefere a MESMA vítima; a kill do placar pode estar com a
   * vítima trocada (a coluna D é casada por ordem) e nesse caso o
   * pareamento por ordem ainda a corrige.
   */
  noteFeedKill(kill: ScorebotKill): void {
    if (!kill || !kill.killer.trim() || !kill.victim.trim()) return;
    // Round já fechado: o killfeed atrasado ainda completa a kill.
    if (this.noteLateFeedKill(kill)) return;
    // Backlog do replay: quando o tracking começou no meio do round, as
    // kills anteriores a ele não têm par (o placar só conta daqui pra
    // frente) — parear por ordem trocaria a vítima.
    if (kill.replay && this.startedBlind) return;
    const mapKey = normalizeMapName(this.map);
    if (kill.map && !isPlaceholderMap(mapKey) && kill.map !== mapKey) return;
    // Round conhecido nos DOIS lados: só o mesmo round pareia. O passado
    // não tem mais par; o futuro ainda não virou no placar — fica na
    // fila (parear agora trocaria a vítima pela do round seguinte).
    if (kill.round > 0 && this.round > 0 && kill.round < this.round) {
      // DRIFT: o round do feed (contado por `RoundStart`) é MENOR que o
      // do placar (`ct+t+1`). A kill é descartada — sem o contador, o
      // detalhe que faltou parecia um bug do killfeed.
      this.noteRoundDrift(kill, this.round);
      return;
    }
    this.feedState.feedKills += 1;
    if (kill.eventId) this.feedState.eventIds.push(kill.eventId);
    if (kill.round > 0 && this.round > 0 && kill.round > this.round) {
      // DRIFT para frente: a kill do round QUE VEM fica na fila. Se o
      // placar nunca virar (round reiniciado), ela pode parear com a
      // kill do round seguinte — o contador mostra que isso aconteceu.
      this.noteRoundDrift(kill, this.round);
      this.enqueueFeed(kill);
      return;
    }
    if (this.pairFeedKill(kill, this.kills, this.feedState)) return;
    this.enqueueFeed(kill);
  }

  /**
   * Contabiliza o DRIFT de round entre o killfeed e o placar.
   *
   * O round do feed é contado pelos `RoundStart` do scorebot e o do
   * placar é `ct+t+1`: quando um dos dois erra (reconexão, restart de
   * round, OT), a kill não pareia — ou fica na fila esperando o round
   * seguinte (e pode parear com a kill errada). O contador deixa o
   * problema VISÍVEL (log + sidecar) em vez de virar detalhe faltando
   * sem explicação.
   */
  private noteRoundDrift(kill: ScorebotKill, placarRound: number): void {
    const state = this.closedRound?.state ?? this.feedState;
    state.roundDrift = (state.roundDrift ?? 0) + 1;
    this.lastRoundDrift = {
      feedRound: kill.round,
      placarRound,
      killer: kill.killer,
    };
  }

  /**
   * O último DRIFT de round seen (diagnóstico: qual round o feed
   * mandou contra qual round o placar tinha).
   */
  lastDrift(): { feedRound: number; placarRound: number; killer: string } | null {
    return this.lastRoundDrift;
  }

  /** Guarda a kill do feed para o placar chegar (com teto de segurança). */
  private enqueueFeed(kill: ScorebotKill): void {
    // `setContext`/`pruneFeed` descartam o round antigo; o teto só existe
    // para uma reconexão que nunca vira de round não crescer sem fim.
    if (this.feedQueue.length >= 64) this.feedQueue.shift();
    this.feedQueue.push(kill);
  }

  /**
   * Liga uma kill do killfeed a uma kill do placar.
   *
   * Prefere a vítima EXATA (o caso normal). Sem ela, usa a 1ª kill do
   * mesmo autor ainda sem par: o placar casa a coluna de mortes por
   * ordem e às vezes erra a vítima (quem matou no mesmo round entra na
   * frente). Vale para o round aberto e para o fechado — sem isto, uma
   * kill do placar com a vítima trocada NUNCA era corrigida quando o
   * killfeed chegava depois dela.
   */
  private pairFeedKill(
    feed: ScorebotKill,
    kills: KillEvent[],
    state: KillfeedTelemetry,
  ): boolean {
    const killerKey = feed.killer.trim().toLowerCase();
    const victimKey = feed.victim.trim().toLowerCase();
    let target = kills.find(
      (stored) =>
        !this.fed.has(stored) &&
        stored.killer.trim().toLowerCase() === killerKey &&
        stored.victim.trim().toLowerCase() === victimKey,
    );
    target ??= kills.find(
      (stored) =>
        !this.fed.has(stored) && stored.killer.trim().toLowerCase() === killerKey,
    );
    if (!target) return false;
    this.applyFeed(target, feed, state);
    return true;
  }

  /** O round da kill do feed pode parear com o round corrente? */
  private feedRoundOk(kill: ScorebotKill): boolean {
    return kill.round <= 0 || this.round <= 0 || kill.round === this.round;
  }

  /**
   * Kill do scorebot que chegou DEPOIS do fechamento do round.
   *
   * O round fechado continua vivo por uma carência (`lateEnrichMs`): o
   * killfeed costuma andar junto do placar, mas uma conexão lenta ou uma
   * reconexão entrega a kill depois da virada. Sem isto, a última kill
   * do round ficaria sem arma/headshot/vítima corrigida.
   *
   * Devolve `true` quando a kill foi absorvida pelo round fechado.
   */
  private noteLateFeedKill(kill: ScorebotKill): boolean {
    const closed = this.closedRound;
    if (!closed) return false;
    if (Date.now() - closed.atMs > this.lateEnrichMs) return false;
    if (kill.round > 0 && closed.round > 0 && kill.round !== closed.round) return false;
    const mapKey = normalizeMapName(closed.map);
    if (kill.map && !isPlaceholderMap(mapKey) && kill.map !== mapKey) return false;
    if (!this.pairFeedKill(kill, closed.kills, closed.state)) return false;
    // A kill atrasada também conta como kill do feed do round.
    closed.state.feedKills += 1;
    return true;
  }

  /** Liga uma kill do placar à primeira kill do killfeed do mesmo autor. */
  private pairFeed(stored: KillEvent): void {
    if (this.feedQueue.length === 0) return;
    const killerKey = stored.killer.trim().toLowerCase();
    if (!killerKey) return;
    const mine = this.feedQueue.filter(
      (k) => k.killer.trim().toLowerCase() === killerKey && this.feedRoundOk(k),
    );
    if (mine.length === 0) return;
    const victimKey = stored.victim.trim().toLowerCase();
    const chosen =
      (victimKey ? mine.find((k) => k.victim.trim().toLowerCase() === victimKey) : undefined) ??
      mine[0];
    this.feedQueue.splice(this.feedQueue.indexOf(chosen), 1);
    this.applyFeed(stored, chosen);
  }

  /**
   * Copia o detalhe do killfeed para a kill do placar (fonte vence).
   *
   * `state` é a telemetria do round dono da kill: o round corrente ou o
   * round já fechado (enriquecimento tardio). O `seen` (dedup) só é
   * mexido no round corrente — o do round fechado foi limpo e não pode
   * voltar (senão a mesma vítima morta no round seguinte seria contada
   * como repetida).
   */
  private applyFeed(
    stored: KillEvent,
    feed: ScorebotKill,
    state: KillfeedTelemetry = this.feedState,
  ): void {
    const oldVictim = stored.victim.trim().toLowerCase();
    if (feed.victim.trim()) stored.victim = feed.victim.trim();
    const weapon = normWeapon(feed.weapon);
    if (weapon) stored.weapon = weapon;
    if (feed.headshot != null) stored.headshot = feed.headshot;
    if (feed.assistBy) stored.assistBy = feed.assistBy;
    if (feed.flashAssistBy) stored.flashAssistBy = feed.flashAssistBy;
    if (feed.throughSmoke != null) stored.throughSmoke = feed.throughSmoke;
    if (feed.wallbang != null) stored.wallbang = feed.wallbang;
    if (feed.noscope != null) stored.noscope = feed.noscope;
    this.fed.add(stored);
    state.paired += 1;
    if (!state.eventIds.includes(feed.eventId ?? '')) {
      if (feed.eventId) state.eventIds.push(feed.eventId);
    }
    // O dedup killer|vítima foi semeado com a vítima do PLACAR: troca a
    // chave junto, senão o mesmo kill poderia entrar de novo.
    const newVictim = stored.victim.trim().toLowerCase();
    if (state === this.feedState && oldVictim && newVictim && oldVictim !== newVictim) {
      const killerKey = stored.killer.trim().toLowerCase();
      this.seen.delete(`${killerKey}|${oldVictim}`);
      this.seen.add(`${killerKey}|${newVictim}`);
    }
  }

  /** Descarta do killfeed o que não pode mais parear com este round. */
  private pruneFeed(): void {
    const mapKey = normalizeMapName(this.map);
    const round = this.round;
    this.feedQueue = this.feedQueue.filter((kill) => {
      if (kill.map && !isPlaceholderMap(mapKey) && kill.map !== mapKey) return false;
      if (kill.round > 0 && round > 0 && kill.round < round) return false;
      return true;
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
   * Retorna true quando as stats foram ZERADAS de verdade (troca de mapa ou
   * repopulação durante o break). Queda GRANDE (2+ pontos ou valor zerado)
   * de quem tem kills pendentes, ou queda grande em metade dos jogadores,
   * marca o round como suspecto e ele é descartado. Queda de 1 ponto em quem
   * tem kills pendentes é tratada como glitch de célula: a base é mantida
   * (reancorar para baixo criaria kill fantasma na volta) e o round segue.
   * Queda isolada de jogador SEM kills pendentes só reancora ele; queda da
   * coluna D ilegível não conta (D ausente = desconhecido, não 0).
   */
  syncBaseline(players: Array<{ name: string; kills: number; deaths?: number }>): boolean {
    const pendingByPlayer = new Map<string, number>();
    for (const kill of this.kills) {
      const key = kill.killer.trim().toLowerCase();
      if (!key) continue;
      pendingByPlayer.set(key, (pendingByPlayer.get(key) ?? 0) + 1);
    }
    const smallKDrops = new Set<string>();
    const smallDDrops = new Set<string>();
    let compared = 0;
    let bigDropped = 0;
    let suspect = false;
    for (const p of players) {
      const rawName = p.name.trim();
      if (!rawName || isRoundMarker(rawName)) continue;
      const key = rawName.toLowerCase();
      const prevK = this.lastCounts.get(key);
      const prevD = this.lastDeaths.get(key);
      if (prevK === undefined && prevD === undefined) continue;
      compared++;
      const deathsKnown = typeof p.deaths === 'number' && Number.isFinite(p.deaths);
      const kDrop = prevK !== undefined && p.kills < prevK;
      const dDrop = prevD !== undefined && deathsKnown && (p.deaths as number) < prevD;
      if (!kDrop && !dDrop) continue;
      const kBig =
        kDrop && ((prevK as number) - p.kills >= 2 || (p.kills === 0 && (prevK as number) > 0));
      const dBig =
        dDrop &&
        ((prevD as number) - (p.deaths as number) >= 2 ||
          ((p.deaths as number) === 0 && (prevD as number) > 0));
      const pending = (pendingByPlayer.get(key) ?? 0) > 0;
      if (kBig || dBig) {
        bigDropped++;
        if (pending) suspect = true;
      } else if (pending) {
        if (kDrop) smallKDrops.add(key);
        if (dDrop) smallDDrops.add(key);
      }
    }
    const broadReset = compared > 0 && bigDropped >= 2 && bigDropped * 2 >= compared;
    const statsReset = suspect || broadReset;
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
        if (typeof p.deaths === 'number' && Number.isFinite(p.deaths)) {
          this.lastDeaths.set(key, p.deaths);
        }
      }
      return true;
    }
    const newKills: Array<{ name: string; n: number }> = [];
    const victimPool: string[] = [];
    for (const p of players) {
      const rawName = p.name.trim();
      if (!rawName || isRoundMarker(rawName)) continue;
      const key = rawName.toLowerCase();
      if (smallKDrops.has(key) && smallDDrops.has(key)) continue;
      const prevK = this.lastCounts.get(key);
      if (!smallKDrops.has(key) && (prevK === undefined || p.kills !== prevK)) {
        if (prevK !== undefined && p.kills > prevK) {
          newKills.push({ name: rawName, n: p.kills - prevK });
        }
        this.lastCounts.set(key, p.kills);
      }
      // D ilegível/ausente: mantém a última contagem conhecida (virar 0
      // aqui criaria vítimas fantasma no próximo poll).
      const deathsKnown = typeof p.deaths === 'number' && Number.isFinite(p.deaths);
      const prevD = this.lastDeaths.get(key);
      if (deathsKnown && !smallDDrops.has(key)) {
        const d = p.deaths as number;
        if (prevD === undefined || d !== prevD) {
          if (prevD !== undefined && d > prevD) {
            for (let i = 0; i < d - prevD; i++) victimPool.push(rawName);
          }
          this.lastDeaths.set(key, d);
        }
      }
    }
    // Excesso de mortes = bomba/queda (não vira vítima de ninguém);
    // falta = kill sem vítima conhecida ('' — honesto nos textos).
    let vi = 0;
    for (const k of newKills) {
      for (let i = 0; i < k.n; i++) {
        const victim = vi < victimPool.length ? victimPool[vi++] : '';
        // A kill veio do DIFERENCIAL do placar: o instante é o poll do
        // HLTV, não uma leitura direta do evento no jogo.
        this.addKill(k.name, victim, { atSource: 'placar' });
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
    // Sem as kills do round, o killfeed pendente não tem mais par.
    this.feedQueue = [];
    // O round descartado não volta: o enriquecimento tardio morre com ele.
    this.closedRound = null;
    this.lastBest = null;
    this.lastClosed = null;
    this.hadReset = true;
  }
  /**
   * Fecha o round e retorna o autor do multikill (3k/4k/5k), se houver —
   * sempre a contagem MÁXIMA do round (um evento por round/jogador, sem
   * duplicar 3k→4k→5k). kills = SÓ os do autor (metadados honestos).
   *
   * A telemetria (`killfeed`) é o MESMO objeto que o round fechado guarda:
   * o enriquecimento tardio continua atualizando ele depois do fechamento
   * (o sidecar é escrito minutos depois e enxerga o número final).
   */
  closeRound(minKills: MinKillsRule = 3): {
    player: string | null;
    kills: KillEvent[];
    killfeed: KillfeedTelemetry;
  } {
    const m = detectMultiKill(this.kills, minKills);
    const kills = m ? m.kills : [];
    // Diagnóstico do "sem multikill": o melhor do round e a contagem, antes
    // de zerar as kills (o chamador loga; nenhum efeito no corte).
    this.lastBest = topKiller(this.kills);
    this.lastClosed = { map: this.map, round: this.round };
    const state = this.feedState;
    // `paired` conta TODAS as kills do round que receberam o detalhe (o
    // pareamento não olha o autor) — o total tem que ser o mesmo universo,
    // senão `paired > total` e o aviso de kill sem par nunca dispara.
    state.total = this.kills.length;
    this.closedRound = {
      kills,
      round: this.round,
      map: this.map,
      atMs: Date.now(),
      state,
    };
    this.kills = [];
    this.seen.clear();
    this.round += 1;
    this.pruneFeed();
    this.feedState = { paired: 0, total: 0, feedKills: 0, eventIds: [] };
    return { player: m?.player ?? null, kills, killfeed: state };
  }

  reset(round = 1): void {
    this.kills = [];
    this.seen.clear();
    this.lastCounts.clear();
    this.lastDeaths.clear();
    this.feedQueue = [];
    this.closedRound = null;
    this.lastBest = null;
    this.lastClosed = null;
    this.feedState = { paired: 0, total: 0, feedKills: 0, eventIds: [] };
    this.round = round;
    // Reancoragem (gap) no meio do round: kills anteriores invisíveis —
    // a próxima âncora deste round nasce suspeita.
    this.hadReset = true;
  }

  get pending(): number {
    return this.kills.length;
  }

  /**
   * Melhor candidato do ÚLTIMO round fechado (mais kills, sem limiar).
   * Só diagnóstico: responde "por que este round não virou clipe".
   */
  get lastRoundBest(): { player: string; kills: number } | null {
    return this.lastBest;
  }

  /** Mapa/round do último round fechado (o número do round que TERMINOU). */
  get lastClosedRound(): { map: string; round: number } | null {
    return this.lastClosed;
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

export interface RoundSummaryInput {
  player: string;
  /** Time do autor; null/'' = desconhecido (nao inventar). */
  team?: string | null;
  /** Time rival; quando ausente, usa `opponents`. */
  opponent?: string | null;
  /** Confronto completo ("A vs B") quando o time do autor e desconhecido. */
  opponents?: string | null;
  /** Mapa do round; sem ele cai no mapa da 1a kill (o tracker antigo nao tinha). */
  map?: string | null;
  round?: number | null;
  kills: KillEvent[];
}

/** Monta o resumo rico de um round de multikill (3k/4k/5k do mesmo jogador). */
export function buildRoundSummary(input: RoundSummaryInput): RoundSummary {
  const { player, kills } = input;
  const team = input.team ?? '';
  const opponents = input.opponent ?? input.opponents ?? '';
  const map = input.map ?? kills[0]?.map ?? 'unknown';
  const round = input.round ?? kills[0]?.round ?? 0;
  const weapons = kills.map((k) => normWeapon(k.weapon));
  const headshotsKnown = kills.some((k) => k.headshot != null);
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
    round,
    map,
    player,
    team,
    opponents,
    kills,
    victims: kills.map((k) => k.victim).filter(Boolean),
    weapons,
    headshots,
    headshotsKnown,
    assists,
    flashAssists,
    grenades,
    mainWeapon,
  };
}

/**
 * Recalcula o resumo com as kills ATUAIS.
 *
 * O `summary` nasce como um SNAPSHOT do fechamento do round: as kills
 * do placar são atualizadas depois (o killfeed do scorebot chega com a
 * arma, o headshot e a vítima corrigida) e os agregados do resumo
 * (headshots, arma principal, assistências) ficavam velhos — o título,
 * a descrição e o prompt da thumbnail saíam com o dado antigo.
 *
 * A IDENTIDADE do round (jogador, time, adversário, mapa, round) é
 * mantida: o que muda são os agregados, que saem das kills.
 *
 * Puro: devolve um resumo novo; quem chama decide o que fazer com ele.
 */
export function refreshRoundSummary(
  summary: RoundSummary,
  kills: KillEvent[],
): RoundSummary {
  if (!summary) return summary;
  const current = kills?.length ? kills : summary.kills;
  return buildRoundSummary({
    player: summary.player,
    team: summary.team,
    opponents: summary.opponents,
    map: summary.map,
    round: summary.round,
    kills: current,
  });
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
