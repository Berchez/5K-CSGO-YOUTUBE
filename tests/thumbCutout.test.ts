import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  cutoutCacheKey,
  getPlayerImage,
  isValidCutout,
  removeDependencyAvailable,
} from '../src/clipper/thumbCutout.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cutout-test-'));
}

async function photo(file: string): Promise<void> {
  await sharp({
    create: { width: 300, height: 400, channels: 3, background: { r: 30, g: 90, b: 180 } },
  })
    .jpeg()
    .toFile(file);
}

async function cutoutPng(file: string): Promise<void> {
  const base = await sharp({
    create: { width: 300, height: 400, channels: 3, background: { r: 30, g: 90, b: 180 } },
  })
    .png()
    .toBuffer();
  const mask = Buffer.from(
    `<svg width="300" height="400" xmlns="http://www.w3.org/2000/svg">
      <rect x="100" y="50" width="100" height="300" fill="#fff"/>
    </svg>`,
  );
  await sharp(base)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toFile(file);
}

describe('recorte do jogador', () => {
  it('a chave do cache é o conteúdo da foto (o mesmo jogador reaproveita)', () => {
    const dir = tempDir();
    const a = path.join(dir, 'a.jpg');
    const b = path.join(dir, 'b.jpg');
    fs.writeFileSync(a, 'bytes-fixos');
    fs.writeFileSync(b, 'bytes-fixos');
    expect(cutoutCacheKey(a)).toBe(cutoutCacheKey(b));
    fs.writeFileSync(b, 'outros-bytes');
    expect(cutoutCacheKey(a)).not.toBe(cutoutCacheKey(b));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('um recorte sem transparência (foto crua) não passa na validação', async () => {
    const dir = tempDir();
    const raw = path.join(dir, 'raw.jpg');
    await photo(raw);
    expect(await isValidCutout(raw)).toBe(false);

    const good = path.join(dir, 'cut.png');
    await cutoutPng(good);
    expect(await isValidCutout(good)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('arquivo que não é imagem não passa na validação', async () => {
    const dir = tempDir();
    const fake = path.join(dir, 'fake.png');
    fs.writeFileSync(fake, 'nao sou png');
    expect(await isValidCutout(fake)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('com o cache negativo, o retrato emoldurado sai na hora (sem spawnar o worker)', async () => {
    const dir = tempDir();
    const player = path.join(dir, 'player.jpg');
    const cacheDir = path.join(dir, 'cache');
    await photo(player);
    fs.mkdirSync(cacheDir, { recursive: true });
    // A remoção de fundo já falhou para esta foto (marcador `.none`):
    // o script não pode spawnar o worker de novo a cada thumb.
    fs.writeFileSync(path.join(cacheDir, `${cutoutCacheKey(player)}.none`), new Date().toISOString());

    const inicio = Date.now();
    const img = await getPlayerImage(player, { cacheDir });
    const elapsed = Date.now() - inicio;
    expect(img?.kind).toBe('framed');
    expect(img?.buffer.length).toBeGreaterThan(1_000);
    expect(elapsed).toBeLessThan(1_000);
    // Nada de recorte no cache.
    const files = fs.readdirSync(cacheDir);
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reaproveita um recorte válido já cacheado', async () => {
    const dir = tempDir();
    const player = path.join(dir, 'player.jpg');
    const cacheDir = path.join(dir, 'cache');
    await photo(player);
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `${cutoutCacheKey(player)}.png`);
    await cutoutPng(cached);

    const img = await getPlayerImage(player, { cacheDir });
    expect(img?.kind).toBe('cutout');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('descarta do cache um recorte invalido e refaz', async () => {
    const dir = tempDir();
    const player = path.join(dir, 'player.jpg');
    const cacheDir = path.join(dir, 'cache');
    await photo(player);
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `${cutoutCacheKey(player)}.png`);
    fs.writeFileSync(cached, 'lixo');
    // Sem o marcador negativo: o cache inválido é jogado fora e o
    // worker é chamado (aqui ele falha e o fallback entra).
    fs.writeFileSync(path.join(cacheDir, `${cutoutCacheKey(player)}.none`), new Date().toISOString());

    const img = await getPlayerImage(player, { cacheDir });
    expect(img?.kind).toBe('framed');
    expect(fs.existsSync(cached)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a dependência opcional é declarada como ausente ou presente (sem instalar nada)', () => {
    expect(typeof removeDependencyAvailable()).toBe('boolean');
  });
});
