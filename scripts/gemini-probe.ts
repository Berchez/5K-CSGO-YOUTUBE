/**
 * Teste isolado do fundo IA (sem baixar VOD, sem upload).
 * Gera com o 1º provider da ordem e salva em data/clips/ai-probe-<ts>.jpg.
 *
 * Uso:
 *   npx tsx scripts/gemini-probe.ts
 *   npx tsx scripts/gemini-probe.ts --order gemini-web
 *   THUMB_AI_ORDER=gemini-web npx tsx scripts/gemini-probe.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { buildAiBackground } from '../src/clipper/aiThumbnail.js';
import type { AiProvider } from '../src/clipper/aiThumbnail.js';
import type { AceEvent } from '../src/types.js';

const sample: AceEvent = {
  matchId: 'probe',
  map: 'Cache',
  round: 10,
  player: 'ZywOo',
  team1: 'Vitality',
  team2: 'Aurora',
  event: 'ESL Pro League Season 24',
  detectedAt: new Date().toISOString(),
  kills: [],
  score: '6-3',
};

async function main(): Promise<void> {
  const cfg = getConfig();
  const i = process.argv.indexOf('--order');
  let orderRaw: string;
  if (i >= 0) {
    // aceita "a,b", "a b" ou "a, b" (Powerwright/PSP agrega/splita diferente)
    const rest: string[] = [];
    for (let j = i + 1; j < process.argv.length; j++) {
      if (process.argv[j].startsWith('--')) break;
      rest.push(process.argv[j]);
    }
    orderRaw = rest.join(',');
  } else {
    orderRaw = cfg.THUMB_AI_ORDER;
  }
  const order = orderRaw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean) as AiProvider[];
  console.log(`Providers: ${order.join(' > ')}`);
  const result = await buildAiBackground(sample, {
    order,
    hfToken: cfg.HF_TOKEN || undefined,
    hfModel: cfg.HF_IMAGE_MODEL,
    geminiApiKey: cfg.GEMINI_API_KEY || undefined,
    geminiModel: cfg.GEMINI_IMAGE_MODEL,
    geminiWebProfileDir: cfg.GEMINI_WEB_PROFILE,
    chatgptProfileDir: cfg.CHATGPT_PROFILE,
    grokProfileDir: cfg.GROK_PROFILE,
    timeoutMs: cfg.THUMB_AI_TIMEOUT_MS,
  });
  if (!result) {
    console.log('FALHOU em todos os providers (fallback seria a composta). Veja logs acima.');
    process.exit(1);
  }
  const bg = result.image;
  fs.mkdirSync('./data/clips', { recursive: true });
  const out = path.join('./data/clips', `ai-probe-${Date.now()}.jpg`);
  if (result.provider === 'chatgpt' || result.provider === 'grok') {
    const sharp = (await import('sharp')).default;
    await sharp(bg).resize(1280, 720, { fit: 'cover' }).jpeg({ quality: 90 }).toFile(out);
  } else {
    fs.writeFileSync(out, bg);
  }
  console.log(`BG OK via ${result.provider} (${bg.length} bytes): ${out}`);
}

main().catch((e) => {
  console.error('FALHOU: ' + String((e as Error).message).slice(0, 300));
  process.exit(1);
});
