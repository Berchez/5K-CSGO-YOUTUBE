import { describe, expect, it } from 'vitest';
import {
  cardToLiveMatch,
  effectiveMatchRule,
  guessTopTier,
  matchPassesFilter,
  minKillsForStars,
  parseStarsFromHtml,
  parseStreamCountry,
  parseViewers,
  pickPreferredStream,
  selectStream,
} from '../src/monitor/hltvMonitor.js';
import { type WatchlistDoc, validateWatchlistDoc } from '../src/watchlist.js';

function watchlist(input: unknown): WatchlistDoc {
  const result = validateWatchlistDoc(input);
  if (!result.ok || !result.value) throw new Error(result.errors.join('; '));
  return result.value;
}

describe('stars filter', () => {
  it('filtra por MIN_STARS', () => {
    expect(matchPassesFilter(5, true, 4, false)).toBe(true);
    expect(matchPassesFilter(2, false, 4, false)).toBe(false);
  });

  it('topTierOnly bloqueia jogo pequeno', () => {
    expect(matchPassesFilter(4, false, 4, true)).toBe(false);
    expect(matchPassesFilter(4, true, 4, true)).toBe(true);
  });

  it('stars 0 (desconhecido) usa heurística top-tier', () => {
    // MIN_STARS=4 mas sem estrelas no listing: Major passa, jogo pequeno não
    expect(matchPassesFilter(0, true, 4, false)).toBe(true);
    expect(matchPassesFilter(0, false, 4, false)).toBe(false);
    // MIN_STARS=0 aceita tudo
    expect(matchPassesFilter(0, false, 0, false)).toBe(true);
  });

  it('parseStars conta fa-star cheias', () => {
    expect(parseStarsFromHtml('x', 5)).toBe(5);
    expect(parseStarsFromHtml('<i class="fa fa-star"></i><i class="fa fa-star"></i>', 0)).toBe(2);
    expect(parseStarsFromHtml('<i class="fa fa-star-o"></i>', 0)).toBe(0);
    // Layout 2026: 5 <i>, sendo 4 "faded" — 1★ real.
    expect(
      parseStarsFromHtml(
        '<i class="fa fa-star"></i><i class="fa fa-star faded"></i><i class="fa fa-star faded"></i><i class="fa fa-star faded"></i><i class="fa fa-star faded"></i>',
        0,
      ),
    ).toBe(1);
  });

  it('guessTopTier reconhece eventos grandes', () => {
    expect(guessTopTier('IEM Katowice 2026', 0)).toBe(true);
    expect(guessTopTier('BLAST Premier', 0)).toBe(true);
    expect(guessTopTier('FRAG University 2026', 0)).toBe(false);
    expect(guessTopTier('qualquer coisa', 5)).toBe(true);
  });
});

describe('minKillsForStars', () => {
  it('com pelo menos 1 estrela: 4k+', () => {
    expect(minKillsForStars(1, 4, 5)).toBe(4);
    expect(minKillsForStars(5, 4, 5)).toBe(4);
  });

  it('sem estrela: só 5k', () => {
    expect(minKillsForStars(0, 4, 5)).toBe(5);
  });
});

describe('effectiveMatchRule (watchlist vence estrelas)', () => {
  const wl = watchlist({
    defaults: { minKills: 4 },
    teams: [
      { names: ['FURIA', 'FURIA Esports'], minKills: 3 },
      { names: ['Imperial', 'Imperial Esports'], minKills: 5 },
      { names: ['Legacy'], minKills: 4, enabled: false },
    ],
  });
  const filter = { watchlist: wl, starredMinKills: 5, unstarredMinKills: 5 };

  it('time na lista grava com 0★ e usa o limiar do time', () => {
    const rule = effectiveMatchRule({ stars: 0, team1: 'Fúria', team2: 'MIBR' }, filter);
    expect(rule).toMatchObject({ watchlisted: true, minKills: 3, matchedTeams: ['FURIA'] });
  });

  it('dois times casados usam o menor limiar (ordem das regras)', () => {
    const rule = effectiveMatchRule({ stars: 0, team1: 'Imperial', team2: 'FURIA' }, filter);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(3);
    expect(rule.matchedTeams).toEqual(['FURIA', 'Imperial']);
  });

  it('fora da lista (ou time desabilitado) cai na política por estrela', () => {
    expect(effectiveMatchRule({ stars: 0, team1: 'MIBR', team2: 'NIP' }, filter)).toMatchObject({
      watchlisted: false,
      minKills: 5,
    });
    expect(effectiveMatchRule({ stars: 4, team1: 'MIBR', team2: 'NIP' }, filter)).toMatchObject({
      watchlisted: false,
      minKills: 5,
    });
    expect(effectiveMatchRule({ stars: 0, team1: 'Legacy', team2: 'NIP' }, filter).watchlisted).toBe(
      false,
    );
  });

  it('sem watchlist mantém a política por estrela', () => {
    expect(effectiveMatchRule({ stars: 2, team1: 'FURIA', team2: 'MIBR' }, {})).toMatchObject({
      watchlisted: false,
      minKills: 4,
    });
  });
});

describe('cardToLiveMatch', () => {
  it('mapeia card real do listing 2026', () => {
    const m = cardToLiveMatch({
      matchId: '2399406',
      href: '/matches/2399406/dendele-vs-imperial-frag-university-2026',
      teamNames: ['DENDELE', 'Imperial'],
      event: 'FRAG University 2026',
      stage: 'Playoffs',
      isLive: true,
      stars: 0,
    });
    expect(m.team1).toBe('DENDELE');
    expect(m.team2).toBe('Imperial');
    expect(m.event).toBe('FRAG University 2026');
    expect(m.matchPageUrl).toContain('2399406');
    expect(m.isTopTierGuess).toBe(false);
  });
});

describe('parseViewers', () => {
  it('lê número cru e formato k', () => {
    expect(parseViewers('9988')).toBe(9988);
    expect(parseViewers('9.9k')).toBe(9900);
    expect(parseViewers('1,2k')).toBe(1200);
  });

  it('vazio e absurdos viram undefined (não quebram o scoring)', () => {
    expect(parseViewers('')).toBeUndefined();
    expect(parseViewers('abc')).toBeUndefined();
    expect(parseViewers('99889.9k')).toBeUndefined();
  });
});

describe('pickPreferredStream', () => {
  it('prefere oficial EN quando pedido', () => {
    const s = pickPreferredStream(
      [
        { name: 'Gaules', url: 'https://twitch.tv/gaules', viewers: 50000 },
        { name: 'ESL_CS', url: 'https://twitch.tv/esl_cs', viewers: 5000 },
      ],
      'official,en',
    );
    expect(s?.name).toBe('ESL_CS');
  });

  it('retorna null sem streams', () => {
    expect(pickPreferredStream([], 'official,en')).toBeNull();
  });

  it('prefere Gaules quando pedido (STREAM_PRIORITY=gaules)', () => {
    const s = pickPreferredStream(
      [
        { name: 'ESL_CS', url: 'https://twitch.tv/esl_cs', viewers: 5000 },
        { name: 'Gaules', url: 'https://twitch.tv/gaules', viewers: 50000 },
      ],
      'gaules',
    );
    expect(s?.name).toBe('Gaules');
  });

  it('gaules vence mesmo com menos viewers que a oficial', () => {
    const s = pickPreferredStream(
      [
        { name: 'ESL_CS', url: 'https://twitch.tv/esl_cs', viewers: 100000 },
        { name: 'Gaules', url: 'https://twitch.tv/gaules', viewers: 5000 },
      ],
      'gaules',
    );
    expect(s?.name).toBe('Gaules');
  });

  it('sem Gaules no ar: fallback para oficial EN (não pega restream)', () => {
    const s = pickPreferredStream(
      [
        { name: 'RandomRestream', url: 'https://twitch.tv/xyz', viewers: 100000 },
        { name: 'ESL_CS', url: 'https://twitch.tv/esl_cs', viewers: 5000 },
      ],
      'gaules',
    );
    expect(s?.name).toBe('ESL_CS');
  });

  it('sem oficial no ar: fallback para Gaules (não pega restream aleatório)', () => {
    const s = pickPreferredStream(
      [
        { name: 'RandomRestream', url: 'https://twitch.tv/xyz', viewers: 200000 },
        { name: 'Gaules', url: 'https://twitch.tv/gaules', viewers: 5000 },
      ],
      'official,en',
    );
    expect(s?.name).toBe('Gaules');
  });
});

describe('parseStreamCountry', () => {
  it('extrai o código da bandeira do HLTV', () => {
    expect(parseStreamCountry('/img/static/flags/30x20/BR.gif', 'Brazil')).toBe('BR');
    expect(parseStreamCountry('/img/static/flags/30x20/RU.gif', 'Russia')).toBe('RU');
    expect(parseStreamCountry('/img/static/flags/30x20/WORLD.gif', 'Other')).toBe('WORLD');
  });

  it('usa o título como fallback', () => {
    expect(parseStreamCountry('', 'Brazil')).toBe('BR');
    expect(parseStreamCountry('', 'Brasil')).toBe('BR');
  });

  it('ignora texto de título que não é código de país', () => {
    expect(parseStreamCountry('', 'Chile')).toBeUndefined();
    expect(parseStreamCountry('', 'English')).toBeUndefined();
  });
});

describe('selectStream', () => {
  const streams = [
    { name: 'lentbb', url: 'https://twitch.tv/lentbb', country: 'RU', viewers: 2289 },
    { name: 'mch', url: 'https://twitch.tv/mch', country: 'BR', viewers: 2229 },
    { name: 'CircuitX', url: 'https://twitch.tv/circuitx', country: 'BR', viewers: 1587 },
    { name: 'ESL_CS', url: 'https://twitch.tv/esl_cs', viewers: 5000 },
  ];

  it('prefere o país com audiência mínima, mesmo sem ser o maior geral', () => {
    const choice = selectStream(streams, 'official,en', {
      country: 'BR',
      minViewers: 2000,
    });
    expect(choice?.stream.name).toBe('mch');
    expect(choice?.reason).toBe('preferred');
  });

  it('sem stream do país acima do mínimo, usa a principal', () => {
    const choice = selectStream(
      streams.filter((s) => s.name !== 'mch'),
      'official,en',
      { country: 'BR', minViewers: 2000 },
    );
    expect(choice?.stream.name).toBe('ESL_CS');
    expect(choice?.reason).toBe('main');
  });

  it('sem principal, usa qualquer stream de maior audiência', () => {
    const choice = selectStream(
      [
        { name: 'CircuitX', url: 'https://twitch.tv/circuitx', country: 'BR', viewers: 1587 },
      ],
      'official,en',
      { country: 'BR', minViewers: 2000 },
    );
    expect(choice?.stream.name).toBe('CircuitX');
    expect(choice?.reason).toBe('fallback');
  });

  it('não aplica preferência quando o país está vazio', () => {
    const choice = selectStream(streams, 'official,en', {
      country: '',
      minViewers: 2000,
    });
    expect(choice?.stream.name).toBe('ESL_CS');
    expect(choice?.reason).toBe('main');
  });

  it('retorna null sem streams', () => {
    expect(selectStream([], 'official,en', { country: 'BR', minViewers: 2000 })).toBeNull();
  });

  it('prioridade explícita (gaules) vence o mínimo de audiência do país', () => {
    const choice = selectStream(
      [
        { name: 'Gaules', url: 'https://twitch.tv/gaules', country: 'FR', viewers: 500 },
        { name: 'ESL_CS', url: 'https://twitch.tv/esl_cs', viewers: 5000 },
      ],
      'gaules',
      { country: 'FR', minViewers: 2000 },
    );
    expect(choice?.stream.name).toBe('Gaules');
  });

  it('desempate mantém a ordem do HLTV (não alfabética)', () => {
    const choice = selectStream(
      [
        { name: 'zzz_channel', url: 'https://twitch.tv/zzz', viewers: 1000 },
        { name: 'aaa_channel', url: 'https://twitch.tv/aaa', viewers: 1000 },
      ],
      'none',
      {},
    );
    expect(choice?.stream.name).toBe('zzz_channel');
  });
});
