import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  defaultWatchlistDoc,
  loadWatchlistFile,
  normalizeName,
  resolveMatchRule,
  resolvePlayerRule,
  validateWatchlistDoc,
  WATCHLIST_MISSING_GRACE_MS,
} from '../src/watchlist.js';

const tmpDirs: string[] = [];

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function validDoc(input: unknown) {
  const result = validateWatchlistDoc(input);
  expect(result.ok).toBe(true);
  expect(result.value).toBeDefined();
  return result.value!;
}

describe('normalizeName', () => {
  it('ignora caixa, acentos e espaços extras', () => {
    expect(normalizeName('  FÚRIA   Esports ')).toBe('furia esports');
    expect(normalizeName('paiN Gaming')).toBe('pain gaming');
    expect(normalizeName('Legacy')).toBe('legacy');
  });
});

describe('validateWatchlistDoc', () => {
  it('preenche defaults em documento mínimo', () => {
    const doc = validDoc({ teams: [{ names: ['FURIA'] }] });
    expect(doc.enabled).toBe(true);
    expect(doc.defaults).toEqual({ minKills: 4, clutch: false });
    expect(doc.teams[0].enabled).toBe(true);
    expect(doc.teams[0].names).toEqual(['FURIA']);
    expect(doc.players).toEqual([]);
  });

  it('aceita o exemplo com limiar por time (Imperial 5, Legacy 4, Fúria 3)', () => {
    const doc = validDoc({
      enabled: true,
      defaults: { minKills: 4 },
      teams: [
        { names: ['FURIA', 'FURIA Esports'], minKills: 3 },
        { names: ['Legacy'], minKills: 4 },
        { names: ['Imperial', 'Imperial Esports'], minKills: 5 },
        { names: ['paiN', 'paiN Gaming'], minKills: 3 },
      ],
    });
    expect(doc.teams).toHaveLength(4);
    expect(doc.teams[0].minKills).toBe(3);
    expect(doc.teams[2].minKills).toBe(5);
  });

  it('rejeita mínimo fora de 2..5 e nomes vazios', () => {
    const badMin = validateWatchlistDoc({ teams: [{ names: ['X'], minKills: 6 }] });
    expect(badMin.ok).toBe(false);
    expect(badMin.errors.join(' ')).toContain('minKills');
    const empty = validateWatchlistDoc({ teams: [{ names: [] }] });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(' ')).toContain('nome');
  });

  it('rejeita alias duplicado entre times (ambíguo)', () => {
    const result = validateWatchlistDoc({
      teams: [{ names: ['FURIA'] }, { names: ['fúria'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('mais de uma vez');
  });

  it('rejeita booleano inválido e documento que não é objeto', () => {
    const badBool = validateWatchlistDoc({ enabled: 'sim' });
    expect(badBool.ok).toBe(false);
    expect(badBool.errors.join(' ')).toContain('true');
    expect(validateWatchlistDoc(null).ok).toBe(false);
    expect(validateWatchlistDoc([]).ok).toBe(false);
  });

  it('ignora campos desconhecidos e normaliza espaços', () => {
    const doc = validDoc({
      foo: 'bar',
      teams: [{ names: ['  FURIA  ', 'FURIA'], qualquer: true }],
    });
    expect(doc.teams[0].names).toEqual(['FURIA']);
  });

  it('aceita jogadores com limiar próprio', () => {
    const doc = validDoc({
      teams: [{ names: ['FURIA'] }],
      players: [{ names: ['KSCERATO'], minKills: 3, clutch: true }],
    });
    expect(doc.players[0].minKills).toBe(3);
    expect(doc.players[0].clutch).toBe(true);
  });
});

describe('resolveMatchRule', () => {
  const doc = validDoc({
    defaults: { minKills: 4, clutch: false },
    teams: [
      { names: ['FURIA', 'FURIA Esports'], minKills: 3 },
      { names: ['Legacy'], minKills: 4 },
      { names: ['Imperial', 'Imperial Esports'], minKills: 5 },
      { names: ['paiN', 'paiN Gaming'], minKills: 3, enabled: false },
    ],
  });

  it('time na lista grava e usa o limiar do time (0 estrelas tanto faz)', () => {
    const rule = resolveMatchRule(doc, ['Fúria', 'MIBR'], 5);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(3);
    expect(rule.matchedTeams).toEqual(['FURIA']);
  });

  it('dois times na lista usam o menor limiar', () => {
    const rule = resolveMatchRule(doc, ['FURIA', 'Legacy'], 5);
    expect(rule.minKills).toBe(3);
    expect(rule.matchedTeams).toEqual(['FURIA', 'Legacy']);
  });

  it('Imperial entra na gravação mas só ace (5)', () => {
    const rule = resolveMatchRule(doc, ['Imperial'], 5);
    expect(rule.watchlisted).toBe(true);
    expect(rule.minKills).toBe(5);
  });

  it('time desabilitado e partida sem time da lista caem na regra por estrelas', () => {
    expect(resolveMatchRule(doc, ['paiN'], 5)).toMatchObject({
      watchlisted: false,
      minKills: 5,
    });
    expect(resolveMatchRule(doc, ['MIBR', 'NIP'], 4)).toMatchObject({
      watchlisted: false,
      minKills: 4,
    });
    expect(resolveMatchRule(doc, ['TBD', 'TBD'], 5).watchlisted).toBe(false);
  });

  it('watchlist desligada inteira desliga o override', () => {
    const off = { ...doc, enabled: false };
    expect(resolveMatchRule(off, ['FURIA'], 5)).toMatchObject({
      watchlisted: false,
      minKills: 5,
    });
    expect(resolveMatchRule(null, ['FURIA'], 5).watchlisted).toBe(false);
  });

  it('clutch: regra do time vence o default e OR entre times', () => {
    const clutchDoc = validDoc({
      defaults: { clutch: true },
      teams: [{ names: ['FURIA'], clutch: false }, { names: ['Legacy'], clutch: true }],
    });
    expect(resolveMatchRule(clutchDoc, ['FURIA'], 4).clutch).toBe(false);
    expect(resolveMatchRule(clutchDoc, ['Legacy'], 4).clutch).toBe(true);
    expect(resolveMatchRule(clutchDoc, ['FURIA', 'Legacy'], 4).clutch).toBe(true);
    expect(resolveMatchRule(clutchDoc, ['MIBR'], 4).clutch).toBe(false);
  });
});

describe('resolvePlayerRule', () => {
  const doc = validDoc({
    defaults: { minKills: 4 },
    teams: [{ names: ['FURIA'], minKills: 3 }],
    players: [
      { names: ['KSCERATO'], minKills: 3 },
      { names: ['FalleN'], minKills: 5, clutch: true },
    ],
  });

  it('jogador sobrescreve o limiar do time e do default', () => {
    expect(resolvePlayerRule(doc, 'kscerato')?.minKills).toBe(3);
    expect(resolvePlayerRule(doc, 'FalleN')?.minKills).toBe(5);
    expect(resolvePlayerRule(doc, 'FalleN')?.clutch).toBe(true);
  });

  it('jogador fora da lista retorna null', () => {
    expect(resolvePlayerRule(doc, 'dev1ce')).toBeNull();
    expect(resolvePlayerRule(doc, '')).toBeNull();
    expect(resolvePlayerRule({ ...doc, enabled: false }, 'KSCERATO')).toBeNull();
  });
});

describe('loadWatchlistFile', () => {
  it('lê, cacheia por mtime, mantém a última versão boa e preserva no grace', () => {
    const t0 = 1_000_000;
    const file = tmpFile(
      'watchlist.json',
      JSON.stringify({ teams: [{ names: ['FURIA'], minKills: 3 }] }),
    );
    const first = loadWatchlistFile(file, t0);
    expect(first.missing).toBe(false);
    expect(first.stale).toBe(false);
    expect(first.error).toBeNull();
    expect(first.doc.teams[0].names).toEqual(['FURIA']);
    expect(loadWatchlistFile(file, t0 + 500).changed).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ teams: [{ names: ['Legacy'], minKills: 4 }] }), 'utf8');
    const second = loadWatchlistFile(file, t0 + 1000);
    expect(second.changed).toBe(true);
    expect(second.doc.teams[0].names).toEqual(['Legacy']);

    fs.writeFileSync(file, '{ quebrado', 'utf8');
    const third = loadWatchlistFile(file, t0 + 2000);
    expect(third.error).toBeTruthy();
    expect(third.doc.teams[0].names).toEqual(['Legacy']);

    fs.rmSync(file, { force: true });
    const missing = loadWatchlistFile(file, t0 + 3000);
    expect(missing.missing).toBe(true);
    expect(missing.stale).toBe(true);
    expect(missing.changed).toBe(true);
    expect(missing.doc.teams[0].names).toEqual(['Legacy']);

    const stillMissing = loadWatchlistFile(file, t0 + 4000);
    expect(stillMissing.changed).toBe(false);
    expect(stillMissing.stale).toBe(true);
    expect(stillMissing.doc.teams[0].names).toEqual(['Legacy']);

    const expired = loadWatchlistFile(file, t0 + 1000 + WATCHLIST_MISSING_GRACE_MS + 1);
    expect(expired.missing).toBe(true);
    expect(expired.stale).toBe(false);
    expect(expired.changed).toBe(true);
    expect(expired.doc).toEqual(defaultWatchlistDoc());
  });

  it('aceita BOM no início do arquivo (Notepad/PowerShell)', () => {
    const file = tmpFile(
      'bom.json',
      `\uFEFF${JSON.stringify({ teams: [{ names: ['paiN'], minKills: 3 }] })}`,
    );
    const loaded = loadWatchlistFile(file);
    expect(loaded.error).toBeNull();
    expect(loaded.doc.teams[0].names).toEqual(['paiN']);
  });
});
