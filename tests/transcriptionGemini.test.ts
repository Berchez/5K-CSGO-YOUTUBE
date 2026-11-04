import { describe, expect, it } from 'vitest';
import {
  isDedicatedTranscribeModel,
  toBcp47Language,
  wordsFromInteraction,
} from '../src/transcription/providers/gemini.js';
import { offsetToSec } from '../src/transcription/providers/common.js';

describe('offsetToSec', () => {
  it('lê os offsets do Gemini', () => {
    expect(offsetToSec('0.100s')).toBeCloseTo(0.1);
    expect(offsetToSec('12.345s')).toBeCloseTo(12.345);
  });

  it('aceita ms, relógio e número puro', () => {
    expect(offsetToSec('150ms')).toBeCloseTo(0.15);
    expect(offsetToSec('00:01.500')).toBeCloseTo(1.5);
    expect(offsetToSec(2.5)).toBeCloseTo(2.5);
  });

  it('devolve NaN para valor inválido', () => {
    expect(offsetToSec('')).toBeNaN();
    expect(offsetToSec('abc')).toBeNaN();
  });
});

describe('isDedicatedTranscribeModel', () => {
  it('reconhece o modelo dedicado', () => {
    expect(isDedicatedTranscribeModel('gemini-3.5-transcribe')).toBe(true);
    expect(isDedicatedTranscribeModel('Gemini-3.5-Transcribe')).toBe(true);
  });

  it('não confunde com o Flash', () => {
    expect(isDedicatedTranscribeModel('gemini-3-flash-preview')).toBe(false);
  });
});

describe('toBcp47Language', () => {
  it('expande os idiomas conhecidos', () => {
    expect(toBcp47Language('pt')).toEqual(['pt-BR']);
    expect(toBcp47Language('en')).toEqual(['en-US']);
  });

  it('mantém região e ignora auto', () => {
    expect(toBcp47Language('pt-BR')).toEqual(['pt-BR']);
    expect(toBcp47Language(null)).toEqual([]);
  });
});

describe('wordsFromInteraction', () => {
  it('extrai word_info dos annotations', () => {
    const words = wordsFromInteraction({
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: 'Olha. toma!',
              annotations: [
                {
                  type: 'word_info',
                  text: 'Olha.',
                  start_offset: '0.100s',
                  end_offset: '0.500s',
                },
                {
                  type: 'word_info',
                  text: 'toma!',
                  start_offset: '0.900s',
                  end_offset: '1.200s',
                },
                { type: 'other', text: 'ignorar', start_offset: '0.000s' },
              ],
            },
          ],
        },
      ],
    });
    expect(words).toEqual([
      { startSec: 0.1, endSec: 0.5, text: 'Olha.' },
      { startSec: 0.9, endSec: 1.2, text: 'toma!' },
    ]);
  });

  it('descarta palavra sem offset válido', () => {
    const words = wordsFromInteraction({
      steps: [{ content: [{ type: 'text', annotations: [{ type: 'word_info', text: 'x' }] }] }],
    });
    expect(words).toEqual([]);
  });
});
