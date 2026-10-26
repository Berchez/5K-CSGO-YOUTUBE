import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('assets do tray/painel', () => {
  it('HTML do painel está em UTF-8 sem mojibake', () => {
    const html = fs.readFileSync(path.join(root, 'scripts', 'tray-panel.html'), 'utf8');
    expect(html).not.toMatch(/\uFFFD/);
    expect(html).not.toMatch(/Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â€/);
    expect(html).toContain('Visão geral');
    expect(html).toContain('Configurações');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('script PowerShell tem BOM para o Windows PowerShell 5.1', () => {
    const bytes = fs.readFileSync(path.join(root, 'scripts', 'bot-tray.ps1'));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xEF, 0xBB, 0xBF]);
    const text = bytes.toString('utf8');
    expect(text).not.toMatch(/\uFFFD/);
    expect(text).toContain('Configurações...');
  });
});
