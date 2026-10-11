import readline from 'node:readline';
import { getConfig } from '../src/config.js';
import { getAuthUrl, saveTokenFromCode } from '../src/uploader/youtubeUploader.js';

async function main(): Promise<void> {
  const cfg = getConfig();
  console.log('1) Abra esta URL no navegador e autorize:');
  console.log(getAuthUrl(cfg.YT_CLIENT_SECRETS));
  console.log('');
  console.log('ATENÇÃO na tela do Google:');
  console.log('  a) escolha a conta-mãe (berchez);');
  console.log('  b) se aparecer a escolha de CANAL, selecione cliponera (não berchez);');
  console.log('     o token fica amarrado ao canal escolhido.');
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
