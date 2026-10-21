export interface StreamInfo {
  /** Nome exibido no HLTV (ex: "ESL_CS", "Gaules") */
  name: string;
  /** URL do embed/página (pode ser twitch url ou link HLTV) */
  url: string;
  language?: string;
  viewers?: number;
  /** true se parece stream oficial do evento (ESL, BLAST, PGL, StarLadder...) */
  isOfficialGuess?: boolean;
}

export interface LiveMatch {
  matchId: string;
  team1: string;
  team2: string;
  event: string;
  stars: number;
  isTopTierGuess: boolean;
  matchPageUrl: string;
  streams: StreamInfo[];
}

export interface KillEvent {
  killer: string;
  victim: string;
  round: number;
  map: string;
  /** Wall-clock (epoch ms) da detecção — ancora o início do clipe. */
  at?: number;
  /** Arma do kill: ak47, awp, deagle, hegrenade, molotov, knife... (minúsculo; '' = desconhecida) */
  weapon?: string;
  headshot?: boolean;
  /** Quem deu assistência no kill (dano prévio). */
  assistBy?: string;
  /** Quem cegou a vítima com flash antes do kill. */
  flashAssistBy?: string;
  throughSmoke?: boolean;
  wallbang?: boolean;
  noscope?: boolean;
}

/** Uso de granada no round (nem todo uso vira kill — dano/cegueira contam). */
export interface GrenadeUse {
  player: string;
  kind: 'he' | 'flash' | 'smoke' | 'molotov' | 'inc';
  /** Dano causado (HE/molotov) ou nº de inimigos cegados (flash). */
  value?: number;
}

/**
 * Confiança na âncora de início do clipe (a "1ª kill" do destaque).
 * Qualquer sinal ligado = a kill pode não ser a 1ª real do round.
 */
export interface AnchorConfidence {
  /** Tracker começou/retomou no meio do round (kills anteriores invisíveis). */
  joinedMidRound: boolean;
  /** Base reancorada (gap) durante este round. */
  resetThisRound: boolean;
  /** Kills do evento observadas na janela de assentamento entre rounds. */
  settleKills: number;
}

/** Resumo completo do round do ace — alimenta título, descrição, thumb e prompt IA. */
export interface RoundSummary {
  round: number;
  map: string;
  player: string;
  team: string;
  opponents: string;
  kills: KillEvent[];
  victims: string[];
  /** Armas na ordem dos kills, ex: ['ak47','ak47','awp','hegrenade','ak47'] */
  weapons: string[];
  headshots: number;
  assists: Array<{ by: string; killIndex: number }>;
  flashAssists: Array<{ by: string; killIndex: number }>;
  grenades: GrenadeUse[];
  /** Arma mais usada (para título/thumb/prompt). '' se desconhecida. */
  mainWeapon: string;
}

export interface AceEvent {
  matchId: string;
  map: string;
  round: number;
  player: string;
  team1: string;
  team2: string;
  event: string;
  detectedAt: string;
  kills: KillEvent[];
  /** ISO do 1º kill da sequência — o clipe começa ~10s antes dele. */
  startedAt?: string;
  /** ISO do fim do clipe (placar do round + CLIP_END_AFTER_CLOSE_SEC). */
  endedAt?: string;
  /** Calibração do fim do clipe pelo placar do round no vídeo. */
  streamSync?: {
    mode: 'auto' | 'log' | 'off';
    applied: boolean;
    source?: 'scoreboard';
    marker?: 'score' | 'round' | null;
    offsetMs: number | null;
    matchedKills: number;
    totalKills: number;
    medianDeviationMs: number | null;
    reason: string;
    roundEndAt?: string | null;
    scoreBefore?: string | null;
    scoreAfter?: string | null;
  };
  /**
   * Confiança na âncora de início: a "1ª kill" é a primeira OBSERVADA pelo
   * tracker — se ele entrou no meio do round, resetou a base ou a kill veio
   * da janela de assentamento entre rounds, pode não ser a 1ª kill real.
   */
  anchorConfidence?: AnchorConfidence;
  /**
   * A âncora de início é mais velha que o buffer (abertura real fora do
   * alcance): o clipe começa no material mais antigo disponível — abertura
   * sabidamente incompleta, nunca silenciosa.
   */
  truncatedStart?: boolean;
  /**
   * Restart do transcode dentro da janela do clipe: a calibragem de offset
   * pode ter mudado no meio — conferir sync (spot-check, não revisão total).
   */
  offsetUnverified?: boolean;
  /** Placar no momento do ace, ex "6-3" (team1-team2). Opcional. */
  score?: string;
  /** Placar antes/depois do fechamento do round, ex "5-2" / "6-2". */
  scoreBefore?: string;
  scoreAfter?: string;
  /** Resumo rico (armas, vítimas, assists, granadas). Ausente em modos sem detalhe (ex: VOD). */
  summary?: RoundSummary;
}

export interface ClipResult {
  filePath: string;
  sidecarPath: string;
  thumbnailPath?: string;
  durationSec: number;
}
