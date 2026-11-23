import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  buildListing,
  dedupeUpcoming,
  extractListingCards,
  extractTeamRankingEntries,
  shouldStopRecorder,
  type ListingCards,
  type MatchCard,
  type UpcomingCard,
  type UpcomingMatch,
} from '../src/monitor/hltvMonitor.js';
import { computePollDecision } from '../src/monitor/pollSchedule.js';
import { buildTeamRanking } from '../src/monitor/teamRanking.js';
import { validateWatchlistDoc } from '../src/watchlist.js';

/**
 * Fixtures do layout 2026 do /matches (copiado do HTML real do HLTV).
 *
 * Live: div.match[data-livescore-match] com .match-meta-live "Live".
 * Futuro: div.match-wrapper[data-match-id] com live="false", data-stars e
 * .match-time[data-unix] (o wrapper de horário data-zonedgrouping-entry-unix
 * é o fallback).
 */

function upcomingCard(opts: {
  matchId: string;
  slug?: string;
  event?: string;
  team1?: string;
  team2?: string;
  unix?: string | null;
  stars?: number;
  live?: boolean;
}): string {
  const {
    matchId,
    slug = `team-a-vs-team-b-${matchId}`,
    event = 'PGL Masters Bucharest 2026',
    team1 = 'Team A',
    team2 = 'Team B',
    unix = '1793156400000',
    stars = 0,
    live = false,
  } = opts;
  const time =
    unix === null
      ? '<div class="match-time">TBD</div>'
      : `<div class="match-time" data-time-format="HH:mm" data-unix="${unix}">04:00</div>`;
  return `
    <div class="match-wrapper " data-match-wrapper="" data-match-id="${matchId}"
         data-stars="${stars}" data-event-id="9414" live="${live}" data-pinned="false">
      <div class="match">
        <a href="/matches/${matchId}/${slug}" class="match-top">
          <div class="match-event" data-event-headline="${event}" data-event-id="9414">
            <div class="match-event-logo-container"><img alt="${event}" src="logo.png"></div>
            ${event}
            <div class="match-stage match-grand-final "></div>
          </div>
        </a>
        <div class="match-bottom">
          <a href="/matches/${matchId}/${slug}" class="match-info">
            ${time}
            <div class="match-meta">bo3</div>
          </a>
          <a href="/matches/${matchId}/${slug}" class="match-teams">
            <div class="match-team team1">
              <div class="match-team-logo-container"><img src="a.png"></div>
              <div class="match-teamname text-ellipsis">${team1}</div>
            </div>
            <div class="match-team team2">
              <div class="match-team-logo-container"><img src="b.png"></div>
              <div class="match-teamname text-ellipsis">${team2}</div>
            </div>
          </a>
        </div>
      </div>
    </div>`;
}

function liveCard(opts: {
  matchId: string;
  slug?: string;
  event?: string;
  team1?: string;
  team2?: string;
  stars?: number;
  /** live="true" no wrapper (o HLTV marca assim quando o jogo começa). */
  wrapperLive?: boolean;
}): string {
  const {
    matchId,
    slug = `live-a-vs-live-b-${matchId}`,
    event = 'IEM Katowice 2026',
    team1 = 'Live A',
    team2 = 'Live B',
    stars = 3,
    wrapperLive = false,
  } = opts;
  return `
    <div class="match-wrapper " data-match-wrapper="" data-match-id="${matchId}" data-stars="${stars}" live="${wrapperLive}">
      <div class="match" data-livescore-match="${matchId}">
        <a href="/matches/${matchId}/${slug}" class="match-top">
          <div class="match-event" data-event-headline="${event}" data-event-id="9414">
            <div class="match-event-logo-container"><img src="logo.png"></div>
            ${event}
          </div>
        </a>
        <div class="match-meta-live">Live</div>
        <div class="match-teams">
          <div class="match-team team1"><div class="match-teamname">${team1}</div></div>
          <div class="match-team team2"><div class="match-teamname">${team2}</div></div>
        </div>
      </div>
    </div>`;
}

function pageHtml(body: string): string {
  return `<!DOCTYPE html><html><body><div class="matches-list">${body}</div></body></html>`;
}

let browser: Browser | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (e) {
    browser = null; // sem browser do Playwright: os testes de DOM são pulados
    // Na CI, teste pulado = pipeline verde sem a cobertura do DOM.
    // Falha alto: instale o Chromium (npm run playwright:install).
    if (process.env.CI) {
      throw new Error(
        `Chromium do Playwright indisponível na CI (${String(e).slice(0, 200)}) — rode npm run playwright:install`,
      );
    }
  }
});

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

async function extract(html: string): Promise<ListingCards> {
  if (!browser) throw new Error('playwright indisponível');
  const page: Page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await extractListingCards(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}

describe('extração do listing (fixture HTML do HLTV)', () => {
  it('lê a live do container data-livescore-match', async (ctx) => {
    if (!browser) return ctx.skip();
    const cards = await extract(
      pageHtml(liveCard({ matchId: '2399406', team1: 'DENDELE', team2: 'Imperial' })),
    );
    expect(cards.liveError).toBeNull();
    expect(cards.live).toHaveLength(1);
    expect(cards.live[0]).toMatchObject({
      matchId: '2399406',
      teamNames: ['DENDELE', 'Imperial'],
      event: 'IEM Katowice 2026',
      isLive: true,
      stars: 3,
    });
    expect(cards.live[0].href).toContain('/matches/2399406/');
  });

  it('lê as partidas futuras com horário e evento', async (ctx) => {
    if (!browser) return ctx.skip();
    const cards = await extract(
      pageHtml(
        upcomingCard({
          matchId: '2399896',
          event: 'DFRAG Invitational 2026',
          team1: 'Off Chops',
          team2: 'NEXVOID',
          unix: '1793156400000',
        }),
      ),
    );
    expect(cards.upcomingError).toBeNull();
    expect(cards.upcomingSeen).toBe(1);
    expect(cards.upcoming).toHaveLength(1);
    expect(cards.upcoming[0]).toMatchObject({
      matchId: '2399896',
      teamNames: ['Off Chops', 'NEXVOID'],
      event: 'DFRAG Invitational 2026',
      isLive: false,
      stars: 0,
      startUnix: '1793156400000',
    });
  });

  it('NÃO descarta card futuro por ter data-livescore-match dentro (fail-open)', async (ctx) => {
    // Cenário do review: se o atributo aparece em card que não é live, a
    // extração antiga jogava TODA a agenda fora (bot dormia 30min cego).
    if (!browser) return ctx.skip();
    const html = pageHtml(`
      <div class="match-wrapper" data-match-id="2399900" data-stars="0" live="false">
        <div class="match" data-livescore-match="2399900">
          <a href="/matches/2399900/a-vs-b">
            <div class="match-event" data-event-headline="Teste"></div>
          </a>
          <div class="match-time" data-unix="1793156400000">04:00</div>
          <div class="match-teamname">A</div>
          <div class="match-teamname">B</div>
        </div>
      </div>`);
    const cards = await extract(html);
    expect(cards.upcoming).toHaveLength(1);
    expect(cards.upcoming[0].matchId).toBe('2399900');
  });

  it('trata wrapper live="true" como live (não entra na agenda)', async (ctx) => {
    if (!browser) return ctx.skip();
    const html = pageHtml(`
      <div class="match-wrapper" data-match-id="2399901" data-stars="0" live="true">
        <div class="match">
          <a href="/matches/2399901/a-vs-b"><div class="match-event" data-event-headline="X"></div></a>
          <div class="match-time" data-unix="1793156400000">04:00</div>
          <div class="match-teamname">A</div>
          <div class="match-teamname">B</div>
        </div>
      </div>`);
    const cards = await extract(html);
    expect(cards.upcoming).toHaveLength(0);
    expect(cards.upcomingSeen).toBe(0);
  });

  it('não duplica partida que aparece como live e como wrapper futuro', async (ctx) => {
    if (!browser) return ctx.skip();
    const html = pageHtml(
      liveCard({ matchId: '2399902', wrapperLive: true }) +
        upcomingCard({ matchId: '2399902', unix: '1793156400000' }),
    );
    const cards = await extract(html);
    expect(cards.live.filter((c) => c.isLive)).toHaveLength(1);
    expect(cards.upcoming).toHaveLength(0);
  });

  it('card sem horário é extraído (sem hora) e conta como visto', async (ctx) => {
    // A exclusão do card sem horário acontece no buildListing (que
    // decide a confiabilidade da agenda), não na extração.
    if (!browser) return ctx.skip();
    const cards = await extract(
      pageHtml(upcomingCard({ matchId: '2399903', unix: null })),
    );
    expect(cards.upcomingSeen).toBe(1);
    expect(cards.upcoming).toHaveLength(1);
    expect(cards.upcoming[0].startUnix).toBe('');
  });

  it('card live quebrado degrada o listing mas não descarta os cards bons', async (ctx) => {
    // Card live SEM link de partida (markup atípico): a partida pode ter
    // sumido do listing → o listing é degradado (o chamador não pode
    // parar os recorders que sumiram) e os cards bons seguem valendo.
    if (!browser) return ctx.skip();
    const html = pageHtml(
      liveCard({ matchId: '2399406', team1: 'DENDELE', team2: 'Imperial' }) +
        `<div class="match" data-livescore-match="2399407">
           <div class="match-meta-live">Live</div>
           <div class="match-teamname">Time Quebrado</div>
         </div>`,
    );
    const cards = await extract(html);
    expect(cards.liveError).toBeNull();
    expect(cards.liveCardErrors).toBe(1);
    expect(cards.brokenLiveIds).toEqual(['2399407']);
    expect(cards.live).toHaveLength(1);
    expect(cards.live[0].matchId).toBe('2399406');
  });
});

describe('shouldStopRecorder (limpeza com listing degradado)', () => {
  const liveIds = new Set(['2399406']);

  it('partida no listing: o recorder continua', () => {
    expect(shouldStopRecorder('2399406', liveIds, [])).toBe(false);
  });

  it('partida que sumiu de verdade: o recorder é parado', () => {
    expect(shouldStopRecorder('2399999', liveIds, [])).toBe(true);
  });

  it('partida cujo card quebrou: o recorder é PRESERVADO', () => {
    // O card quebrado pode ser o dela: parar mataria a gravação (e
    // apagaria o buffer) sem motivo.
    expect(shouldStopRecorder('2399999', liveIds, ['2399999'])).toBe(false);
  });

  it('a proteção é POR ID (as outras partidas encerradas são limpas)', () => {
    // Suspender a limpeza inteira deixava recorders mortos ocupando os
    // slots de MAX_RECORDINGS (partidas novas deixavam de ser gravadas).
    expect(shouldStopRecorder('2399998', liveIds, ['2399999'])).toBe(true);
  });
});

describe('buildListing (filtros puros sobre os cards)', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');

  it('sem nenhum card futuro: agenda não confiável e poll no intervalo base', async (ctx) => {
    if (!browser) return ctx.skip();
    const cards = await extract(pageHtml(liveCard({ matchId: '2399406' })));
    const listing = buildListing(cards, 0, false);
    expect(listing.upcomingTotal).toBe(0);
    expect(listing.upcomingSeen).toBe(0);
    expect(listing.scheduleReliable).toBe(false);
    // O poll NÃO pode dormir 15/30min com a agenda quebrada.
    const decision = computePollDecision({
      now,
      nextMatchAt: null,
      baseIntervalMs: 45_000,
      forceReasons: [],
      scheduleReliable: listing.scheduleReliable,
      adaptive: true,
    });
    expect(decision.delayMs).toBe(45_000);
    expect(decision.reason).toBe('schedule-unreliable');
  });

  it('cards futuros mas nenhum elegível: agenda confiável, poll adiado', async (ctx) => {
    if (!browser) return ctx.skip();
    const cards = await extract(
      pageHtml(
        upcomingCard({ matchId: '2399904', stars: 1, unix: String(now + 4 * 3600_000) }) +
          upcomingCard({ matchId: '2399905', stars: 1, unix: String(now + 5 * 3600_000) }),
      ),
    );
    const listing = buildListing(cards, 4, false);
    expect(listing.upcomingTotal).toBe(2);
    expect(listing.upcoming).toHaveLength(0); // 1★ não passa em MIN_STARS=4
    expect(listing.scheduleReliable).toBe(true);
    const decision = computePollDecision({
      now,
      nextMatchAt: null,
      baseIntervalMs: 45_000,
      forceReasons: [],
      scheduleReliable: listing.scheduleReliable,
      adaptive: true,
    });
    expect(decision.reason).toBe('no-next-match');
    expect(decision.delayMs).toBe(15 * 60_000);
  });

  it('partida futura elegível entra na agenda com o horário do HLTV', async (ctx) => {
    if (!browser) return ctx.skip();
    const cards = await extract(
      pageHtml(
        upcomingCard({ matchId: '2399906', stars: 5, unix: String(now + 2 * 3600_000) }),
      ),
    );
    const listing = buildListing(cards, 4, false);
    expect(listing.scheduleReliable).toBe(true);
    expect(listing.upcoming).toHaveLength(1);
    expect(listing.upcoming[0].startsAt).toBe(now + 2 * 3600_000);
    expect(listing.upcoming[0].team1).toBe('Team A');
  });
});

/** ListingCards cru (sem DOM) para testar o buildListing puro. */
function rawCards(partial: Partial<ListingCards>): ListingCards {
  return {
    live: [],
    upcoming: [],
    upcomingSeen: 0,
    liveError: null,
    upcomingError: null,
    liveCardErrors: 0,
    upcomingCardErrors: 0,
    brokenLiveIds: [],
    ...partial,
  };
}

function rawUpcoming(matchId: string, startUnix: string): UpcomingCard {
  return {
    matchId,
    href: `/matches/${matchId}/a-vs-b`,
    teamNames: ['A', 'B'],
    event: 'Evento',
    stage: '',
    isLive: false,
    stars: 5,
    startUnix,
  };
}

describe('buildListing (confiabilidade da agenda)', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');

  it('maioria dos cards com horário: agenda confiável', () => {
    const listing = buildListing(
      rawCards({
        upcoming: [
          rawUpcoming('1', String(now + 3600_000)),
          rawUpcoming('2', String(now + 7200_000)),
          rawUpcoming('3', ''),
        ],
        upcomingSeen: 3,
      }),
      0,
      false,
    );
    expect(listing.upcomingTotal).toBe(2);
    expect(listing.scheduleReliable).toBe(true);
  });

  it('poucos cards com horário: agenda NÃO confiável (fail-open)', () => {
    // A partida mais próxima pode ser a que está sem data: adiar o poll
    // mirando a mais distante seria perder o começo do jogo.
    const listing = buildListing(
      rawCards({
        upcoming: [
          rawUpcoming('1', String(now + 3600_000)),
          rawUpcoming('2', ''),
          rawUpcoming('3', ''),
          rawUpcoming('4', ''),
        ],
        upcomingSeen: 4,
      }),
      0,
      false,
    );
    expect(listing.upcomingTotal).toBe(1);
    expect(listing.scheduleReliable).toBe(false);
  });

  it('card futuro que quebrou: agenda NÃO confiável', () => {
    const listing = buildListing(
      rawCards({
        upcoming: [rawUpcoming('1', String(now + 3600_000))],
        upcomingSeen: 1,
        upcomingCardErrors: 1,
      }),
      0,
      false,
    );
    expect(listing.scheduleReliable).toBe(false);
  });
});

describe('buildListing (piso de estrelas da watchlist)', () => {
  function rawLive(matchId: string, team1: string, team2: string, stars: number): MatchCard {
    return {
      matchId,
      href: `/matches/${matchId}/x-vs-y`,
      teamNames: [team1, team2],
      event: 'Evento',
      stage: '',
      isLive: true,
      stars,
    };
  }

  function watchlist(input: unknown) {
    const result = validateWatchlistDoc(input);
    expect(result.ok).toBe(true);
    return result.value!;
  }

  const wl = watchlist({
    defaults: { minKills: 4, minStars: 0 },
    teams: [
      { names: ['FURIA'], minKills: 3, minStars: 2 },
      { names: ['Legacy'], minKills: 4 },
    ],
  });

  it('time da lista entra pelo override quando o piso é atendido', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'MIBR', 2)] }),
      4, // MIN_STARS: a partida não passa no filtro geral
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].watchlisted).toBe(true);
    expect(listing.live[0].minKills).toBe(3);
  });

  it('piso não atendido: partida não entra (nem pelo watchlist)', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'MIBR', 1)] }),
      4,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(0);
  });

  it('partida sem estrelas (0 = desconhecido) não satisfaz piso acima de 0', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'MIBR', 0)] }),
      4,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(0);
  });

  it('piso 0 (herdado) mantém o override em qualquer partida', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'Legacy', 'MIBR', 0)] }),
      4,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].watchlisted).toBe(true);
  });

  it('piso atendido: entra pelo override mesmo passando no filtro geral', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'MIBR', 4)] }),
      2,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].watchlisted).toBe(true);
    expect(listing.live[0].minKills).toBe(3);
  });

  it('piso NÃO atendido: entra pela política geral, mas SEM o override', () => {
    // 1★ com MIN_STARS=1: a partida passa na política geral, mas o piso
    // do time (2) não é atendido — o override NÃO vale (o time volta ao
    // limiar geral) e o descarte fica registrado.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'MIBR', 1)] }),
      1,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].watchlisted).toBe(false);
    expect(listing.live[0].watchlistedTeams).toEqual(['FURIA']);
    // O limiar EFETIVO é o geral: o do time (3) não vale com o piso
    // barrado — mostrar 3 no log faria o bot cortar no limiar errado.
    expect(listing.live[0].minKills).toBe(5);
    expect(listing.discarded).toEqual([
      { section: 'live', team: 'FURIA', stars: 1, minStars: 2, enteredByGeneral: true },
    ]);
  });

  it('piso por time: quem não atendeu o piso não dá o limiar dele', () => {
    // 1★: FURIA (piso 2) NÃO atende; Legacy (piso 0) atende → o limiar
    // efetivo é o do Legacy (4), não o 3 do FURIA.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'Legacy', 1)] }),
      1,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].watchlisted).toBe(true);
    expect(listing.live[0].minKills).toBe(4);
  });

  it('piso não atendido e fora da política geral: a partida não entra', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'MIBR', 1)] }),
      4,
      false,
      { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(0);
    expect(listing.discarded).toEqual([
      { section: 'live', team: 'FURIA', stars: 1, minStars: 2, enteredByGeneral: false },
    ]);
  });
});

describe('buildListing (regra de rank: segundo fator de busca)', () => {
  function rawLive(matchId: string, team1: string, team2: string, stars: number): MatchCard {
    return {
      matchId,
      href: `/matches/${matchId}/x-vs-y`,
      teamNames: [team1, team2],
      event: 'Stake Ranked Episode 6',
      stage: '',
      isLive: true,
      stars,
    };
  }

  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const ranking = buildTeamRanking(
    [
      { position: '#5', name: 'FURIA' },
      { position: '#18', name: 'Ninjas in Pyjamas' },
      { position: '#34', name: 'BIG' },
      { position: '#60', name: 'MIBR' },
      { position: '#62', name: 'Legacy' },
    ],
    now,
  );
  // X=70 / Y=30, limiar da partida que entrou por rank = 4, sem piso de estrelas.
  const rank = { sumMax: 70, strongMax: 30, minKills: 4, minStars: 0 };
  const base = { ranking, rank, starredMinKills: 4, unstarredMinKills: 5 };

  it('0★ com a soma abaixo de X entra e libera os DOIS lados', () => {
    // NIP #18 + BIG #34 = 52 < 70 (o caso real).
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      4, // MIN_STARS: não passaria pelo filtro geral
      false,
      base,
    );
    expect(listing.live).toHaveLength(1);
    const m = listing.live[0];
    expect(m.rankQualified).toBe(true);
    expect(m.team1Rank).toBe(34);
    expect(m.team2Rank).toBe(18);
    expect(m.rankAllowedTeams).toEqual(['BIG', 'Ninjas in Pyjamas']);
    // Limiar da regra de rank (4), não o 5 de partida 0★.
    expect(m.minKills).toBe(4);
  });

  it('MIN_STARS=0 + below-general: o rank fica inerte porque o geral aceita tudo', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      0,
      false,
      { ...base, rank: { ...rank, starsMode: 'below-general' } },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankQualified).toBeUndefined();
    expect(listing.live[0].minKills).toBe(5);
  });

  it('below-general: RANK_MIN_STARS>=MIN_STARS deixa o rank sem faixa elegível', () => {
    // 1★ é recusada pelo geral, mas não atinge o piso 2★ do rank; 2★ passa
    // pelo geral e, em below-general, o rank não age sobre ela.
    const listing = buildListing(
      rawCards({
        live: [
          rawLive('1', 'BIG', 'Ninjas in Pyjamas', 1),
          rawLive('2', 'BIG', 'Ninjas in Pyjamas', 2),
        ],
      }),
      2,
      false,
      { ...base, rank: { ...rank, minStars: 2, starsMode: 'below-general' } },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].stars).toBe(2);
    expect(listing.live[0].rankQualified).toBeUndefined();
  });

  it('partida que entra só pelo rank usa o limiar de rank, mesmo maior que o geral', () => {
    // 1★ < MIN_STARS=2: o filtro geral recusa, então o rank é o único
    // limiar válido no runtime. O painel não pode mostrar o 4k geral.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 1)] }),
      2,
      false,
      { ...base, rank: { ...rank, minKills: 5 } },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankOnly).toBe(true);
    expect(listing.live[0].minKills).toBe(5);
  });

  it('sem a soma, o time abaixo de Y entra — e SÓ ele gera clipe', () => {
    // #18 + #60 = 78 (não passa na soma); NIP #18 < 30.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'Ninjas in Pyjamas', 'MIBR', 0)] }),
      4,
      false,
      base,
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankQualified).toBe(true);
    expect(listing.live[0].rankAllowedTeams).toEqual(['Ninjas in Pyjamas']);
    expect(listing.live[0].minKills).toBe(4);
  });

  it('soma e ranks fora do limite: não entra', () => {
    // #60 + #62 = 122 e nenhum abaixo de 30.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'MIBR', 'Legacy', 0)] }),
      4,
      false,
      base,
    );
    expect(listing.live).toHaveLength(0);
  });

  it('time fora do ranking não entra (fail-closed)', () => {
    // "Team Sem Rank" não está no ranking: não soma e não libera.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'FURIA', 'Team Sem Rank', 0)] }),
      4,
      false,
      base,
    );
    expect(listing.live).toHaveLength(0);
    // Anotação do rank conhecido fica no objeto mesmo sem entrar? Não:
    // a partida descartada não vira LiveMatch.
  });

  it('com a regra desligada (X=Y=0) nada é anotado', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      0,
      false,
      { ranking, rank: { sumMax: 0, strongMax: 0, minKills: 4, minStars: 0 } },
    );
    expect(listing.live).toHaveLength(1); // MIN_STARS=0 já deixa entrar
    expect(listing.live[0].rankQualified).toBeUndefined();
    expect(listing.live[0].team1Rank).toBeUndefined();
    expect(listing.live[0].minKills).toBe(5); // 0★: segue o limiar geral
  });

  it('sem ranking carregado a regra não age (fail-closed)', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      4,
      false,
      { ...base, ranking: null },
    );
    expect(listing.live).toHaveLength(0);
  });

  it('RANK_STARS_MODE=any: partida que já passa por estrelas NÃO é bloqueada pelo rank', () => {
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 5)] }),
      4,
      false,
      { ...base, rank: { ...rank, starsMode: 'any' } },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankOnly).toBe(false);
    // No modo any a condição de rank é atendida (o limiar de rank vale), mas
    // a partida NÃO entrou só por ele: os dois lados seguem liberados.
    expect(listing.live[0].rankQualified).toBe(true);
    expect(listing.live[0].rankAllowedTeams).toEqual(['BIG', 'Ninjas in Pyjamas']);
    expect(listing.live[0].minKills).toBe(4);
  });

  it('RANK_STARS_MODE=any: 2★ com o geral em 5k vira 4k', () => {
    // A partida passa por estrelas (2★ ≥ MIN_STARS=2), mas no modo any a
    // condição de rank também é atendida → o limiar de rank (4) vence o
    // geral (5). É o opt-in "mais clipes".
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 2)] }),
      2,
      false,
      { ...base, rank: { ...rank, starsMode: 'any' }, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    const m = listing.live[0];
    expect(m.rankQualified).toBe(true);
    expect(m.rankOnly).toBe(false);
    expect(m.minKills).toBe(4);
  });

  it('sem o modo (default below-general) a partida 2★ já aceita NÃO vira 4k', () => {
    // Mesmo caso do teste acima, sem `starsMode`: o default é o plano B, e
    // o rank não rebaixa o limiar de uma partida que as estrelas aceitaram.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 2)] }),
      2,
      false,
      { ...base, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankQualified).toBeUndefined();
    expect(listing.live[0].minKills).toBe(5);
  });

  it('sem a condição de rank, as estrelas seguem mandando no limiar', () => {
    // MIBR #60 + Legacy #62: soma 122 e nenhum abaixo de 30 → sem rank.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'MIBR', 'Legacy', 2)] }),
      2,
      false,
      { ...base, starredMinKills: 5, unstarredMinKills: 5 },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankQualified).toBeUndefined();
    expect(listing.live[0].minKills).toBe(5);
  });

  it('RANK_STARS_MODE=below-general: a partida que o geral aceitou segue o limiar geral', () => {
    // 2★ ≥ MIN_STARS=2 e o geral pede 5k. Em below-general o rank é só o
    // segundo fator: não rebaixa o limiar nem marca rankQualified.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 2)] }),
      2,
      false,
      {
        ...base,
        rank: { ...rank, starsMode: 'below-general' },
        starredMinKills: 5,
        unstarredMinKills: 5,
      },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankQualified).toBeUndefined();
    expect(listing.live[0].rankAllowedTeams).toBeUndefined();
    expect(listing.live[0].minKills).toBe(5);
  });

  it('RANK_STARS_MODE=below-general: a partida que o geral recusou continua entrando por rank', () => {
    // 0★ < MIN_STARS=2: o rank é o segundo fator e vale (4k), como antes.
    const listing = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      2,
      false,
      {
        ...base,
        rank: { ...rank, starsMode: 'below-general' },
        starredMinKills: 5,
        unstarredMinKills: 5,
      },
    );
    expect(listing.live).toHaveLength(1);
    expect(listing.live[0].rankQualified).toBe(true);
    expect(listing.live[0].rankOnly).toBe(true);
    expect(listing.live[0].minKills).toBe(4);
  });

  it('RANK_STARS_MODE=below-general também vale para a agenda futura', () => {
    const upcoming: UpcomingCard = {
      matchId: '2',
      href: '/matches/2/big-vs-nip',
      teamNames: ['BIG', 'Ninjas in Pyjamas'],
      event: 'Stake Ranked Episode 6',
      stage: '',
      isLive: false,
      stars: 2,
      startUnix: String(now + 3_600_000),
    };
    const listing = buildListing(
      rawCards({ upcoming: [upcoming], upcomingSeen: 1 }),
      2,
      false,
      {
        ...base,
        rank: { ...rank, starsMode: 'below-general' },
        starredMinKills: 5,
        unstarredMinKills: 5,
      },
    );
    // Passa no geral (continua na agenda), mas SEM a regra de rank.
    expect(listing.upcoming).toHaveLength(1);
    expect(listing.upcoming[0].rankQualified).toBeUndefined();
  });

  it('a agenda futura também entra por rank (o poll acorda para o jogo)', () => {
    const upcoming: UpcomingCard = {
      matchId: '2',
      href: '/matches/2/big-vs-nip',
      teamNames: ['BIG', 'Ninjas in Pyjamas'],
      event: 'Stake Ranked Episode 6',
      stage: '',
      isLive: false,
      stars: 0,
      startUnix: String(now + 3_600_000),
    };
    const listing = buildListing(
      rawCards({ upcoming: [upcoming], upcomingSeen: 1 }),
      4,
      false,
      base,
    );
    expect(listing.upcoming).toHaveLength(1);
    expect(listing.upcoming[0].rankQualified).toBe(true);
    expect(listing.upcoming[0].rankAllowedTeams).toEqual(['BIG', 'Ninjas in Pyjamas']);
  });

  it('piso de estrelas da própria regra de rank (RANK_MIN_STARS)', () => {
    // Piso 1: a partida 0★ (avaliação ausente) NÃO satisfaz → não entra.
    const comPiso = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      4,
      false,
      { ...base, rank: { ...rank, minStars: 1 } },
    );
    expect(comPiso.live).toHaveLength(0);

    // Piso 1 e a partida com 2 estrelas: entra pelo rank.
    const comEstrelas = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 2)] }),
      4,
      false,
      { ...base, rank: { ...rank, minStars: 1 } },
    );
    expect(comEstrelas.live).toHaveLength(1);
    expect(comEstrelas.live[0].rankQualified).toBe(true);

    // Piso 2 e a partida com 1 estrela: não entra.
    const curto = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 1)] }),
      4,
      false,
      { ...base, rank: { ...rank, minStars: 2 } },
    );
    expect(curto.live).toHaveLength(0);

    // Piso 0 (default): sem piso — a partida 0★ entra.
    const semPiso = buildListing(
      rawCards({ live: [rawLive('1', 'BIG', 'Ninjas in Pyjamas', 0)] }),
      4,
      false,
      base,
    );
    expect(semPiso.live).toHaveLength(1);
    expect(semPiso.live[0].rankQualified).toBe(true);
  });
});

describe('extração do ranking (/ranking/teams, fixture HTML do HLTV)', () => {
  it('lê posição e nome de cada ranked-team', async (ctx) => {
    if (!browser) return ctx.skip();
    const page: Page = await browser.newPage();
    try {
      await page.setContent(
        `<!DOCTYPE html><html><body>
           <div class="ranked-team standard-box"><div class="bg-holder">
             <div class="ranking-header">
               <span class="position wide-position">#18</span>
               <div class="relative"><div class="teamLine sectionTeamPlayers"><span class="name">Ninjas in Pyjamas</span></div></div>
             </div>
           </div></div>
           <div class="ranked-team standard-box"><div class="bg-holder">
             <div class="ranking-header">
               <span class="position wide-position">#34</span>
               <div class="relative"><div class="teamLine sectionTeamPlayers"><span class="name">BIG</span></div></div>
             </div>
           </div></div>
         </body></html>`,
        { waitUntil: 'domcontentloaded' },
      );
      const entries = await extractTeamRankingEntries(page);
      expect(entries).toEqual([
        { position: '#18', name: 'Ninjas in Pyjamas' },
        { position: '#34', name: 'BIG' },
      ]);
    } finally {
      await page.close().catch(() => undefined);
    }
  });

  it('descarta bloco sem posição e aceita .name direto no header', async (ctx) => {
    if (!browser) return ctx.skip();
    const page: Page = await browser.newPage();
    try {
      await page.setContent(
        `<!DOCTYPE html><html><body>
           <div class="ranked-team"><div class="ranking-header">
             <span class="name">FURIA</span><span class="position">#1</span>
           </div></div>
           <div class="ranked-team"><div class="ranking-header">
             <span class="position">#2</span>
           </div></div>
         </body></html>`,
        { waitUntil: 'domcontentloaded' },
      );
      const entries = await extractTeamRankingEntries(page);
      expect(entries).toEqual([{ position: '#1', name: 'FURIA' }]);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
});

describe('dedupeUpcoming', () => {
  function mk(matchId: string, startsAt: number, event = 'Evento'): UpcomingMatch {
    return {
      matchId,
      team1: 'A',
      team2: 'B',
      event,
      stars: 2,
      isTopTierGuess: false,
      startsAt,
      matchPageUrl: `https://www.hltv.org/matches/${matchId}/x`,
    };
  }

  it('dedupe por matchId e vence o horário mais próximo', () => {
    const out = dedupeUpcoming([
      mk('1', 1000),
      mk('1', 500),
      mk('2', 2000),
    ]);
    expect(out.map((m) => m.matchId)).toEqual(['1', '2']);
    expect(out[0].startsAt).toBe(500);
  });

  it('mantém o evento quando o card mais próximo não tem nome', () => {
    const out = dedupeUpcoming([mk('1', 1000, 'Evento X'), mk('1', 500, '')]);
    expect(out).toHaveLength(1);
    expect(out[0].startsAt).toBe(500);
    expect(out[0].event).toBe('Evento X');
  });

  it('ordena por horário', () => {
    const out = dedupeUpcoming([mk('2', 3000), mk('1', 1000)]);
    expect(out.map((m) => m.matchId)).toEqual(['1', '2']);
  });
});
