/**
 * Explica a política de captura de uma partida a partir do LOG do bot.
 *
 * POR QUE: o limiar de kills tem quatro camadas (política geral por
 * estrelas, time da watchlist, jogador da watchlist e bloqueio do
 * adversário). Quando um round não vira clipe, o log dizia só "round
 * fechado sem multikill" — sem o candidato nem o limiar dele. Este módulo
 * responde "por que esta partida/round não gerou clipe" lendo o que o bot
 * já registra, sem ninguém precisar abrir o código.
 *
 * Puro: recebe as linhas já parseadas. Quem lê o arquivo é o script
 * (`scripts/explain.ts`) — assim o formato do relatório é testável.
 */

/** Linha do log (pino): JSON por linha, campos livres. */
export interface ExplainLogLine {
  time?: number;
  msg?: string;
  matchId?: string;
  [key: string]: unknown;
}

export interface ExplainPolicy {
  stars: number | null;
  minKills: number | null;
  passesGeneral: boolean | null;
  watchlisted: boolean | null;
  teams: string[];
}

export interface ExplainRound {
  map: string;
  round: number;
  /** Placar no fechamento do round (placar do DOM). */
  score: string | null;
  /** Melhor candidato do round (mais kills, sem limiar). */
  bestPlayer: string | null;
  bestKills: number | null;
  /** Limiar exigido do candidato; null = bloqueado ou sem candidato. */
  required: number | null;
  /** true = candidato de time bloqueado (partida só da watchlist). */
  blocked: boolean;
  multikill: { player: string; kills: number } | null;
  /** Motivo do descarte quando o multikill existiu mas não virou clipe. */
  dropped: string | null;
}

export interface ExplainMatch {
  matchId: string;
  policy: ExplainPolicy | null;
  rounds: ExplainRound[];
  /** Início/fim da vigia (para saber se a partida chegou a ser gravada). */
  events: Array<{ at: string; msg: string }>;
}

const MSG_POLICY = 'iniciando tracker de multikill';
const MSG_CLOSED = 'round fechado sem multikill';
const MSG_MULTI = 'multikill detectado';
const MSG_DROPPED = 'multikill descartado';
const MSG_TRACK_START = 'iniciando tracking do match';
const MSG_TRACK_END = 'tracking encerrado';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function iso(value: unknown): string {
  const t = num(value);
  return t == null ? '?' : new Date(t).toISOString();
}

/**
 * Times da watchlist: o log grava string (`join(', ')`), mas aceita array
 * (linha de teste/versão antiga). Normaliza para lista.
 */
function teamList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((team) => String(team)).filter((team) => team.trim().length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((team) => team.trim())
      .filter((team) => team.length > 0);
  }
  return [];
}

/**
 * Percorre as linhas e monta o quadro da partida: política resolvida no
 * início do tracking + um registro por round (multikill, descarte ou o
 * candidato que não atingiu o limiar).
 */
export function explainMatchLog(
  lines: readonly ExplainLogLine[],
  matchId: string,
): ExplainMatch {
  const alvo = String(matchId);
  const rounds = new Map<string, ExplainRound>();
  const events: Array<{ at: string; msg: string }> = [];
  let policy: ExplainPolicy | null = null;

  const ensure = (map: string, round: number): ExplainRound => {
    const key = `${map.toLowerCase()}#${round}`;
    let entry = rounds.get(key);
    if (!entry) {
      entry = {
        map,
        round,
        score: null,
        bestPlayer: null,
        bestKills: null,
        required: null,
        blocked: false,
        multikill: null,
        dropped: null,
      };
      rounds.set(key, entry);
    }
    return entry;
  };

  for (const line of lines) {
    if (String(line.matchId ?? '') !== alvo) continue;
    const msg = String(line.msg ?? '');
    if (msg === MSG_POLICY) {
      policy = {
        stars: num(line.stars),
        minKills: num(line.minKills),
        passesGeneral: typeof line.passaGeral === 'boolean' ? line.passaGeral : null,
        watchlisted: typeof line.watchlisted === 'boolean' ? line.watchlisted : null,
        teams: teamList(line.teams),
      };
      events.push({ at: iso(line.time), msg });
      continue;
    }
    if (msg === MSG_CLOSED) {
      const entry = ensure(str(line.map) ?? '?', num(line.round) ?? 0);
      entry.score = str(line.score) ?? entry.score;
      entry.bestPlayer = str(line.bestPlayer);
      entry.bestKills = num(line.bestKills);
      entry.required = num(line.required);
      entry.blocked = line.blocked === true;
      continue;
    }
    if (msg === MSG_MULTI) {
      const entry = ensure(str(line.map) ?? '?', num(line.round) ?? 0);
      entry.multikill = { player: str(line.player) ?? '?', kills: num(line.kills) ?? 0 };
      continue;
    }
    if (msg === MSG_DROPPED) {
      const entry = ensure(str(line.map) ?? '?', num(line.round) ?? 0);
      entry.dropped = str(line.dropped);
      continue;
    }
    if (msg === MSG_TRACK_START || msg === MSG_TRACK_END) {
      events.push({ at: iso(line.time), msg });
    }
  }

  return { matchId: alvo, policy, rounds: [...rounds.values()], events };
}

/** Relatório em texto (o script só imprime). */
export function formatExplain(result: ExplainMatch): string {
  const out: string[] = [`partida ${result.matchId}`];
  if (result.policy) {
    const p = result.policy;
    const stars = p.stars == null ? '?' : `${p.stars}★`;
    const filtro =
      p.passesGeneral == null ? 'filtro geral desconhecido' : p.passesGeneral ? 'passa no filtro geral' : 'NÃO passa no filtro geral';
    const override = p.watchlisted
      ? ` · override da watchlist${p.teams.length > 0 ? ` (${p.teams.join(', ')})` : ''}`
      : '';
    out.push(`política: ${stars} · limiar ${p.minKills ?? '?'}k · ${filtro}${override}`);
  } else {
    out.push('política: sem registro no log (o tracker não iniciou nesta partida)');
  }
  for (const event of result.events) out.push(`  ${event.at} ${event.msg}`);
  if (result.rounds.length === 0) {
    out.push('rounds: nenhum round fechado registrado');
    return out.join('\n');
  }
  out.push('rounds:');
  for (const round of result.rounds) {
    const partes = [`  ${round.map} r${round.round}`];
    if (round.multikill) {
      partes.push(`multikill ${round.multikill.kills}k de ${round.multikill.player}`);
    } else if (round.blocked) {
      partes.push('bloqueado (time fora da lista da watchlist)');
    } else if (round.bestPlayer) {
      partes.push(
        `${round.bestKills ?? 0}k de ${round.bestPlayer} < ${round.required ?? '?'}k exigidos`,
      );
    } else if (round.bestKills != null) {
      partes.push('sem kills no round');
    } else {
      // Log anterior à telemetria: não havia candidato registrado.
      partes.push('sem diagnóstico no log (linha antiga)');
    }
    if (round.dropped) partes.push(`descartado: ${round.dropped}`);
    if (round.score) partes.push(`placar ${round.score}`);
    out.push(partes.join(' | '));
  }
  const multikills = result.rounds.filter((round) => round.multikill).length;
  const dropped = result.rounds.filter((round) => round.dropped).length;
  out.push(
    `resumo: ${result.rounds.length} round(s) · ${multikills} multikill(s) · ${dropped} descartado(s)`,
  );
  return out.join('\n');
}
