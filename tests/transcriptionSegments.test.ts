import { describe, expect, it } from 'vitest';
import {
  groupWordsIntoSegments,
  isSentenceEnd,
  normalizeLanguageCode,
  normalizeSegmentText,
  sanitizeSegments,
  singleSegment,
} from '../src/transcription/segments.js';
import type { TimedWord } from '../src/transcription/types.js';

function word(text: string, startSec: number, endSec: number): TimedWord {
  return { text, startSec, endSec };
}

describe('normalizeLanguageCode', () => {
  it('auto/vazio vira null (detectar)', () => {
    expect(normalizeLanguageCode('auto')).toBeNull();
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode(undefined)).toBeNull();
  });

  it('reduz a variante regional para o código base', () => {
    expect(normalizeLanguageCode('pt-BR')).toBe('pt');
    expect(normalizeLanguageCode('EN')).toBe('en');
  });
});

describe('normalizeSegmentText', () => {
  it('colapsa espaços e quebras', () => {
    expect(normalizeSegmentText('  a   b\n c ')).toBe('a b c');
  });
});

describe('isSentenceEnd', () => {
  it('reconhece a pontuação de fim de frase', () => {
    expect(isSentenceEnd('Acabou.')).toBe(true);
    expect(isSentenceEnd('Sério?')).toBe(true);
    expect(isSentenceEnd('não')).toBe(false);
  });
});

describe('sanitizeSegments', () => {
  it('descarta tempo inválido, texto vazio e ordena', () => {
    const out = sanitizeSegments([
      { startSec: 5, endSec: 6, text: 'depois' },
      { startSec: Number.NaN, endSec: 2, text: 'lixo' },
      { startSec: 1, endSec: 2, text: '  antes  ' },
      { startSec: 3, endSec: 4, text: '' },
    ]);
    expect(out).toEqual([
      { startSec: 1, endSec: 2, text: 'antes' },
      { startSec: 5, endSec: 6, text: 'depois' },
    ]);
  });

  it('corta o fim no começo do próximo bloco', () => {
    const out = sanitizeSegments([
      { startSec: 0, endSec: 4, text: 'um' },
      { startSec: 2, endSec: 3, text: 'dois' },
    ]);
    expect(out).toEqual([
      { startSec: 0, endSec: 2, text: 'um' },
      { startSec: 2, endSec: 3, text: 'dois' },
    ]);
  });

  it('limita ao fim do áudio', () => {
    const out = sanitizeSegments([{ startSec: 9, endSec: 12, text: 'fim' }], 10);
    expect(out).toEqual([{ startSec: 9, endSec: 10, text: 'fim' }]);
  });
});

describe('groupWordsIntoSegments', () => {
  it('junta palavras próximas num bloco', () => {
    const out = groupWordsIntoSegments([word('Hello', 0, 0.3), word('world', 0.35, 0.6)]);
    expect(out).toEqual([{ startSec: 0, endSec: 0.6, text: 'Hello world' }]);
  });

  it('fecha o bloco no fim de uma frase longa', () => {
    const out = groupWordsIntoSegments([
      word('This', 0, 0.2),
      word('is', 0.25, 0.35),
      word('a', 0.4, 0.45),
      word('sentence.', 0.5, 0.9),
      word('Another', 0.95, 1.3),
      word('one.', 1.35, 1.7),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('This is a sentence.');
  });

  it('junta interjeição curta com a fala seguinte', () => {
    const out = groupWordsIntoSegments([
      word('Olha.', 0, 0.3),
      word('toma!', 0.35, 0.9),
    ]);
    expect(out).toEqual([{ startSec: 0, endSec: 0.9, text: 'Olha. toma!' }]);
  });

  it('fecha o bloco na pausa', () => {
    const out = groupWordsIntoSegments(
      [word('Hello', 0, 0.3), word('world', 2, 2.4)],
      { gapSec: 0.6 },
    );
    expect(out).toHaveLength(2);
  });

  it('fecha o bloco no limite de caracteres', () => {
    const out = groupWordsIntoSegments(
      [word('aaaaaaaaaa', 0, 0.3), word('bbbbbbbbbb', 0.35, 0.6)],
      { maxChars: 12 },
    );
    expect(out).toHaveLength(2);
  });

  it('cola pontuação sem espaço antes', () => {
    const out = groupWordsIntoSegments([word('Hello', 0, 0.2), word(',', 0.2, 0.25)]);
    expect(out[0].text).toBe('Hello,');
  });

  it('não perde palavra com tempo zerado', () => {
    const out = groupWordsIntoSegments([word('oi', 1, 1)]);
    expect(out).toEqual([{ startSec: 1, endSec: 1.05, text: 'oi' }]);
  });
});

describe('singleSegment', () => {
  it('cobre o áudio inteiro e ignora texto vazio', () => {
    expect(singleSegment('texto', 12)).toEqual([
      { startSec: 0, endSec: 12, text: 'texto' },
    ]);
    expect(singleSegment('   ', 12)).toEqual([]);
  });
});
