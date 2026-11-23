/**
 * Auth do YouTube por canal.
 *
 * Uso:
 *   npx tsx scripts/auth-youtube.ts                # canal default (BR)
 *   npx tsx scripts/auth-youtube.ts --channel en   # canal EN
 *   npx tsx scripts/auth-youtube.ts --channel en --force  # sobrescreve o token
 *
 *proteções:
 * - canal fora de `CHANNELS` → recusa (config de canal inexistente é
 *   herança silenciosa do BR);
 * - canal sem chaves ISOLADAS (token/secrets próprios) → recusa: sem
 *   `EN_YT_TOKEN_PATH`, o auth gravaria por cima do token do BR;
 * - token já existente → recusa sem `--force` (não sobrescreve o token
 *   do outro canal por acidente).
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { DEFAULT_CHANNEL_ID, channelFromArgv } from '../src/channels.js';
import { channelIsolationErrors, getChannelConfig } from '../src/config.js';
import { getAuthUrl, saveTokenFromCode } from '../src/uploader/youtubeUploader.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const channelId = channelFromArgv(argv);
  const force = argv.includes('--force');

  const isolation = channelIsolationErrors(channelId);
  if (isolation.length > 0) {
    console.error(`Canal "${channelId}" não está isolado do BR — auth recusado:`);
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

  if (fs.existsSync(cfg.YT_TOKEN_PATH) && !force) {
    console.error(`Token já existe: ${cfg.YT_TOKEN_PATH}`);
    console.error('Para sobrescrever: npx tsx scripts/auth-youtube.ts --force (ou adicione --force ao comando).');
    process.exit(1);
  }

  console.log(`Canal: ${channelId}`);
  console.log(`Token: ${cfg.YT_TOKEN_PATH}`);
  console.log('1) Abra esta URL no navegador e autorize:');
  console.log(getAuthUrl(cfg.YT_CLIENT_SECRETS));
  console.log('');
  if (channelId === DEFAULT_CHANNEL_ID) {
    console.log('ATENÇÃO na tela do Google:');
    console.log('  a) escolha a conta-mãe (berchez);');
    console.log('  b) se aparecer a escolha de CANAL, selecione cliponera (não berchez);');
    console.log('     o token fica amarrado ao canal escolhido.');
  } else {
    console.log(`ATENÇÃO na tela do Google: escolha a conta/canal do canal "${channelId}".`);
    console.log('O token fica amarrado ao canal escolhido.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise<string>((resolve) =>
    rl.question('\n2) Cole o código aqui: ', (a) => {
      rl.close();
      resolve(a);
    }),
  );
  await saveTokenFromCode(cfg.YT_CLIENT_SECRETS, cfg.YT_TOKEN_PATH, code);
  console.log(`\nOK! Token salvo em ${cfg.YT_TOKEN_PATH}. Agora rode: npm run dev`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
