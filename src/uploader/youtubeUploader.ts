import fs from 'node:fs';
import { google } from 'googleapis';
import type { AceEvent } from '../types.js';
import { buildDescription, buildTitle } from '../clipper/clipBuilder.js';
import { getLogger } from '../logger.js';
import type { VideoMetadata } from './videoMetadata.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

export function loadOAuthClient(
  clientSecretsPath: string,
  tokenPath: string,
): InstanceType<typeof google.auth.OAuth2> {
  if (!fs.existsSync(clientSecretsPath)) {
    throw new Error(
      `client_secrets.json não encontrado em ${clientSecretsPath}. Crie no Google Cloud Console (OAuth Client Desktop) e rode: npm run auth:youtube`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(clientSecretsPath, 'utf8'));
  const creds = raw.web ?? raw.installed;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  if (fs.existsSync(tokenPath)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
  }
  return oauth;
}

export function getAuthUrl(clientSecretsPath: string): string {
  const raw = JSON.parse(fs.readFileSync(clientSecretsPath, 'utf8'));
  const creds = raw.web ?? raw.installed;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  // select_account: força a tela de escolha de conta E de canal (conta de marca).
  // Quem tem vários canais (berchez + cliponera) precisa escolher cliponera aqui —
  // o token fica amarrado ao canal escolhido.
  return oauth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent select_account' });
}

export async function saveTokenFromCode(
  clientSecretsPath: string,
  tokenPath: string,
  code: string,
): Promise<void> {
  const oauth = loadOAuthClient(clientSecretsPath, tokenPath);
  const { tokens } = await oauth.getToken(code.trim());
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

export interface UploadOptions {
  clientSecretsPath: string;
  tokenPath: string;
  privacy: 'private' | 'unlisted' | 'public';
  categoryId: string;
  defaultTags: string;
  /** Caminho da thumb 1280x720 (opcional). Sobe via thumbnails.set após o vídeo. */
  thumbnailPath?: string;
  /** Metadados já gerados (IA ou template). Ausente = caminho legado. */
  metadata?: VideoMetadata;
  /**
   * O clipe só tem o REPLAY do round (o material ao vivo não estava no
   * buffer). No caminho legado (sem `metadata`) o marcador entra na
   * descrição — "publicado marcado" não pode ser só uma promessa no
   * log.
   */
  replayOnly?: boolean;
  /**
   * Vídeo vertical (9:16) do feed Shorts: garante a hashtag de
   * classificação na descrição (é a convenção do canal) e ajusta o log.
   */
  isShorts?: boolean;
  /** Hashtag usada no Shorts (default #Shorts). */
  shortsHashtag?: string;
  /**
   * Conteúdo infantil? O padrão é `false` (o YouTube não pode inferir:
   * marcar errado tira comentários e dá menos alcance).
   */
  madeForKids?: boolean;
  /**
   * Publicação agendada (ISO 8601). Ausente = publica agora.
   *
   * A API só aceita agendamento com `privacyStatus = private` (com
   * public/unlisted o `publishAt` é recusado).
   */
  publishAt?: string;
}

export interface ThumbnailAuthOptions {
  clientSecretsPath: string;
  tokenPath: string;
}

/**
 * Aplica a thumbnail num vídeo JÁ enviado (F4: a thumb é gerada DEPOIS
 * do upload, pela IA). Best-effort: devolve false em falha — o vídeo
 * segue sem ela.
 */
export async function applyThumbnail(
  videoId: string,
  thumbnailPath: string,
  opts: ThumbnailAuthOptions,
): Promise<boolean> {
  const log = getLogger();
  if (!fs.existsSync(thumbnailPath)) {
    log.warn({ videoId, thumbnailPath }, 'thumbnail não encontrada — vídeo segue sem ela');
    return false;
  }
  try {
    const auth = loadOAuthClient(opts.clientSecretsPath, opts.tokenPath);
    const youtube = google.youtube({ version: 'v3', auth });
    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType: 'image/jpeg',
        body: fs.createReadStream(thumbnailPath),
      },
    });
    log.info({ videoId }, 'thumbnail aplicada');
    return true;
  } catch (e) {
    // Thumb é cosmético: não falha o pipeline (custo 50u de quota, pode estourar antes do upload)
    log.warn({ err: String(e).slice(0, 200) }, 'falha ao aplicar thumbnail, vídeo segue sem ela');
    return false;
  }
}

/**
 * Upload sempre como private no MVP (revisão humana no YouTube Studio).
 * Quota: videos.insert tem bucket próprio (~100/dia). Projetos novos precisam
 * de auditoria para vídeos públicos — por isso private primeiro.
 */
export async function uploadClip(
  ace: AceEvent,
  filePath: string,
  opts: UploadOptions,
): Promise<string> {
  const log = getLogger();
  const auth = loadOAuthClient(opts.clientSecretsPath, opts.tokenPath);
  const youtube = google.youtube({ version: 'v3', auth });

  const title = opts.metadata
    ? opts.metadata.title
    : buildTitle(ace).slice(0, 100);
  let description = opts.metadata
    ? opts.metadata.description
    : buildDescription(ace, opts.defaultTags);
  if (opts.replayOnly === true && !description.includes('replay do round')) {
    description = `(replay do round — o material ao vivo não estava no buffer)\n\n${description}`;
  }
  const tags = opts.metadata
    ? opts.metadata.tags
    : [...new Set([...opts.defaultTags.split(',').map((t) => t.trim()).filter(Boolean), ace.player, ace.map, ace.event])].slice(0, 30);

  // A hashtag do Short entra na descrição se não estiver lá (o YouTube
  // classifica o Short pelo formato VERTICAL; a tag é a convenção do
  // canal e o que a busca enxerga).
  if (opts.isShorts) {
    const hashtag = (opts.shortsHashtag ?? '#Shorts').trim() || '#Shorts';
    const tag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
    if (!description.includes(tag)) {
      description = `${description}\n\n${tag}`;
    }
  }

  if (opts.publishAt && opts.privacy !== 'private') {
    throw new Error(
      `publicação agendada exige privacyStatus=private (recebido: ${opts.privacy})`,
    );
  }

  log.info(
    {
      title,
      privacy: opts.privacy,
      source: opts.metadata?.source ?? 'legacy',
      shorts: Boolean(opts.isShorts),
    },
    'enviando para o YouTube',
  );
  const status: {
    privacyStatus: 'private' | 'unlisted' | 'public';
    selfDeclaredMadeForKids: boolean;
    publishAt?: string;
  } = {
    privacyStatus: opts.privacy,
    selfDeclaredMadeForKids: opts.madeForKids ?? false,
  };
  if (opts.publishAt) status.publishAt = opts.publishAt;
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, tags, categoryId: opts.categoryId },
      status,
    },
    media: { body: fs.createReadStream(filePath) },
  });
  const videoId = res.data.id ?? '';
  if (!videoId) throw new Error('YouTube não retornou videoId');
  log.info(
    { videoId, privacy: opts.privacy, shorts: Boolean(opts.isShorts) },
    'upload concluído (aguardando revisão no Studio)',
  );

  if (opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
    await applyThumbnail(videoId, opts.thumbnailPath, {
      clientSecretsPath: opts.clientSecretsPath,
      tokenPath: opts.tokenPath,
    });
  }
  return videoId;
}
