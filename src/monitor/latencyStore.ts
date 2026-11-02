import fs from 'node:fs';
import path from 'node:path';
import { LATENCY_STATE_VERSION, StreamLatencyTracker } from './streamLatency.js';

/**
 * Persistência do estado de latência por canal.
 *
 * O estado guarda as ÚLTIMAS medições de cada canal (com timestamp) e o
 * crop do placar que funcionou. Persistir entre reinícios do bot é o
 * que faz a sincronização "entre partidas" ser fácil: o primeiro round
 * da nova partida já começa com a latência medida na partida anterior e
 * a primeira transição de placar corrige o valor.
 *
 * Escrita ATÔMICA (arquivo temporário + rename): o bot pode ser morto
 * no meio da gravação e o estado não pode ficar truncado (JSON inválido
 * = histórico inteiro perdido).
 */

export interface LoadedLatencyState {
  state: StreamLatencyTracker;
  /** Problema encontrado no arquivo (null = ok). */
  problem: string | null;
  /**
   * Migração aplicada ao carregar (null = o arquivo já era do schema
   * atual). O log do startup precisa dizer que o arquivo veio de outra
   * versão e o que foi aproveitado — sem isso, uma migração silenciosa
   * parece "o canal perdeu a medição".
   */
  migration: {
    from: number;
    to: number;
    samples: number;
    channels: string[];
  } | null;
}

/** Lê o estado persistido. Arquivo ausente/corrompido = estado vazio. */
export function loadLatencyState(file: string): LoadedLatencyState {
  try {
    if (!fs.existsSync(file)) return { state: new StreamLatencyTracker(), problem: null, migration: null };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { state: new StreamLatencyTracker(), problem: null, migration: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        state: new StreamLatencyTracker(),
        problem: 'JSON inválido',
        migration: null,
      };
    }
    const version = Number((parsed as { version?: unknown })?.version);
    /**
     * v1 e v2 são aceitos pelo `fromJSON`: o v2 aproveita as amostras
     * (o `startOnly` é separado pelo roteamento) e o v1 fica só com os
     * crops. Arquivo de outra versão é recusado aqui — o `fromJSON` não
     * deve interpretar um schema desconhecido.
     */
    if (
      Number.isFinite(version) &&
      version !== LATENCY_STATE_VERSION &&
      version !== 1 &&
      version !== 2
    ) {
      return {
        state: new StreamLatencyTracker(),
        problem: `versão ${version} incompatível`,
        migration: null,
      };
    }
    const state = StreamLatencyTracker.fromJSON(parsed);
    const migration =
      Number.isFinite(version) && version !== LATENCY_STATE_VERSION
        ? {
            from: version,
            to: LATENCY_STATE_VERSION,
            samples: state.restoredSamplesCount,
            channels: state.channels(),
          }
        : null;
    return { state, problem: null, migration };
  } catch (e) {
    return {
      state: new StreamLatencyTracker(),
      problem: String(e).slice(0, 120),
      migration: null,
    };
  }
}

/**
 * Grava o estado (atômico). Best-effort: falhar ao salvar o histórico
 * de latência NÃO pode derrubar o clipe — a medição volta no próximo
 * round.
 */
export function saveLatencyState(file: string, state: StreamLatencyTracker): boolean {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state.toJSON(), null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(`${file}.tmp`, { force: true });
    } catch {
      // best-effort
    }
    return false;
  }
}
