/**
 * Telemetria de detecção: quando uma live elegível aparece pela 1ª vez,
 * quanto tempo depois do horário previsto ela foi vista.
 *
 * Serve para validar o poll adaptativo em produção (e ajustar os limites):
 * - latencyMs alto = o backoff demorou demais (ou o horário do HLTV errou);
 * - latencyMs null = a partida não estava na agenda conhecida (entrou no
 *   listing depois) — o backoff pode ter dormido por cima dela.
 */

export interface DetectionEvent {
  matchId: string;
  /** ms entre o horário marcado e a detecção (null = não estava na agenda). */
  latencyMs: number | null;
  /** A partida era a próxima prevista pelo poll anterior? */
  predicted: boolean;
}

/**
 * Eventos de detecção das lives elegíveis que ainda não tinha visto.
 * Marca as ids em `seen` (evita log repetido a cada poll).
 */
export function detectionEvents(input: {
  /** Live elegível neste poll. */
  liveMatchIds: string[];
  /** Agenda conhecida: matchId → horário marcado (epoch ms). */
  knownUpcoming: Map<string, number>;
  /** matchId da próxima partida prevista no poll anterior. */
  predictedMatchId: string | null;
  now: number;
  /** Lives já detectadas antes (mutado: as novas entram aqui). */
  seen: Set<string>;
}): DetectionEvent[] {
  const out: DetectionEvent[] = [];
  for (const matchId of input.liveMatchIds) {
    if (input.seen.has(matchId)) continue;
    input.seen.add(matchId);
    const startsAt = input.knownUpcoming.get(matchId);
    out.push({
      matchId,
      latencyMs: startsAt === undefined ? null : input.now - startsAt,
      predicted: matchId === input.predictedMatchId,
    });
  }
  return out;
}
