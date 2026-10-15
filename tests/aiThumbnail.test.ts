import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  aiBackgroundPrompt,
  buildAiBackground,
  buildAiThumbnail,
  buildThumbnailPrompt,
} from '../src/clipper/aiThumbnail.js';
import { buildSidecar } from '../src/clipper/clipBuilder.js';
import { makeSmartThumbnail } from '../src/clipper/thumbnail.js';

const ace = {
  matchId: 'm1',
  map: 'anubis',
  round: 9,
  player: 'donk',
  team1: 'Spirit',
  team2: 'Falcons',
  event: 'ESL Pro League Season 24',
  detectedAt: new Date().toISOString(),
  kills: [],
};

describe('aiThumbnail', () => {
  it('prompt segue o layout do canal (PT, 3 zonas, ACCENT)', () => {
    const p = aiBackgroundPrompt(ace);
    expect(p).toContain('16:9');
    expect(p).toContain('neon lime green (#B6FF00)');
    expect(p).toContain('LAYOUT (3 zonas)');
    expect(p).toContain('Sem marca d');
  });

  it('prompt carrega todos os dados do round', () => {
    const rich = {
      ...ace,
      map: 'Cache',
      score: '6-3',
      player: 'ZywOo',
      team1: 'Vitality',
      team2: 'Aurora',
      summary: {
        round: 10,
        map: 'Cache',
        player: 'ZywOo',
        team: 'Vitality',
        opponents: 'Aurora',
        kills: [1, 2, 3, 4, 5].map((i) => ({
          killer: 'ZywOo',
          victim: `v${i}`,
          round: 10,
          map: 'Cache',
          weapon: 'ak47',
          headshot: i <= 2 ? true : undefined,
        })),
        victims: ['XANTARES', 'woxic', 'Soulfly', 'Jimpphat', 'Wicadia'],
        weapons: ['ak47', 'ak47', 'ak47', 'ak47', 'awp'],
        headshots: 2,
        assists: [{ by: 'apEX', killIndex: 2 }],
        flashAssists: [],
        grenades: [{ player: 'ZywOo', kind: 'he' as const }],
        mainWeapon: 'ak47',
      },
    };
    const p = buildThumbnailPrompt(rich);
    expect(p).toContain('Cache');
    expect(p).toContain('AK-47');
    expect(p).toContain('XANTARES');
    expect(p).toContain('6-3');
    expect(p).toContain('ZywOo');
    expect(p).toContain('Vitality vs Aurora');
    expect(p).toContain('"ACE"');
    expect(p).toContain('"5K"');
    expect(p).toContain('1. "ZywOo" [AK-47 icon] [headshot skull icon] "v1"');
    expect(p).toContain('ESL Pro League Season 24');
  });

  it('oponente deriva do time do autor', () => {    const p = buildThumbnailPrompt({
      ...ace,
      team1: 'Spirit',
      team2: 'Falcons',
      summary: {
        round: 1,
        map: 'm',
        player: 'donk',
        team: 'Spirit',
        opponents: 'Falcons',
        kills: [],
        victims: [],
        weapons: [],
        headshots: 0,
        assists: [],
        flashAssists: [],
        grenades: [],
        mainWeapon: '',
      },
    });
    expect(p).toContain('"Spirit vs Falcons"');
    expect(p).not.toContain('Spirit vs Spirit');
  });

  it('rodapé sem summary usa o confronto direto (sem duplicar)', () => {
    const p = buildThumbnailPrompt({ ...ace, team1: 'Vitality', team2: 'Aurora' });
    expect(p).toContain('"Vitality vs Aurora"');
    expect(p).not.toContain('Vitality vs Vitality');
  });

  it('vítima desconhecida vira "?" no killfeed', () => {
    const p = buildThumbnailPrompt({
      ...ace,
      kills: [{ killer: 'donk', victim: '', round: 1, map: 'm', weapon: 'ak47' }],
    });
    expect(p).toContain('1. "donk" [AK-47 icon] "?"');
  });

  it('prompt lista referências com nomes específicos, na ordem dos anexos', () => {
    const p = buildThumbnailPrompt(ace, {
      player: './data/clips/refs/x/player.jpg',
      playerAlt: './data/clips/refs/x/player-alt.jpg',
      team1Logo: './data/clips/refs/x/t1.png',
      team2Logo: './data/clips/refs/x/t2.png',
      mapImage: './data/clips/refs/x/map.jpg',
    });
    expect(p).toContain('REFERÊNCIAS OBRIGATÓRIAS (as 5 imagens anexadas');
    expect(p).toContain('NESTA EXATA ORDEM');
    // nomes específicos de tudo
    expect(p).toContain(`Foto oficial do jogador "donk"`);
    expect(p).toContain(`Segunda foto do jogador "donk"`);
    expect(p).toContain('camisa do Spirit');
    expect(p).toContain('Logo do time Spirit');
    expect(p).toContain('Logo do time adversário Falcons');
    expect(p).toContain('Cenário do mapa anubis');
    // ordem = ordem dos anexos [player, playerAlt, t1, t2, map]
    const idx = [
      p.indexOf('Foto oficial do jogador'),
      p.indexOf('Segunda foto do jogador'),
      p.indexOf('Logo do time Spirit'),
      p.indexOf('Logo do time adversário'),
      p.indexOf('Cenário do mapa'),
    ];
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('numeração é dinâmica quando referência do meio falta', () => {
    const p = buildThumbnailPrompt(ace, {
      player: './refs/p.jpg',
      team2Logo: './refs/t2.png',
    });
    expect(p).toContain('1. Foto oficial do jogador');
    expect(p).toContain('2. Logo do time adversário');
    expect(p).not.toContain('3.');
    expect(p).toContain('(as 2 imagens anexadas');
  });

  it('label dinâmico: 3K em vez de ACE/5K para multikills', () => {
    const three = [1, 2, 3].map(() => ({ killer: 'x', victim: 'y', round: 1, map: 'm' }));
    const p = buildThumbnailPrompt({ ...ace, kills: three });
    expect(p).toContain('"3K"');
    expect(p).toContain('multikill de 3K');
    expect(p).not.toContain('"5K"');
    expect(p).not.toContain('ACE');
  });

  it('sem referências não cria seção REFERÊNCIAS', () => {
    expect(buildThumbnailPrompt(ace)).not.toContain('REFERÊNCIAS');
  });

  it('retorna null sem providers (fallback seguro, sem rede)', async () => {
    await expect(buildAiBackground(ace, { order: [] })).resolves.toBeNull();
  });

  it('provider com login expirado é PULADO sem abrir browser (rápido)', async () => {
    const os = await import('node:os');
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const { markLoggedOut } = await import('../src/clipper/providerStatus.js');
    const f = pathx.join(fsx.mkdtempSync(pathx.join(os.tmpdir(), 'pskip-')), 'status.json');
    try {
      expect(markLoggedOut('chatgpt', 'sem login', f)).toBe(true);
      const t0 = Date.now();
      // Sem o skip isto abriria o Chrome (perfil real) — com ele, null em ms.
      await expect(
        buildAiBackground(ace, { order: ['chatgpt'], statusFile: f }),
      ).resolves.toBeNull();
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      fsx.rmSync(pathx.dirname(f), { recursive: true, force: true });
    }
  });

  it('pula providers sem token sem fazer rede', async () => {
    // huggingface e gemini sem token: pula direto → null, nenhuma chamada HTTP
    await expect(
      buildAiBackground(ace, { order: ['huggingface', 'gemini'], timeoutMs: 1000 }),
    ).resolves.toBeNull();
  });

  it('ignora provider desconhecido sem quebrar', async () => {
    await expect(
      buildAiBackground(ace, { order: ['inexistente' as never], timeoutMs: 1000 }),
    ).resolves.toBeNull();
  });

  it('compõe híbrida 1280x720 com bg + frame falsos', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aithumb-'));
    const frame = path.join(dir, 'frame.jpg');
    const out = path.join(dir, 'out.jpg');
    await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .jpeg()
      .toFile(frame);
    const bg = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: { r: 120, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    await buildAiThumbnail(frame, out, ace, bg);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makeSmartThumbnail cai p/ composta quando IA falha', async () => {
    // modo ai sem providers configurados (order vazio) → buildAiBackground=null → fallback.
    // Usa vídeo inexistente de propósito: AMBOS os caminhos falham → deve lançar erro, não travar.
    await expect(
      makeSmartThumbnail('nao-existe.mp4', 'out.jpg', ace, 1, { mode: 'ai', ai: { order: [] } }),
    ).rejects.toThrow();
  });

  it('buildSidecar não duplica kills no summary', () => {
    const full = {
      ...ace,
      kills: [{ killer: 'a', victim: 'b', round: 1, map: 'm', weapon: 'ak47' }],
      summary: {
        round: 1,
        map: 'm',
        player: 'a',
        team: 'T',
        opponents: 'O',
        kills: [{ killer: 'a', victim: 'b', round: 1, map: 'm', weapon: 'ak47' }],
        victims: ['b'],
        weapons: ['ak47'],
        headshots: 0,
        assists: [],
        flashAssists: [],
        grenades: [],
        mainWeapon: 'ak47',
      },
    };
    const json = JSON.parse(JSON.stringify(buildSidecar(full))) as {
      kills: unknown[];
      summary: Record<string, unknown>;
    };
    expect(json.kills).toHaveLength(1);
    expect(json.summary.kills).toBeUndefined();
    expect(json.summary.killCount).toBe(1);
    expect(json.summary.mainWeapon).toBe('ak47');
  });
});
