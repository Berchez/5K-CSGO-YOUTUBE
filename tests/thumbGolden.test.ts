import { describe, expect, it } from 'vitest';
import {
  buildThumbnailPrompt,
  planForProvider,
} from '../src/clipper/aiThumbnail.js';
import type { AceEvent } from '../src/types.js';
import type { ReferenceImages } from '../src/clipper/referenceImages.js';

/**
 * GOLDEN do caminho chatgpt.
 *
 * O chatgpt gera a thumb COMPLETA (IA com texto e rosto). Esse caminho é
 * intocável: qualquer mudança no prompt ou no plano quebra o golden e
 * invalida as thumbnails já publicadas com o layout antigo.
 *
 * Não edite as constantes abaixo sem revisar o resultado visual.
 */

const ace: AceEvent = {
  matchId: '2400005',
  map: 'Inferno',
  round: 16,
  player: 'KSCERATO',
  team1: 'The MongolZ',
  team2: 'FURIA',
  event: 'IEM Beijing 2026',
  detectedAt: '2026-11-04T10:11:31.766Z',
  score: '6-9',
  kills: [
    { killer: 'KSCERATO', victim: 'bLitz', round: 16, map: 'Inferno' },
    { killer: 'KSCERATO', victim: 'nin9', round: 16, map: 'Inferno' },
    { killer: 'KSCERATO', victim: '910', round: 16, map: 'Inferno' },
    { killer: 'KSCERATO', victim: 'cobrazera', round: 16, map: 'Inferno' },
  ],
  summary: {
    round: 16,
    map: 'Inferno',
    player: 'KSCERATO',
    team: 'The MongolZ',
    opponents: 'FURIA',
    kills: [
      { killer: 'KSCERATO', victim: 'bLitz', round: 16, map: 'Inferno', weapon: 'ak47' },
      { killer: 'KSCERATO', victim: 'nin9', round: 16, map: 'Inferno', weapon: 'ak47', headshot: true },
      { killer: 'KSCERATO', victim: '910', round: 16, map: 'Inferno', weapon: 'm4a1-s' },
      { killer: 'KSCERATO', victim: 'cobrazera', round: 16, map: 'Inferno', weapon: 'ak47' },
    ],
    victims: ['bLitz', 'nin9', '910', 'cobrazera'],
    weapons: ['ak47', 'ak47', 'm4a1-s', 'ak47'],
    headshots: 1,
    assists: [],
    flashAssists: [],
    grenades: [{ player: 'KSCERATO', kind: 'he' }],
    mainWeapon: 'ak47',
  },
};

const refs: ReferenceImages = {
  player: 'data/clips/refs/2400005/ref-player-KSCERATO.jpg',
  playerAlt: 'data/clips/refs/2400005/ref-player-alt-KSCERATO.jpg',
  team1Logo: 'data/clips/refs/2400005/ref-team1Logo.png',
  team2Logo: 'data/clips/refs/2400005/ref-team2Logo.png',
  mapImage: 'data/clips/refs/2400005/ref-map-Inferno.jpg',
};

const attachments = [
  refs.player!,
  refs.playerAlt!,
  refs.team1Logo!,
  refs.team2Logo!,
  refs.mapImage!,
];

const GOLDEN_PROMPT = `Gere uma thumbnail de YouTube 16:9 (1920x1080) para um clipe de Counter-Strike 2 que representa o multikill de 4K descrito neste json:
{
  "player": "KSCERATO",
  "team1": "The MongolZ",
  "team2": "FURIA",
  "playerTeam": "The MongolZ",
  "opponents": "FURIA",
  "map": "Inferno",
  "round": 16,
  "score": "6-9",
  "event": "IEM Beijing 2026",
  "mainWeapon": "AK-47",
  "weapons": [
    "ak47",
    "ak47",
    "m4a1-s",
    "ak47"
  ],
  "victims": [
    "bLitz",
    "nin9",
    "910",
    "cobrazera"
  ],
  "headshots": 1,
  "assists": [],
  "flashAssists": [],
  "grenades": [
    {
      "player": "KSCERATO",
      "kind": "he"
    }
  ]
}

REFERÊNCIAS OBRIGATÓRIAS (as 5 imagens anexadas a esta mensagem, NESTA EXATA ORDEM — siga-as como verdade visual para identidade, cores, formas e cenário):
1. Foto oficial do jogador "KSCERATO" — rosto e identidade visual dele
2. Segunda foto do jogador "KSCERATO" em evento com a camisa do The MongolZ — use para o uniforme e a pose
3. Logo do time The MongolZ — reproduza formas e cores exatos
4. Logo do time adversário FURIA — reproduza formas e cores exatos
5. Cenário do mapa Inferno — use como ambiente da cena

ESTILO
Thumbnail de esports profissional, fundo preto com acentos em neon lime green (#B6FF00), pinceladas/respingos de tinta, alto contraste, legível em tela pequena (mobile).

LAYOUT (3 zonas)
- ESQUERDA: logo do evento "IEM Beijing 2026" no topo; abaixo, logo do time The MongolZ e o nick "KSCERATO" em letras brush/manuscritas brancas.
- CENTRO: retrato em close do jogador KSCERATO (camisa do The MongolZ), olhando de lado, iluminação dramática com rim light. À direita dele, texto gigante "4K" em neon lime green (#B6FF00) estilo pincelada, com um traço de tinta sublinhando.
- DIREITA: killfeed estilo CS2 empilhado no topo, com 4 linhas (nick em verde, ícone da arma, ícone de headshot só onde indicado, adversário em azul):
  1. "KSCERATO" [AK-47 icon] "bLitz"
  2. "KSCERATO" [AK-47 icon] [headshot skull icon] "nin9"
  3. "KSCERATO" [m4a1-s icon] "910"
  4. "KSCERATO" [AK-47 icon] "cobrazera"
  Abaixo do killfeed, cenário do mapa Inferno (ambiente reconhecível, luz quente, ponto de bomba pintado no chão) e a viewmodel em primeira pessoa da AK-47 com skin temática do The MongolZ entrando pelo canto inferior direito.
- RODAPÉ ESQUERDO: logos pequenos "The MongolZ vs FURIA" com texto em branco.

REGRAS
- Texto limitado a: evento, The MongolZ, "KSCERATO", "4K", killfeed e "The MongolZ vs FURIA". Sem outros textos.
- Diagonais de tinta neon lime green (#B6FF00) costurando as zonas, vinheta escura nas bordas.
- Sem marca d'água, sem HUD extra.`;

describe('golden chatgpt (caminho intocável)', () => {
  it('prompt do chatgpt é byte a byte o atual', () => {
    expect(buildThumbnailPrompt(ace, refs)).toBe(GOLDEN_PROMPT);
  });

  it('plano do chatgpt: thumb completa + 5 anexos, sem layout composite', () => {
    const plan = planForProvider('chatgpt', ace, refs, attachments);
    expect(plan).toEqual({
      prompt: GOLDEN_PROMPT,
      attachments,
      fullThumb: true,
    });
    expect(plan.layout).toBeUndefined();
  });

  it('plano do chatgpt sem referências: prompt completo e nenhum anexo', () => {
    const plan = planForProvider('chatgpt', ace, undefined, []);
    expect(plan.prompt).toBe(buildThumbnailPrompt(ace));
    expect(plan.attachments).toEqual([]);
    expect(plan.fullThumb).toBe(true);
  });
});
