/**
 * Demo da thumb COMPOSTA (montagem local com sharp).
 *
 * Não chama nenhum provider: usa as referências do match e um frame do
 * próprio clipe como fundo, para ver o layout (retrato, logos, mapa,
 * killfeed e textos em path) sem gastar cota de IA.
 *
 * Uso:
 *   npx tsx scripts/thumb-composite-demo.ts [--clip <sidecar.json>] [--out <arquivo.jpg>]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AceEvent } from '../src/types.js';
import { buildCompositeThumbnail, compositeLayout } from '../src/clipper/compositeThumbnail.js';
import { extractFrame } from '../src/clipper/thumbnail.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return def;
}

/**
 * Clipe mais recente gravado (o demo não fixa um caminho: o clipe fixo
 * sumia do disco e o demo deixava de rodar).
 */
function newestClipSidecar(clipsDir = './data/clips'): string | null {
  let best: { file: string; at: number } | null = null;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(clipsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'refs') continue;
    const dir = path.join(clipsDir, entry.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      let at = 0;
      try {
        at = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (!best || at > best.at) best = { file: full, at };
    }
  }
  return best?.file ?? null;
}

async function main(): Promise<void> {
  const clipPath = arg('clip') ?? newestClipSidecar();
  if (!clipPath) {
    console.error(
      'nenhum clipe gravado encontrado em ./data/clips — grave um clipe ou passe --clip <sidecar.json>',
    );
    process.exit(1);
  }
  const outPath = arg('out', './data/clips/_demo/composite.jpg')!;
  if (!fs.existsSync(clipPath)) {
    console.error(`clipe não encontrado: ${clipPath}`);
    process.exit(1);
  }
  const ace = JSON.parse(fs.readFileSync(clipPath, 'utf-8')) as AceEvent;
  const refsDir = path.join('./data/clips/refs', ace.matchId);
  const refs = {
    player: path.join(refsDir, `ref-player-${ace.player}.jpg`),
    playerAlt: path.join(refsDir, `ref-player-alt-${ace.player}.jpg`),
    team1Logo: path.join(refsDir, 'ref-team1Logo.png'),
    team2Logo: path.join(refsDir, 'ref-team2Logo.png'),
    mapImage: path.join(refsDir, `ref-map-${ace.map}.jpg`),
  };

  // Fundo: frame real do clipe (sem IA). Cai para um fundo escuro.
  let background: Buffer;
  const video = path.join(path.dirname(clipPath), `${path.basename(clipPath, '.json')}.mp4`);
  if (fs.existsSync(video)) {
    let frame = '';
    try {
      frame = await extractFrame(video, 2);
      background = await sharp(frame).resize(1280, 720, { fit: 'cover' }).png().toBuffer();
    } catch (e) {
      console.error(`frame não saiu (${String(e).slice(0, 120)}) — usando fundo escuro`);
      background = await sharp({
        create: { width: 1280, height: 720, channels: 3, background: { r: 12, g: 12, b: 14 } },
      })
        .png()
        .toBuffer();
    } finally {
      if (frame) fs.rmSync(frame, { force: true });
    }
  } else {
    background = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: { r: 12, g: 12, b: 14 } },
    })
      .png()
      .toBuffer();
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await buildCompositeThumbnail({ ace, background, refs, outPath });

  const layout = compositeLayout(ace);
  console.log(`thumb composta: ${outPath}`);
  console.log(
    `label=${layout.label}${layout.subLabel ? `+${layout.subLabel}` : ''} | kills=${layout.kills.length} | rodapé="${layout.footer}"`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
