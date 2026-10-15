import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WEB_LOGIN_PROVIDERS,
  clearLoggedOut,
  isLoginError,
  isProviderLoggedOut,
  loadLoggedOut,
  loginScriptFor,
  markLoggedOut,
} from '../src/clipper/providerStatus.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pstatus-')), 'status.json');
}

describe('providerStatus store (round-trip em arquivo)', () => {
  it('ausente = {}; marca com transição, reler, limpar', () => {
    const f = tmpFile();
    expect(loadLoggedOut(f)).toEqual({});
    expect(markLoggedOut('chatgpt', 'sem login', f)).toBe(true);
    expect(markLoggedOut('chatgpt', 'de novo', f)).toBe(false);
    const loaded = loadLoggedOut(f);
    expect(isProviderLoggedOut(loaded, 'chatgpt')).toBe(true);
    expect(loaded.chatgpt.reason).toBe('de novo');
    expect(loaded.chatgpt.at).toBeGreaterThan(0);
    expect(clearLoggedOut('chatgpt', f)).toBe(true);
    expect(clearLoggedOut('chatgpt', f)).toBe(false);
    expect(loadLoggedOut(f)).toEqual({});
  });

  it('corrompido = {} (nunca joga)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pstatus-'));
    const f = path.join(dir, 'status.json');
    fs.writeFileSync(f, '{{{ não é json');
    expect(loadLoggedOut(f)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('entradas inválidas são filtradas; múltiplos providers coexistem', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pstatus-'));
    const f = path.join(dir, 'status.json');
    fs.writeFileSync(f, JSON.stringify({
      chatgpt: { at: 1_700_000_000_000, reason: 'x' },
      ruim: { reason: 'sem at' },
      lixo: 42,
    }));
    const loaded = loadLoggedOut(f);
    expect(Object.keys(loaded)).toEqual(['chatgpt']);
    expect(isProviderLoggedOut(loaded, 'grok')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('escopo: só os providers web de login manual', () => {
    expect([...WEB_LOGIN_PROVIDERS].sort()).toEqual(['chatgpt', 'gemini-web', 'grok']);
    expect(loginScriptFor('chatgpt')).toContain('chatgpt-login.ts');
    expect(loginScriptFor('gemini-web')).toContain('gemini-login.ts');
    expect(loginScriptFor('desconhecido')).toBeUndefined();
  });
});

describe('isLoginError (classificação: login vs transitório)', () => {
  const NEED_CHATGPT =
    'ChatGPT sem login. Rode uma vez: npx tsx scripts/chatgpt-login.ts (abre o Chrome — use UMA CONTA DESCARTÁVEL, nunca contas importantes) e faça login manualmente.';
  const NEED_GROK = 'Grok sem login. Rode uma vez: npx tsx scripts/grok-login.ts e faça login manualmente.';
  const NEED_GEMINI =
    'Gemini web sem login. Rode uma vez: npx tsx scripts/gemini-login.ts e faça login manualmente.';

  it('mensagens reais dos 3 providers + URLs de auth = login', () => {
    expect(isLoginError(NEED_CHATGPT)).toBe(true);
    expect(isLoginError(NEED_GROK)).toBe(true);
    expect(isLoginError(NEED_GEMINI)).toBe(true);
    expect(isLoginError('redirect para auth.openai.com/authorize')).toBe(true);
    expect(isLoginError('página em accounts.google.com')).toBe(true);
    expect(isLoginError('Login expirado — rode o script')).toBe(true);
  });

  it('falhas transitórias NÃO são login (challenge, backend, layout, timeout)', () => {
    expect(
      isLoginError('ChatGPT bloqueado pelo desafio Cloudflare mesmo após tentativas. Tente de novo mais tarde.'),
    ).toBe(false);
    expect(
      isLoginError('upload de anexos falhou no ChatGPT (ref-player-x.jpg: pill não apareceu no composer (upload nem iniciou)) — abortando antes do envio'),
    ).toBe(false);
    expect(isLoginError('Estamos com problemas para processar uploads no momento. Tente novamente mais tarde.')).toBe(false);
    expect(isLoginError('composer do ChatGPT não encontrado (layout mudou?)')).toBe(false);
    expect(isLoginError('ChatGPT não retornou imagem a tempo — cota grátis esgotada, ou resposta em texto.')).toBe(false);
    expect(isLoginError('')).toBe(false);
  });
});
