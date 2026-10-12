/**
 * Login manual único para o provider gemini-web.
 *
 * Abre o Chrome (perfil persistente em ./data/gemini-profile) e espera você
 * fazer login MANUALMENTE. Use UMA CONTA GOOGLE DESCARTÁVEL — nunca a conta
 * dona do canal/projeto Cloud (automação de UI viola os Termos do Google e
 * pode suspender a conta).
 *
 * Uso: npx tsx scripts/gemini-login.ts
 */
import readline from 'node:readline';
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const profileDir = process.env.GEMINI_WEB_PROFILE ?? './data/gemini-profile';

async function main(): Promise<void> {
  const { launchStealthContext } = await import('../src/clipper/stealthBrowser.js');
  const browser = await launchStealthContext({ profileDir, headless: false });
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  console.log('1) No Chrome aberto, faça login com a conta DESCARTÁVEL.');
  const { trySolveChallenge } = await import('../src/clipper/stealthBrowser.js');
  const { getLogger } = await import('../src/logger.js');
  await trySolveChallenge(page, getLogger(), 2);
  console.log('1) No Chrome aberto, faça login com a conta DESCARTÁVEL.');
  console.log('2) Gere uma imagem de teste para confirmar a cota grátis.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) =>
    rl.question('\nPressione ENTER aqui quando terminar (sessão será salva): ', () => {
      rl.close();
      resolve();
    }),
  );
  await browser.close();
  console.log(`OK! Sessão salva em ${profileDir} (NUNCA commite — está no .gitignore).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
