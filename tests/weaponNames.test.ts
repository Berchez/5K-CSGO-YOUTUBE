import { describe, expect, it } from 'vitest';
import { normWeapon, prettyWeapon } from '../src/detector/aceDetector.js';

/**
 * A tabela de nomesPretty é a COPY que vai para o título, a descrição e
 * a thumb. O scorebot manda o nome da arma com o sufixo do silenciador
 * (`usp_silencer`); sem o alias, o texto saía cru na thumb.
 */
describe('nomes de arma (PRETTY)', () => {
  it('normaliza o nome (minúsculo, sem pontuação)', () => {
    expect(normWeapon('USP-S')).toBe('usps');
    expect(normWeapon('usp_silencer')).toBe('uspsilencer');
    expect(normWeapon('weapon_ak47')).toBe('ak47');
    expect(normWeapon(undefined)).toBe('');
  });

  it('traduz as armas do canal', () => {
    expect(prettyWeapon('ak47')).toBe('AK-47');
    expect(prettyWeapon('awp')).toBe('AWP');
    expect(prettyWeapon('m4a1')).toBe('M4A1-S');
    expect(prettyWeapon('deagle')).toBe('Desert Eagle');
    expect(prettyWeapon('glock')).toBe('Glock');
    expect(prettyWeapon('ump45')).toBe('UMP-45');
  });

  it('traduz os aliases do scorebot (silenciador/estilo)', () => {
    expect(prettyWeapon('usp_silencer')).toBe('USP-S');
    expect(prettyWeapon('m4a1_silencer')).toBe('M4A1-S');
    expect(prettyWeapon('knife_butterfly')).toBe('Butterfly Knife');
    expect(prettyWeapon('knife_kukri')).toBe('Kukri Knife');
    expect(prettyWeapon('smoke_grenade')).toBe('Smoke');
    expect(prettyWeapon('he_grenade')).toBe('HE Grenade');
    expect(prettyWeapon('flashbang')).toBe('Flashbang');
    expect(prettyWeapon('molotov')).toBe('Molotov');
    expect(prettyWeapon('incendiary')).toBe('Incendiary');
    expect(prettyWeapon('decoy')).toBe('Decoy');
  });

  it('arma desconhecida volta como veio (não inventa nome)', () => {
    expect(prettyWeapon('weapon_xpto')).toBe('weapon_xpto');
    expect(prettyWeapon('')).toBe('');
  });
});
