import { describe, expect, it } from 'vitest';
import {
  buildShortLayout,
  camBoxToString,
  isStaleRender,
  isStaleWindow,
  killAtMs,
  killPositionsByKill,
  killPositionsSec,
  parseShortCamBox,
  planShortWindow,
  resolveShortWindowConfig,
  shortRenderSignature,
  shortVideoFilter,
  shortWindowConfigErrors,
  SHORT_DEFAULT_HEAD_SEC,
  SHORT_DEFAULT_MAX_SEC,
  SHORT_DEFAULT_MIN_SEC,
} from '../src/clipper/shorts.js';
import { fitBannerText, wrapShortTitle } from '../src/clipper/shortBanner.js';

describe('planShortWindow', () => {
  it('a folga padrão antes da 1ª kill é 4s (o gancho precisa de respiro)', () => {
    expect(SHORT_DEFAULT_HEAD_SEC).toBe(4);
    const w = planShortWindow([30, 35, 40], 120);
    expect(w.startSec).toBe(26);
  });

  it('o Short padrão vai de 60s a 90s (o YouTube aceita até 3min)', () => {
    expect(SHORT_DEFAULT_MIN_SEC).toBe(60);
    expect(SHORT_DEFAULT_MAX_SEC).toBe(90);
  });

  it('cobre da 1ª à última kill (com folga antes e depois)', () => {
    const w = planShortWindow([15, 18, 21, 24, 52], 59.14, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.startSec).toBe(13);
    expect(w.endSec).toBe(56);
    expect(w.durSec).toBe(43);
    expect(w.includedKills).toEqual([15, 18, 21, 24, 52]);
    expect(w.droppedKills).toEqual([]);
    expect(w.truncated).toBe(false);
  });

  it('corta a jogada longa e reporta as kills que ficaram de fora', () => {
    // Ace de 80s não cabe em 60s: o Short prioriza o CLÍMAX (a 5ª kill)
    // — um Short que termina sem o ace acaba sem payoff, mesmo que tenha
    // mais kills no meio.
    const w = planShortWindow([5, 20, 40, 60, 85], 120, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.startSec).toBe(38);
    expect(w.durSec).toBe(51);
    expect(w.endSec).toBe(89);
    expect(w.includedKills).toEqual([40, 60, 85]);
    expect(w.droppedKills).toEqual([5, 20]);
    expect(w.truncated).toBe(true);
  });

  it('em empate de kills, a janela que inclui o CLÍMAX (última kill) vence', () => {
    // Duas janelas possíveis de 60s com 3 kills: uma começa na 1ª kill
    // (e corta o clímax), outra começa na 2ª e guarda a última kill. O
    // Short tem que terminar no ace.
    const w = planShortWindow([15, 48.1, 57.2, 82.3], 104.3, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.includedKills).toEqual([48.1, 57.2, 82.3]);
    expect(w.droppedKills).toEqual([15]);
    // Sem rabo morto depois do clímax: a janela termina logo depois.
    expect(w.endSec).toBe(86.3);
    expect(w.durSec).toBe(40.2);
  });

  it('mantém TODAS as kills quando elas cabem (o corte é só da cauda)', () => {
    // 15, 18, 18, 36.1, 70.2 num clipe de 78.19s: cabe em 60s.
    const w = planShortWindow([15, 18, 18, 36.1, 70.2], 78.19, {
      maxSec: 60,
      minSec: 30,
      headSec: 2,
      tailSec: 4,
    });
    expect(w.includedKills).toEqual([15, 18, 18, 36.1, 70.2]);
    expect(w.droppedKills).toEqual([]);
    expect(w.startSec).toBe(13);
    expect(w.endSec).toBe(73);
  });

  it('a 1ª kill é o gancho: fica no começo da janela', () => {
    const w = planShortWindow([30, 35, 40], 120, { headSec: 2, maxSec: 60 });
    expect(w.startSec).toBe(28);
    expect(w.includedKills[0]).toBe(30);
    // A folga de 60s vai para DEPOIS (a 1ª kill não sai do gancho).
    expect(w.endSec).toBe(88);
    expect(w.durSec).toBe(60);
  });

  it('a 1ª kill no fim do clipe: fica o último minuto do material', () => {
    const w = planShortWindow([118], 120, { maxSec: 60, headSec: 2, tailSec: 4 });
    expect(w.endSec).toBe(120);
    expect(w.durSec).toBe(60);
    expect(w.startSec).toBe(60);
    expect(w.droppedKills).toEqual([]);
  });

  it('esticado para a duração mínima (Short de 8s perde retenção)', () => {
    const w = planShortWindow([10, 12], 60, { minSec: 30, maxSec: 60, headSec: 2, tailSec: 4 });
    expect(w.durSec).toBe(30);
    expect(w.padded).toBe(true);
    expect(w.startSec).toBe(8);
    expect(w.endSec).toBe(38);
  });

  it('jogada de 30s em clipe longo: estica para 60s (para frente)', () => {
    // KSCERATO: 4 kills entre 15s e 37s (janela 11-41 = 30s) num clipe
    // de 106s. Com o mínimo em 60s a sobra vai para DEPOIS da última
    // kill (reação/rotação final), nunca para antes do gancho.
    const w = planShortWindow([15, 37], 106.4, { minSec: 60, maxSec: 90, headSec: 4, tailSec: 4 });
    expect(w.startSec).toBe(11);
    expect(w.endSec).toBe(71);
    expect(w.durSec).toBe(60);
    expect(w.padded).toBe(true);
    expect(w.includedKills).toEqual([15, 37]);
    expect(w.truncated).toBe(false);
  });

  it('ace de 95s não cabe em 90s: corta e mantém o clímax', () => {
    const w = planShortWindow([5, 25, 45, 65, 85, 100], 120, {
      maxSec: 90,
      minSec: 60,
      headSec: 4,
      tailSec: 4,
    });
    expect(w.startSec).toBe(21);
    expect(w.endSec).toBe(104);
    expect(w.durSec).toBe(83);
    expect(w.includedKills).toEqual([25, 45, 65, 85, 100]);
    expect(w.droppedKills).toEqual([5]);
    expect(w.truncated).toBe(true);
  });

  it('sem kills: começa do início e respeita o máximo', () => {
    const w = planShortWindow([], 45, { maxSec: 60 });
    expect(w.startSec).toBe(0);
    expect(w.durSec).toBe(45);
    expect(w.includedKills).toEqual([]);
    expect(w.truncated).toBe(false);
  });

  it('clip sem duração: não gera janela', () => {
    const w = planShortWindow([10], 0);
    expect(w.durSec).toBe(0);
    expect(w.startSec).toBe(0);
  });
});

describe('killPositionsSec', () => {
  it('converte o relógio do placar no tempo do clipe (com o offset da latência)', () => {
    const positions = killPositionsSec(
      [
        { at: 1793482031411 },
        { at: 1793482034452 },
        { at: 1793482068598 },
      ],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positions[0]).toBeCloseTo(15, 1);
    expect(positions[1]).toBeCloseTo(18, 1);
    expect(positions[2]).toBeCloseTo(52.2, 1);
  });

  it('aceita o `at` em ISO (sidecar do script de VOD)', () => {
    const positions = killPositionsSec(
      [{ at: '2026-10-31T21:27:11.411Z' }],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positions.length).toBe(1);
    expect(positions[0]).toBeCloseTo(15, 1);
  });

  it('sem o offset da latência: não inventa posição (o corte sairia errado)', () => {
    expect(
      killPositionsSec([{ at: 1793482031411 }], {
        clipStartMs: 1793482037465,
        clipDurationSec: 59.14,
      }),
    ).toEqual([]);
  });

  it('descarta a kill que caiu fora do clipe', () => {
    const positions = killPositionsSec(
      [{ at: 1793482000000 }, { at: 1793482034452 }],
      {
        clipStartMs: 1793482037465,
        killVideoOffsetMs: 21053.67,
        clipDurationSec: 59.14,
      },
    );
    expect(positions.length).toBe(1);
    expect(positions[0]).toBeCloseTo(18, 1);
  });

  it('sem clipStartMs: não inventa posição', () => {
    expect(killPositionsSec([{ at: 1 }], {})).toEqual([]);
  });

  it('killPositionsByKill devolve o índice da kill (metadados honestos)', () => {
    const positioned = killPositionsByKill(
      [
        { at: 1793482000000 },
        { at: 1793482031411 },
        { at: 1793482034452 },
      ],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positioned.map((p) => p.index)).toEqual([1, 2]);
    expect(positioned[0].sec).toBeCloseTo(15, 1);
  });

  it('kill ESTIMADA (posição não medida) não entra na janela do Short', () => {
    // Abertura limitada pelo teto = a posição vem do palpite: montar a
    // janela em cima dela cortaria o começo do ace e prometeria um
    // horário que ninguém mediu.
    const positioned = killPositionsByKill(
      [
        { at: 1793482031411, estimated: true },
        { at: 1793482034452, estimated: true },
        { at: 1793482037465 },
      ],
      { clipStartMs: 1793482037465, killVideoOffsetMs: 21053.67, clipDurationSec: 59.14 },
    );
    expect(positioned.map((p) => p.index)).toEqual([2]);
  });
});

describe('killAtMs', () => {
  it('lê número e ISO', () => {
    expect(killAtMs(1793482031411)).toBe(1793482031411);
    expect(killAtMs('2026-10-31T21:27:11.411Z')).toBe(
      Date.parse('2026-10-31T21:27:11.411Z'),
    );
    expect(killAtMs('lixo')).toBeNull();
    expect(killAtMs(null)).toBeNull();
  });
});

describe('shortVideoFilter', () => {
  it('corta 9:16 pela altura e escala para 1080x1920', () => {
    const f = shortVideoFilter();
    expect(f).toContain('crop=ih*9/16:ih');
    expect(f).toContain('scale=1080:1920');
    expect(f).toContain('setsar=1');
  });

  it('o deslocamento horizontal do crop é parametrizável', () => {
    expect(shortVideoFilter({ cropX: 0.7 })).toContain('(iw-ih*9/16)*0.7');
    expect(shortVideoFilter({ cropX: 5 })).toContain('(iw-ih*9/16)*1');
  });
});

describe('parseShortCamBox', () => {
  it('lê x:y:w:h e rejeita caixa inválida', () => {
    expect(parseShortCamBox('0.816:0.310:0.177:0.240')).toEqual({
      x: 0.816,
      y: 0.31,
      w: 0.177,
      h: 0.24,
    });
    expect(parseShortCamBox('')).toBeNull();
    expect(parseShortCamBox(null)).toBeNull();
    expect(parseShortCamBox('0.9:0.1:0.5:0.5')).toBeNull();
    expect(parseShortCamBox('lixo')).toBeNull();
  });

  it('camBoxToString desfaz o parse', () => {
    expect(camBoxToString(parseShortCamBox('0.1:0.2:0.3:0.4'))).toBe('0.1:0.2:0.3:0.4');
    expect(camBoxToString(null)).toBeNull();
  });
});

describe('buildShortLayout (cam no topo + jogo embaixo)', () => {
  const camBox = { x: 0.816, y: 0.31, w: 0.177, h: 0.24 };
  const base = {
    width: 1080,
    height: 1920,
    camBox,
    camHeight: 540,
    gameCrop: 0.95,
    gameY: 0.5,
    srcWidth: 1920,
    srcHeight: 1080,
  } as const;

  it('empilha cam (topo) e jogo (embaixo) com a altura pedida', () => {
    const layout = buildShortLayout({ ...base, top: 'cam' });
    expect(layout.top).toBe('cam');
    expect(layout.camFit).toBe('cover');
    expect(layout.topHeight + layout.gameHeight).toBe(1920);
    expect(layout.topHeight).toBe(540);
    expect(layout.filter).toContain('vstack=inputs=2');
    // O jogo escala para a faixa de baixo (1080x1380 = aspecto 0.78).
    expect(layout.filter).toContain('scale=1080:1380');
  });

  it('a cam preenche a faixa sem barra preta (zoom, sem distorcer)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam' });
    // Cover: a cam cresce até estourar a faixa e é cortada na vertical.
    expect(layout.filter).toContain('force_original_aspect_ratio=increase');
    expect(layout.filter).toContain('crop=1080:540:(iw-ow)/2:(ih-oh)*0.35');
    // Sem `pad` preto (era o que cobria o fundo e voltava a barra preta).
    expect(layout.filter).not.toContain('pad=');
    expect(layout.filter).not.toContain('color=black');
  });

  it('modo blur: cam inteira sobre o fundo desfocado, overlay centralizado', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', camFit: 'blur' });
    expect(layout.camFit).toBe('blur');
    expect(layout.filter).toContain('force_original_aspect_ratio=decrease');
    expect(layout.filter).toContain('overlay=(W-w)/2:(H-h)/2');
    expect(layout.filter).not.toContain('pad=');
  });

  it('o jogo é centralizado (corta em cima e embaixo)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam' });
    // 1080 * 0.95 = 1026 de altura; largura = 1026 * 1080/1380 = 803;
    // x = (1920 - 803) / 2 = 559; y = (1080 - 1026) / 2 = 27.
    expect(layout.filter).toContain('crop=803:1026:559:27');
  });

  it('jogo em "blur": o crop entra centralizado sobre fundo desfocado (nada cortado)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', gameFit: 'blur' });
    expect(layout.gameFit).toBe('blur');
    // O crop é encaixado (contain) num fundo desfocado.
    expect(layout.filter).toContain('force_original_aspect_ratio=decrease');
    expect(layout.filter).toContain('boxblur=20:2');
    expect(layout.filter).toContain('overlay=(W-w)/2:(H-h)/2[game]');
    // Nenhum crop apertado: o killfeed/placar/rodapé ficam no quadro.
    expect(layout.filter).not.toContain('crop=803:1026:559:27');
  });

  it('a proporção do jogo define a fatia da transmissão (4:3 = 71% da largura)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', gameFit: 'blur', gameAspect: 4 / 3 });
    expect(layout.gameAspect).toBeCloseTo(1.3333, 4);
    // Altura = 0.95 * 1080 = 1026; largura = 1026 * 4/3 = 1368;
    // centralizado: x = (1920 - 1368) / 2 = 276; y = (1080 - 1026) / 2 = 27.
    expect(layout.filter).toContain('crop=1368:1026:276:27');
  });

  it('proporções mais largas mostram mais da transmissão (1:1 e 3:2)', () => {
    const quadrado = buildShortLayout({ ...base, top: 'cam', gameFit: 'blur', gameAspect: 1 });
    expect(quadrado.filter).toContain('crop=1026:1026:447:27');
    const tresDois = buildShortLayout({ ...base, top: 'cam', gameFit: 'blur', gameAspect: 1.5 });
    expect(tresDois.filter).toContain('crop=1539:1026:191:27');
  });

  it('o 9:16 (0.7826) no modo blur reproduz o crop de antes', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', gameFit: 'blur', gameAspect: 0.7826 });
    expect(layout.filter).toContain('crop=803:1026:559:27');
  });

  it('jogo em "cover" (padrão antigo): crop 9:16 apertado', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', gameFit: 'cover' });
    expect(layout.gameFit).toBe('cover');
    expect(layout.filter).toContain('crop=803:1026:559:27');
    expect(layout.filter).not.toContain('boxblur');
  });

  it('gameCrop=1 usa a fonte inteira (y=0)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', gameCrop: 1 });
    expect(layout.filter).toContain('crop=845:1080:538:0');
  });

  it('gameY move o crop na vertical (0 = topo, 1 = base)', () => {
    expect(buildShortLayout({ ...base, top: 'cam', gameY: 0 }).filter).toContain(
      'crop=803:1026:559:0',
    );
    expect(buildShortLayout({ ...base, top: 'cam', gameY: 1 }).filter).toContain(
      'crop=803:1026:559:54',
    );
  });

  it('altura da cam é forçada a par (x264/yuv420p)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', camHeight: 541 });
    expect(layout.topHeight % 2).toBe(0);
    expect(layout.topHeight + layout.gameHeight).toBe(1920);
  });

  it('sem caixa de cam cai no crop central (não corta o quadro errado)', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', camBox: null });
    expect(layout.top).toBe('center');
    expect(layout.filter).toContain('crop=ih*9/16:ih');
    expect(layout.filter).not.toContain('vstack');
  });

  it('texto usa o PNG da faixa como segundo input', () => {
    const layout = buildShortLayout({ ...base, top: 'text' });
    expect(layout.top).toBe('text');
    expect(layout.filter).toContain('[1:v]scale=1080:540');
    expect(layout.filter).toContain('vstack=inputs=2');
    // O jogo continua centralizado no layout de texto.
    expect(layout.filter).toContain('crop=803:1026:559:27');
  });

  it('center mantém o filtro antigo (rotulado para o filter_complex)', () => {
    const layout = buildShortLayout({ ...base, top: 'center' });
    expect(layout.topHeight).toBe(1920);
    expect(layout.filter.startsWith('[0:v]crop=ih*9/16:ih')).toBe(true);
    expect(layout.filter.endsWith('[v]')).toBe(true);
  });

  it('fonte 720p usa as medidas reais no crop do jogo', () => {
    const layout = buildShortLayout({ ...base, top: 'cam', srcWidth: 1280, srcHeight: 720 });
    // 720 * 0.95 = 684; largura = 684 * 1080/1380 = 535;
    // x = (1280 - 535) / 2 = 373; y = (720 - 684) / 2 = 18.
    expect(layout.filter).toContain('crop=535:684:373:18');
  });
});

describe('shortRenderSignature / isStaleRender', () => {
  const sig = shortRenderSignature({
    top: 'cam',
    camBox: { x: 0.8, y: 0.3, w: 0.17, h: 0.24 },
    camHeight: 540,
    camFit: 'cover',
    camAnchor: 0.35,
    gameCrop: 0.95,
    gameY: 0.5,
    gameFit: 'blur',
    gameAspect: 4 / 3,
    width: 1080,
    height: 1920,
    bannerText: null,
  });

  it('sem marker antigo re-renderiza', () => {
    expect(isStaleRender(null, sig)).toBe(true);
    expect(isStaleRender(undefined, sig)).toBe(true);
  });

  it('marker de uma versão antiga do layout re-renderiza', () => {
    const antigo = { ...sig, gameCrop: undefined, gameY: undefined } as unknown as typeof sig;
    expect(isStaleRender(antigo, sig)).toBe(true);
  });

  it('marker sem o preenchimento do jogo (versão antiga) re-renderiza', () => {
    const antigo = { ...sig, gameFit: undefined } as unknown as typeof sig;
    expect(isStaleRender(antigo, sig)).toBe(true);
  });

  it('proporção do jogo diferente re-renderiza', () => {
    expect(isStaleRender(sig, { ...sig, gameAspect: 1.5 })).toBe(true);
    // A assinatura arredonda a proporção (4 casas): o mesmo valor não
    // re-renderiza.
    expect(isStaleRender(sig, { ...sig, gameAspect: 1.3333 })).toBe(false);
  });

  it('mesma assinatura não re-renderiza', () => {
    expect(isStaleRender(sig, { ...sig })).toBe(false);
  });

  it('regra de correção da legenda diferente re-renderiza (o texto é queimado)', () => {
    const comLegenda = shortRenderSignature({
      top: 'cam',
      captions: 'on',
      captionRulesHash: 'aaa111',
    });
    expect(isStaleRender(comLegenda, { ...comLegenda })).toBe(false);
    expect(isStaleRender(comLegenda, { ...comLegenda, captionRulesHash: 'bbb222' })).toBe(true);
    // Marker de uma versão antiga (sem o campo) re-renderiza.
    const antigo = { ...comLegenda, captionRulesHash: undefined } as unknown as typeof comLegenda;
    expect(isStaleRender(antigo, comLegenda)).toBe(true);
  });

  it('sem legenda, a regra de correção não força re-render', () => {
    const semLegenda = shortRenderSignature({ top: 'cam', captions: 'off' });
    expect(isStaleRender(semLegenda, { ...semLegenda, captionRulesHash: 'ccc333' })).toBe(false);
  });

  it('layout/caixa/geometria/texto diferentes re-renderizam', () => {
    expect(isStaleRender(sig, { ...sig, top: 'text' })).toBe(true);
    expect(isStaleRender(sig, { ...sig, camBox: '0.1:0.1:0.1:0.1' })).toBe(true);
    expect(isStaleRender(sig, { ...sig, camHeight: 720 })).toBe(true);
    expect(isStaleRender(sig, { ...sig, camFit: 'blur' })).toBe(true);
    expect(isStaleRender(sig, { ...sig, camAnchor: 0.6 })).toBe(true);
    expect(isStaleRender(sig, { ...sig, gameCrop: 0.8 })).toBe(true);
    expect(isStaleRender(sig, { ...sig, gameY: 0 })).toBe(true);
    expect(isStaleRender(sig, { ...sig, gameFit: 'cover' })).toBe(true);
    expect(isStaleRender(sig, { ...sig, width: 720 })).toBe(true);
    expect(isStaleRender(sig, { ...sig, bannerText: 'outro título' })).toBe(true);
  });

  it('adesivo do começo diferente re-renderiza', () => {
    const comAdesivo = shortRenderSignature({
      top: 'cam',
      overlayText: 'Furia nos playoffs',
      overlayHoldSec: 2,
    });
    expect(isStaleRender(sig, comAdesivo)).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayText: 'Outro texto' })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayHoldSec: 3 })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo })).toBe(false);
  });

  it('visual do adesivo diferente re-renderiza (preset, cor, borda, sombra)', () => {
    const comAdesivo = shortRenderSignature({
      top: 'cam',
      overlayText: 'Furia nos playoffs',
      overlayHoldSec: 2,
      overlayPreset: 'polex',
      overlayShape: 'capsule',
      overlayBackground: '#e10600',
      overlayBorderPx: 0,
      overlayShadowPx: 10,
      overlayUppercase: true,
    });
    expect(isStaleRender(comAdesivo, { ...comAdesivo })).toBe(false);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayPreset: 'madhouse' })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayShape: 'rect' })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayBackground: '#2563eb' })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayBorderPx: 7 })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayShadowPx: 12 })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayShadowBlurPx: 4 })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayTiltDeg: -2 })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayFont: 'Impact' })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayTag: 'MADHOUSE' })).toBe(true);
    expect(isStaleRender(comAdesivo, { ...comAdesivo, overlayUppercase: false })).toBe(true);
  });

  it('sem adesivo: o preset/visual do adesivo NÃO força re-render', () => {
    // O adesivo não existe no vertical: mudar o preset (ou o hash do
    // visual no código) não muda o mp4 — forçar o re-render aqui
    // refazia TODOS os clipes sem adesivo a cada mudança de preset.
    expect(isStaleRender(sig, { ...sig, overlayPreset: 'madhouse' })).toBe(false);
    expect(isStaleRender(sig, { ...sig, overlayVisuals: 'outro-hash' })).toBe(false);
    // Marker de uma versão anterior (sem o campo overlayVisuals) segue
    // valendo quando não há adesivo.
    const antigo = { ...sig, overlayVisuals: undefined } as unknown as typeof sig;
    expect(isStaleRender(antigo, sig)).toBe(false);
  });

  it('adesivo que aparece (ou some) re-renderiza', () => {
    const comAdesivo = shortRenderSignature({ top: 'cam', overlayText: 'Furia' });
    expect(isStaleRender(sig, comAdesivo)).toBe(true);
    expect(isStaleRender(comAdesivo, sig)).toBe(true);
  });
});

describe('resolveShortWindowConfig / shortWindowConfigErrors', () => {
  const cfg = {
    SHORTS_MIN_SEC: 60,
    SHORTS_MAX_SEC: 90,
    SHORTS_HEAD_SEC: 4,
    SHORTS_TAIL_SEC: 4,
  };

  it('as flags da execução ganham do .env', () => {
    expect(resolveShortWindowConfig(cfg)).toEqual({
      minSec: 60,
      maxSec: 90,
      headSec: 4,
      tailSec: 4,
    });
    expect(resolveShortWindowConfig(cfg, { minSec: 30, maxSec: null })).toEqual({
      minSec: 30,
      maxSec: 90,
      headSec: 4,
      tailSec: 4,
    });
  });

  it('janela invertida ou grande demais é recusada (antes do lote)', () => {
    const geo = { width: 1080, height: 1920, camHeight: 600 };
    expect(shortWindowConfigErrors(resolveShortWindowConfig(cfg), geo)).toEqual([]);
    const invertida = shortWindowConfigErrors(
      resolveShortWindowConfig(cfg, { minSec: 120, maxSec: 90 }),
      geo,
    );
    expect(invertida.length).toBeGreaterThan(0);
    const grande = shortWindowConfigErrors(
      resolveShortWindowConfig(cfg, { maxSec: 400 }),
      geo,
    );
    expect(grande.length).toBeGreaterThan(0);
  });
});

describe('wrapShortTitle (faixa de texto)', () => {
  it('quebra por palavra e respeita o limite', () => {
    expect(wrapShortTitle('4K! KSCERATO — Ancient R27 | IEM Beijing 2026', 20, 3)).toEqual([
      '4K! KSCERATO —',
      'Ancient R27 | IEM',
      'Beijing 2026',
    ]);
  });

  it('corta palavra maior que a linha', () => {
    expect(wrapShortTitle('AAAAAAAAAAAAAAAAAAAAAA', 10, 3)).toEqual([
      'AAAAAAAAAA',
      'AAAAAAAAAA',
      'AA',
    ]);
  });

  it('acima do máximo de linhas, a última ganha reticências', () => {
    const lines = wrapShortTitle('um dois tres quatro cinco seis sete oito', 8, 2);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('título vazio não gera linha', () => {
    expect(wrapShortTitle('', 20, 3)).toEqual([]);
    expect(wrapShortTitle(null, 20, 3)).toEqual([]);
  });

  it('emoji do título não vira quadradinho (tofu) na faixa', () => {
    // A fonte da faixa é do sistema (sem fallback de emoji): o emoji
    // saía como tofu no topo do Short.
    const lines = wrapShortTitle('5K 🔥 donk!! 🎯', 20, 3);
    expect(lines.join(' ')).toBe('5K donk!!');
    for (const line of lines) {
      expect(line).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);
    }
  });
});

describe('fitBannerText (o texto cabe na faixa)', () => {
  const largura = 1080;

  it('título de 1 linha cheia não encosta nas bordas', () => {
    // Antes o limite de caracteres era fixo (w/52) e o tamanho da fonte
    // crescia com menos linhas: um título de 21 caracteres saía colado
    // nas duas bordas da faixa.
    const fit = fitBannerText(largura, 'AAAAAAAAAAAAAAAAAAAAA', null);
    const maisLonga = fit.lines.reduce((max, l) => Math.max(max, l.length), 0);
    expect(maisLonga * fit.size * 0.62).toBeLessThanOrEqual(fit.maxWidth);
  });

  it('título de 2 linhas também cabe', () => {
    const fit = fitBannerText(largura, '4K! KSCERATO — Ancient R27 | IEM Beijing 2026', null);
    const maisLonga = fit.lines.reduce((max, l) => Math.max(max, l.length), 0);
    expect(maisLonga * fit.size * 0.62).toBeLessThanOrEqual(fit.maxWidth);
    expect(fit.lines.length).toBeGreaterThan(0);
  });

  it('o subtítulo é cortado (com reticências) quando é longo', () => {
    const fit = fitBannerText(largura, '5K', 'x'.repeat(200));
    expect(fit.subtitle.length).toBeLessThan(200);
    expect(fit.subtitle.endsWith('…')).toBe(true);
  });

  it('título vazio não quebra', () => {
    const fit = fitBannerText(largura, '', null);
    expect(fit.lines).toEqual([]);
    expect(fit.subtitle).toBe('');
  });

  it('emoji sai do título e do subtítulo (nem tofu, nem sobra de espaço)', () => {
    const fit = fitBannerText(largura, '🔥 5K donk 🎯', 'KSCERATO 🚀');
    expect(fit.lines.join(' ')).toBe('5K donk');
    expect(fit.subtitle).toBe('KSCERATO');
  });
});

describe('isStaleWindow (o vertical em disco cobre a janela?)', () => {
  const plan = planShortWindow([30, 35, 40], 120, { headSec: 4, tailSec: 4 });

  it('sem vertical gravado não há o que re-renderizar', () => {
    expect(isStaleWindow(null, plan, false)).toBe(false);
  });

  it('sem marker (janela desconhecida) re-renderiza', () => {
    expect(isStaleWindow(null, plan, true)).toBe(true);
    expect(isStaleWindow({ startSec: NaN, durSec: NaN }, plan, true)).toBe(true);
  });

  it('mesma janela = não re-renderiza', () => {
    expect(
      isStaleWindow({ startSec: plan.startSec, durSec: plan.durSec }, plan, true),
    ).toBe(false);
  });

  it('janela diferente (folga/limite mudados) re-renderiza', () => {
    expect(isStaleWindow({ startSec: plan.startSec + 2, durSec: plan.durSec }, plan, true)).toBe(
      true,
    );
    expect(isStaleWindow({ startSec: plan.startSec, durSec: plan.durSec + 5 }, plan, true)).toBe(
      true,
    );
  });

  it('a tolerância é de 50ms (arredondamento não conta como mudança)', () => {
    expect(
      isStaleWindow(
        { startSec: plan.startSec + 0.04, durSec: plan.durSec - 0.04 },
        plan,
        true,
      ),
    ).toBe(false);
  });
});
