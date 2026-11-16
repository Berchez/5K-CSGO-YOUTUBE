import { describe, expect, it } from 'vitest';
import {
  markerOverlaySpec,
  mergeShortOverlaySources,
  normalizeShortOverlaySpec,
  overlaySpecForMarker,
  parseShortOverlayConfig,
  shortOverlaySpecForClip,
} from '../src/clipper/shortOverlayConfig.js';

describe('config do adesivo por clipe', () => {
  it('normaliza e descarta os campos inválidos', () => {
    const spec = normalizeShortOverlaySpec({
      text: '  4K NA DUST2 ',
      preset: 'polex-die',
      holdSec: 2.5,
      fadeSec: -1,
      y: 3,
      uppercase: 'true',
      background: 123,
    });
    expect(spec.text).toBe('4K NA DUST2');
    expect(spec.preset).toBe('polex-die');
    expect(spec.holdSec).toBe(2.5);
    // Inválidos caem fora (não viram 0/false e não sobrescrevem o .env).
    expect(spec.fadeSec).toBeUndefined();
    expect(spec.y).toBeUndefined();
    expect(spec.background).toBeUndefined();
    expect(spec.uppercase).toBe(true);
  });

  it('lê o arquivo por clipe e ignora as entradas quebradas', () => {
    const config = parseShortOverlayConfig({
      '2400207_Dust2_r17_YEKINDAR': { text: 'YEKINDAR 4K NA DUST2', preset: 'polex-die' },
      quebrado: 'texto solto',
      vazio: {},
    });
    expect(Object.keys(config)).toEqual(['2400207_Dust2_r17_YEKINDAR']);
    expect(config['2400207_Dust2_r17_YEKINDAR'].preset).toBe('polex-die');
  });

  it('acha a entrada pela pasta do clipe (e pelo nome do arquivo)', () => {
    const config = parseShortOverlayConfig({
      '2400207_Dust2_r17_YEKINDAR': { text: 'YEKINDAR' },
      '2400207_Anubis_r13_kyousuke.mp4': { text: 'KYOUSUKE' },
    });
    expect(shortOverlaySpecForClip(config, '2400207_Dust2_r17_YEKINDAR')?.text).toBe('YEKINDAR');
    expect(
      shortOverlaySpecForClip(config, '2400207_Anubis_r13_kyousuke', '2400207_Anubis_r13_kyousuke.mp4')
        ?.text,
    ).toBe('KYOUSUKE');
    expect(shortOverlaySpecForClip(config, 'outro_clipe')).toBeNull();
  });

  it('a flag da CLI vence o arquivo, o marker e o .env', () => {
    const merged = mergeShortOverlaySources({
      cli: { text: 'DA CLI' },
      file: { text: 'DO ARQUIVO', preset: 'gaules' },
      marker: { text: 'DO MARKER' },
      env: { text: 'DO ENV', preset: 'polex' },
    });
    expect(merged.spec.text).toBe('DA CLI');
    expect(merged.source).toBe('cli');
  });

  it('o arquivo por clipe vence o marker e o .env', () => {
    const merged = mergeShortOverlaySources({
      file: { text: 'DO ARQUIVO' },
      marker: { text: 'DO MARKER' },
      env: { text: 'DO ENV' },
    });
    expect(merged.spec.text).toBe('DO ARQUIVO');
    expect(merged.source).toBe('file');
  });

  it('o marker vence o .env (o adesivo que já foi ao ar não volta ao padrão)', () => {
    const merged = mergeShortOverlaySources({
      marker: { text: 'DO MARKER', preset: 'polex-die' },
      env: { text: 'DO ENV', preset: 'polex' },
    });
    expect(merged.spec.text).toBe('DO MARKER');
    expect(merged.spec.preset).toBe('polex-die');
    expect(merged.source).toBe('marker');
  });

  it('sem marker/arquivo/flag, o .env manda', () => {
    const merged = mergeShortOverlaySources({
      env: { text: 'DO ENV', preset: 'gaules' },
    });
    expect(merged.spec.text).toBe('DO ENV');
    expect(merged.source).toBe('env');
  });

  it('o marker guarda o pedido: o visual explícito continua valendo', () => {
    const merged = mergeShortOverlaySources({
      marker: {
        text: 'DO MARKER',
        background: '#ff0000',
        borderPx: 4,
        uppercase: true,
        tag: 'POLEX',
      },
      env: { text: 'DO ENV', background: '#00ff00', borderPx: 0 },
    });
    expect(merged.spec.background).toBe('#ff0000');
    expect(merged.spec.borderPx).toBe(4);
    expect(merged.spec.uppercase).toBe(true);
    expect(merged.spec.tag).toBe('POLEX');
  });

  it('o preset do marker é um nome: o código resolve o visual atual', () => {
    const merged = mergeShortOverlaySources({
      marker: { preset: 'polex-die' },
      env: { preset: 'polex' },
    });
    expect(merged.spec.preset).toBe('polex-die');
  });

  it('o texto vazio do marker (sem adesivo) não sobrescreve o .env', () => {
    const merged = mergeShortOverlaySources({
      marker: { text: '', borderPx: 0, holdSec: 0, y: 0 },
      env: { text: 'auto' },
    });
    expect(merged.spec.text).toBe('auto');
    expect(merged.spec.borderPx).toBeUndefined();
    expect(merged.spec.holdSec).toBeUndefined();
    expect(merged.spec.y).toBeUndefined();
  });
});

describe('o que vai GRAVADO no marker do Short', () => {
  it('o que veio do .env NÃO é gravado (o .env continua valendo)', () => {
    const persisted = overlaySpecForMarker(
      mergeShortOverlaySources({
        env: { text: 'auto', preset: 'gaules', holdSec: 2, y: 0.54 },
      }),
    );
    expect(persisted).toEqual({});
  });

  it('o que veio do arquivo por clipe É gravado', () => {
    const persisted = overlaySpecForMarker(
      mergeShortOverlaySources({
        file: { text: 'YEKINDAR 4K NA DUST2', preset: 'polex-die' },
        env: { text: 'auto', holdSec: 2 },
      }),
    );
    expect(persisted.text).toBe('YEKINDAR 4K NA DUST2');
    expect(persisted.preset).toBe('polex-die');
    // O `holdSec` do .env não foi congelado.
    expect(persisted.holdSec).toBeUndefined();
  });

  it('o marker continua valendo (o adesivo que já foi ao ar não volta ao padrão)', () => {
    const persisted = overlaySpecForMarker(
      mergeShortOverlaySources({
        marker: { text: 'DO MARKER' },
        env: { text: 'auto' },
      }),
    );
    expect(persisted.text).toBe('DO MARKER');
  });

  it('a flag da CLI NÃO é gravada (é decisão de UMA rodada)', () => {
    const persisted = overlaySpecForMarker(
      mergeShortOverlaySources({
        cli: { text: 'DA CLI' },
        env: { text: 'auto' },
      }),
    );
    expect(persisted.text).toBeUndefined();
  });
});

describe('faixas dos valores do arquivo por clipe', () => {
  it('descarta número fora da faixa (não vira 0 nem quebra o SVG)', () => {
    const spec = normalizeShortOverlaySpec({
      borderPx: 9999,
      shadowPx: 9999,
      shadowBlurPx: 9999,
      tiltDeg: 90,
      holdSec: 100,
      fadeSec: 50,
      y: 3,
    });
    expect(spec.borderPx).toBeUndefined();
    expect(spec.shadowPx).toBeUndefined();
    expect(spec.shadowBlurPx).toBeUndefined();
    expect(spec.tiltDeg).toBeUndefined();
    expect(spec.holdSec).toBeUndefined();
    expect(spec.fadeSec).toBeUndefined();
    expect(spec.y).toBeUndefined();
  });

  it('aceita número dentro da faixa', () => {
    const spec = normalizeShortOverlaySpec({
      borderPx: 4,
      shadowPx: 2,
      shadowBlurPx: 6,
      tiltDeg: -5,
      holdSec: 2.5,
      fadeSec: 0.5,
      y: 0.4,
    });
    expect(spec.borderPx).toBe(4);
    expect(spec.shadowPx).toBe(2);
    expect(spec.shadowBlurPx).toBe(6);
    expect(spec.tiltDeg).toBe(-5);
    expect(spec.holdSec).toBe(2.5);
    expect(spec.fadeSec).toBe(0.5);
    expect(spec.y).toBe(0.4);
  });

  it('descarta cor fora do hex (o SVG não pode sair com fill inválido)', () => {
    const spec = normalizeShortOverlaySpec({
      color: 'vermelho',
      background: '#12345',
      borderColor: '#ff00ff',
    });
    expect(spec.color).toBeUndefined();
    expect(spec.background).toBeUndefined();
    expect(spec.borderColor).toBe('#ff00ff');
  });
});

describe('marker do adesivo (o que ele pode mandar)', () => {
  it('marker sem adesivo no vertical não manda nada', () => {
    // Marker legado: o `short.render` tem o texto VAZIO (não havia
    // adesivo) e o visual zerado pela assinatura.
    expect(
      markerOverlaySpec({
        render: { overlayText: '' },
        overlaySpec: { text: 'auto', holdSec: 0, y: 0 },
      }),
    ).toBeNull();
    expect(markerOverlaySpec(null)).toBeNull();
    expect(markerOverlaySpec({ render: null, overlaySpec: { text: 'auto' } })).toBeNull();
  });

  it('marker com adesivo devolve o spec PEDIDO (auto resolve de novo)', () => {
    const spec = markerOverlaySpec({
      render: { overlayText: 'ACE FalleN' },
      overlaySpec: { text: 'auto', preset: 'gaules' },
    });
    expect(spec).toEqual({ text: 'auto', preset: 'gaules' });
  });

  it('marker legado (sem spec) não congela o texto resolvido', () => {
    expect(
      markerOverlaySpec({
        render: { overlayText: 'ACE FalleN' },
        overlaySpec: null,
      }),
    ).toBeNull();
  });
});
