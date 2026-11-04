import { describe, expect, it } from 'vitest';
import {
  buildCaptionLines,
  buildCaptionsAss,
  captionCrosshairTopY,
  captionMaxChars,
  escapeAssFilterPath,
  escapeAssText,
  fitCaptionLines,
  formatAssTime,
  normalizeCaptionText,
  wrapCaptionText,
} from '../src/clipper/shortCaptions.js';
import {
  captionProviders,
  groupCaptionChunks,
  parseGeminiTranscript,
} from '../src/clipper/shortCaptionsAi.js';
import { buildShortLayout, isStaleRender, shortRenderSignature } from '../src/clipper/shorts.js';

describe('normalizeCaptionText', () => {
  it('junta os espaços e tira as notas musicais', () => {
    expect(normalizeCaptionText('  ele   pegou  o  rifle ♪ ')).toBe('ele pegou o rifle');
  });

  it('tira os marcadores entre colchetes (som, não fala)', () => {
    expect(normalizeCaptionText('que inning [applause] em Cache')).toBe('que inning em Cache');
  });

  it('tira o espaço antes da pontuação', () => {
    expect(normalizeCaptionText('que isso , cara !')).toBe('que isso, cara!');
  });

  it('texto vazio fica vazio', () => {
    expect(normalizeCaptionText('   ')).toBe('');
    expect(normalizeCaptionText('[music]')).toBe('');
  });
});

describe('wrapCaptionText', () => {
  it('quebra em linhas de até maxChars sem cortar palavra', () => {
    expect(wrapCaptionText('um dois tres quatro cinco', 12)).toEqual([
      'um dois tres',
      'quatro cinco',
    ]);
    expect(wrapCaptionText('um dois tres quatro cinco', 10)).toEqual([
      'um dois',
      'tres',
      'quatro',
      'cinco',
    ]);
  });

  it('palavra maior que a linha é partida', () => {
    expect(wrapCaptionText('supercalifragilistico', 8)).toEqual([
      'supercal',
      'ifragili',
      'stico',
    ]);
  });
});

describe('fitCaptionLines', () => {
  it('corta o que passa de maxLines com reticências', () => {
    const lines = fitCaptionLines('um dois tres quatro cinco seis', 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });
});

describe('buildCaptionLines', () => {
  it('joga fora o que está fora da duração do Short', () => {
    const lines = buildCaptionLines(
      [
        { startSec: 1, endSec: 2, text: 'dentro' },
        { startSec: 50, endSec: 60, text: 'depois' },
      ],
      { durSec: 10 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('dentro');
  });

  it('não deixa uma legenda por cima da outra', () => {
    const lines = buildCaptionLines(
      [
        { startSec: 0, endSec: 5, text: 'primeira' },
        { startSec: 2, endSec: 4, text: 'segunda' },
      ],
      { durSec: 10 },
    );
    expect(lines[0].endSec).toBeLessThanOrEqual(lines[1].startSec);
  });

  it('divide um bloco longo na tela em pedaços', () => {
    const linhas = buildCaptionLines(
      [{ startSec: 0, endSec: 12, text: 'uma frase bem longa demais para a tela' }],
      { durSec: 20, maxLineSec: 6 },
    );
    expect(linhas.length).toBeGreaterThan(1);
    for (const linha of linhas) expect(linha.endSec - linha.startSec).toBeLessThanOrEqual(6.01);
  });

  it('dá tempo mínimo de leitura', () => {
    const linhas = buildCaptionLines([{ startSec: 1, endSec: 1.1, text: 'oi' }], {
      durSec: 10,
      minLineSec: 0.9,
    });
    expect(linhas[0].endSec - linhas[0].startSec).toBeCloseTo(0.9, 3);
  });

  it('descarta linha sem texto', () => {
    expect(buildCaptionLines([{ startSec: 0, endSec: 2, text: '  ' }], { durSec: 10 })).toEqual(
      [],
    );
  });
});

describe('formatAssTime', () => {
  it('formata em H:MM:SS.cc', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00');
    expect(formatAssTime(1.2)).toBe('0:00:01.20');
    expect(formatAssTime(61.5)).toBe('0:01:01.50');
    expect(formatAssTime(3661.25)).toBe('1:01:01.25');
  });
});

describe('escapeAssText', () => {
  it('escapa as chaves (o libass leria como formatação)', () => {
    expect(escapeAssText('a {b} c')).toBe('a \\{b\\} c');
  });

  it('a quebra de linha vira \\N', () => {
    expect(escapeAssText('linha 1\nlinha 2')).toBe('linha 1\\Nlinha 2');
  });
});

describe('escapeAssFilterPath', () => {
  it('escapa a unidade do Windows e usa barra', () => {
    expect(escapeAssFilterPath('C:\\Users\\x\\a.ass')).toBe(
      "'C\\:/Users/x/a.ass'",
    );
  });

  it('o caminho com espaço fica entre aspas', () => {
    expect(escapeAssFilterPath('/tmp/dir com espaco/a.ass')).toBe("'/tmp/dir com espaco/a.ass'");
  });
});

describe('captionMaxChars', () => {
  it('cabe mais caracteres com a fonte menor', () => {
    expect(captionMaxChars(1080, 40)).toBeGreaterThan(captionMaxChars(1080, 80));
  });
});

describe('captionCrosshairTopY', () => {
  it('fica no centro da área do jogo mais o offset', () => {
    expect(captionCrosshairTopY(1920, 660)).toBe(1350);
    expect(captionCrosshairTopY(1920, 660, 80)).toBe(1370);
  });

  it('sem cam, usa o centro do vertical', () => {
    expect(captionCrosshairTopY(1920, 0)).toBe(1020);
  });
});

describe('buildCaptionsAss', () => {
  const linhas = [{ startSec: 1.2, endSec: 3.4, text: 'olá pessoal\nsegunda linha' }];

  it('gera o arquivo com o tamanho do vertical', () => {
    const ass = buildCaptionsAss(linhas, { width: 1080, height: 1920 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('[Events]');
  });

  it('ancora a legenda no topo do jogo (abaixo da cam)', () => {
    const ass = buildCaptionsAss(linhas, { position: 'game-top', topY: 668 });
    expect(ass).toContain('{\\an8\\pos(540,668)}');
    expect(ass).toContain('0:00:01.20,0:00:03.40');
  });

  it('ancora a legenda abaixo da mira', () => {
    const ass = buildCaptionsAss(linhas, { position: 'below-crosshair', topY: 1350 });
    expect(ass).toContain('{\\an8\\pos(540,1350)}');
  });

  it('usa a fonte mais forte na legenda', () => {
    const ass = buildCaptionsAss(linhas);
    expect(ass).toContain('Style: Caption,Segoe UI Black,54');
    expect(ass).toContain(',-1,0,0,0,100,100,0,0,1,3,1,8,');
  });

  it('no modo rodapé a legenda desce para o fim do vertical', () => {
    const ass = buildCaptionsAss(linhas, { position: 'bottom', height: 1920, bottomMargin: 140 });
    expect(ass).toContain('{\\an2\\pos(540,1780)}');
  });

  it('a quebra de linha do texto vira \\N no evento', () => {
    const ass = buildCaptionsAss(linhas);
    expect(ass).toContain('olá pessoal\\Nsegunda linha');
  });

  it('linha sem texto não vira evento', () => {
    const ass = buildCaptionsAss([{ startSec: 0, endSec: 0, text: 'nada' }]);
    expect(ass).not.toContain('Dialogue:');
  });
});

describe('parseGeminiTranscript', () => {
  it('lê o JSON com os tempos', () => {
    const parsed = parseGeminiTranscript(
      '{"language":"en","lines":[{"start":1.2,"end":3.4,"text":"what a play"}]}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.lines[0]).toEqual({ startSec: 1.2, endSec: 3.4, text: 'what a play' });
    expect(parsed?.language).toBe('en');
  });

  it('usa a tradução quando existe', () => {
    const parsed = parseGeminiTranscript(
      '{"language":"en","lines":[{"start":1,"end":2,"text":"what a play","text_pt":"que jogada"}]}',
    );
    expect(parsed?.lines[0].text).toBe('que jogada');
    expect(parsed?.translated).toBe(true);
  });

  it('aceita JSON dentro de cerca de código', () => {
    const parsed = parseGeminiTranscript(
      '```json\n{"language":"pt-BR","lines":[{"start":0,"end":1,"text":"olá"}]}\n```',
    );
    expect(parsed?.lines[0].text).toBe('olá');
  });

  it('JSON inválido devolve null (o provider é pulado)', () => {
    expect(parseGeminiTranscript('isto não é json')).toBeNull();
    expect(parseGeminiTranscript('{"lines":[]}')).toBeNull();
    expect(parseGeminiTranscript('')).toBeNull();
  });
});

describe('groupCaptionChunks', () => {
  it('junta as palavras em blocos de legenda', () => {
    const linhas = groupCaptionChunks(
      [
        { text: 'que', timestamp: [0, 0.3] },
        { text: 'jogada', timestamp: [0.3, 0.9] },
        { text: 'incrível', timestamp: [0.9, 1.5] },
      ],
      { maxChars: 32 },
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0].text).toBe('que jogada incrível');
    expect(linhas[0].startSec).toBe(0);
    expect(linhas[0].endSec).toBe(1.5);
  });

  it('pausa longa fecha o bloco', () => {
    const linhas = groupCaptionChunks(
      [
        { text: 'primeiro', timestamp: [0, 0.5] },
        { text: 'segundo', timestamp: [5, 5.5] },
      ],
      { maxChars: 32, gapSec: 0.6 },
    );
    expect(linhas).toHaveLength(2);
  });

  it('texto cheio fecha o bloco', () => {
    const linhas = groupCaptionChunks(
      [
        { text: 'a'.repeat(30), timestamp: [0, 1] },
        { text: 'b'.repeat(30), timestamp: [1, 2] },
      ],
      { maxChars: 32 },
    );
    expect(linhas).toHaveLength(2);
  });
});

describe('captionProviders', () => {
  it('mantém a ordem e não repete', () => {
    expect(captionProviders('gemini,huggingface,gemini')).toEqual(['gemini', 'huggingface']);
    expect(captionProviders('huggingface')).toEqual(['huggingface']);
  });

  it('provider desconhecido é ignorado', () => {
    expect(captionProviders('openai,gemini')).toEqual(['gemini']);
  });
});

describe('layout com legenda queimada', () => {
  const base = { width: 1080, height: 1920, top: 'cam' as const, camHeight: 660 };

  it('o filtro ass entra depois do vstack (coordenadas do vertical)', () => {
    const com = buildShortLayout({
      ...base,
      camBox: { x: 0.8, y: 0.3, w: 0.18, h: 0.24 },
      captionsAssPath: 'C:\\tmp\\legenda.ass',
    });
    expect(com.filter).toContain("ass=filename='C\\:/tmp/legenda.ass'");
    expect(com.filter.indexOf('vstack')).toBeLessThan(com.filter.indexOf('ass=filename'));
  });

  it('sem arquivo de legenda o filtro não muda', () => {
    const sem = buildShortLayout({
      ...base,
      camBox: { x: 0.8, y: 0.3, w: 0.18, h: 0.24 },
    });
    expect(sem.filter).not.toContain('ass=filename');
    expect(sem.filter).toContain('format=yuv420p[v]');
  });
});

describe('assinatura com legendas', () => {
  it('mudar o modo da legenda invalida o vertical', () => {
    const atual = shortRenderSignature({ top: 'cam', captions: 'on' });
    const anterior = shortRenderSignature({ top: 'cam', captions: 'off' });
    expect(isStaleRender(anterior, atual)).toBe(true);
  });

  it('mudar o tamanho da fonte invalida o vertical', () => {
    const atual = shortRenderSignature({ top: 'cam', captions: 'on', captionFontSize: 72 });
    const anterior = shortRenderSignature({ top: 'cam', captions: 'on', captionFontSize: 54 });
    expect(isStaleRender(anterior, atual)).toBe(true);
  });

  it('mudar a fonte ou a posição invalida o vertical', () => {
    const atual = shortRenderSignature({
      top: 'cam',
      captions: 'on',
      captionFontFamily: 'Arial Black',
      captionPosition: 'below-crosshair',
    });
    const anterior = shortRenderSignature({
      top: 'cam',
      captions: 'on',
      captionFontFamily: 'Arial',
      captionPosition: 'game-top',
    });
    expect(isStaleRender(anterior, atual)).toBe(true);
  });

  it('marker antigo (sem o campo da legenda) cai no re-render', () => {
    const atual = shortRenderSignature({ top: 'cam', captions: 'on' });
    const anterior = { ...atual, captions: undefined } as unknown as typeof atual;
    expect(isStaleRender(anterior, atual)).toBe(true);
  });

  it('mesma configuração não invalida', () => {
    const atual = shortRenderSignature({ top: 'cam', captions: 'on' });
    expect(isStaleRender(atual, atual)).toBe(false);
  });
});
