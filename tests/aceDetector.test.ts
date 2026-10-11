import { describe, expect, it } from 'vitest';
import { detectAceInRound, RoundTracker, isRoundMarker } from '../src/detector/aceDetector.js';

const k = (killer: string, victim = 'v') => ({
  killer,
  victim,
  round: 1,
  map: 'mirage',
});

describe('detectAceInRound', () => {
  it('detecta 5 kills do mesmo player', () => {
    const kills = ['donk', 'donk', 'donk', 'donk', 'donk'].map((p) => k(p));
    expect(detectAceInRound(kills)).toBe('donk');
  });

  it('ignora case', () => {
    const kills = ['ZyWoo', 'zywoo', 'ZYWOO', 'ZywOo', 'zywoo'].map((p) => k(p));
    expect(detectAceInRound(kills)).toBe('ZyWoo');
  });

  it('rejeita 4k', () => {
    expect(detectAceInRound(['a', 'a', 'a', 'a'].map((p) => k(p)))).toBeNull();
  });

  it('rejeita 5 kills divididos', () => {
    const kills = ['a', 'a', 'a', 'a', 'b'].map((p) => k(p));
    expect(detectAceInRound(kills)).toBeNull();
  });

  it('ignora markers T/CT legados', () => {
    expect(isRoundMarker('T')).toBe(true);
    expect(isRoundMarker('CT')).toBe(true);
    expect(isRoundMarker('donk')).toBe(false);
  });
});

describe('RoundTracker', () => {
  it('acumula e fecha round com ace', () => {
    const t = new RoundTracker('anubis', 5);
    for (let i = 0; i < 5; i++) t.addKill('m0NESY', `victim${i}`);
    expect(t.pending).toBe(5);
    const { ace, kills } = t.closeRound();
    expect(ace).toBe('m0NESY');
    expect(kills).toHaveLength(5);
    expect(t.pending).toBe(0);
  });

  it('pula markers sem contar', () => {
    const t = new RoundTracker();
    t.addKill('T', '');
    t.addKill('s1mple', 'a');
    expect(t.pending).toBe(1);
  });
});
