import { describe, expect, it } from 'vitest';
import {
  buildMetadataPrompt,
  isRetriableError,
  metadataAiProviders,
  parseAiDraft,
  thinkingConfigFor,
  titlesArrayTruncated,
} from '../src/uploader/metadataAi.js';
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

  it('conserta JSON truncado no meio da lista e descarta o título cortado', () => {
    // O último item de uma resposta truncada fica pela metade e passa na
    // validação: ele viraria título cortado no vídeo.
    const draft = parseAiDraft('{"titles": ["titulo bom", "titulo cortad');
    expect(draft?.titles?.[0]).toBe('titulo bom');
    expect(draft?.titles).toHaveLength(1);
  });

  it('descarta a resposta truncada que só tinha o título cortado', () => {
    const draft = parseAiDraft('{"titles": ["titulo cortad');
    expect(draft).toBeNull();
  });

  it('descarta resposta sem JSON utilizável', () => {
    expect(parseAiDraft('sem json nenhum')).toBeNull();
    expect(parseAiDraft('')).toBeNull();
    expect(parseAiDraft('{"titles": [], "description": ""}')).toBeNull();
  });

  it('mantém os títulos inteiros quando o corte foi na abertura', () => {
    // O corte no meio da ABERTURA não deixa nenhum título pela metade:
    // descartar o último título tiraria uma opção boa de graça.
    const draft = parseAiDraft('{"titles": ["titulo 1", "titulo 2"], "opening": "linha de impacto\\n\\nparagrafo cortad');
    expect(draft?.titles).toEqual(['titulo 1', 'titulo 2']);
    expect(draft?.truncated).toBe(true);
  });

  it('marca a resposta truncada mesmo quando os títulos estão inteiros', () => {
    const draft = parseAiDraft('{"titles": ["titulo 1"], "opening": "abertura cortad');
    expect(draft?.truncated).toBe(true);
  });

  it('JSON completo não é marcado como truncado', () => {
    const draft = parseAiDraft('{"titles": ["a"], "opening": "d"}');
    expect(draft?.truncated).toBe(false);
  });
});

describe('detecção de corte na lista de títulos', () => {
  it('reconhece o array fechado', () => {
    expect(titlesArrayTruncated('{"titles": ["a", "b"], "opening": "d"}')).toBe(false);
  });

  it('reconhece o array interrompido', () => {
    expect(titlesArrayTruncated('{"titles": ["a", "b"')).toBe(true);
  });

  it('array fechado não é truncagem de lista (mesmo com o JSON cortado depois)', () => {
    // O JSON pode ter sido cortado DEPOIS do array: os títulos estão
    // inteiros e nenhum deve ser descartado.
    expect(titlesArrayTruncated('{"titles": ["a", "b"]')).toBe(false);
  });

  it('não confunde ] dentro de string com fim do array', () => {
    expect(titlesArrayTruncated('{"titles": ["a ] b", "c"], "opening": "d"}')).toBe(false);
  });

  it('sem lista de títulos não é truncagem de lista', () => {
    expect(titlesArrayTruncated('{"opening": "d"}')).toBe(false);
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

describe('resiliência do provider', () => {
  it('não repete erro de credencial/permissão', () => {
    expect(isRetriableError(new Error('API key not valid: 400'))).toBe(false);
    expect(isRetriableError(new Error('got status 401 Unauthorized'))).toBe(false);
    expect(isRetriableError(new Error('got status 403 Forbidden'))).toBe(false);
  });

  it('repete erro de rede/rate limit', () => {
    expect(isRetriableError(new Error('fetch failed'))).toBe(true);
    expect(isRetriableError(new Error('got status 429 Too Many Requests'))).toBe(true);
    expect(isRetriableError(new Error('timeout gemini-texto após 45000ms'))).toBe(true);
  });

  it('não manda thinkingBudget para o Gemini 3 (o modelo rejeita o campo)', () => {
    expect(thinkingConfigFor('gemini-3-flash-preview')).toBeUndefined();
    expect(thinkingConfigFor('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
  });
});
