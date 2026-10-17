import { describe, expect, it } from 'vitest';
import { estimateStreamOffset, matchKillfeedText } from '../src/clipper/killfeedSync.js';
import type { KillEvent } from '../src/types.js';

const kills: KillEvent[] = [
  { killer: 'nqz', victim: 'playerA', round: 20, map: 'Cache', at: 100_000 },
  { killer: 'nqz', victim: 'playerB', round: 20, map: 'Cache', at: 110_000 },
  { killer: 'nqz', victim: 'playerC', round: 20, map: 'Cache', at: 120_000 },
  { killer: 'nqz', victim: 'playerD', round: 20, map: 'Cache', at: 130_000 },
];

describe('estimateStreamOffset', () => {
  it('returns the median source delay when distinct kills agree', () => {
    const observations = [
      { killIndex: 0, streamAtMs: 110_200 },
      { killIndex: 0, streamAtMs: 113_200 },
      { killIndex: 1, streamAtMs: 120_700 },
      { killIndex: 1, streamAtMs: 123_700 },
      { killIndex: 2, streamAtMs: 130_400 },
      { killIndex: 2, streamAtMs: 133_400 },
    ];

    expect(estimateStreamOffset(kills, observations, 10_000, 120)).toEqual({
      offsetMs: 20_400,
      matchedKills: 3,
      totalKills: 4,
      medianDeviationMs: 200,
      reason: 'confident',
    });
  });

  it('requires enough distinct kills and rejects inconsistent offsets', () => {
    const oneKill = [{ killIndex: 0, streamAtMs: 110_000 }];
    expect(estimateStreamOffset(kills, oneKill, 10_000, 120).reason).toBe('insufficient-matches');
    expect(
      estimateStreamOffset(kills.slice(0, 3), [
        { killIndex: 0, streamAtMs: 110_000 },
        { killIndex: 1, streamAtMs: 120_000 },
      ], 10_000, 120).reason,
    ).toBe('insufficient-matches');

    const inconsistent = [
      { killIndex: 0, streamAtMs: 110_000 },
      { killIndex: 1, streamAtMs: 130_000 },
      { killIndex: 2, streamAtMs: 150_000 },
    ];
    expect(estimateStreamOffset(kills, inconsistent, 10_000, 120)).toMatchObject({
      offsetMs: null,
      reason: 'inconsistent-offsets',
    });
  });

  it('rejects offsets outside the configured source-delay range', () => {
    const observations = [
      { killIndex: 0, streamAtMs: 300_000 },
      { killIndex: 1, streamAtMs: 310_000 },
      { killIndex: 2, streamAtMs: 320_000 },
    ];
    expect(estimateStreamOffset(kills, observations, 10_000, 120).reason).toBe('insufficient-matches');
  });
});

describe('matchKillfeedText', () => {
  it('matches both exact player names despite punctuation and case', () => {
    expect(matchKillfeedText('NQZ | rifle icon | PlayerA', kills)).toEqual([0]);
  });

  it('does not treat a nickname as a substring of a different name', () => {
    expect(matchKillfeedText('nqz killed playerA2', kills)).toEqual([]);
  });

  it('matches aliases split into adjacent OCR tokens', () => {
    const withCompoundNames: KillEvent[] = [
      { killer: 'N Q Z', victim: 'Player-A', round: 1, map: 'Cache' },
    ];
    expect(matchKillfeedText('N Q Z | rifle | Player A', withCompoundNames)).toEqual([0]);
  });
});
