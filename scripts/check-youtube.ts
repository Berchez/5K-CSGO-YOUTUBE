/**
 * Mostra EM QUAL CANAL os uploads vão cair com o token atual.
 * Fundamental quando a conta Google gerencia vários canais
 * (ex: conta-mãe berchez + canal cliponera como conta de marca).
 *
 * Uso: npx tsx scripts/check-youtube.ts
 * (rode `npm run auth:youtube` antes, logado com a conta berchez)
 */
import { google } from 'googleapis';
import { getConfig } from '../src/config.js';
import { loadOAuthClient } from '../src/uploader/youtubeUploader.js';

async function main(): Promise<void> {
  const cfg = getConfig();
  const auth = loadOAuthClient(cfg.YT_CLIENT_SECRETS, cfg.YT_TOKEN_PATH);
  const youtube = google.youtube({ version: 'v3', auth });
  const res = await youtube.channels.list({ mine: true, part: ['snippet'] });
  const ch = res.data.items?.[0];
  if (!ch) {
    console.log('Nenhum canal encontrado para este token. A conta autenticada não tem canal no YouTube.');
    return;
  }
  console.log(`CANAL-ID=${ch.id}`);
  console.log(`CANAL-NOME=${ch.snippet?.title}`);
  console.log(`(é neste canal que o videos.insert vai publicar como ${cfg.YT_PRIVACY})`);
}

main().catch((e) => {
  console.error('FALHOU: ' + String((e as Error).message).slice(0, 400));
  process.exit(1);
});
