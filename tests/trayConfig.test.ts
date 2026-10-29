import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import {
  EDITABLE_FIELDS,
  panelConfigValues,
  parseEnvFile,
  updateEnvFile,
  validateConfigPatch,
} from '../src/trayConfig.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '5k-tray-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('lê valores simples, quotes e comentários', () => {
    const values = parseEnvFile(
      [
        '# comentário',
        'MIN_STARS=2',
        'YT_DEFAULT_TAGS="cs2, ace, highlight"',
        "STREAM_PRIORITY='official,en'",
        'CLIP_CONTEXT_SEC=25 # contexto',
        '',
      ].join('\n'),
    );
    expect(values.MIN_STARS).toBe('2');
    expect(values.YT_DEFAULT_TAGS).toBe('cs2, ace, highlight');
    expect(values.STREAM_PRIORITY).toBe('official,en');
    expect(values.CLIP_CONTEXT_SEC).toBe('25');
  });

  it('lê arquivo com BOM (a 1ª chave não some)', () => {
    const values = parseEnvFile('\uFEFFMIN_STARS=2\nYT_UPLOAD=true\n');
    expect(values.MIN_STARS).toBe('2');
    expect(values.YT_UPLOAD).toBe('true');
  });
});

describe('updateEnvFile', () => {
  it('substitui só as chaves pedidas, preserva comentários e cria backup', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env');
    fs.writeFileSync(
      file,
      ['# runtime', 'MIN_STARS=1', 'YT_UPLOAD=true', 'YT_DEFAULT_TAGS="cs2, ace"', ''].join('\n'),
      'utf8',
    );

    const result = updateEnvFile(file, {
      MIN_STARS: '2',
      STREAM_PREFERRED_COUNTRY: 'BR',
    });

    expect(result.changedKeys).toEqual(['MIN_STARS', 'STREAM_PREFERRED_COUNTRY']);
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('# runtime');
    expect(raw).toContain('MIN_STARS=2');
    expect(raw).toContain('STREAM_PREFERRED_COUNTRY=BR');
    expect(raw).toContain('YT_UPLOAD=true');
    expect(raw.match(/^MIN_STARS=/gm)).toHaveLength(1);
    const values = parseEnvFile(raw);
    expect(values.MIN_STARS).toBe('2');
    expect(values.STREAM_PREFERRED_COUNTRY).toBe('BR');
  });

  it('faz quote quando o valor contém #', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'MIN_STARS=2\n', 'utf8');
    updateEnvFile(file, { YT_DEFAULT_TAGS: 'cs2, #ace' });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('YT_DEFAULT_TAGS="cs2, #ace"');
    expect(parseEnvFile(raw).YT_DEFAULT_TAGS).toBe('cs2, #ace');
  });

  it('rejeita chave fora da allowlist', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'MIN_STARS=2\n', 'utf8');
    expect(() => updateEnvFile(file, { GC_TOKEN: 'x' })).toThrow(/não editável/i);
  });

  it('substitui todas as ocorrências da chave (dotenv usa a última)', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, ['MIN_STARS=1', 'YT_UPLOAD=true', 'MIN_STARS=1', ''].join('\n'), 'utf8');
    updateEnvFile(file, { MIN_STARS: '3' });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.match(/^MIN_STARS=3$/gm)).toHaveLength(2);
    expect(parseEnvFile(raw).MIN_STARS).toBe('3');
  });
});

describe('validateConfigPatch', () => {
  it('normaliza país e booleanos', () => {
    const result = validateConfigPatch({
      MIN_STARS: '2',
      STREAM_PREFERRED_COUNTRY: 'br',
      YT_UPLOAD: 'false',
      TOP_TIER_ONLY: '1',
    });
    expect(result).toEqual({
      ok: true,
      values: {
        MIN_STARS: '2',
        STREAM_PREFERRED_COUNTRY: 'BR',
        YT_UPLOAD: 'false',
        TOP_TIER_ONLY: 'true',
      },
    });
  });

  it('rejeita número fora do range com mensagem em português', () => {
    const result = validateConfigPatch({ MIN_STARS: '9' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.key).toBe('MIN_STARS');
      expect(result.errors[0]?.message).toContain('menor ou igual a 5');
    }
  });

  it('rejeita booleano inválido em vez de virar false silencioso', () => {
    const result = validateConfigPatch({ YT_UPLOAD: 'talvez' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.key).toBe('YT_UPLOAD');
  });

  it('rejeita número vazio e chave desconhecida', () => {
    const empty = validateConfigPatch({ MIN_KILLS: '' });
    expect(empty.ok).toBe(false);
    const unknown = validateConfigPatch({ NOPE: '1' });
    expect(unknown.ok).toBe(false);
  });

  it('rejeita país inválido e prioridade vazia', () => {
    expect(validateConfigPatch({ STREAM_PREFERRED_COUNTRY: 'BRAZIL' }).ok).toBe(false);
    expect(validateConfigPatch({ STREAM_PRIORITY: '' }).ok).toBe(false);
  });
});

describe('metadados do painel', () => {
  it('todos os campos editáveis existem no schema e são únicos', () => {
    const keys = EDITABLE_FIELDS.map((field) => String(field.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(ConfigSchema.shape[key as keyof typeof ConfigSchema.shape]).toBeDefined();
    }
  });
});

describe('panelConfigValues', () => {
  it('preenche defaults para chaves ausentes', () => {
    const values = panelConfigValues({});
    expect(values.MIN_STARS).toBe('0');
    expect(values.YT_UPLOAD).toBe('true');
    expect(values.YT_PRIVACY).toBe('private');
    expect(values.STREAM_PREFERRED_COUNTRY).toBe('');
  });

  it('respeita valores explícitos', () => {
    const values = panelConfigValues({ MIN_STARS: '2', YT_UPLOAD: 'false' });
    expect(values.MIN_STARS).toBe('2');
    expect(values.YT_UPLOAD).toBe('false');
  });

  it('normaliza booleanos escritos como 1/yes/on (o painel e o bot)', () => {
    // Com "1" no .env o bot tratava como LIGADO e o painel mostrava
    // "desligado" — num toggle que controla upload isso é enganoso.
    const values = panelConfigValues({ YT_UPLOAD: '1', POLL_ADAPTIVE: 'on', TOP_TIER_ONLY: 'no' });
    expect(values.YT_UPLOAD).toBe('true');
    expect(values.POLL_ADAPTIVE).toBe('true');
    expect(values.TOP_TIER_ONLY).toBe('false');
  });

  it('aceita as mesmas formas de ligado/desligado no patch', () => {
    const result = validateConfigPatch({ YT_UPLOAD: 'yes', POLL_ADAPTIVE: 'off' });
    expect(result).toEqual({
      ok: true,
      values: { YT_UPLOAD: 'true', POLL_ADAPTIVE: 'false' },
    });
  });
});
