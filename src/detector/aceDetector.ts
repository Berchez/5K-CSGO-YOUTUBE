import type { KillEvent } from '../types.js';

/** Nomes que indicam fim de round / reset no killfeed (não são killers). */
const ROUND_MARKERS = new Set(['T', 'CT', 'ROUND STARTED', 'ROUND OVER', 'PLANTED']);

export function isRoundMarker(name: string): boolean {
  return ROUND_MARKERS.has(name.trim().toUpperCase());
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

  addKill(killer: string, victim: string): void {
    if (isRoundMarker(killer)) return;
    this.kills.push({ killer, victim, round: this.round, map: this.map });
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
