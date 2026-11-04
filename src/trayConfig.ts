import fs from 'node:fs';
import path from 'node:path';
import { boolEnv, ConfigSchema, parseBoolEnv, shortsCrossFieldErrors } from './config.js';
import type { AppConfig } from './config.js';
import { providerSelectOptions } from './transcription/registry.js';

export type ConfigGroup =
  | 'capture'
  | 'stream'
  | 'clips'
  | 'youtube'
  | 'transcription'
  | 'system';

export interface ConfigField {
  key: keyof AppConfig;
  group: ConfigGroup;
  label: string;
  help?: string;
  type: 'number' | 'text' | 'select' | 'boolean';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  advanced?: boolean;
}

export interface EnvReadResult {
  raw: string;
  values: Record<string, string>;
}

export type ConfigPatchResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: Array<{ key: string; message: string }> };

const COUNTRY_OPTIONS = [
  { value: '', label: 'Sem preferência' },
  { value: 'BR', label: 'Brasil (BR)' },
  { value: 'US', label: 'Estados Unidos (US)' },
  { value: 'PT', label: 'Portugal (PT)' },
  { value: 'AR', label: 'Argentina (AR)' },
  { value: 'RU', label: 'Rússia (RU)' },
  { value: 'DE', label: 'Alemanha (DE)' },
  { value: 'FR', label: 'França (FR)' },
  { value: 'ES', label: 'Espanha (ES)' },
  { value: 'PL', label: 'Polônia (PL)' },
  { value: 'UA', label: 'Ucrânia (UA)' },
  { value: 'TR', label: 'Turquia (TR)' },
];

export const EDITABLE_FIELDS: ConfigField[] = [
  {
    key: 'MIN_STARS',
    group: 'capture',
    label: 'Estrelas mínimas',
    help: '0 = qualquer partida; 2 = somente 2★ ou mais. Partidas sem estrela continuam sujeitas ao mínimo de kills.',
    type: 'number',
    min: 0,
    max: 5,
    step: 1,
  },
  {
    key: 'MIN_KILLS',
    group: 'capture',
    label: 'Kills mínimas com estrela',
    help: '4 = 4k/5k; 5 = somente ACE.',
    type: 'number',
    min: 2,
    max: 5,
    step: 1,
  },
  {
    key: 'MIN_KILLS_NO_STARS',
    group: 'capture',
    label: 'Kills mínimas sem estrela',
    help: 'Partidas com 0★ no listing usam este limite (normalmente 5 = ACE).',
    type: 'number',
    min: 2,
    max: 5,
    step: 1,
  },
  {
    key: 'TOP_TIER_ONLY',
    group: 'capture',
    label: 'Somente torneios top-tier',
    help: 'Quando o listing permite classificar; reduz partidas de tier baixo.',
    type: 'boolean',
  },
  {
    key: 'POLL_INTERVAL_MS',
    group: 'capture',
    label: 'Intervalo de poll',
    help: 'Intervalo base entre checagens do listing. Ocioso, o bot espera metade do tempo até a próxima partida (teto de 30min).',
    type: 'number',
    min: 5000,
    max: 600000,
    step: 1000,
    unit: 'ms',
  },
  {
    key: 'POLL_ADAPTIVE',
    group: 'capture',
    label: 'Poll adaptativo',
    help: 'Ligado: ocioso, o bot espera metade do tempo até a próxima partida (teto de 30min). Desligado: sempre no intervalo base.',
    type: 'boolean',
  },
  {
    key: 'HLTV_CLOSE_BROWSER_IDLE',
    group: 'capture',
    label: 'Fechar o browser ocioso',
    help: 'Desligado = mantém o browser aberto entre polls (não pisca na tela ao relançar).',
    type: 'boolean',
    advanced: true,
  },
  {
    key: 'HLTV_CLOSE_BROWSER_MIN_IDLE_MS',
    group: 'capture',
    label: 'Espera mínima p/ fechar o browser',
    help: 'Só fecha o browser ocioso depois desta espera (evita relançar o Chrome a cada ciclo).',
    type: 'number',
    min: 0,
    max: 3_600_000,
    step: 60_000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'MAX_RECORDINGS',
    group: 'capture',
    label: 'Gravações simultâneas',
    help: 'Máximo de partidas com buffer ao mesmo tempo.',
    type: 'number',
    min: 1,
    max: 4,
    step: 1,
  },
  {
    key: 'STREAM_PRIORITY',
    group: 'stream',
    label: 'Prioridade de stream',
    help: 'Termos separados por vírgula. Ex.: official,en (oficial primeiro, depois inglês).',
    type: 'text',
  },
  {
    key: 'STREAM_PREFERRED_COUNTRY',
    group: 'stream',
    label: 'País preferido',
    help: 'Tenta primeiro uma stream deste país com audiência suficiente. Se não houver, usa a prioridade normal.',
    type: 'select',
    options: COUNTRY_OPTIONS,
  },
  {
    key: 'STREAM_PREFERRED_MIN_VIEWERS',
    group: 'stream',
    label: 'Audiência mínima do país',
    help: '0 = qualquer audiência. A stream preferida precisa ter pelo menos este número de viewers.',
    type: 'number',
    min: 0,
    max: 10_000_000,
    step: 500,
    unit: 'viewers',
  },
  {
    key: 'CLIP_PRE_ROLL_SEC',
    group: 'clips',
    label: 'Pré-roll',
    help: 'Buffer antes do primeiro kill incluído no corte.',
    type: 'number',
    min: 15,
    max: 120,
    step: 5,
    unit: 's',
  },
  {
    key: 'CLIP_POST_ROLL_SEC',
    group: 'clips',
    label: 'Pós-roll',
    help: 'Buffer depois do último kill/placar.',
    type: 'number',
    min: 5,
    max: 60,
    step: 1,
    unit: 's',
  },
  {
    key: 'CLIP_CONTEXT_SEC',
    group: 'clips',
    label: 'Contexto antes do ACE',
    help: 'Segundos extras antes da primeira kill quando a âncora é confiável.',
    type: 'number',
    min: 0,
    max: 30,
    step: 1,
    unit: 's',
  },
  {
    key: 'CLIP_CONTEXT_UNCERTAIN_SEC',
    group: 'clips',
    label: 'Contexto com âncora incerta',
    help: 'Contexto maior quando o tracker pode ter entrado no meio do round.',
    type: 'number',
    min: 0,
    max: 120,
    step: 1,
    unit: 's',
    advanced: true,
  },
  {
    key: 'CLIP_STREAM_SYNC',
    group: 'clips',
    label: 'Sync pelo placar',
    help: 'auto aplica o fim do round quando encontra a virada do placar; log só mede; off desliga.',
    type: 'select',
    options: [
      { value: 'auto', label: 'Automático' },
      { value: 'log', label: 'Só registrar' },
      { value: 'off', label: 'Desligado' },
    ],
  },
  {
    key: 'CLIP_STREAM_LATENCY_MS',
    group: 'clips',
    label: 'Latência da stream',
    help: 'Atraso do material gravado em relação ao jogo. Suba se o clipe abrir ANTES da 1ª kill; desça se abrir muito depois. O log "latência observada" mede o valor real de cada canal.',
    type: 'number',
    min: 0,
    max: 120_000,
    step: 1000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'SCOREBOARD_DELAY_MS',
    group: 'clips',
    label: 'Atraso do placar',
    help: 'Quanto o placar do HLTV atrasa em relação ao jogo (por kill). Entra no offset dos timestamps da descrição.',
    type: 'number',
    min: 0,
    max: 120_000,
    step: 500,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'CLIP_SCORE_DELAY_MS',
    group: 'clips',
    label: 'Atraso do placar final',
    help: 'Quanto o HLTV demora para publicar o placar final do round (ancora o FIM do clipe quando o sync do vídeo não acha a virada).',
    type: 'number',
    min: 0,
    max: 120_000,
    step: 1000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'CLIP_END_AFTER_CLOSE_SEC',
    group: 'clips',
    label: 'Margem após o round',
    help: 'Segundos depois do fechamento do round que entram no clipe (win panel/freeze).',
    type: 'number',
    min: 0,
    max: 60,
    step: 1,
    unit: 's',
    advanced: true,
  },
  {
    key: 'CLIP_END_TAIL_SEC',
    group: 'clips',
    label: 'Cauda do fim estimado',
    help: 'Folga extra no fim quando o round não foi ancorado no vídeo (proteger a última kill quando a latência real é maior que a configurada).',
    type: 'number',
    min: 0,
    max: 120,
    step: 1,
    unit: 's',
    advanced: true,
  },
  {
    key: 'REPLAY_AWARE',
    group: 'clips',
    label: 'Replay-aware',
    help: 'shadow detecta a retomada do round seguinte e registra; off desliga.',
    type: 'select',
    options: [
      { value: 'shadow', label: 'Shadow (recomendado)' },
      { value: 'off', label: 'Desligado' },
      { value: 'on', label: 'Ligado (experimental)' },
    ],
    advanced: true,
  },
  {
    key: 'DISK_MIN_FREE_GB',
    group: 'clips',
    label: 'Disco livre mínimo',
    help: 'Abaixo disso o render é abortado e novos segmentos param de acumular.',
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    unit: 'GB',
  },
  {
    key: 'SHORTS_ENABLED',
    group: 'clips',
    label: 'Gerar Shorts (9:16)',
    help: 'O script publish:shorts só PUBLICA com esta chave ligada; o dry-run (cálculo + render) funciona sempre.',
    type: 'boolean',
    advanced: true,
  },
  {
    key: 'SHORTS_MAX_SEC',
    group: 'clips',
    label: 'Duração máx. do Short',
    help: 'Duração máxima do Short. O YouTube aceita até 3min, mas acima de 1min um Short com claim de copyright é bloqueado — por isso o corte é 90s.',
    type: 'number',
    min: 10,
    max: 180,
    step: 1,
    unit: 's',
    advanced: true,
  },
  {
    key: 'SHORTS_MIN_KILLS',
    group: 'clips',
    label: 'Mín. de kills no Short',
    help: 'O bot também grava 3K/4K: no feed Shorts um 4K é tão bom quanto um ace.',
    type: 'number',
    min: 2,
    max: 5,
    step: 1,
    advanced: true,
  },
  {
    key: 'SHORTS_MIN_SEC',
    group: 'clips',
    label: 'Duração mín. do Short',
    help: 'Abaixo disso o Short é rápido demais e perde retenção. Quando a jogada é curta, a janela é esticada para frente (reação/rotação final).',
    type: 'number',
    min: 5,
    max: 180,
    step: 1,
    unit: 's',
    advanced: true,
  },
  {
    key: 'SHORTS_CROP_X',
    group: 'clips',
    label: 'Crop do Short (horizontal)',
    help: '0 = esquerda, 0.5 = centro, 1 = direita. O crop 9:16 tira ~2/3 da largura: se a ação ou o placar saírem do quadro, mova aqui.',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    advanced: true,
  },
  {
    key: 'SHORTS_TOP',
    group: 'clips',
    label: 'Topo do Short',
    help: 'Cam do streamer no topo (caixa medida por canal no SHORTS_CAM_BOX_BY_STREAM) ou faixa com o título do vídeo. Center = crop vertical antigo.',
    type: 'select',
    options: [
      { value: 'cam', label: 'Cam do streamer' },
      { value: 'text', label: 'Faixa com o título' },
      { value: 'center', label: 'Crop 9:16 antigo' },
    ],
    advanced: true,
  },
  {
    key: 'SHORTS_CAM_HEIGHT',
    group: 'clips',
    label: 'Altura da faixa do topo',
    help: 'Quanto da saída é a cam (o resto é o jogo). 660 em 1920: ~80% da caixa da webcam do gaules no quadro e o jogo 1:1 em 1080x1080. Ajuste em 20px.',
    type: 'number',
    min: 160,
    max: 1800,
    step: 20,
    unit: 'px',
    advanced: true,
  },
  {
    key: 'SHORTS_CAM_FIT',
    group: 'clips',
    label: 'Preenchimento da cam',
    help: 'Cover = a cam é zoomada até preencher a faixa (sem barras pretas). Blur = a cam inteira sobre um fundo desfocado.',
    type: 'select',
    options: [
      { value: 'cover', label: 'Zoom (sem barras)' },
      { value: 'blur', label: 'Fundo desfocado' },
    ],
    advanced: true,
  },
  {
    key: 'SHORTS_CAM_ANCHOR',
    group: 'clips',
    label: 'Âncora do corte da cam',
    help: 'Onde o corte vertical da cam pega (0 = topo, 0.5 = centro, 1 = base). Deixe perto de 0.35 para o rosto ficar inteiro.',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    advanced: true,
  },
  {
    key: 'SHORTS_GAME_CROP',
    group: 'clips',
    label: 'Altura do crop do jogo (fração)',
    help: 'Fração da altura do clipe usada pelo jogo. 0.95 é o default: o HUD de vida/munição entra no quadro.',
    type: 'number',
    min: 0.3,
    max: 1,
    step: 0.05,
    advanced: true,
  },
  {
    key: 'SHORTS_GAME_Y',
    group: 'clips',
    label: 'Posição vertical do crop do jogo',
    help: '0 = topo (come o placar), 0.5 = centro (recomendado), 1 = base. Só vale no modo "Zoom" do preenchimento do jogo.',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    advanced: true,
  },
  {
    key: 'SHORTS_GAME_FIT',
    group: 'clips',
    label: 'Preenchimento do jogo',
    help: 'Fundo desfocado = o crop do jogo fica centralizado sobre a cena desfocada. Zoom = crop 9:16 apertado, ação grande mas com o killfeed fora.',
    type: 'select',
    options: [
      { value: 'blur', label: 'Fundo desfocado' },
      { value: 'cover', label: 'Zoom (sem barras)' },
    ],
    advanced: true,
  },
  {
    key: 'SHORTS_GAME_ASPECT',
    group: 'clips',
    label: 'Proporção do jogo',
    help: 'Proporção (largura/altura) do crop do jogo com o preenchimento "Fundo desfocado". Mais largo = mais da transmissão no quadro, com o jogo menor. Dá para escrever qualquer número no .env.',
    type: 'select',
    options: [
      { value: '1', label: '1:1 (quadrado, ~53%)' },
      { value: '1.3333', label: '4:3 (~71%)' },
      { value: '1.5', label: '3:2 (~80%)' },
      { value: '1.7778', label: '16:9 (~95%)' },
      { value: '0.7826', label: '9:16 (o crop de antes, ~42%)' },
    ],
    advanced: true,
  },
  {
    key: 'SHORTS_CAPTIONS',
    group: 'clips',
    label: 'Legenda no Short',
    help: 'Grava a legenda da narração no proprio mp4 (nao depende do caption do YouTube). Cada Short gasta uma chamada de IA para transcrever.',
    type: 'boolean',
    advanced: true,
  },
  {
    key: 'SHORTS_CAPTION_POSITION',
    group: 'clips',
    label: 'Posicao da legenda',
    help: 'Abaixo da mira = centro da area do jogo, um pouco abaixo do crosshair (padrao). Topo do jogo = logo abaixo da cam. Rodape = posicao classica.',
    type: 'select',
    options: [
      { value: 'below-crosshair', label: 'Abaixo da mira (padrao)' },
      { value: 'game-top', label: 'Topo do jogo' },
      { value: 'bottom', label: 'Rodape' },
    ],
    advanced: true,
  },
  {
    key: 'SHORTS_CAPTION_FONT_SIZE',
    group: 'clips',
    label: 'Tamanho da fonte da legenda',
    help: 'Altura do texto da legenda em px (na saida de 1080 de largura).',
    type: 'number',
    min: 24,
    max: 160,
    step: 2,
    unit: 'px',
    advanced: true,
  },
  {
    key: 'SHORTS_CAPTION_FONT_FAMILY',
    group: 'clips',
    label: 'Fonte da legenda',
    help: 'Fonte da legenda. O padrão (Barlow Condensed) vem do repo; outra família precisa estar instalada no Windows.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'SHORTS_PRIVACY',
    group: 'clips',
    label: 'Visibilidade do Short',
    help: 'Unlisted testa sem risco de claim no canal; public publica de cara.',
    type: 'select',
    options: [
      { value: 'unlisted', label: 'Unlisted (teste)' },
      { value: 'private', label: 'Privado' },
      { value: 'public', label: 'Público' },
    ],
    advanced: true,
  },
  {
    key: 'SHORTS_HASHTAG',
    group: 'clips',
    label: 'Hashtag do Short',
    help: 'Tag que entra no fim da descrição do Short (o painel grava entre aspas — o # solto seria lido como comentário).',
    type: 'text',
    advanced: true,
  },
  {
    key: 'THUMB_MODE',
    group: 'clips',
    label: 'Thumbnail',
    help: 'Composed usa um frame + selo; AI tenta gerar fundo com os providers configurados.',
    type: 'select',
    options: [
      { value: 'composed', label: 'Frame + selo' },
      { value: 'ai', label: 'IA (com fallback)' },
    ],
  },
  {
    key: 'YT_UPLOAD',
    group: 'youtube',
    label: 'Enviar para o YouTube',
    help: 'Desligado = gera e mantém o clipe local, sem upload.',
    type: 'boolean',
  },
  {
    key: 'YT_PRIVACY',
    group: 'youtube',
    label: 'Privacidade do vídeo',
    help: 'O fluxo do bot usa private por padrão (revisão manual antes de publicar).',
    type: 'select',
    options: [
      { value: 'private', label: 'Privado' },
      { value: 'unlisted', label: 'Não listado' },
      { value: 'public', label: 'Público' },
    ],
  },
  {
    key: 'YT_CATEGORY_ID',
    group: 'youtube',
    label: 'Categoria do YouTube',
    help: '20 = Gaming.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'YT_DEFAULT_TAGS',
    group: 'youtube',
    label: 'Tags padrão',
    help: 'Separadas por vírgula.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'YT_META_MODE',
    group: 'youtube',
    label: 'Título e descrição',
    help: 'IA gera criativo com queda para o gerador determinístico; Determinístico nunca usa a rede; Legado mantém o texto fixo antigo.',
    type: 'select',
    options: [
      { value: 'ai', label: 'IA (com fallback)' },
      { value: 'template', label: 'Determinístico' },
      { value: 'legacy', label: 'Legado (fixo)' },
    ],
  },
  {
    key: 'YT_BRAND',
    group: 'youtube',
    label: 'Assinatura do canal',
    help: 'Vira hashtag no fim da descrição (ex.: 5K CS). Vazio = sem assinatura.',
    type: 'text',
  },
  {
    key: 'YT_DESC_CTA',
    group: 'youtube',
    label: 'Chamada final',
    help: 'Linha extra no fim da descrição (ex.: "Inscreva-se para mais highlights").',
    type: 'text',
  },
  {
    key: 'YT_META_AI_ORDER',
    group: 'youtube',
    label: 'Ordem dos providers de texto',
    help: 'Ex.: gemini,huggingface. Só usados quando YT_META_MODE=ai.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'YT_META_AI_TIMEOUT_MS',
    group: 'youtube',
    label: 'Timeout do texto IA',
    help: 'Tempo máximo por provider de texto.',
    type: 'number',
    min: 5000,
    max: 600000,
    step: 5000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'YT_META_GEMINI_MODEL',
    group: 'youtube',
    label: 'Modelo de texto (Gemini)',
    help: 'Modelo da API do Gemini usado nos títulos e descrições.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'YT_META_HF_MODEL',
    group: 'youtube',
    label: 'Modelo de texto (HuggingFace)',
    help: 'Segundo provider da fila de texto.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'THUMB_AI_ORDER',
    group: 'youtube',
    label: 'Ordem dos providers de IA',
    help: 'Ex.: chatgpt,grok,gemini-web. Só usados quando THUMB_MODE=ai.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'THUMB_AI_TIMEOUT_MS',
    group: 'youtube',
    label: 'Timeout da thumb IA',
    help: 'Tempo máximo por provider.',
    type: 'number',
    min: 60000,
    max: 3600000,
    step: 30000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'THUMB_COMPOSITE',
    group: 'youtube',
    label: 'Thumb composta',
    help: 'A IA gera só o fundo e a montagem local (sharp) faz o retrato do jogador, os logos, o mapa e os textos — o texto nunca é alucinado. O chatgpt não muda (a thumb dele já é completa).',
    type: 'boolean',
    advanced: true,
  },
  {
    key: 'TRANSCRIPTION_PROVIDER',
    group: 'transcription',
    label: 'Provider de transcrição',
    help: 'Local = grátis e sem enviar áudio (Whisper/Vosk); nuvem = mais preciso/rápido, mas exige chave no .env. A velocidade medida está no README.',
    type: 'select',
    options: providerSelectOptions(),
  },
  {
    key: 'TRANSCRIPTION_MODEL',
    group: 'transcription',
    label: 'Modelo',
    help: 'Vazio = modelo padrão do provider. Ex.: small, medium, large-v3-turbo-q5_0, gemini-3.5-transcribe, whisper-large-v3-turbo.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'TRANSCRIPTION_LANGUAGE',
    group: 'transcription',
    label: 'Idioma do áudio',
    help: 'auto = o provider detecta; pt, en... força um idioma (útil quando o caster fala baixo ou há muito ruído).',
    type: 'text',
    advanced: true,
  },
  {
    key: 'TRANSCRIPTION_VAD',
    group: 'transcription',
    label: 'Detectar fala (VAD)',
    help: 'Ligado = pula silêncio antes de transcrever (mais rápido e evita alucinação). Só vale nos providers locais.',
    type: 'boolean',
    advanced: true,
  },
  {
    key: 'TRANSCRIPTION_OUTPUT_FORMAT',
    group: 'transcription',
    label: 'Formato da legenda',
    help: 'SRT é o formato que o YouTube e os editores importam; VTT é o da web; TXT é só o texto.',
    type: 'select',
    options: [
      { value: 'srt', label: 'SRT' },
      { value: 'vtt', label: 'WebVTT' },
      { value: 'txt', label: 'Texto puro' },
    ],
    advanced: true,
  },
  {
    key: 'TRANSCRIPTION_TIMEOUT_MS',
    group: 'transcription',
    label: 'Timeout da transcrição',
    help: 'Tempo máximo por transcrição (extração do áudio + inferência).',
    type: 'number',
    min: 10000,
    max: 1800000,
    step: 30000,
    unit: 'ms',
    advanced: true,
  },
  {
    key: 'LOG_LEVEL',
    group: 'system',
    label: 'Nível de log',
    help: 'debug mostra detalhes; info é o padrão; warn/error reduzem o volume.',
    type: 'select',
    options: [
      { value: 'debug', label: 'Debug' },
      { value: 'info', label: 'Info' },
      { value: 'warn', label: 'Warn' },
      { value: 'error', label: 'Error' },
    ],
  },
];

export const EDITABLE_KEYS = new Set<string>(EDITABLE_FIELDS.map((field) => String(field.key)));

export const CONFIG_GROUPS: Array<{ id: ConfigGroup; label: string; description: string }> = [
  { id: 'capture', label: 'Captura', description: 'O que entra no monitor e quantas partidas podem gravar.' },
  { id: 'stream', label: 'Stream', description: 'Qual transmissão é escolhida e em que ordem.' },
  { id: 'clips', label: 'Clipes e thumbs', description: 'Corte, sincronização, espaço em disco e thumbnail.' },
  { id: 'youtube', label: 'YouTube', description: 'Upload, privacidade e metadados.' },
  {
    id: 'transcription',
    label: 'Transcrição',
    description: 'Fala do clipe → legenda (SRT/VTT/TXT): provider, modelo, idioma e VAD.',
  },
  { id: 'system', label: 'Sistema', description: 'Diagnóstico e comportamento geral.' },
];

function unquoteEnvValue(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
      if (first === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return value;
    }
  }
  const comment = value.indexOf(' #');
  if (comment >= 0) value = value.slice(0, comment).trim();
  return value;
}

export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = unquoteEnvValue(match[2]);
  }
  return out;
}

export function readEnvFile(filePath: string): EnvReadResult {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { raw, values: parseEnvFile(raw) };
  } catch {
    return { raw: '', values: {} };
  }
}

export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_.,:/+\-@%*= ]+$/.test(value) && !value.includes('#')) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function updateEnvFile(
  filePath: string,
  updates: Record<string, string>,
): { backupPath: string | null; changedKeys: string[] } {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailing = raw === '' || raw.endsWith('\n');
  let lines = raw === '' ? [] : raw.split(/\r?\n/);
  if (hadTrailing && lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const changedKeys: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_KEYS.has(key)) throw new Error(`Configuração não editável: ${key}`);
    if (/[\r\n]/.test(value)) throw new Error(`Valor inválido para ${key}: quebra de linha`);
    const lineRe = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lineRe.test(lines[i])) continue;
      lines[i] = `${key}=${formatEnvValue(value)}`;
      replaced = true;
    }
    if (!replaced) {
      lines.push(`${key}=${formatEnvValue(value)}`);
    }
    changedKeys.push(key);
  }
  const next = `${lines.join(eol)}${eol}`;
  let backupPath: string | null = null;
  if (raw !== '' && fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.copyFileSync(tmp, filePath);
    fs.rmSync(tmp, { force: true });
  }
  return { backupPath, changedKeys };
}

function defaultValueFor(key: keyof AppConfig): string {
  const schema = ConfigSchema.shape[key];
  const parsed = schema.safeParse(undefined);
  if (!parsed.success) return '';
  const value = parsed.data;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value ?? '');
}

export function configValueForPanel(
  values: Record<string, string>,
  field: ConfigField,
): string {
  const raw = values[field.key];
  const fallback = defaultValueFor(field.key);
  if (field.type === 'boolean') {
    // O .env aceita 1/true/yes/on/sim — o painel precisa mostrar o MESMO
    // estado que o bot enxerga (antes, "1" era tratado como ligado pelo
    // bot e como desligado pelo painel).
    const source = raw === undefined ? fallback : raw;
    return boolEnv(source, fallback === 'true') ? 'true' : 'false';
  }
  return raw === undefined ? fallback : raw;
}

export function panelConfigValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of EDITABLE_FIELDS) out[field.key] = configValueForPanel(values, field);
  return out;
}

export function validateConfigPatch(
  patch: Record<string, unknown>,
  current: Record<string, string> = {},
): ConfigPatchResult {
  const errors: Array<{ key: string; message: string }> = [];
  const values: Record<string, string> = {};
  const fieldByKey = new Map(EDITABLE_FIELDS.map((field) => [String(field.key), field]));
  for (const [key, raw] of Object.entries(patch)) {
    if (!EDITABLE_KEYS.has(key)) {
      errors.push({ key, message: 'Configuração não editável.' });
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      errors.push({ key, message: 'Valor inválido.' });
      continue;
    }
    const field = fieldByKey.get(key);
    let value = String(raw).trim();
    if (field?.type === 'number') {
      const numeric = Number(value);
      if (value === '' || !Number.isFinite(numeric)) {
        errors.push({ key, message: 'Informe um número.' });
        continue;
      }
      if (field.min != null && numeric < field.min) {
        errors.push({ key, message: `Use um valor maior ou igual a ${field.min}.` });
        continue;
      }
      if (field.max != null && numeric > field.max) {
        errors.push({ key, message: `Use um valor menor ou igual a ${field.max}.` });
        continue;
      }
    }
    if (field?.type === 'boolean') {
      // Mesmo conjunto de valores do .env (1/true/yes/on/sim x
      // 0/false/no/off/não) — gravado sempre como true/false.
      const parsed = parseBoolEnv(value);
      if (parsed === null) {
        errors.push({ key, message: 'Use ligado/desligado.' });
        continue;
      }
      value = parsed ? 'true' : 'false';
    }
    if (key === 'STREAM_PREFERRED_COUNTRY') {
      value = value.toUpperCase();
      if (value !== '' && !/^[A-Z]{2,3}$/.test(value)) {
        errors.push({ key, message: 'Use um código de país com 2 ou 3 letras.' });
        continue;
      }
    }
    if (key === 'STREAM_PRIORITY' && value === '') {
      errors.push({ key, message: 'Informe ao menos um critério de prioridade.' });
      continue;
    }
    const schema = ConfigSchema.shape[key as keyof typeof ConfigSchema.shape];
    if (!schema) {
      errors.push({ key, message: 'Configuração desconhecida.' });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ key, message: issue?.message ?? 'Valor inválido.' });
      continue;
    }
    values[key] = value;
  }
  if (Object.keys(values).length === 0 && errors.length === 0) {
    errors.push({ key: '_', message: 'Nenhuma alteração informada.' });
  }
  // Regras CRUZADAS (dois campos ao mesmo tempo): salvar só o MAX dos
  // Shorts sem o MIN deixaria um .env que o script de Shorts recusa —
  // e o painel é justamente o lugar de pegar isso antes de gravar.
  const effective = (
    key:
      | 'SHORTS_MIN_SEC'
      | 'SHORTS_MAX_SEC'
      | 'SHORTS_WIDTH'
      | 'SHORTS_HEIGHT'
      | 'SHORTS_CAM_HEIGHT',
  ): number => {
    const raw = values[key] ?? current[key];
    if (raw != null && String(raw).trim() !== '') {
      const n = Number(String(raw).trim());
      if (Number.isFinite(n)) return n;
    }
    const parsed = ConfigSchema.shape[key].safeParse(undefined);
    return parsed.success ? Number(parsed.data) : 0;
  };
  errors.push(
    ...shortsCrossFieldErrors({
      minSec: effective('SHORTS_MIN_SEC'),
      maxSec: effective('SHORTS_MAX_SEC'),
      width: effective('SHORTS_WIDTH'),
      height: effective('SHORTS_HEIGHT'),
      camHeight: effective('SHORTS_CAM_HEIGHT'),
    }),
  );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
