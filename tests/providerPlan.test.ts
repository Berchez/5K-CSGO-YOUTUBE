import { describe, expect, it } from 'vitest';
import { planForProvider, type AiProvider } from '../src/clipper/aiThumbnail.js';
import type { AceEvent } from '../src/types.js';
import type { ReferenceImages } from '../src/clipper/referenceImages.js';

const ace: AceEvent = {
  matchId: 'm1',
  map: 'Anubis',
  round: 9,
  player: 'donk',
  team1: 'Spirit',
  team2: 'Falcons',
  event: 'ESL Pro League Season 24',
  detectedAt: new Date().toISOString(),
  kills: [],
};

const refs: ReferenceImages = {
  player: 'refs/player.jpg',
  playerAlt: 'refs/player-alt.jpg',
  team1Logo: 'refs/t1.png',
  team2Logo: 'refs/t2.png',
  mapImage: 'refs/map.jpg',
};
const all = [
  refs.player!,
  refs.playerAlt!,
  refs.team1Logo!,
  refs.team2Logo!,
  refs.mapImage!,
];

describe('planForProvider (roteamento da cadeia de fallback)', () => {
  it('chatgpt/grok: thumb completa com todas as referências', () => {
    for (const p of ['chatgpt', 'grok'] as AiProvider[]) {
      const plan = planForProvider(p, ace, refs, all);
      expect(plan.fullThumb).toBe(true);
      expect(plan.attachments).toEqual(all);
      expect(plan.prompt).toContain('LAYOUT (3 zonas)');
      expect(plan.prompt).toContain('REFERÊNCIAS');
    }
  });

  it('gemini-web: thumb COMPLETA policy-safe com as 4 referências', () => {
    const plan = planForProvider('gemini-web', ace, refs, all);
    expect(plan.fullThumb).toBe(true);
    expect(plan.attachments).toEqual(all);
    expect(plan.prompt).toContain('LAYOUT (3 zonas)');
    expect(plan.prompt).toContain('rosto na sombra');
    expect(plan.prompt).toContain('REFERÊNCIAS');
    expect(plan.prompt).not.toContain('retrato em close');
  });

  it('APIs (hf/gemini/pollinations): fundo sem anexos', () => {
    for (const p of ['huggingface', 'gemini', 'pollinations'] as AiProvider[]) {
      const plan = planForProvider(p, ace, refs, all);
      expect(plan.attachments).toEqual([]);
      expect(plan.fullThumb).toBe(false);
    }
  });

  it('sem referências: chatgpt segue com prompt completo e sem anexos', () => {
    const plan = planForProvider('chatgpt', ace, undefined, []);
    expect(plan.fullThumb).toBe(true);
    expect(plan.attachments).toEqual([]);
    expect(plan.prompt).not.toContain('REFERÊNCIAS');
  });
});
