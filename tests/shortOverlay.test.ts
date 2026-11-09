import { describe, expect, it } from 'vitest';
import { SHORTS_OVERLAY_PRESETS } from '../src/config.js';
import {
  overlayTextWidth,
  resolveShortOverlayStyle,
  shortOverlayButtonSvg,
  shortOverlayFilter,
  shortOverlayMetrics,
  wrapOverlayTextByWidth,
} from '../src/clipper/shortOverlay.js';

describe('shortOverlayMetrics (o botão cabe no vertical?)', () => {
  it('o botão é compacto e proporcional à largura do vertical', () => {
    const m = shortOverlayMetrics('Furia nos playoffs', 1080, 1920);
    expect(m.fontSize).toBeGreaterThanOrEqual(40);
    expect(m.fontSize).toBeLessThanOrEqual(56);
    // Carimbo, não faixa: bem menor que o vertical.
    expect(m.width).toBeLessThan(720);
    expect(m.height).toBeLessThan(110);
    expect(m.margin).toBeGreaterThan(0);
  });

  it('texto muito longo não estoura a largura do vertical', () => {
    const m = shortOverlayMetrics('a'.repeat(200), 1080, 1920);
    expect(m.width).toBeLessThanOrEqual(Math.round(1080 * 0.86));
  });

  it('a forma é dimensionada pela largura do texto (o texto não estoura)', () => {
    const madhouse = resolveShortOverlayStyle({
      preset: 'madhouse',
      text: 'FURIA NOS PLAYOFFS',
      holdSec: 2,
      fadeSec: 0.5,
      y: 0.54,
    });
    const m = shortOverlayMetrics('FURIA NOS PLAYOFFS', 1080, 1920, madhouse ?? {});
    const widest = Math.max(...m.lineWidths);
    expect(m.width).toBeGreaterThanOrEqual(Math.ceil(widest));
    expect(m.width).toBeLessThanOrEqual(Math.round(1080 * 0.86));
  });

  it('a largura da tag comporta o texto da tag', () => {
    const madhouse = resolveShortOverlayStyle({
      preset: 'madhouse',
      text: 'FURIA NOS PLAYOFFS',
      holdSec: 2,
      fadeSec: 0.5,
      y: 0.54,
    });
    const m = shortOverlayMetrics('FURIA NOS PLAYOFFS', 1080, 1920, madhouse ?? {});
    const tagFontSize = Math.round(m.fontSize * 0.42);
    expect(m.tagWidth).toBeGreaterThan(
      overlayTextWidth('MADHOUSE', 'Arial Black', tagFontSize),
    );
  });

  it('palavra gigante: a forma não estoura o vertical', () => {
    const m = shortOverlayMetrics('M'.repeat(120), 1080, 1920);
    const limit = Math.round(1080 * 0.86);
    expect(m.width).toBeLessThanOrEqual(limit);
    expect(Math.max(...m.lineWidths)).toBeLessThanOrEqual(limit);
    expect(m.lines.length).toBeLessThanOrEqual(4);
  });
});

describe('overlayTextWidth (a estimativa cobre o texto real)', () => {
  // Larguras REAIS medidas com o mesmo renderizador (fonte de 100px).
  it('Arial Black cobre as frases de referência', () => {
    expect(overlayTextWidth('FURIA NOS PLAYOFFS', 'Arial Black', 100)).toBeGreaterThanOrEqual(1208);
    expect(overlayTextWidth('Furia nos playoffs', 'Arial Black', 100)).toBeGreaterThanOrEqual(962);
    expect(overlayTextWidth('MADHOUSE', 'Arial Black', 100)).toBeGreaterThanOrEqual(633);
  });

  it('Impact cobre as frases de referência', () => {
    expect(overlayTextWidth('FURIA NOS PLAYOFFS', 'Impact', 100)).toBeGreaterThanOrEqual(786);
    expect(overlayTextWidth('MADHOUSE', 'Impact', 100)).toBeGreaterThanOrEqual(430);
  });

  it('cresce com o tamanho da fonte e aceita acento', () => {
    expect(overlayTextWidth('FURIA', 'Arial Black', 50)).toBeGreaterThan(
      overlayTextWidth('FURIA', 'Arial Black', 25),
    );
    expect(overlayTextWidth('CORAÇÃO', 'Arial Black', 50)).toBeGreaterThan(0);
  });
});

describe('shortOverlayButtonSvg (o botão vermelho)', () => {
  it('desenha o fundo com gradiente, sombra e o texto dentro', () => {
    const svg = shortOverlayButtonSvg('Furia nos playoffs', {
      outWidth: 1080,
      outHeight: 1920,
      background: '#e10600',
      color: '#ffffff',
    });
    expect(svg).toContain('Furia nos playoffs');
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('<stop offset="0.55" stop-color="#e10600"/>');
    expect(svg).toContain('feGaussianBlur');
    expect(svg).toContain('fill="url(#ovl-bg)"');
    expect(svg).toContain('filter="url(#ovl-shadow)"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it('emoji não entra no botão (a fonte do sistema não tem)', () => {
    const svg = shortOverlayButtonSvg('Furia nos playoffs 🎯', {
      outWidth: 1080,
      outHeight: 1920,
    });
    expect(svg).toContain('Furia nos playoffs');
    expect(svg).not.toContain('🎯');
  });

  it('o preset polex sai chapado, sem gradiente e com sombra sólida', () => {
    const style = resolveShortOverlayStyle({
      preset: 'polex',
      text: 'Furia nos playoffs',
      holdSec: 2,
      fadeSec: 0.5,
      y: 0.54,
    });
    const svg = shortOverlayButtonSvg('Furia nos playoffs', {
      outWidth: 1080,
      outHeight: 1920,
      ...(style ?? {}),
    });
    expect(svg).not.toContain('linearGradient');
    expect(svg).not.toContain('feGaussianBlur');
    expect(svg).toContain('FURIA NOS PLAYOFFS');
    expect(svg).toContain('fill="#7a0000"');
  });

  it('o preset diecut tem borda branca, tag e recorte irregular', () => {
    const style = resolveShortOverlayStyle({
      preset: 'diecut',
      text: 'Corte brabo',
      holdSec: 2,
      fadeSec: 0.5,
      y: 0.54,
    });
    const svg = shortOverlayButtonSvg('Corte brabo', {
      outWidth: 1080,
      outHeight: 1920,
      ...(style ?? {}),
    });
    expect(svg).toContain('feTurbulence');
    expect(svg).toContain('feDisplacementMap');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('rotate(-2');
  });

  it('o preset madhouse mostra a tag no topo', () => {
    const style = resolveShortOverlayStyle({
      preset: 'madhouse',
      text: 'Furia nos playoffs',
      holdSec: 2,
      fadeSec: 0.5,
      y: 0.54,
    });
    const svg = shortOverlayButtonSvg('Furia nos playoffs', {
      outWidth: 1080,
      outHeight: 1920,
      ...(style ?? {}),
    });
    expect(svg).toContain('MADHOUSE');
    expect(svg).toContain('fill="#ffd400"');
  });
});

describe('resolveShortOverlayStyle (preset + overrides)', () => {
  const base = {
    text: 'Furia nos playoffs',
    holdSec: 2,
    fadeSec: 0.5,
    y: 0.54,
  };

  it('texto vazio = sem adesivo', () => {
    expect(resolveShortOverlayStyle({ ...base, preset: 'polex', text: '   ' })).toBeNull();
  });

  it('texto só com emoji = sem adesivo (a fonte do sistema não tem)', () => {
    expect(resolveShortOverlayStyle({ ...base, preset: 'polex', text: '🎯' })).toBeNull();
    expect(resolveShortOverlayStyle({ ...base, preset: 'pill', text: '🏆🔥' })).toBeNull();
  });

  it('cada preset resolve para si mesmo (preset novo não cai no polex)', () => {
    for (const preset of SHORTS_OVERLAY_PRESETS) {
      const style = resolveShortOverlayStyle({ ...base, preset });
      expect(style?.preset).toBe(preset);
    }
  });

  it('tag "none" = sem tag (dá para tirar a tag do preset)', () => {
    const style = resolveShortOverlayStyle({
      ...base,
      preset: 'madhouse',
      overrides: { tag: 'none' },
    });
    expect(style?.tag).toBe('');
  });

  it('cor inválida cai no preset (o SVG sairia sem o texto)', () => {
    const style = resolveShortOverlayStyle({
      ...base,
      preset: 'polex',
      overrides: { background: 'vermelho', color: '#zzz' },
    });
    expect(style?.background).toBe('#e10600');
    expect(style?.color).toBe('#ffffff');
  });

  it('cor hex válida (com ou sem #) é aceita e normalizada', () => {
    const style = resolveShortOverlayStyle({
      ...base,
      preset: 'polex',
      overrides: { background: '2563eb', color: '#FFFFFF' },
    });
    expect(style?.background).toBe('#2563eb');
    expect(style?.color).toBe('#ffffff');
  });

  it('preset polex: vermelho chapado, sombra sólida, sem borda', () => {
    const style = resolveShortOverlayStyle({ ...base, preset: 'polex' });
    expect(style).not.toBeNull();
    expect(style?.background).toBe('#e10600');
    expect(style?.color).toBe('#ffffff');
    expect(style?.borderPx).toBe(0);
    expect(style?.shadowBlurPx).toBe(0);
    expect(style?.shadowPx).toBeGreaterThan(0);
    expect(style?.uppercase).toBe(true);
    expect(style?.shape).toBe('capsule');
  });

  it('preset diecut: borda branca, sombra e recorte irregular', () => {
    const style = resolveShortOverlayStyle({ ...base, preset: 'diecut' });
    expect(style?.borderColor).toBe('#ffffff');
    expect(style?.borderPx).toBeGreaterThan(0);
    expect(style?.roughEdge).toBe(true);
    expect(style?.shape).toBe('rect');
  });

  it('preset madhouse: amarelo, tag e roxo na borda', () => {
    const style = resolveShortOverlayStyle({ ...base, preset: 'madhouse' });
    expect(style?.background).toBe('#ffd400');
    expect(style?.tag).toBe('MADHOUSE');
    expect(style?.shape).toBe('rect');
  });

  it('preset desconhecido cai no polex', () => {
    const style = resolveShortOverlayStyle({ ...base, preset: 'sticker' });
    expect(style?.preset).toBe('polex');
  });

  it('override vazio mantém o preset e 0 é override válido', () => {
    const style = resolveShortOverlayStyle({
      ...base,
      preset: 'polex',
      overrides: { background: '', borderPx: 0, shadowPx: 12 },
    });
    expect(style?.background).toBe('#e10600');
    expect(style?.borderPx).toBe(0);
    expect(style?.shadowPx).toBe(12);
  });

  it('override de cor/formato/fonte vale sobre o preset', () => {
    const style = resolveShortOverlayStyle({
      ...base,
      preset: 'polex',
      overrides: {
        background: '#2563eb',
        shape: 'rect',
        font: 'Impact',
        tag: 'MURILLO',
        uppercase: false,
      },
    });
    expect(style?.background).toBe('#2563eb');
    expect(style?.shape).toBe('rect');
    expect(style?.font).toBe('Impact');
    expect(style?.tag).toBe('MURILLO');
    expect(style?.uppercase).toBe(false);
  });
});

describe('wrapOverlayTextByWidth (o texto do adesivo quebra em linhas)', () => {
  it('quebra por largura, sem perder palavra', () => {
    const lines = wrapOverlayTextByWidth('Furia nos playoffs do canal', 300, 'Arial Black', 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(overlayTextWidth(line, 'Arial Black', 40)).toBeLessThanOrEqual(300);
    }
    expect(lines.join(' ')).toContain('playoffs');
  });

  it('texto curto fica em UMA linha (não quebra por contagem de caracteres)', () => {
    const lines = wrapOverlayTextByWidth('Furia nos playoffs', 900, 'Arial Black', 49);
    expect(lines).toEqual(['Furia nos playoffs']);
  });

  it('texto muito longo vira no máximo 4 linhas', () => {
    const lines = wrapOverlayTextByWidth('palavra '.repeat(80), 300, 'Arial Black', 40);
    expect(lines.length).toBeLessThanOrEqual(4);
  });
});

describe('shortOverlayFilter (o adesivo se mexe e some em fade out)', () => {
  const base = '[0:v]crop=ih*9/16:ih,setsar=1[v]';

  it('entra com fade-in, compõe por cima e renomeia a base', () => {
    const f = shortOverlayFilter({
      baseFilter: base,
      inputIndex: 1,
      holdSec: 2,
      fadeSec: 0.5,
      yPx: 864,
    });
    expect(f).toContain('[base]');
    expect(f).toContain('[1:v]format=rgba');
    expect(f).toContain('fade=t=in:st=0:d=0.18:alpha=1');
    expect(f).toContain('fade=t=out:st=1.50:d=0.50:alpha=1');
    expect(f).toContain("enable='between(t,0,2.00)'");
    expect(f.endsWith('[v]')).toBe(true);
  });

  it('o movimento usa a subida e o balanço (eixos avaliados por frame)', () => {
    const f = shortOverlayFilter({
      baseFilter: base,
      inputIndex: 1,
      holdSec: 2,
      fadeSec: 0.5,
      yPx: 864,
    });
    expect(f).toContain('pow(1-min(t/0.32,1),2)');
    expect(f).toContain('sin(2*PI*');
    expect(f).toContain("overlay=x=(W-w)/2:y='864");
  });

  it('o fade começa antes do fim do tempo do adesivo', () => {
    const f = shortOverlayFilter({
      baseFilter: base,
      inputIndex: 2,
      holdSec: 2,
      fadeSec: 0.8,
      yPx: 100,
    });
    expect(f).toContain('st=1.20');
    expect(f).toContain('d=0.80');
    expect(f).toContain('[2:v]');
  });

  it('fade maior que o tempo do adesivo não vira fade negativo', () => {
    const f = shortOverlayFilter({
      baseFilter: base,
      inputIndex: 1,
      holdSec: 1,
      fadeSec: 5,
      yPx: 100,
    });
    expect(f).toContain('st=0.00');
    expect(f).toContain('d=1.00');
  });
});
