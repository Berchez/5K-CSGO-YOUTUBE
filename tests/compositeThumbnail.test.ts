import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { AceEvent, RoundSummary } from '../src/types.js';
import {
  buildCompositeThumbnail,
  compositeLayout,
  compositeOverlaySvg,
  fitKillfeedRow,
} from '../src/clipper/compositeThumbnail.js';
import { cutoutCacheKey } from '../src/clipper/thumbCutout.js';

const ace: AceEvent = {
  matchId: 'm1',
  map: 'Inferno',
  round: 16,
  player: 'KSCERATO',
  team1: 'The MongolZ',
  team2: 'FURIA',
  event: 'IEM Beijing 2026',
  detectedAt: '2026-11-04T10:11:31.766Z',
  score: '6-9',
  kills: [
    { killer: 'KSCERATO', victim: 'bLitz', round: 16, map: 'Inferno', weapon: 'ak47' },
    { killer: 'KSCERATO', victim: 'nin9', round: 16, map: 'Inferno', weapon: 'ak47', headshot: true },
    { killer: 'KSCERATO', victim: '910', round: 16, map: 'Inferno', weapon: 'm4a1-s' },
    { killer: 'KSCERATO', victim: 'cobrazera', round: 16, map: 'Inferno', weapon: 'ak47' },
  ],
  summary: {
    round: 16,
    map: 'Inferno',
    player: 'KSCERATO',
    team: 'The MongolZ',
    opponents: 'FURIA',
    kills: [
      { killer: 'KSCERATO', victim: 'bLitz', round: 16, map: 'Inferno', weapon: 'ak47' },
      { killer: 'KSCERATO', victim: 'nin9', round: 16, map: 'Inferno', weapon: 'ak47', headshot: true },
      { killer: 'KSCERATO', victim: '910', round: 16, map: 'Inferno', weapon: 'm4a1-s' },
      { killer: 'KSCERATO', victim: 'cobrazera', round: 16, map: 'Inferno', weapon: 'ak47' },
    ],
    victims: ['bLitz', 'nin9', '910', 'cobrazera'],
    weapons: ['ak47', 'ak47', 'm4a1-s', 'ak47'],
    headshots: 1,
    assists: [],
    flashAssists: [],
    grenades: [],
    mainWeapon: 'ak47',
  },
};

async function makeBackground(): Promise<Buffer> {
  return sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 12, g: 12, b: 14 } },
  })
    .png()
    .toBuffer();
}

describe('compositeLayout (layout puro, sem I/O)', () => {
  it('4K: label "4K", sem subLabel, 4 linhas de killfeed', async () => {
    const layout = compositeLayout(ace);
    expect(layout.label).toBe('4K');
    expect(layout.subLabel).toBe('');
    expect(layout.kills).toHaveLength(4);
    expect(layout.playerName).toBe('KSCERATO');
    expect(layout.footer).toBe('The MongolZ vs FURIA');
  });

  it('ACE (>=5 kills): subLabel "5K"', async () => {
    const five = [1, 2, 3, 4, 5].map((i) => ({ killer: 'x', victim: `v${i}`, round: 1, map: 'm' }));
    const layout = compositeLayout({
      ...ace,
      kills: five,
      summary: { ...(ace.summary as RoundSummary), kills: five },
    });
    expect(layout.label).toBe('ACE');
    expect(layout.subLabel).toBe('5K');
    expect(layout.kills).toHaveLength(5);
  });

  it('todas as caixas ficam dentro do canvas 1280x720', () => {
    const layout = compositeLayout(ace);
    const boxes = [
      layout.logoBox,
      layout.eventBox,
      layout.nameBox,
      layout.playerBox,
      layout.labelBox,
      layout.killfeedBox,
      layout.mapBox,
      layout.footerBox,
    ];
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(layout.width);
      expect(b.top + b.height).toBeLessThanOrEqual(layout.height);
    }
    // Label à esquerda do killfeed (sem sobreposição das zonas).
    expect(layout.labelBox.left + layout.labelBox.width).toBeLessThanOrEqual(layout.killfeedBox.left);
  });

  it('com summary.time: rodapé é o confronto do time do autor', () => {
    const layout = compositeLayout(ace);
    expect(layout.footer).toBe('The MongolZ vs FURIA');
    expect(layout.playerTeam).toBe('The MongolZ');
    expect(layout.opponent).toBe('FURIA');
  });

  it('sem summary.team: rodapé é o confronto direto (sem duplicar)', () => {
    const layout = compositeLayout({
      ...ace,
      summary: { ...(ace.summary as RoundSummary), team: '' },
    });
    expect(layout.footer).toBe('The MongolZ vs FURIA');
    expect(layout.footer).not.toBe('The MongolZ vs The MongolZ');
  });

  it('sem summary.team: o time do jogador fica DESCONHECIDO', () => {
    // No ao vivo o `team1` do card não é necessariamente o time do
    // jogador: assumircia metade das vezes e mostraria o logo errado.
    const layout = compositeLayout({
      ...ace,
      summary: { ...(ace.summary as RoundSummary), team: '' },
    });
    expect(layout.playerTeamKnown).toBe(false);
  });

  it('com summary.team: o time do jogador é conhecido', () => {
    expect(compositeLayout(ace).playerTeamKnown).toBe(true);
  });

  it('summary.team = team2: o nome do rodapé fica com o logo do MESMO time', () => {
    const layout = compositeLayout({
      ...ace,
      summary: { ...(ace.summary as RoundSummary), team: 'FURIA' },
    });
    // Esquerda: o time do jogador (FURIA) com o logo do time 2.
    expect(layout.footerLeft).toEqual({ name: 'FURIA', logoSlot: 2 });
    // Direita: o adversário (The MongolZ) com o logo do time 1.
    expect(layout.footerRight).toEqual({ name: 'The MongolZ', logoSlot: 1 });
    expect(layout.opponent).toBe('The MongolZ');
    expect(layout.playerTeamKnown).toBe(true);
  });

  it('summary.team = team1: o nome do rodapé fica com o logo do MESMO time', () => {
    const layout = compositeLayout(ace);
    expect(layout.footerLeft).toEqual({ name: 'The MongolZ', logoSlot: 1 });
    expect(layout.footerRight).toEqual({ name: 'FURIA', logoSlot: 2 });
  });

  it('summary.team com outra grafia: o time do jogador fica desconhecido (não adivinha)', () => {
    const layout = compositeLayout({
      ...ace,
      summary: { ...(ace.summary as RoundSummary), team: 'Furia Esports' },
    });
    expect(layout.playerTeamKnown).toBe(false);
    // Sem time conhecido, o rodapé é o confronto do card.
    expect(layout.footerLeft).toEqual({ name: 'The MongolZ', logoSlot: 1 });
    expect(layout.footerRight).toEqual({ name: 'FURIA', logoSlot: 2 });
  });

  it('o rodapé do SVG usa o nome do time do logo ao lado', () => {
    const layout = compositeLayout({
      ...ace,
      summary: { ...(ace.summary as RoundSummary), team: 'FURIA' },
    });
    // O texto do rodapé é desenhado em PATH (fonte do repo), então o SVG
    // não traz o nome legível: o que garante o par é o layout.
    expect(layout.footerRight.name).toBe('The MongolZ');
    const svg = compositeOverlaySvg(layout, { hasMap: false, playerFramed: false }).toString('utf8');
    expect(svg).toContain('<svg');
  });
});

describe('fitKillfeedRow (a linha cabe na caixa do killfeed)', () => {
  const budget = 372 - 18 - 12;

  it('nome normal não muda de tamanho', () => {
    const fit = fitKillfeedRow(
      { killer: 'molodoy', weapon: 'AK-47', headshot: false, victim: 'bLitz' },
      budget,
    );
    expect(fit.killerSize).toBe(28);
    expect(fit.victimSize).toBe(28);
  });

  it('nome longo: a fonte encolhe e o texto é cortado', () => {
    const fit = fitKillfeedRow(
      {
        killer: 'VeryLongPlayerNameHere',
        weapon: 'AK-47-SILENCER',
        headshot: true,
        victim: 'SuperLongVictimName',
      },
      budget,
    );
    expect(fit.width).toBeLessThanOrEqual(budget);
    expect(fit.killerSize).toBeLessThan(28);
  });
});

describe('compositeOverlaySvg (textos em path, nunca <text>)', () => {
  it('nome do jogador, label grande e killfeed são <path> com as cores de acento', () => {
    const layout = compositeLayout(ace);
    const svg = compositeOverlaySvg(layout, { hasMap: true, playerFramed: false }).toString('utf8');
    // Muitos paths (nome, label, 4x kill, 4x victim, sublabel quando ACE, etc.)
    const pathCount = (svg.match(/<path d=/g) ?? []).length;
    expect(pathCount).toBeGreaterThan(5);
    // Cores de acento presentes.
    expect(svg).toContain('fill="#B6FF00"');
    expect(svg).toContain('fill="#5AA9E6"');
    // Sem <text> (tudo virou path da fonte versionada).
    expect(svg.match(/<text\b/)).toBeNull();
  });

  it('sem mapa: não desenha painel do mapa', () => {
    const layout = compositeLayout(ace);
    const svg = compositeOverlaySvg(layout, { hasMap: false, playerFramed: false }).toString('utf8');
    // O painel do mapa só aparece com hasMap; a ausência não quebra nada.
    expect(svg.includes('<path d=')).toBe(true);
  });
});

describe('buildCompositeThumbnail (montagem sharp)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composite-thumb-'));
  const out = path.join(dir, 'out.jpg');

  it('gera 1280x720 sem retrato do jogador (player indefinido)', async () => {
    await buildCompositeThumbnail({ ace, background: await makeBackground(), outPath: out });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(meta.format).toBe('jpeg');
  });

  it('gera 1280x720 com retrato do jogador (recorte ou moldura de fallback)', async () => {
    const out2 = path.join(dir, 'out2.jpg');
    // A foto do jogador é um FIXTURE SINTÉTICO: o caminho real
    // (`data/clips/refs/...`) é gitignored — no CI o arquivo não existe e
    // o caso "com retrato" testava o caminho SEM retrato sem falar nada.
    const playerRef = path.join(dir, 'player.jpg');
    await sharp({
      create: { width: 300, height: 400, channels: 3, background: { r: 90, g: 120, b: 160 } },
    })
      .jpeg()
      .toFile(playerRef);
    // O recorte (ONNX) fica fora do teste: o cache do cutout é semeado
    // com o recorte pronto (o teste não baixa modelo nem roda o native).
    // O recorte semeado tem fundo TRANSPARENTE de verdade: um PNG
    // todo opaco não é um recorte (o validador descarta e refaz).
    const cutoutDir = path.join(dir, 'cutouts');
    fs.mkdirSync(cutoutDir, { recursive: true });
    const base = await sharp({
      create: { width: 300, height: 400, channels: 3, background: { r: 90, g: 120, b: 160 } },
    })
      .png()
      .toBuffer();
    const mask = Buffer.from(
      `<svg width="300" height="400" xmlns="http://www.w3.org/2000/svg">
        <rect x="90" y="40" width="120" height="320" fill="#fff"/>
      </svg>`,
    );
    const cutout = await sharp(base)
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(cutoutDir, `${cutoutCacheKey(playerRef)}.png`), cutout);
    await buildCompositeThumbnail({
      ace,
      background: await makeBackground(),
      refs: { player: playerRef },
      outPath: out2,
      cutoutCacheDir: cutoutDir,
    });
    const meta = await sharp(out2).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(meta.format).toBe('jpeg');
    // O retrato PRECISA ter entrado: a área do player muda em relação à
    // thumb sem retrato (aqui ela seria só o fundo).
    const area = { left: 196, top: 100, width: 480, height: 400 };
    const sem = await sharp(out).extract(area).stats();
    const com = await sharp(out2).extract(area).stats();
    expect(com.channels[0].mean).not.toBeCloseTo(sem.channels[0].mean, 1);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
