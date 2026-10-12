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
  /** Placar no momento do ace, ex "6-3" (team1-team2). Opcional. */
  score?: string;
  /** Resumo rico (armas, vítimas, assists, granadas). Ausente em modos sem detalhe (ex: VOD). */
  summary?: RoundSummary;
}

export interface ClipResult {
  filePath: string;
  sidecarPath: string;
  thumbnailPath?: string;
  durationSec: number;
}
