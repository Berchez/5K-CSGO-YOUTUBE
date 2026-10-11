import { describe, expect, it } from 'vitest';
import {
  cardToLiveMatch,
  guessTopTier,
  matchPassesFilter,
  parseStarsFromHtml,
  pickPreferredStream,
} from '../src/monitor/hltvMonitor.js';

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
  });

  it('guessTopTier reconhece eventos grandes', () => {
    expect(guessTopTier('IEM Katowice 2026', 0)).toBe(true);
    expect(guessTopTier('BLAST Premier', 0)).toBe(true);
    expect(guessTopTier('FRAG University 2026', 0)).toBe(false);
    expect(guessTopTier('qualquer coisa', 5)).toBe(true);
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
});
