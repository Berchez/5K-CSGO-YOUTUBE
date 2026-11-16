import { describe, expect, it } from 'vitest';
import {
  normalizeMapName,
  parseScorebotLog,
  scorebotKillKey,
  type ScorebotKill,
} from '../src/detector/scorebotLog.js';
import {
  ScorebotProtocolError,
  ScorebotSession,
  type ScorebotResponse,
  type ScorebotTransport,
} from '../src/detector/scorebotFeed.js';

/** Kill crua no formato observado no evento `log` (campos reais). */
const rawKill = {
  killerName: 'kyousuke',
  killerNick: 'kyousuke',
  killerSide: 'TERRORIST',
  victimNick: 'huNter-',
  victimName: 'huNter',
  victimSide: 'CT',
  weapon: 'glock',
  headShot: true,
  eventId: 4026916284,
  penetrated: false,
  throughSmoke: true,
  noScope: false,
  flasherNick: 'm0NESY',
};

describe('normalizeMapName', () => {
  it('canoniza o nome do mapa', () => {
    expect(normalizeMapName('de_anubis')).toBe('anubis');
    expect(normalizeMapName('Anubis')).toBe('anubis');
    expect(normalizeMapName('de_mirage')).toBe('mirage');
    expect(normalizeMapName('')).toBe('');
  });
});

describe('parseScorebotLog', () => {
  it('normaliza os campos do kill (incl. flash e modificadores)', () => {
    const kills = parseScorebotLog([{ Kill: rawKill }]);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({
      eventId: '4026916284',
      killer: 'kyousuke',
      victim: 'huNter-',
      weapon: 'glock',
      headshot: true,
      flashAssistBy: 'm0NESY',
      throughSmoke: true,
      wallbang: false,
      noscope: false,
      replay: false,
    });
  });

  it('aceita os nomes alternativos do payload (defensivo)', () => {
    const kills = parseScorebotLog([
      {
        Kill: {
          KillerName: 'r1nkle',
          VictimName: 'karrigan',
          Weapon: 'usp_silencer',
          Headshot: true,
          eventId: '1',
        },
      },
    ]);
    expect(kills[0]).toMatchObject({
      killer: 'r1nkle',
      victim: 'karrigan',
      weapon: 'usp_silencer',
      headshot: true,
    });
  });

  it('não inventa booleano ausente', () => {
    const kills = parseScorebotLog([{ Kill: { killerNick: 'a', victimNick: 'b' } }]);
    expect(kills[0].headshot).toBeUndefined();
    expect(kills[0].throughSmoke).toBeUndefined();
    expect(kills[0].wallbang).toBeUndefined();
    expect(kills[0].noscope).toBeUndefined();
  });

  it('funde o Assist separado que chega DEPOIS da kill', () => {
    const kills = parseScorebotLog([
      { Kill: { killerNick: 'kyousuke', victimNick: 'huNter-', eventId: 42 } },
      { Assist: { assisterNick: 'm0NESY', victimNick: 'huNter-', killEventId: 42 } },
    ]);
    expect(kills[0].assistBy).toBe('m0NESY');
  });

  it('funde o Assist separado que chega ANTES da kill', () => {
    const kills = parseScorebotLog([
      { Assist: { assisterNick: 'm0NESY', killEventId: '42' } },
      { Kill: { killerNick: 'kyousuke', victimNick: 'MATYS', eventId: '42' } },
    ]);
    expect(kills[0].assistBy).toBe('m0NESY');
  });

  it('ignora suicídio (é evento próprio, não é kill)', () => {
    const kills = parseScorebotLog([
      { Suicide: { playerName: 'karrigan', weapon: 'world' } },
      { Kill: { killerNick: 'a', victimNick: 'b', eventId: 1 } },
    ]);
    expect(kills).toHaveLength(1);
  });

  it('resolve mapa e round pelos marcadores, no replay invertido', () => {
    // Replay real: mais novo primeiro (do fim do mapa para o começo).
    const items = [
      { Kill: { killerNick: 'k2', victimNick: 'v2', eventId: 2 } },
      { RoundStart: {} },
      { Kill: { killerNick: 'k1', victimNick: 'v1', eventId: 1 } },
      { RoundStart: {} },
      { MatchStarted: { map: 'de_anubis' } },
      { PlayerJoin: { playerName: 'k1' } },
    ];
    const kills = parseScorebotLog(items, { reverse: true, replay: true });
    expect(kills.map((k) => k.killer)).toEqual(['k1', 'k2']);
    expect(kills.map((k) => k.round)).toEqual([1, 2]);
    expect(kills.every((k) => k.map === 'anubis')).toBe(true);
    expect(kills.every((k) => k.replay)).toBe(true);
  });

  it('deduplica pelo eventId', () => {
    const kills = parseScorebotLog([
      { Kill: { killerNick: 'a', victimNick: 'b', eventId: 7 } },
      { Kill: { killerNick: 'a', victimNick: 'b', eventId: 7 } },
    ]);
    expect(kills).toHaveLength(1);
  });

  it('o estado mapa/round persiste entre frames (o live não repete o RoundStart)', () => {
    const state = { map: '', round: 0 };
    // 1º frame: o replay semeia mapa e round.
    parseScorebotLog(
      [
        { Kill: { killerNick: 'k1', victimNick: 'v1', eventId: 1 } },
        { RoundStart: {} },
        { MatchStarted: { map: 'de_anubis' } },
      ],
      { reverse: true, replay: true, state },
    );
    expect(state.map).toBe('anubis');
    expect(state.round).toBe(1);
    // 2º frame (live): só vem `Kill` — o mapa/round vêm do estado.
    const live = parseScorebotLog(
      [{ Kill: { killerNick: 'k2', victimNick: 'v2', eventId: 2 } }],
      { state },
    );
    expect(live[0]).toMatchObject({ map: 'anubis', round: 1 });
  });
});

describe('scorebotKillKey', () => {
  it('usa o eventId quando existe', () => {
    const kill: ScorebotKill = {
      eventId: '9',
      killer: 'a',
      victim: 'b',
      map: 'anubis',
      round: 1,
      replay: false,
    };
    expect(scorebotKillKey(kill)).toBe('id:9');
  });

  it('cai no composto quando falta o eventId', () => {
    const kill: ScorebotKill = {
      eventId: null,
      killer: 'A',
      victim: 'B',
      map: 'anubis',
      round: 3,
      replay: false,
    };
    expect(scorebotKillKey(kill)).toBe('a|b|anubis|3');
  });
});

/** Transporte roteirizado: sem rede, sem timers. */
class FakeTransport implements ScorebotTransport {
  readonly posts: string[] = [];
  readonly gets: string[] = [];
  private handshakes: string[];
  private polls: string[];

  constructor(opts: { handshakes?: string[]; polls?: string[] }) {
    this.handshakes = [...(opts.handshakes ?? ['0{"sid":"sid-1"}'])];
    this.polls = [...(opts.polls ?? [])];
  }

  async get(url: string): Promise<ScorebotResponse> {
    this.gets.push(url);
    if (url.includes('sid=')) {
      const body = this.polls.shift();
      return body == null ? { status: 500, body: '' } : { status: 200, body };
    }
    const body = this.handshakes.shift();
    return body == null ? { status: 500, body: '' } : { status: 200, body };
  }

  async post(_url: string, body: string): Promise<ScorebotResponse> {
    this.posts.push(body);
    return { status: 200, body: 'ok' };
  }
}

/** Frame socket.io do evento `log`. */
function logFrame(items: unknown[]): string {
  const payload = JSON.stringify({ log: items });
  return `42["log","${payload.replace(/"/g, '\\"')}"]`;
}

describe('ScorebotSession', () => {
  it('faz handshake, entra na partida e pede o log', async () => {
    const transport = new FakeTransport({ polls: [logFrame([])] });
    const session = new ScorebotSession({ matchId: '2400205', transport, onKills: () => undefined });
    await session.pollOnce();
    expect(session.connected).toBe(true);
    expect(transport.posts[0]).toBe('40');
    expect(transport.posts[1]).toContain('"readyForMatch"');
    expect(transport.posts[1]).toContain('2400205');
    expect(transport.posts[1]).toContain('\\"token\\":\\"\\"');
  });

  it('responde o ping e entrega as kills do replay em ordem cronológica', async () => {
    const transport = new FakeTransport({
      polls: [
        [
          '2',
          logFrame([
            { Kill: { killerNick: 'novo', victimNick: 'v2', eventId: 2 } },
            { RoundStart: {} },
            { Kill: { killerNick: 'velho', victimNick: 'v1', eventId: 1 } },
            { MatchStarted: { map: 'de_anubis' } },
          ]),
        ].join('\x1e'),
      ],
    });
    const got: ScorebotKill[] = [];
    const session = new ScorebotSession({
      matchId: '2400205',
      transport,
      onKills: (kills) => got.push(...kills),
    });
    await session.pollOnce();
    expect(transport.posts).toContain('3');
    expect(got.map((k) => k.killer)).toEqual(['velho', 'novo']);
  });

  it('não repete kill já entregue (replay de reconexão)', async () => {
    const frame = logFrame([{ Kill: { killerNick: 'a', victimNick: 'b', eventId: 5 } }]);
    const transport = new FakeTransport({ polls: [frame, frame] });
    const got: ScorebotKill[] = [];
    const session = new ScorebotSession({
      matchId: '2400205',
      transport,
      onKills: (kills) => got.push(...kills),
    });
    await session.pollOnce();
    await session.pollOnce();
    expect(got).toHaveLength(1);
  });

  it('derruba a sessão em falha de HTTP (o chamador reconecta)', async () => {
    const transport = new FakeTransport({ polls: [] });
    const session = new ScorebotSession({ matchId: '1', transport, onKills: () => undefined });
    await expect(session.pollOnce()).rejects.toBeInstanceOf(ScorebotProtocolError);
    // O próximo ciclo negocia de novo em vez de reusar o sid morto.
    expect(session.connected).toBe(false);
  });

  it('guarda o Assist que chega num frame antes da kill', async () => {
    // O scorebot pode mandar o `Assist` num `log` separado; a sessão
    // persiste a assistência entre frames para não perdê-la.
    const assistFrame = logFrame([
      { Assist: { assisterNick: 'm0NESY', victimNick: 'huNter-', killEventId: 4242 } },
    ]);
    const killFrame = logFrame([
      { Kill: { killerNick: 'kyousuke', victimNick: 'huNter-', eventId: 4242, weapon: 'glock' } },
    ]);
    const transport = new FakeTransport({ polls: [assistFrame, killFrame] });
    const got: ScorebotKill[] = [];
    const session = new ScorebotSession({
      matchId: '2400205',
      transport,
      onKills: (kills) => got.push(...kills),
    });
    await session.pollOnce();
    await session.pollOnce();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ victim: 'huNter-', assistBy: 'm0NESY' });
  });

  it('o frame LIVE herda mapa/round do replay (não vem RoundStart)', async () => {
    const replayFrame = logFrame([
      { Kill: { killerNick: 'velho', victimNick: 'v1', eventId: 1 } },
      { RoundStart: {} },
      { MatchStarted: { map: 'de_anubis' } },
    ]);
    const liveFrame = logFrame([
      { Kill: { killerNick: 'novo', victimNick: 'v2', eventId: 2, weapon: 'ak47' } },
    ]);
    const transport = new FakeTransport({ polls: [replayFrame, liveFrame] });
    const got: ScorebotKill[] = [];
    const session = new ScorebotSession({
      matchId: '2400205',
      transport,
      onKills: (kills) => got.push(...kills),
    });
    await session.pollOnce();
    await session.pollOnce();
    const live = got.find((k) => k.killer === 'novo');
    expect(live).toMatchObject({ map: 'anubis', round: 1 });
  });
});
