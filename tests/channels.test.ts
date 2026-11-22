import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANNEL_ID,
  channelEnvPrefix,
  channelFromArgv,
  channelIdOrDefault,
  isChannelId,
  normalizeChannelId,
} from '../src/channels.js';

describe('identidade de canal', () => {
  it('id válido: começa com letra e aceita números e _', () => {
    for (const id of ['br', 'en', 'canal_2', 'x']) {
      expect(isChannelId(id)).toBe(true);
    }
  });

  it('id inválido: vazio, começa com número, símbolo, maiúsculas ou espaço', () => {
    for (const id of ['', '2br', 'br!', 'br en', 'br/en', ' EN ', 'EN', null, undefined, 42]) {
      expect(isChannelId(id)).toBe(false);
    }
  });

  it('id com hífen é inválido (o prefixo viraria env inválida)', () => {
    // `PT-BR_` não é nome de variável válido no shell/pm2.
    expect(isChannelId('pt-br')).toBe(false);
  });

  it('normaliza para trim + minúsculo', () => {
    expect(normalizeChannelId(' EN ')).toBe('en');
    expect(normalizeChannelId(undefined)).toBe('');
  });

  it('dado ausente cai no default br', () => {
    expect(channelIdOrDefault(undefined)).toBe(DEFAULT_CHANNEL_ID);
    expect(channelIdOrDefault(null)).toBe(DEFAULT_CHANNEL_ID);
    expect(channelIdOrDefault('')).toBe(DEFAULT_CHANNEL_ID);
    expect(channelIdOrDefault(' EN ')).toBe('en');
  });

  it('dado presente e INVÁLIDO é erro (não vira br em silêncio)', () => {
    expect(() => channelIdOrDefault('???')).toThrow(/channelId inválido/);
    expect(() => channelIdOrDefault('pt-br')).toThrow(/channelId inválido/);
  });

  it('prefixo das envs é o id em maiúsculo', () => {
    expect(channelEnvPrefix('en')).toBe('EN_');
    expect(channelEnvPrefix('canal_2')).toBe('CANAL_2_');
  });
});

describe('--channel da linha de comando', () => {
  it('sem a flag usa o default (br)', () => {
    expect(channelFromArgv([])).toBe(DEFAULT_CHANNEL_ID);
    expect(channelFromArgv(['--apply'])).toBe(DEFAULT_CHANNEL_ID);
  });

  it('aceita --channel en e --channel=en (normaliza)', () => {
    expect(channelFromArgv(['--channel', 'en'])).toBe('en');
    expect(channelFromArgv(['--channel=EN'])).toBe('en');
    expect(channelFromArgv(['--apply', '--channel', 'en'])).toBe('en');
  });

  it('flag sem valor ou id inválido falha alto', () => {
    expect(() => channelFromArgv(['--channel'])).toThrow(/--channel inválido/);
    expect(() => channelFromArgv(['--channel='])).toThrow(/--channel inválido/);
    expect(() => channelFromArgv(['--channel', 'EN!'])).toThrow(/--channel inválido/);
    expect(() => channelFromArgv(['--channel', 'pt-br'])).toThrow(/--channel inválido/);
  });
});
