import { describe, expect, it } from 'vitest';
import {
  buildCaptionLines,
  buildCaptionsAss,
  canPublishShortWithCaptions,
  captionCrosshairTopY,
  captionMaxChars,
  escapeAssFilterPath,
  escapeAssText,
  fitCaptionLines,
  formatAssTime,
  isRetryableCaptionFailure,
  normalizeCaptionText,
  safeAssName,
  shortRetryBackoffMs,
  shortRetryDecision,
  MAX_SHORT_ATTEMPTS,
  wrapCaptionText,
} from '../src/clipper/shortCaptions.js';
import {
  captionProviders,
  captionVocabulary,
  captionContextFromAce,
  alignReferenceWords,
  alignCaptionTimings,
  applyCaptionCorrections,
  buildCaptionPrompt,
  buildRefinePrompt,
  buildTranslationPrompt,
  captionNeedsTranslation,
  captionEffectiveLanguage,
  captionLooksPortuguese,
  captionPromptLanguage,
  captionSimilarity,
  captionTokensMatch,
  classifyTranscriptResponse,
  createCaptionTranscriber,
  dedicatedResponseLanguage,
  dedicatedResponseText,
  groupCaptionChunks,
  isPlausibleTranslation,
  isQuotaError,
  isSafeCaptionFix,
  loadCaptionCorrections,
  loadCaptionVocabulary,
  parseGeminiTranscript,
  parseCaptionCorrections,
  parseLineFixes,
  usableTranscriptLines,
} from '../src/clipper/shortCaptionsAi.js';
import {
  isLikelyHallucination,
  parseWhisperJson,
  wordsFromTextSpan,
  wordsFromWhisperTokens,
} from '../src/transcription/providers/whisperCpp.js';
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

  it('texto que não cabe na tela vira OUTRO bloco (nada de fala se perde)', () => {
    const texto = 'primeira parte da fala que é bem comprida mesmo segunda parte da fala que também é comprida';
    const linhas = buildCaptionLines([{ startSec: 0, endSec: 4, text: texto }], {
      durSec: 10,
      maxCharsPerLine: 20,
      maxLines: 2,
      maxLineSec: 6,
    });
    expect(linhas.length).toBeGreaterThan(1);
    // Nenhuma linha tem mais de 2 linhas de 20 caracteres.
    for (const linha of linhas) {
      for (const parte of linha.text.split('\n')) {
        expect(parte.length).toBeLessThanOrEqual(20);
      }
    }
    // A fala inteira está na tela (sem reticências).
    const naTela = linhas.map((l) => l.text.replace(/\n/g, ' ')).join(' ');
    expect(naTela).not.toContain('…');
    expect(naTela.replace(/\s+/g, ' ').trim()).toBe(texto);
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

describe('safeAssName', () => {
  it('mantém um nome normal', () => {
    expect(safeAssName('C:\\tmp\\legenda.ass')).toBe('legenda.ass');
  });

  it('apóstrofo (e qualquer caractere do filtergraph) sai do nome', () => {
    // O apóstrofo fecha a aspa do filtro `ass` e quebra o filtergraph.
    expect(safeAssName("C:\\tmp\\O'Brien.ass")).toBe('O_Brien.ass');
    expect(safeAssName('C:\\tmp\\a:b,c.ass')).toBe('a_b_c.ass');
  });

  it('nome vazio vira um nome válido', () => {
    expect(safeAssName('')).toBe('caption.ass');
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
    expect(ass).toContain('Style: Caption,Barlow Condensed,54');
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

  it('aceita o whisper.cpp local (sem nuvem)', () => {
    expect(captionProviders('gemini,whisper-cpp')).toEqual(['gemini', 'whisper-cpp']);
    expect(captionProviders('whisper-cpp')).toEqual(['whisper-cpp']);
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
    // O filtro usa só o NOME do arquivo (o ffmpeg roda na pasta dele):
    // o caminho absoluto com `C:` e apóstrofo quebraria o filtergraph.
    expect(com.filter).toContain("ass=filename='legenda.ass'");
    expect(com.filter).toContain('fontsdir=');
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

describe('legenda quebrada no publish (o Short não pode ir ao ar sem ela)', () => {
  it('falha técnica (erro/libass) segura a publicação', () => {
    expect(
      canPublishShortWithCaptions({
        captionsOn: true,
        status: { applied: false, reason: 'error' },
        allowNoCaptions: false,
      }).publish,
    ).toBe(false);
    expect(
      canPublishShortWithCaptions({
        captionsOn: true,
        status: { applied: false, reason: 'failed' },
        allowNoCaptions: false,
      }).publish,
    ).toBe(false);
  });

  it('o dono pode forçar a publicação sem legenda', () => {
    expect(
      canPublishShortWithCaptions({
        captionsOn: true,
        status: { applied: false, reason: 'error' },
        allowNoCaptions: true,
      }).publish,
    ).toBe(true);
  });

  it('legenda aplicada (ou não pedida) publica normalmente', () => {
    expect(
      canPublishShortWithCaptions({
        captionsOn: true,
        status: { applied: true, lines: 13 },
        allowNoCaptions: false,
      }).publish,
    ).toBe(true);
    expect(
      canPublishShortWithCaptions({
        captionsOn: false,
        status: null,
        allowNoCaptions: false,
      }).publish,
    ).toBe(true);
  });

  it('silêncio (sem fala) e áudio ausente são estado final: publica', () => {
    for (const reason of ['no-speech', 'no-audio', 'disabled'] as const) {
      expect(
        canPublishShortWithCaptions({
          captionsOn: true,
          status: { applied: false, reason },
          allowNoCaptions: false,
        }).publish,
      ).toBe(true);
      expect(isRetryableCaptionFailure({ applied: false, reason })).toBe(false);
    }
    expect(isRetryableCaptionFailure({ applied: false, reason: 'error' })).toBe(true);
    expect(isRetryableCaptionFailure({ applied: false, reason: 'failed' })).toBe(true);
  });
});

describe('classifyTranscriptResponse (JSON inválido é FALHA, não silêncio)', () => {
  it('JSON válido com linhas é ok', () => {
    expect(
      classifyTranscriptResponse('{"language":"pt-BR","lines":[{"start":1,"end":2,"text":"oi"}]}'),
    ).toBe('ok');
  });

  it('JSON válido sem fala é silêncio', () => {
    expect(classifyTranscriptResponse('{"language":"pt-BR","lines":[]}')).toBe('silence');
    expect(classifyTranscriptResponse('')).toBe('silence');
  });

  it('JSON inválido é falha (inclusive o que termina em })', () => {
    expect(classifyTranscriptResponse('{"language":"pt-BR","lines":[}')).toBe('invalid');
    expect(classifyTranscriptResponse('{"language":"pt-BR","lines":[]}')).toBe('silence');
    expect(classifyTranscriptResponse('{"language":"pt-BR","lines":[{"start":1}')).toBe('invalid');
    expect(classifyTranscriptResponse('resposta em texto puro')).toBe('invalid');
  });

  it('linhas com tempo inválido é FALHA (a transcrição existiu e se perdeu)', () => {
    expect(
      classifyTranscriptResponse(
        '{"language":"pt-BR","lines":[{"start":"0:01.2","end":"0:02.2","text":"oi"}]}',
      ),
    ).toBe('invalid');
  });
});

describe('usableTranscriptLines (a definição única de linha aproveitável)', () => {
  it('descarta a linha com tempo inválido e mantém a boa', () => {
    const usable = usableTranscriptLines({
      language: 'pt-BR',
      lines: [
        { start: '0:01.2', end: '0:02.2', text: 'tempo ruim' },
        { start: 1, end: 2, text: 'tempo bom' },
      ],
    });
    expect(usable.lines).toHaveLength(1);
    expect(usable.lines[0].text).toBe('tempo bom');
  });

  it('nada aproveitável devolve lista vazia', () => {
    const usable = usableTranscriptLines({ lines: [{ start: 'x', end: 'y', text: 'oi' }] });
    expect(usable.lines).toEqual([]);
  });
});

describe('contexto da legenda (nomes e gíria no prompt)', () => {
  it('o contexto junta jogador, times e jogadores citados', () => {
    const ctx = captionContextFromAce({
      player: 'molodoy',
      team1: 'The MongolZ',
      team2: 'FURIA',
      event: 'IEM Beijing 2026',
      map: 'Inferno',
      round: 19,
      kills: [
        { killer: 'molodoy', victim: 'cobrazera' },
        { killer: 'molodoy', victim: '910' },
      ],
    });
    expect(ctx.player).toBe('molodoy');
    expect(ctx.players).toEqual(['molodoy', 'cobrazera', '910']);
    const vocab = captionVocabulary(ctx);
    expect(vocab).toContain('molodoy');
    expect(vocab).toContain('The MongolZ');
    expect(vocab).toContain('FURIA');
    expect(vocab).toContain('kills');
    expect(vocab).toContain('equinho');
    // Sem repetição (o jogador do ace aparece duas vezes).
    expect(new Set(vocab.map((v) => v.toLowerCase())).size).toBe(vocab.length);
  });

  it('o prompt leva os nomes e o gíria (o modelo erra a grafia sem eles)', () => {
    const prompt = buildCaptionPrompt(66, {
      player: 'molodoy',
      team1: 'The MongolZ',
      team2: 'FURIA',
      players: ['cobrazera', '910'],
    });
    expect(prompt).toContain('molodoy');
    expect(prompt).toContain('cobrazera');
    expect(prompt).toContain('The MongolZ');
    expect(prompt).toContain('equinho');
    expect(prompt).toContain('"equinho" (NÃO "é quinho")');
    expect(prompt).toContain('"kills" (NÃO "quilos")');
    // Grafia oficial dos nomes/termos que o dono já viu sair errado.
    // O prompt NÃO traz exemplo de nome solto (o "Lex" virava "Legacy"
    // em qualquer clipe): o nome vem do CONTEXTO e as regras com `@ctx`
    // ficam no arquivo de correções.
    expect(prompt).toContain('Use os nomes do CONTEXTO com a grafia exata');
    expect(prompt).not.toContain('"Lex" → Legacy');
    expect(prompt).toContain('Tec-9 (NÃO "tech nine")');
    expect(prompt).toContain('Bomb A/Bomb B (NÃO "bombear")');
    expect(prompt).toContain('Gau (apelido do Gaules');
  });

  it('sem contexto o prompt continua válido (não quebra o provider)', () => {
    const prompt = buildCaptionPrompt(30);
    expect(prompt).toContain('REGRAS:');
    expect(prompt).not.toContain('jogador do ace:');
  });

  it('o vocabulário global entra no prompt (nomes de outros clipes)', () => {
    const prompt = buildCaptionPrompt(30, { player: 'molodoy' }, ['donk', 'zont1x']);
    expect(prompt).toContain('donk');
    expect(prompt).toContain('zont1x');
  });

  it('o arquivo de vocabulário do repo é lido (um termo por linha, sem comentário)', () => {
    const vocab = loadCaptionVocabulary();
    expect(vocab.length).toBeGreaterThan(10);
    expect(vocab).toContain('molodoy');
    expect(vocab.every((v) => !v.startsWith('#'))).toBe(true);
  });

  it('as correções trocam o erro pela forma certa', () => {
    // FIXTURE (não o arquivo do repo): a lógica é testada sem depender
    // do que o dono edita em assets/caption-corrections.txt.
    const rules = parseCaptionCorrections(
      [
        'molodói>molodoy',
        'quilos>kills',
        'é quinho>equinho',
        'cacerato>KSCERATO',
        'iekindar>YEKINDAR',
        'demongols>The MongolZ',
        'twist>Twistzz @ctx',
        'tech nine>Tec-9',
        'bela a gae>bela HE',
        'gae>HE',
        'gaezinha>HEzinha',
        'bisqué>biskela',
      ].join('\n'),
    );
    const corrigido = applyCaptionCorrections(
      [
        { startSec: 0, endSec: 1, text: 'três quilos do molodói' },
        { startSec: 1, endSec: 2, text: 'é quinho!' },
        { startSec: 2, endSec: 3, text: 'cacerato e iekindar contra o demongols' },
        { startSec: 3, endSec: 4, text: 'o twist pegou a tech nine e o bombear' },
        { startSec: 4, endSec: 5, text: 'bela a gae, a gaezinha do bisqué' },
      ],
      rules,
      // O clipe é do Twistzz: só então "twist" vira o nome do jogador.
      { contextNames: ['Twistzz'] },
    );
    expect(corrigido[0].text).toBe('três kills do molodoy');
    expect(corrigido[1].text).toBe('equinho!');
    expect(corrigido[2].text).toBe('KSCERATO e YEKINDAR contra o The MongolZ');
    // "bombear" NÃO é regra: a troca é cega (bombear o site B viraria
    // "Bomb A") — quem resolve é o prompt ("Bomb A/Bomb B").
    expect(corrigido[3].text).toBe('o Twistzz pegou a Tec-9 e o bombear');
    expect(corrigido[4].text).toBe('bela HE, a HEzinha do biskela');
  });

  it('o arquivo de correções do repo tem as regras que o dono espera', () => {
    const rules = loadCaptionCorrections();
    expect(rules.length).toBeGreaterThan(10);
    const pares = rules.map((r) => `${r.wrong}>${r.right}`);
    expect(pares).toContain('molodói>molodoy');
    expect(pares).toContain('tech nine>Tec-9');
    expect(pares).toContain('quilos>kills');
    // As regras de nome ambíguo são contextuais (só entram no clipe do
    // jogador) — sem o gate, "twist" viraria "Twistzz" em qualquer
    // legenda do canal.
    const contextual = rules.filter((r) => r.contextual).map((r) => r.wrong);
    expect(contextual).toContain('lex');
    expect(contextual).toContain('twist');
    expect(contextual).toContain('robô');
    // A ORDEM do arquivo importa: a regra de frase vem antes da de
    // palavra (senão "bela a gae" viraria "bela a HE").
    expect(pares.indexOf('bela a gae>bela HE')).toBeGreaterThanOrEqual(0);
    expect(pares.indexOf('bela a gae>bela HE')).toBeLessThan(pares.indexOf('gae>HE'));
  });

  it('regra contextual não entra sem o nome no contexto do clipe', () => {
    const rules = loadCaptionCorrections();
    const linhas = [{ startSec: 0, endSec: 1, text: 'o twist pegou a tech nine' }];
    expect(applyCaptionCorrections(linhas, rules)[0].text).toBe(
      'o twist pegou a Tec-9',
    );
    expect(
      applyCaptionCorrections(linhas, rules, { contextNames: ['Twistzz'] })[0].text,
    ).toBe('o Twistzz pegou a Tec-9');
  });

  it('correção é literal (não troca dentro de outra palavra)', () => {
    const linhas = applyCaptionCorrections(
      [{ startSec: 0, endSec: 1, text: 'quiloso e inquieta' }],
      [{ wrong: 'quilos', right: 'kills' }],
    );
    expect(linhas[0].text).toBe('quiloso e inquieta');
  });

  it('sem correções o texto fica como está', () => {
    const linhas = [{ startSec: 0, endSec: 1, text: 'olá' }];
    expect(applyCaptionCorrections(linhas, [])).toBe(linhas);
  });
});

describe('alinhamento da legenda (o texto certo com o tempo da fala)', () => {
  it('mesma quantidade de tokens: troca o texto e mantém o tempo', () => {
    const words = [
      { text: 'Molodói', startSec: 1, endSec: 1.4 },
      { text: 'fez', startSec: 1.5, endSec: 1.8 },
      { text: 'kills', startSec: 1.9, endSec: 2.4 },
    ];
    const out = alignReferenceWords(words, 'Molodoy fez kills');
    expect(out.map((w) => w.text)).toEqual(['Molodoy', 'fez', 'kills']);
    expect(out.map((w) => w.startSec)).toEqual([1, 1.5, 1.9]);
  });

  it('quantidade diferente: o LCS casa o que é igual e o resto fica no tempo do vizinho', () => {
    const words = [
      { text: 'Cobra', startSec: 0, endSec: 0.5 },
      { text: 'cera', startSec: 0.6, endSec: 1 },
      { text: 'é', startSec: 1.1, endSec: 1.2 },
      { text: 'quinho', startSec: 1.3, endSec: 2 },
    ];
    const out = alignReferenceWords(words, 'Cobraseira equinho');
    expect(out[0].text).toBe('Cobraseira');
    expect(out[0].startSec).toBe(0);
    expect(out[out.length - 1].text).toBe('equinho');
    expect(out[out.length - 1].startSec).toBeGreaterThanOrEqual(1);
    expect(out[out.length - 1].endSec).toBeGreaterThan(out[out.length - 1].startSec);
  });

  it('sem referência: devolve as palavras como vieram', () => {
    const words = [{ text: 'oi', startSec: 0, endSec: 0.5 }];
    expect(alignReferenceWords(words, '   ')).toEqual(words);
  });
});

describe('isQuotaError (cota do Gemini não pode derrubar a legenda)', () => {
  it('reconhece 429 e "quota"', () => {
    expect(isQuotaError(new Error('{"error":{"code":429,"message":"quota exceeded"}}'))).toBe(true);
    expect(isQuotaError(new Error('You exceeded your current quota'))).toBe(true);
  });

  it('não confunde timeout/chave inválida com cota', () => {
    expect(isQuotaError(new Error('timeout'))).toBe(false);
    expect(isQuotaError(new Error('API key not valid'))).toBe(false);
  });
});

describe('createCaptionTranscriber (silêncio é estado final; falta de chave não é falha)', () => {
  const silent = async (): Promise<null> => null;
  const failed = async (): Promise<never> => {
    throw new Error('timeout gemini');
  };
  const spoke = async () => ({
    lines: [{ startSec: 1, endSec: 2, text: 'que jogada' }],
    language: 'pt-BR',
    translated: false,
  });

  it('gemini em silêncio + huggingface sem token: o Short sai sem legenda (NÃO é falha)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: silent },
      hfToken: undefined,
    });
    await expect(transcriber('audio.wav', 30)).resolves.toBeNull();
  });

  it('gemini em silêncio + huggingface que também cala: sem legenda, sem erro', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: silent, huggingface: silent },
    });
    await expect(transcriber('audio.wav', 30)).resolves.toBeNull();
  });

  it('gemini falha + huggingface em silêncio: é FALHA (o Short espera a próxima rodada)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: failed, huggingface: silent },
    });
    await expect(transcriber('audio.wav', 30)).rejects.toThrow(/timeout gemini/);
  });

  it('gemini falha + huggingface responde: usa o huggingface', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: failed, huggingface: spoke },
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.provider).toBe('huggingface');
    expect(result?.lines[0].text).toBe('que jogada');
  });

  it('nenhum provider configurado: erro claro (setup, não silêncio)', async () => {
    const transcriber = createCaptionTranscriber({});
    await expect(transcriber('audio.wav', 30)).rejects.toThrow(/nenhum provider de transcrição configurado/);
  });

  it('o contexto do clipe chega no provider (nomes no prompt)', async () => {
    let recebido: unknown = null;
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async (_audio, _dur, context) => {
          recebido = context;
          return { lines: [{ startSec: 0, endSec: 1, text: 'oi' }], language: 'pt-BR', translated: false };
        },
      },
      hfToken: undefined,
    });
    await transcriber('audio.wav', 30, { player: 'molodoy', players: ['cobrazera'] });
    expect(recebido).toEqual({ player: 'molodoy', players: ['cobrazera'] });
  });
});

describe('whisper.cpp: palavras com tempo (legenda sem VAD adiantado)', () => {
  it('junta os tokens em palavras com o tempo de cada uma', () => {
    const words = wordsFromWhisperTokens([
      { text: ' Ola', offsets: { from: 1000, to: 1300 } },
      { text: ' pes', offsets: { from: 1300, to: 1500 } },
      { text: 'so', offsets: { from: 1500, to: 1650 } },
      { text: 'al', offsets: { from: 1650, to: 1800 } },
      { text: '!', offsets: { from: 1800, to: 1900 } },
      { text: ' [_BEG_]', offsets: { from: 0, to: 100 } },
    ]);
    expect(words).toEqual([
      { startSec: 1, endSec: 1.3, text: 'Ola' },
      { startSec: 1.3, endSec: 1.9, text: 'pessoal!' },
    ]);
  });

  it('token sem offsets usa os timestamps textuais', () => {
    const words = wordsFromWhisperTokens([
      { text: ' oi', timestamps: { from: '00:00:01,000', to: '00:00:01,500' } },
    ]);
    expect(words).toEqual([{ startSec: 1, endSec: 1.5, text: 'oi' }]);
  });
});

describe('tradução da legenda (streamer estrangeiro)', () => {
  it('pt não precisa; en/es/ru precisam; idioma vazio não gasta chamada', () => {
    expect(captionNeedsTranslation('pt-BR')).toBe(false);
    expect(captionNeedsTranslation('por')).toBe(false);
    expect(captionNeedsTranslation('português')).toBe(false);
    expect(captionNeedsTranslation('en')).toBe(true);
    expect(captionNeedsTranslation('es')).toBe(true);
    expect(captionNeedsTranslation('ru')).toBe(true);
    expect(captionNeedsTranslation(null)).toBe(false);
  });

  it('o prompt mantém a quantidade de falas, os nomes e a gíria', () => {
    const prompt = buildTranslationPrompt(
      [{ startSec: 0, endSec: 1, text: 'what a clutch' }],
      { team1: 'FURIA' },
    );
    expect(prompt).toContain('EXATAMENTE 1 falas');
    expect(prompt).toContain('what a clutch');
    expect(prompt).toContain('NÃO traduza');
    expect(prompt).toContain('FURIA');
  });

  it('resposta com quantidade diferente é descartada', () => {
    expect(parseLineFixes('{"lines":[{"text":"a"},{"text":"b"}]}', 1)).toBeNull();
    expect(parseLineFixes('{"lines":[{"text":"a"}]}', 1)).toEqual(['a']);
    expect(parseLineFixes('lixo', 1)).toBeNull();
  });

  it('a tradução entra e o original fica guardado', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [
            { startSec: 0, endSec: 1, text: 'what a clutch' },
            { startSec: 1, endSec: 2, text: 'he is insane' },
          ],
          language: 'en',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiTranslator: async (lines) => ({
        lines: lines.map((line) => ({ ...line, text: `pt: ${line.text}` })),
        outcome: 'translated' as const,
      }),
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.translated).toBe(true);
    expect(result?.lines.map((l) => l.text)).toEqual(['pt: what a clutch', 'pt: he is insane']);
    expect(result?.originalLines?.map((l) => l.text)).toEqual([
      'what a clutch',
      'he is insane',
    ]);
  });

  it('falha do tradutor mantém o idioma original (não perde a legenda)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [{ startSec: 0, endSec: 1, text: 'what a clutch' }],
          language: 'en',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiTranslator: async () => {
        throw new Error('cota');
      },
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.translated).toBe(false);
    expect(result?.lines[0].text).toBe('what a clutch');
  });
});

describe('revisão da legenda (o passe LLM não pode reescrever a fala)', () => {
  it('similaridade e a guarda de nome curto', () => {
    expect(captionSimilarity('Lex contra Demongols', 'Legacy contra The MongolZ')).toBeGreaterThan(0.5);
    expect(isSafeCaptionFix('ele jogou muito', 'ele jogou muito bem')).toBe(true);
    expect(isSafeCaptionFix('ele jogou muito', 'que jogada absurda dele')).toBe(false);
    expect(isSafeCaptionFix('legal', 'Gau', ['Gau'])).toBe(true);
    expect(isSafeCaptionFix('beat', 'b1t', ['b1t'])).toBe(true);
    expect(isSafeCaptionFix('legal', 'Gau')).toBe(false);
    // Não troca um termo do jogo por outro (ambos estão no vocabulário).
    expect(isSafeCaptionFix('ace', 'site', ['ace', 'site'])).toBe(false);
  });

  it('o prompt exige a mesma quantidade e lembra os termos canônicos', () => {
    const prompt = buildRefinePrompt(
      [{ startSec: 0, endSec: 1, text: 'Lex contra Demongols' }],
      { team1: 'Legacy', team2: 'The MongolZ' },
    );
    expect(prompt).toContain('EXATAMENTE 1 falas');
    expect(prompt).toContain('Lex contra Demongols');
    expect(prompt).toContain('Tec-9');
    expect(prompt).toContain('Legacy');
  });

  it('o revisor corrige o nome e as correções do repo passam por último', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [{ startSec: 0, endSec: 1, text: 'cacerato pega o molodói' }],
          language: 'pt-BR',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiRefiner: async (lines) =>
        lines.map((line) => ({ ...line, text: 'KSCERATO pega o molodói' })),
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.lines[0].text).toBe('KSCERATO pega o molodoy');
  });
});

describe('backoff das tentativas do Short', () => {
  const agora = Date.parse('2026-01-01T12:00:00.000Z');

  it('sem falha anterior, o Short é tentado', () => {
    expect(shortRetryDecision(undefined, agora).skip).toBe(false);
    expect(shortRetryDecision({ attempts: 0 }, agora).skip).toBe(false);
  });

  it('a espera cresce com o número de falhas', () => {
    expect(shortRetryBackoffMs(0)).toBe(0);
    expect(shortRetryBackoffMs(1)).toBeLessThan(shortRetryBackoffMs(2));
    expect(shortRetryBackoffMs(2)).toBeLessThan(shortRetryBackoffMs(3));
    expect(shortRetryBackoffMs(9)).toBe(shortRetryBackoffMs(4));
  });

  it('falhou há pouco: espera antes de tentar de novo', () => {
    const state = {
      attempts: 1,
      lastAttemptAt: new Date(agora - 60_000).toISOString(),
    };
    const decision = shortRetryDecision(state, agora);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toMatch(/aguardando/);
  });

  it('a espera já passou: tenta de novo', () => {
    const state = {
      attempts: 1,
      lastAttemptAt: new Date(agora - 11 * 60_000).toISOString(),
    };
    expect(shortRetryDecision(state, agora).skip).toBe(false);
  });

  it('passou do teto: só o dono manda tentar de novo (--force)', () => {
    const state = {
      attempts: MAX_SHORT_ATTEMPTS,
      lastAttemptAt: new Date(agora - 10 * 24 * 3_600_000).toISOString(),
    };
    const decision = shortRetryDecision(state, agora);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toMatch(/--force/);
  });
});

describe('dedicated: falha ≠ silêncio', () => {
  it('a resposta dedicated sem texto é silêncio', () => {
    expect(dedicatedResponseText({ output_text: '  ' })).toBe('');
    expect(dedicatedResponseText({ steps: [] })).toBe('');
  });

  it('a resposta dedicated com texto (sem tempo por palavra) é FALHA', () => {
    const res = { steps: [{ content: [{ type: 'text', text: 'que jogada' }] }] };
    expect(dedicatedResponseText(res)).toBe('que jogada');
  });

  it('o idioma que a API devolveu é lido', () => {
    expect(dedicatedResponseLanguage({ language: 'en' })).toBe('en');
    expect(dedicatedResponseLanguage({})).toBeNull();
  });
});

describe('ordem do pós-processamento (traduzir → corrigir → revisar)', () => {
  it('palavra comum NÃO vira nome de jogador (a regra contextual exige o nome no clipe)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [{ startSec: 0, endSec: 1, text: 'what a twist' }],
          language: 'en',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiTranslator: async () => ({
        lines: [{ startSec: 0, endSec: 1, text: 'que twist' }],
        outcome: 'translated' as const,
      }),
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.translated).toBe(true);
    expect(result?.lines[0].text).toBe('que twist');
  });

  it('com o jogador no contexto, a regra contextual entra (a grafia oficial do clip)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [{ startSec: 0, endSec: 1, text: 'what a twist' }],
          language: 'en',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiTranslator: async () => ({
        lines: [{ startSec: 0, endSec: 1, text: 'que twist' }],
        outcome: 'translated' as const,
      }),
    });
    const result = await transcriber('audio.wav', 30, { player: 'Twistzz' });
    expect(result?.lines[0].text).toBe('que Twistzz');
    expect(result?.correctionsApplied).toContain('twist>Twistzz');
  });

  it('a tradução que falha marca o Short como não traduzido (não vai ao ar)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [{ startSec: 0, endSec: 1, text: 'what a twist' }],
          language: 'en',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiTranslator: async () => {
        throw new Error('cota do Gemini');
      },
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBe(true);
    expect(result?.translated).toBe(false);
    expect(result?.degraded).toContain('translate');
    expect(isRetryableCaptionFailure({ applied: true, reason: 'untranslated' })).toBe(true);
    expect(
      canPublishShortWithCaptions({
        captionsOn: true,
        status: { applied: true, reason: 'untranslated' },
        allowNoCaptions: false,
      }).publish,
    ).toBe(false);
  });

  it('a revisão que falha não derruba a legenda (o texto anterior fica)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => ({
          lines: [{ startSec: 0, endSec: 1, text: 'cacerato' }],
          language: 'pt-BR',
          translated: false,
        }),
      },
      hfToken: undefined,
      geminiRefiner: async () => {
        throw new Error('timeout');
      },
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.lines[0].text).toBe('KSCERATO');
    expect(result?.degraded).toContain('refine');
  });
});

describe('whisper.cpp endurecido (silêncio, alucinação e UTF-8)', () => {
  it.each([
    'Obrigado por assistir!',
    'Thanks for watching',
    "That's all folks",
    'Please subscribe',
    'Subscribe to my channel',
    'Subtitles by the Amara.org community',
    'www.youtube.com',
    '[BLANK_AUDIO]',
  ])('a fala inventada é reconhecida: %s', (text) => {
    expect(isLikelyHallucination(text)).toBe(true);
  });

  it('a fala de verdade não é confundida com alucinação', () => {
    expect(isLikelyHallucination('que jogada do molodoy')).toBe(false);
    expect(isLikelyHallucination('o cara vai bombar o site')).toBe(false);
  });

  it('o texto do segmento vira palavras espalhadas no tempo (UTF-8 quebrado no token)', () => {
    const words = wordsFromTextSpan('que jogada', 10, 12);
    expect(words).toHaveLength(2);
    expect(words[0].startSec).toBeCloseTo(10);
    expect(words[1].endSec).toBeCloseTo(12);
  });

  it('o token com UTF-8 quebrado é descartado (o segmento é refeito pelo texto)', () => {
    const words = wordsFromWhisperTokens([
      { text: ' molo', offsets: { from: 1000, to: 1200 } },
      { text: '\uFFFD', offsets: { from: 1200, to: 1400 } },
    ]);
    expect(words.map((w) => w.text)).toEqual(['molo']);
  });
});

describe('idioma da legenda (o provider não é a palavra final)', () => {
  it('texto curto não decide nada', () => {
    expect(captionLooksPortuguese('que jogada')).toBe('unknown');
  });

  it('texto em português é reconhecido', () => {
    expect(
      captionLooksPortuguese(
        'e ai galera quem ta com a tacada no round esse cara pegou a kill e ainda nao morreu',
      ),
    ).toBe(true);
  });

  it('texto em inglês é reconhecido', () => {
    expect(
      captionLooksPortuguese(
        'and what a play from this guy he got the kill and they are all dead now',
      ),
    ).toBe(false);
  });

  it('provider sem idioma: o texto decide', () => {
    const foreign = captionEffectiveLanguage(
      null,
      'and what a play from this guy he got the kill and they are all dead now',
    );
    expect(foreign.needsTranslation).toBe(true);
    const local = captionEffectiveLanguage(
      null,
      'e ai galera quem ta com a tacada no round esse cara pegou a kill e ainda nao morreu',
    );
    expect(local.needsTranslation).toBe(false);
  });

  it('provider que errou o idioma (gíria em inglês) não segura o Short', () => {
    const effective = captionEffectiveLanguage(
      'en',
      'e ai galera quem ta com a tacada no round esse cara pegou a kill e ainda nao morreu',
    );
    expect(effective.needsTranslation).toBe(false);
  });
});

describe('tradução: falha, "não mudou nada" e parcial', () => {
  const english = {
    lines: [{ startSec: 0, endSec: 1, text: 'what a play from this guy' }],
    language: 'en',
    translated: false,
  };

  it('"não mudou nada" NÃO segura o Short (não há o que traduzir)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: async () => english },
      hfToken: undefined,
      geminiTranslator: async (lines) => ({ lines, outcome: 'unchanged' as const }),
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBeFalsy();
    expect(result?.degraded).toContain('translate');
  });

  it('tradução que falha SEGURA o Short', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: async () => english },
      hfToken: undefined,
      geminiTranslator: async () => null,
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBe(true);
  });

  it('traduzido pela metade: a legenda NÃO conta como traduzida', () => {
    const parsed = usableTranscriptLines({
      language: 'en',
      lines: [
        { start: 0, end: 1, text: 'what a play', text_pt: 'que jogada' },
        { start: 1, end: 2, text: 'he is insane' },
      ],
    });
    expect(parsed.translated).toBe(false);
    expect(parsed.partialTranslation).toBe(true);
  });

  it('legenda estrangeira não leva correção em português (corromperia o texto)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: async () => english },
      hfToken: undefined,
      geminiTranslator: async () => {
        throw new Error('cota');
      },
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.lines[0].text).toBe('what a play from this guy');
    expect(result?.correctionsApplied).toBeUndefined();
  });
});

describe('cota do Gemini: o fallback dedicado entra', () => {
  it('gemini com 429 usa o transcritor dedicado injetado', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => {
          const err = new Error('Resource has been exhausted (e.g. check quota)') as Error & {
            status?: number;
          };
          err.status = 429;
          throw err;
        },
      },
      dedicatedTranscriber: async () => ({
        lines: [{ startSec: 0, endSec: 1, text: 'que jogada' }],
        language: 'pt-BR',
        translated: false,
      }),
      hfToken: undefined,
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.provider).toBe('gemini');
    expect(result?.lines[0].text).toBe('que jogada');
  });
});

describe('os dados do repositório (vocabulário e correções)', () => {
  it('o vocabulário não tem palavra comum (o modelo escreveria errado)', () => {
    const comum = ['try', 'rain', 'fame', 'rate', 'doc', 'frozen', 'case', 'solid', 'big', 'just', 'icy'];
    const vocab = loadCaptionVocabulary().map((v) => v.toLowerCase());
    for (const word of comum) {
      expect(vocab).not.toContain(word);
    }
  });

  it('o vocabulário não repete termo (case-insensitive)', () => {
    const vocab = loadCaptionVocabulary().map((v) => v.toLowerCase());
    expect(new Set(vocab).size).toBe(vocab.length);
  });

  it('as correções são idempotentes (aplicar duas vezes dá o mesmo texto)', () => {
    const corrections = loadCaptionCorrections();
    const lines = [{ startSec: 0, endSec: 1, text: 'cacerato e o the mongolz' }];
    const uma = applyCaptionCorrections(lines, corrections);
    const duas = applyCaptionCorrections(uma, corrections);
    expect(duas[0].text).toBe(uma[0].text);
    expect(uma[0].text).toBe('KSCERATO e o The MongolZ');
  });

  it('BOM não vira termo (Notepad/PS 5.1 gravam com BOM)', () => {
    const regras = parseCaptionCorrections('\uFEFF# comentário\ncacerato>KSCERATO');
    expect(regras).toHaveLength(1);
    expect(regras[0]).toEqual({ wrong: 'cacerato', right: 'KSCERATO' });
  });

  it('a regra contextual é marcada no arquivo (@ctx)', () => {
    const regras = parseCaptionCorrections('lex>Legacy @ctx\nquilos>kills');
    expect(regras[0].contextual).toBe(true);
    expect(regras[1].contextual).toBeUndefined();
  });

  it('o .orig.txt tem o texto original INTEIRO (mesmo quando a tradução veio pela metade)', () => {
    const parsed = usableTranscriptLines({
      language: 'en',
      lines: [
        { start: 0, end: 1, text: 'what a play', text_pt: 'que jogada' },
        { start: 1, end: 2, text: 'he is insane' },
      ],
    });
    expect(parsed.originalLines?.map((l) => l.text)).toEqual([
      'what a play',
      'he is insane',
    ]);
  });
});

describe('whisper.cpp: o JSON do -ojf (o filtro vale no caminho inteiro)', () => {
  const alucination = {
    offsets: { from: 0, to: 3000 },
    text: ' Obrigado por assistir!',
    tokens: [
      { text: ' Obrigado', offsets: { from: 0, to: 1200 } },
      { text: ' por', offsets: { from: 1200, to: 1600 } },
      { text: ' assistir', offsets: { from: 1600, to: 3000 } },
    ],
  };
  const fala = {
    offsets: { from: 4000, to: 6000 },
    text: ' que jogada do molodoy',
    tokens: [
      { text: ' que', offsets: { from: 4000, to: 4500 } },
      { text: ' jogada', offsets: { from: 4500, to: 5200 } },
      { text: ' do', offsets: { from: 5200, to: 5500 } },
      { text: ' molodoy', offsets: { from: 5500, to: 6000 } },
    ],
  };

  it('JSON só com alucinação vira SILÊNCIO (a frase não vira legenda)', () => {
    const out = parseWhisperJson(
      { result: { language: 'pt' }, transcription: [alucination] },
      { words: true, language: 'pt' },
    );
    expect(out.segments).toEqual([]);
    expect(out.language).toBe('pt');
  });

  it('fala real + alucinação: só a fala real fica', () => {
    const out = parseWhisperJson(
      { result: { language: 'pt' }, transcription: [alucination, fala] },
      { words: true, language: 'pt' },
    );
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].text).toContain('molodoy');
  });

  it('fora do modo legenda a frase continua valendo ("thanks for watching" no fim do vídeo)', () => {
    const out = parseWhisperJson(
      { result: { language: 'pt' }, transcription: [alucination] },
      { words: false },
    );
    expect(out.segments.length).toBe(1);
  });
});

describe('silêncio do provider: final por padrão, configurável', () => {
  const silent = async (): Promise<null> => null;
  const spoke = async () => ({
    lines: [{ startSec: 1, endSec: 2, text: 'que jogada' }],
    language: 'pt-BR',
    translated: false,
  });

  it('padrão: o silêncio do primeiro provider é final (o local não contradiz)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: silent, huggingface: spoke },
    });
    await expect(transcriber('audio.wav', 30)).resolves.toBeNull();
  });

  it('com silenceFinal=false o provider seguinte é consultado', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: silent, huggingface: spoke },
      silenceFinal: false,
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.provider).toBe('huggingface');
    expect(result?.lines[0].text).toBe('que jogada');
  });

  it('com silenceFinal=false, todos em silêncio: sem legenda e sem erro', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: silent, huggingface: silent },
      silenceFinal: false,
    });
    await expect(transcriber('audio.wav', 30)).resolves.toBeNull();
  });

  it('com silenceFinal=false, quem falhou de verdade ainda manda (o Short espera)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async (): Promise<never> => {
          throw new Error('timeout gemini');
        },
        huggingface: silent,
      },
      silenceFinal: false,
    });
    await expect(transcriber('audio.wav', 30)).rejects.toThrow(/timeout gemini/);
  });
});

describe('áudio estrangeiro sem tradutor (a legenda não vai ao ar no idioma original)', () => {
  const english = async () => ({
    lines: [{ startSec: 0, endSec: 1, text: 'what a clutch' }],
    language: 'en',
    translated: false,
  });

  it('sem tradutor configurado: o Short é segurado (untranslated)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: english },
      hfToken: undefined,
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBe(true);
    expect(result?.degraded).toContain('translate');
    // O publicador segura o Short (a legenda em inglês não vai ao ar).
    const verdict = canPublishShortWithCaptions({
      captionsOn: true,
      status: { applied: true, reason: 'untranslated' },
      allowNoCaptions: false,
    });
    expect(verdict.publish).toBe(false);
    // O dono pode forçar.
    const forcado = canPublishShortWithCaptions({
      captionsOn: true,
      status: { applied: true, reason: 'untranslated' },
      allowNoCaptions: true,
    });
    expect(forcado.publish).toBe(true);
  });

  it('com translate=false o dono aceitou o idioma original: o Short NÃO é segurado', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: english },
      hfToken: undefined,
      translate: false,
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBeUndefined();
    expect(result?.degraded).toContain('translate');
  });

  it('tradutor que não tinha o que traduzir: não é falha (o Short não é segurado)', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: english },
      hfToken: undefined,
      geminiTranslator: async (lines) => ({ lines, outcome: 'unchanged' as const }),
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBeUndefined();
  });

  it('tradutor que falhou: o Short é segurado e a legenda fica degradada', async () => {
    const transcriber = createCaptionTranscriber({
      transcribers: { gemini: english },
      hfToken: undefined,
      geminiTranslator: async (): Promise<never> => {
        throw new Error('cota');
      },
    });
    const result = await transcriber('audio.wav', 30);
    expect(result?.untranslated).toBe(true);
    expect(result?.degraded).toContain('translate');
  });
});

describe('retomar do passo que falhou (a transcrição guardada no marker)', () => {
  it('com a transcrição guardada, o provider de transcrição NÃO é chamado', async () => {
    let chamadas = 0;
    const transcriber = createCaptionTranscriber({
      transcribers: {
        gemini: async () => {
          chamadas += 1;
          return null;
        },
      },
      hfToken: undefined,
      geminiTranslator: async (lines) => ({
        lines: lines.map((line) => ({ ...line, text: 'que jogada' })),
        outcome: 'translated' as const,
      }),
    });
    const result = await transcriber('audio.wav', 30, null, {
      provider: 'gemini',
      language: 'en',
      translated: false,
      lines: [{ startSec: 0, endSec: 1, text: 'what a clutch' }],
    });
    expect(chamadas).toBe(0);
    expect(result?.lines[0].text).toBe('que jogada');
    expect(result?.translated).toBe(true);
    expect(result?.originalLines?.[0].text).toBe('what a clutch');
  });
});

describe('idioma: a heurística enxerga o texto COM acento', () => {
  it('português com acento é português', () => {
    const texto =
      'não, você não vai pegar essa, mano, isso já foi, muito bom, vamos ver o que ele faz agora';
    expect(captionLooksPortuguese(texto)).toBe(true);
  });

  it('inglês é inglês', () => {
    const texto =
      'you will not take that, man, this is already done, very good, let us see what he does now';
    expect(captionLooksPortuguese(texto)).toBe(false);
  });

  it('texto curto demais não decide nada', () => {
    expect(captionLooksPortuguese('que bom')).toBe('unknown');
  });

  it('a sentinela de idioma não vaza para o prompt do tradutor', () => {
    expect(captionPromptLanguage('unknown-foreign')).toBeNull();
    expect(captionPromptLanguage('en')).toBe('en');
    expect(captionPromptLanguage(null)).toBeNull();
  });
});

describe('tradução: guarda por fala e guarda de tamanho', () => {
  it('uma fala vazia não descarta o passe inteiro (fica a original)', () => {
    const fixes = parseLineFixes(
      '{"lines":[{"text":"que jogada"},{"text":""}]}',
      2,
      ['what a play', 'he is insane'],
    );
    expect(fixes).toEqual(['que jogada', 'he is insane']);
  });

  it('quantidade errada ainda descarta o passe todo', () => {
    expect(parseLineFixes('{"lines":[{"text":"a"}]}', 2, ['x', 'y'])).toBeNull();
  });

  it('tradução enorme ou resumida demais é recusada', () => {
    expect(isPlausibleTranslation('what a clutch', 'que jogada')).toBe(true);
    expect(isPlausibleTranslation('what a clutch', 'x'.repeat(300))).toBe(false);
    expect(isPlausibleTranslation('a very long original sentence here', 'oi')).toBe(false);
    expect(isPlausibleTranslation('', 'que jogada')).toBe(false);
  });
});

describe('tempo real da legenda (whisper local) com o texto do modelo', () => {
  const timing = [
    { startSec: 10.5, endSec: 12.9, text: 'A USP dele é envenenada, Gal.' },
    { startSec: 13.0, endSec: 14.8, text: 'Eu avisei, eu avisei.' },
    { startSec: 18.0, endSec: 19.9, text: 'Certeza que ele pegou aquele DMzinho.' },
  ];

  it('a palavra é a mesma mesmo com a grafia diferente', () => {
    expect(captionTokensMatch('kscerato', 'cacerato')).toBe(false);
    expect(captionTokensMatch('defusa', 'defuse')).toBe(true);
    expect(captionTokensMatch('fallen', 'fallenn')).toBe(true);
    expect(captionTokensMatch('nao', 'não')).toBe(false);
  });

  it('o texto do modelo ganha o tempo do whisper', () => {
    const out = alignCaptionTimings(
      [
        { startSec: 0, endSec: 1.5, text: 'A USP dele é envenenada, Gau.' },
        { startSec: 1.5, endSec: 3, text: 'Eu avisei, eu avisei.' },
        { startSec: 3, endSec: 4.5, text: 'Certeza que ele pegou aquele DMzinho.' },
      ],
      timing,
    );
    expect(out[0].text).toBe('A USP dele é envenenada, Gau.');
    expect(out[0].startSec).toBeCloseTo(10.5, 1);
    expect(out[0].endSec).toBeCloseTo(12.9, 1);
    expect(out[2].startSec).toBeCloseTo(18.0, 1);
  });

  it('fala sem par no whisper fica no vão entre as vizinhas (sem invadir a fala seguinte)', () => {
    const out = alignCaptionTimings(
      [
        { startSec: 0, endSec: 1, text: 'A USP dele é envenenada, Gau.' },
        { startSec: 1, endSec: 2, text: 'Brasil!' },
        { startSec: 2, endSec: 3, text: 'Eu avisei, eu avisei.' },
      ],
      timing,
    );
    expect(out[1].text).toBe('Brasil!');
    expect(out[1].startSec).toBeGreaterThanOrEqual(out[0].endSec - 0.001);
    expect(out[1].endSec).toBeLessThanOrEqual(out[2].startSec + 0.001);
  });

  it('as falas nunca se sobrepõem nem voltam atrás', () => {
    const out = alignCaptionTimings(
      [
        { startSec: 0, endSec: 1, text: 'A USP dele é envenenada, Gal.' },
        { startSec: 1, endSec: 2, text: 'Eu avisei, eu avisei.' },
        { startSec: 2, endSec: 3, text: 'Certeza que ele pegou aquele DMzinho.' },
      ],
      timing,
    );
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].endSec).toBeLessThanOrEqual(out[i + 1].startSec + 0.001);
      expect(out[i + 1].startSec).toBeGreaterThanOrEqual(out[i].startSec);
    }
  });

  it('sem provider de tempo, a legenda sai como o modelo falou', () => {
    const lines = [{ startSec: 0, endSec: 1, text: 'A USP dele é envenenada, Gal.' }];
    expect(alignCaptionTimings(lines, [])).toEqual(lines);
  });
});

