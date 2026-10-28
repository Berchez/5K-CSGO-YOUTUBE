import { describe, expect, it } from 'vitest';
import { buildMetadataPrompt, metadataAiProviders, parseAiDraft } from '../src/uploader/metadataAi.js';
import { buildMetadataContext } from '../src/uploader/videoMetadata.js';
import type { AceEvent } from '../src/types.js';

const ace: AceEvent = {
  matchId: '1',
  map: 'Mirage',
  round: 12,
  player: 'donk',
  team1: 'Spirit',
  team2: 'MOUZ',
  event: 'PGL Masters Bucharest',
  detectedAt: '2026-10-27T16:48:50.654Z',
  score: '3-6',
  kills: Array.from({ length: 5 }, (_, i) => ({
    killer: 'donk',
    victim: `vitor${i}`,
    round: 12,
    map: 'Mirage',
    weapon: 'ak47',
    headshot: i < 2,
  })),
};

describe('ordem dos providers de texto', () => {
  it('usa a ordem configurada e ignora desconhecidos', () => {
    expect(metadataAiProviders('gemini,huggingface')).toEqual(['gemini', 'huggingface']);
    expect(metadataAiProviders('huggingface,gemini')).toEqual(['huggingface', 'gemini']);
    expect(metadataAiProviders('chatgpt,gemini')).toEqual(['gemini']);
    expect(metadataAiProviders('')).toEqual(['gemini', 'huggingface']);
  });
});

describe('parse da resposta da IA', () => {
  it('lê JSON puro', () => {
    const draft = parseAiDraft('{"titles": ["a", "b"], "description": "d"}');
    expect(draft?.titles).toEqual(['a', 'b']);
    expect(draft?.opening).toBe('d');
  });

  it('lê JSON dentro de bloco de código', () => {
    const draft = parseAiDraft('```json\n{"titles": ["a"], "opening": "d"}\n```');
    expect(draft?.titles).toEqual(['a']);
    expect(draft?.opening).toBe('d');
  });

  it('lê JSON com texto em volta', () => {
    const draft = parseAiDraft('Claro! {"titles": ["a"], "opening": "d"} espero que sirva');
    expect(draft?.titles).toEqual(['a']);
    expect(draft?.opening).toBe('d');
  });

  it('conserta JSON truncado no meio da lista', () => {
    const draft = parseAiDraft('{"titles": ["titulo bom", "titulo cortad');
    expect(draft?.titles?.[0]).toBe('titulo bom');
    expect(draft?.titles).toHaveLength(2);
  });

  it('conserta JSON truncado dentro de uma string', () => {
    const draft = parseAiDraft('{"titles": ["titulo cortad');
    expect(draft?.titles).toEqual(['titulo cortad']);
  });

  it('descarta resposta sem JSON utilizável', () => {
    expect(parseAiDraft('sem json nenhum')).toBeNull();
    expect(parseAiDraft('')).toBeNull();
    expect(parseAiDraft('{"titles": [], "description": ""}')).toBeNull();
  });
});

describe('prompt dos metadados', () => {
  it('embute os fatos e as regras', () => {
    const prompt = buildMetadataPrompt(buildMetadataContext(ace));
    expect(prompt).toContain('donk');
    expect(prompt).toContain('Mirage');
    expect(prompt).toContain('PGL Masters Bucharest');
    expect(prompt).toContain('5');
    expect(prompt).toContain('clutch');
    expect(prompt).toContain('100 caracteres');
  });
});
