/**
 * Mostra EM QUAL CANAL os uploads vão cair com o token atual.
 * Fundamental quando a conta Google gerencia vários canais
 * (ex: conta-mãe berchez + canal cliponera como conta de marca).
 *
 * Uso: npx tsx scripts/check-youtube.ts [--channel en]
 * (rode `npm run auth:youtube` antes, logado com a conta berchez)
 */
import { google } from 'googleapis';
import { channelFromArgv } from '../src/channels.js';
import { channelIsolationErrors, getChannelConfig } from '../src/config.js';
import { loadOAuthClient } from '../src/uploader/youtubeUploader.js';

async function main(): Promise<void> {
  const channelId = channelFromArgv(process.argv.slice(2));
  // Canal sem chaves isoladas mostraria o canal do BR com o rótulo "en" —
  // e a cota/token do BR valendo por engano.
  const isolation = channelIsolationErrors(channelId);
  if (isolation.length > 0) {
    console.error(`Canal "${channelId}" não está isolado do BR — check recusado:`);
    for (const err of isolation) console.error(`  - ${err}`);
    process.exit(1);
  }
  let cfg: ReturnType<typeof getChannelConfig>;
  try {
    cfg = getChannelConfig(channelId);
  } catch (e) {
    console.error(`Canal "${channelId}" indisponível: ${String(e).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`Canal: ${channelId}`);
  console.log(`Token: ${cfg.YT_TOKEN_PATH}`);
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
