/**
 * Login manual único para o provider chatgpt.
 *
 * Abre o Chrome (perfil persistente em ./data/chatgpt-profile) e espera você
 * fazer login MANUALMENTE. Use UMA CONTA DESCARTÁVEL — automatizar a UI do
 * ChatGPT viola os Termos da OpenAI e a conta pode ser suspensa.
 *
 * Uso: npx tsx scripts/chatgpt-login.ts
 */
import readline from 'node:readline';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const profileDir = process.env.CHATGPT_PROFILE ?? cfg.CHATGPT_PROFILE;

async function main(): Promise<void> {
  const { launchStealthContext } = await import('../src/clipper/stealthBrowser.js');
  const browser = await launchStealthContext({ profileDir, headless: false });
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  console.log('1) No Chrome aberto, faça login com a conta DESCARTÁVEL.');
  const { trySolveChallenge } = await import('../src/clipper/stealthBrowser.js');
  const { getLogger } = await import('../src/logger.js');
  await trySolveChallenge(page, getLogger(), 2);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) =>
    rl.question(
      '2) Se ainda houver checkbox "não sou um robô", CLIQUE nele 1x e aguarde liberar.\n3) Peça 1 imagem de teste para confirmar a cota grátis.\n\nPressione ENTER aqui quando terminar (sessão + cookie de liberação salvos): ',
      () => {
        rl.close();
        resolve();
      },
    ),
  );
  await browser.close();
  console.log(`OK! Sessão salva em ${profileDir} (NUNCA commite — está no .gitignore).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
