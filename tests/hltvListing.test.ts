import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  buildListing,
  dedupeUpcoming,
  extractListingCards,
  shouldStopRecorder,
  type ListingCards,
  type UpcomingCard,
  type UpcomingMatch,
} from '../src/monitor/hltvMonitor.js';
import { computePollDecision } from '../src/monitor/pollSchedule.js';

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
