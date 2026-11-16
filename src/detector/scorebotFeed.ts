/**
 * Cliente do scorebot do HLTV por Engine.IO v4 (transporte polling).
 *
 * POR QUE: o placar do DOM só conta K/D. Arma, headshot, assistência e
 * flash só existem no evento `log` do scorebot. O protocolo é:
 *
 *   GET  /socket.io/?EIO=4&transport=polling&t=x   → 0{"sid":...}
 *   POST ...&sid=<sid>  body "40"                  → 40{"sid":...}
 *   POST body 42["readyForMatch","{\"token\":\"\",\"listId\":\"<id>\"}"]
 *   GET  long-poll → pacotes separados por \x1e ("2" = ping → POST "3")
 *
 * As requisições SAEM DO CONTEXTO DA PÁGINA: o Cloudflare barra Node
 * direto (403) e a sessão do perfil do bot já tem o clearance.
 *
 * A sessão aqui é pura em relação ao transporte (recebe um
 * `ScorebotTransport`), então o protocolo é testável sem rede; só
 * `startScorebotFeed` amarra o transporte ao `fetch` da página.
 */
import type { Page } from 'playwright';
import { getLogger } from '../logger.js';
import {
  parseScorebotLog,
  scorebotKillKey,
  type ScorebotKill,
  type ScorebotLogState,
} from './scorebotLog.js';

export const SCOREBOT_URL = 'https://scorebot-lb.hltv.org';

export interface ScorebotResponse {
  status: number;
  body: string;
}

/** HTTP da página: GET/POST cru. Injetável para teste. */
export interface ScorebotTransport {
  get(url: string): Promise<ScorebotResponse>;
  post(url: string, body: string): Promise<ScorebotResponse>;
}

export interface ScorebotSessionOptions {
  matchId: string;
  transport: ScorebotTransport;
  /** Kills novas (já deduplicadas entre reconexões). */
  onKills: (kills: ScorebotKill[]) => void;
  /** Uma vez por conexão (handshake + readyForMatch) — diagnóstico. */
  onConnect?: () => void;
  baseUrl?: string;
}

/** O servidor respondeu algo que não é o protocolo esperado. */
export class ScorebotProtocolError extends Error {}

/** Escapa JSON para dentro do frame de texto do socket.io. */
function socketFrame(event: string, payload: unknown): string {
  // `JSON.stringify` do array inteiro escapa aspas, barras e quebras de
  // linha de uma vez — o escape manual deixava passar `\n` (nome com
  // newline quebrava o frame e a conexão morria).
  return `42${JSON.stringify([event, JSON.stringify(payload)])}`;
}

/**
 * Sessão de UMA partida. `pollOnce` faz um ciclo completo (handshake, se
 * preciso, + um long-poll) e entrega as kills novas; quem chama decide o
 * ritmo/backoff.
 */
export class ScorebotSession {
  private readonly baseUrl: string;
  private sid: string | null = null;
  /** O próximo `log` é o replay de abertura (mais novo primeiro). */
  private fresh = false;
  /** eventId/jogo já entregue — reconexão repete o replay inteiro. */
  private readonly seen = new Set<string>();
  /** `Assist` que chegou antes da kill (frames separados). */
  private readonly assists = new Map<string, string>();
  /**
   * Mapa/round correntes: o replay semeia (MatchStarted/RoundStart) e os
   * frames ao vivo — que só trazem Kill/Assist — continuam daqui.
   */
  private readonly context: ScorebotLogState = { map: '', round: 0 };

  constructor(private readonly opts: ScorebotSessionOptions) {
    this.baseUrl = (opts.baseUrl ?? SCOREBOT_URL).replace(/\/+$/, '');
  }

  get connected(): boolean {
    return this.sid !== null;
  }

  /** Esquece a conexão (o próximo ciclo faz handshake de novo). */
  disconnect(): void {
    this.sid = null;
    this.fresh = false;
  }

  async pollOnce(): Promise<void> {
    if (!this.sid) await this.connect();
    const res = await this.opts.transport.get(this.url());
    if (res.status !== 200) {
      this.sid = null;
      throw new ScorebotProtocolError(`long-poll falhou (HTTP ${res.status})`);
    }
    for (const packet of res.body.split('\x1e')) {
      if (!packet) continue;
      await this.handle(packet);
    }
  }

  private url(): string {
    const t = Date.now();
    return this.sid
      ? `${this.baseUrl}/socket.io/?EIO=4&transport=polling&t=${t}&sid=${this.sid}`
      : `${this.baseUrl}/socket.io/?EIO=4&transport=polling&t=${t}`;
  }

  private async post(body: string): Promise<void> {
    if (!this.sid) throw new ScorebotProtocolError('post sem sessão');
    const res = await this.opts.transport.post(this.url(), body);
    if (res.status !== 200) {
      this.sid = null;
      throw new ScorebotProtocolError(`post falhou (HTTP ${res.status})`);
    }
  }

  private async connect(): Promise<void> {
    const handshake = await this.opts.transport.get(
      `${this.baseUrl}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`,
    );
    if (handshake.status !== 200) {
      throw new ScorebotProtocolError(`handshake falhou (HTTP ${handshake.status})`);
    }
    const body = handshake.body.trim();
    if (!body.startsWith('0')) {
      throw new ScorebotProtocolError('handshake sem pacote de abertura (EIO=4)');
    }
    let sid: unknown;
    try {
      sid = (JSON.parse(body.slice(1)) as { sid?: unknown }).sid;
    } catch {
      throw new ScorebotProtocolError('handshake com JSON inválido');
    }
    if (typeof sid !== 'string' || !sid) {
      throw new ScorebotProtocolError('handshake sem sid');
    }
    this.sid = sid;
    await this.post('40');
    // `token` vazio é aceito (o site também manda vazio neste fluxo).
    await this.post(socketFrame('readyForMatch', { token: '', listId: String(this.opts.matchId) }));
    this.fresh = true;
    this.opts.onConnect?.();
  }

  private async handle(packet: string): Promise<void> {
    if (packet === '2') {
      await this.post('3');
      return;
    }
    if (packet === '1') {
      this.sid = null;
      return;
    }
    if (!packet.startsWith('42')) return;
    let event: unknown;
    try {
      event = JSON.parse(packet.slice(2));
    } catch {
      return;
    }
    if (!Array.isArray(event) || typeof event[0] !== 'string') return;
    if (event[0] !== 'log') return;
    let payload: unknown = event[1];
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const items = (payload as { log?: unknown })?.log;
    if (!Array.isArray(items)) return;
    const replay = this.fresh;
    this.fresh = false;
    // Sem poda o mapa cresceria com assistências de kills que nunca
    // chegaram (mapa/partida trocados) — o teto evita vazamento.
    if (this.assists.size > 500) this.assists.clear();
    const kills = parseScorebotLog(items, {
      reverse: replay,
      replay,
      assistStore: this.assists,
      state: this.context,
    });
    const fresh: ScorebotKill[] = [];
    for (const kill of kills) {
      const key = scorebotKillKey(kill);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push(kill);
    }
    if (fresh.length > 0) this.opts.onKills(fresh);
  }
}

/** `fetch` dentro da página (o Cloudflare barra o Node direto). */
async function pageFetch(
  page: Page,
  url: string,
  body: string | null,
): Promise<ScorebotResponse> {
  // Nenhuma função nomeada aqui dentro: sob tsx o esbuild injeta `__name`
  // e a página não tem esse helper (ver AGENTS.md).
  return (await page.evaluate(
    async (req) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const res = await fetch(req.url, {
          method: req.body == null ? 'GET' : 'POST',
          credentials: 'include',
          cache: 'no-store',
          body: req.body ?? undefined,
          headers:
            req.body == null ? undefined : { 'content-type': 'text/plain;charset=UTF-8' },
          signal: ctl.signal,
        });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, body },
  )) as ScorebotResponse;
}

/**
 * Transporte do scorebot que fala ATRAVÉS da página do navegador.
 *
 * Exportado para o backfill (`scripts/enrich-clip.ts`): ele precisa do
 * mesmo caminho (o Node direto é barrado pelo Cloudflare).
 */
export function createPageScorebotTransport(page: Page): ScorebotTransport {
  return {
    get: (url) => pageFetch(page, url, null),
    post: (url, body) => pageFetch(page, url, body),
  };
}

/**
 * Puxa o REPLAY do killfeed de uma partida.
 *
 * Ao conectar, o scorebot manda o histórico INTEIRO da partida (do mais
 * novo para o mais antigo) — é isso que permite corrigir um clipe já
 * gravado (o backfill).
 */
export async function fetchScorebotReplay(
  page: Page,
  matchId: string,
  opts: { maxPolls?: number; waitMs?: number } = {},
): Promise<ScorebotKill[]> {
  const kills: ScorebotKill[] = [];
  const session = new ScorebotSession({
    matchId,
    transport: createPageScorebotTransport(page),
    onKills: (fresh) => kills.push(...fresh),
  });
  const maxPolls = Math.max(1, opts.maxPolls ?? 5);
  for (let i = 0; i < maxPolls; i++) {
    await session.pollOnce();
    if (kills.length > 0) break;
    await sleep(opts.waitMs ?? 1000);
  }
  session.disconnect();
  return kills;
}

export interface ScorebotFeed {
  stop(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Intervalo mínimo entre dois polls (ms).
 *
 * A long-poll do scorebot segura a conexão por ~25s; mas uma resposta
 * instantânea (o servidor respondeu antes) viraria um laço quente:
 * requests sem parar e CPU queimada.
 */
const MIN_POLL_INTERVAL_MS = 1000;

/** Falhas seguidas antes de avisar o dono (o `warn` é o sinal visível). */
const WARN_AFTER_FAILURES = 3;

/**
 * Liga o killfeed do scorebot à página do tracking. Best-effort: falha de
 * rede só re-tenta com backoff — o tracking do placar segue funcionando.
 */
export async function startScorebotFeed(
  page: Page,
  matchId: string,
  onKills: (kills: ScorebotKill[]) => void,
): Promise<ScorebotFeed> {
  const log = getLogger().child({ matchId });
  const transport: ScorebotTransport = {
    get: (url) => pageFetch(page, url, null),
    post: (url, body) => pageFetch(page, url, body),
  };
  let running = true;
  const session = new ScorebotSession({
    matchId,
    transport,
    onConnect: () => log.info('killfeed do scorebot conectado'),
    onKills: (kills) => {
      log.debug({ kills: kills.length }, 'kills do scorebot');
      onKills(kills);
    },
  });
  const loop = async (): Promise<void> => {
    let backoff = 2000;
    let failures = 0;
    while (running) {
      try {
        await session.pollOnce();
        backoff = 2000;
        failures = 0;
        // Sem este piso, uma resposta instantânea do servidor vira um
        // laço quente (requests sem parar).
        await sleep(MIN_POLL_INTERVAL_MS);
      } catch (err) {
        if (!running) break;
        session.disconnect();
        failures += 1;
        const message = String(err).slice(0, 200);
        if (failures >= WARN_AFTER_FAILURES) {
          // O dono precisa SABER que o killfeed não está entrando: sem
          // sinal, o clipe sai sem arma/headshot e ninguém entende por
          // quê. Antes isso só aparecia em `debug`.
          log.warn({ err: message, falhas: failures }, 'killfeed do scorebot falhou');
        } else {
          log.debug({ err: message, falhas: failures }, 'killfeed do scorebot falhou, re-tentando');
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    log.debug('killfeed do scorebot encerrado');
  };
  void loop();
  return {
    stop: () => {
      running = false;
    },
  };
}
