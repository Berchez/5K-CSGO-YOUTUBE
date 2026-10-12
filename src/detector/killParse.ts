import type { KillEvent } from '../types.js';
import { normWeapon } from './aceDetector.js';

/**
 * Mini-DSL para declarar kills em testes/CLI sem JSON verboso.
 *
 * Formato (separados por vírgula):
 *   killer>victim:weapon:mod1+mod2
 *
 * - victim '?' ou vazio = desconhecida (honesto: não inventa nome)
 * - weapon opcional (ex: ak47, awp, molotov)
 * - mods: hs | ns (no-scope) | wb (wallbang) | smoke (through smoke) |
 *         assist=Nome | flash=Nome
 *
 * Ex:
 *   donk>kyousuke:ak47:hs, donk>NiKo:ak47:flash=chopper, donk>?:awp
 */
export function parseKillList(spec: string, round: number, map: string): KillEvent[] {
  if (!spec.trim()) return [];
  return spec.split(',').map((raw, idx) => {
    const seg = raw.trim();
    if (!seg) throw new Error(`kill vazio na posição ${idx + 1}`);
    const [kv = '', weapon = '', mods = ''] = seg.split(':');
    const gt = kv.indexOf('>');
    if (gt < 0) throw new Error(`kill inválido (falta '>'): ${seg}`);
    const killer = kv.slice(0, gt).trim();
    const victimRaw = kv.slice(gt + 1).trim();
    if (!killer) throw new Error(`killer vazio: ${seg}`);
    const kill: KillEvent = {
      killer,
      victim: victimRaw === '?' ? '' : victimRaw,
      round,
      map,
      weapon: normWeapon(weapon) || undefined,
    };
    for (const mod of mods.split('+').map((s) => s.trim()).filter(Boolean)) {
      if (mod === 'hs') kill.headshot = true;
      else if (mod === 'ns') kill.noscope = true;
      else if (mod === 'wb') kill.wallbang = true;
      else if (mod === 'smoke') kill.throughSmoke = true;
      else if (mod.startsWith('assist=')) kill.assistBy = mod.slice('assist='.length) || undefined;
      else if (mod.startsWith('flash=')) kill.flashAssistBy = mod.slice('flash='.length) || undefined;
      else throw new Error(`modificador desconhecido '${mod}' em: ${seg}`);
    }
    return kill;
  });
}
