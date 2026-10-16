const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const manifest = {
  id: 'org.aleksandarkamenov.publicmovies',
  version: '1.2.0',
  name: 'Public Movies',
  description: 'Search Internet Archive and PlayTube videos',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['ia_', 'pt_'],
  catalogs: [
    {
      type: 'movie',
      id: 'public-movies',
      name: 'Internet Archive Movies',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'movie',
      id: 'playtube-videos',
      name: 'PlayTube Videos',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ]
};

const builder = new addonBuilder(manifest);

const PAGE_SIZE = 30;
const PLAYTUBE_PAGE_SIZE = 20;
const PLAYTUBE_ORIGIN = 'https://playtube.tv';

// Internet Archive sometimes returns fields as arrays.
function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function searchArchive(search = '', skip = 0) {
  const query = search.trim()
    ? `mediatype:movies AND licenseurl:http*publicdomain* AND title:(${search.trim().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' AND ')})`
    : 'mediatype:movies AND licenseurl:http*publicdomain*';

  const url = new URL('https://archive.org/advancedsearch.php');
  url.searchParams.set('q', query);
  url.searchParams.set('fl[]', 'identifier');
  url.searchParams.append('fl[]', 'title');
  url.searchParams.append('fl[]', 'description');
  url.searchParams.append('fl[]', 'year');
  url.searchParams.append('fl[]', 'licenseurl');
  url.searchParams.set('rows', String(PAGE_SIZE));
  url.searchParams.set('page', String(Math.floor(skip / PAGE_SIZE) + 1));
  url.searchParams.append('sort[]', 'downloads desc');
  url.searchParams.set('output', 'json');

  const response = await fetch(url, {
    headers: { 'User-Agent': 'PublicMoviesStremioAddon/1.0' }
  });
  if (!response.ok) throw new Error(`Internet Archive: HTTP ${response.status}`);
  const data = await response.json();
  return data.response?.docs || [];
}

function toArchiveMeta(item) {
  const identifier = String(item.identifier || '');
  return {
    id: `ia_${identifier}`,
    type: 'movie',
    name: first(item.title) || identifier,
    poster: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    description: item.description
      ? `Internet Archive description (rights not independently verified): ${String(first(item.description)).replace(/<[^>]*>/g, '').slice(0, 1100)}`
      : 'Listed on Internet Archive. Verify its rights on the item page.',
    year: item.year ? Number(String(first(item.year)).slice(0, 4)) || undefined : undefined,
    website: `https://archive.org/details/${encodeURIComponent(identifier)}`
  };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function htmlText(value) {
  return decodeHtml(String(value || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function safePlayTubeWatchUrl(value) {
  try {
    const url = new URL(value, PLAYTUBE_ORIGIN);
    if (url.protocol !== 'https:' || url.hostname !== 'playtube.tv' || !url.pathname.startsWith('/watch/')) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeThumbnail(value) {
  try {
    const url = new URL(value, PLAYTUBE_ORIGIN);
    if (url.protocol !== 'https:' || !['playtube.tv', 'i.ytimg.com'].includes(url.hostname)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function playTubeId(item) {
  // Keep the catalog metadata with the opaque ID so meta/stream requests
  // remain deterministic across Render restarts and multiple instances.
  return `pt_${Buffer.from(JSON.stringify(item)).toString('base64url')}`;
}

function decodePlayTubeId(id) {
  try {
    const encoded = String(id).slice(3);
    if (!encoded || encoded.length > 12000) return null;
    const item = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const website = safePlayTubeWatchUrl(item.website);
    if (!website || typeof item.name !== 'string' || !item.name.trim()) return null;
    return {
      id: String(id),
      type: 'movie',
      name: item.name.slice(0, 500),
      poster: safeThumbnail(item.poster),
      description: typeof item.description === 'string' ? item.description.slice(0, 1200) : 'Video listed on PlayTube.',
      website
    };
  } catch {
    return null;
  }
}

function parsePlayTubeResults(html) {
  const source = String(html || '');
  const starts = [...source.matchAll(
    /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bvideo-wrapper\b[^"']*["'])(?=[^>]*\bdata-identifier\s*=\s*(["'])(.*?)\1)[^>]*>/gi
  )];

  return starts.flatMap((match, index) => {
    const start = match.index;
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const card = source.slice(start, end);
    const identifier = decodeHtml(match[2] || '').trim();

    const thumbAnchor = card.match(
      /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bthumb\b[^"']*["'])[^>]*>[\s\S]*?<\/a>/i
    )?.[0] || '';
    const watchTag = thumbAnchor.match(/<a\b[^>]*>/i)?.[0] || '';
    const website = safePlayTubeWatchUrl(attribute(watchTag, 'href'));
    const imageTag = thumbAnchor.match(/<img\b[^>]*>/i)?.[0] || '';
    const titleMatch = card.match(/<h[34]\b[^>]*>([\s\S]*?)<\/h[34]>/i);
    const name = htmlText(titleMatch?.[1]);
    const poster = safeThumbnail(attribute(imageTag, 'src') || attribute(imageTag, 'data-src'));
    const wrapperTag = match[0];
    const views = attribute(wrapperTag, 'data-views');

    if (!identifier || !website || !name) return [];
    const item = {
      name,
      poster,
      description: views ? `${views} views · Listed on PlayTube. Rights are not verified.` : 'Listed on PlayTube. Rights are not verified.',
      website
    };
    return [{ ...item, id: playTubeId(item), type: 'movie' }];
  });
}

async function searchPlayTube(search = '', skip = 0) {
  const keyword = String(search || '').trim();
  if (!keyword) return [];

  const url = new URL('/search', PLAYTUBE_ORIGIN);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('page_id', String(Math.floor(skip / PLAYTUBE_PAGE_SIZE) + 1));

  const response = await fetch(url, {
    headers: { 'User-Agent': 'PublicMoviesStremioAddon/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`PlayTube: HTTP ${response.status}`);
  return parsePlayTubeResults(await response.text());
}

async function findEmbeddedYouTubeId(watchUrl) {
  const response = await fetch(watchUrl, {
    headers: { 'User-Agent': 'PublicMoviesStremioAddon/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`PlayTube watch page: HTTP ${response.status}`);

  const html = await response.text();
  const iframeTags = html.match(/<iframe\b[^>]*>/gi) || [];
  for (const tag of iframeTags) {
    const src = attribute(tag, 'src');
    try {
      const url = new URL(src, watchUrl);
      if (!['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
        continue;
      }
      const match = url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})(?:\/|$)/);
      if (match) return match[1];
    } catch {
      // Ignore malformed or non-YouTube iframe URLs.
    }
  }
  return null;
}

builder.defineCatalogHandler(async ({ id, extra }) => {
  try {
    const search = extra?.search || '';
    const skip = Math.max(0, Number(extra?.skip) || 0);
    if (id === 'playtube-videos') {
      return { metas: await searchPlayTube(search, skip) };
    }
    const docs = await searchArchive(search, skip);
    return { metas: docs.map(toArchiveMeta) };
  } catch (error) {
    console.error('Catalog error:', error.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  if (String(id).startsWith('pt_')) {
    return { meta: decodePlayTubeId(id) };
  }

  try {
    const identifier = String(id).replace(/^ia_/, '');
    const response = await fetch(
      `https://archive.org/metadata/${encodeURIComponent(identifier)}`
    );
    if (!response.ok) return { meta: null };

    const data = await response.json();
    const metadata = data.metadata || {};

    return {
      meta: {
        id,
        type: 'movie',
        name: first(metadata.title) || identifier,
        poster: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
        description: `Internet Archive metadata (rights not independently verified): ${String(first(metadata.description) || first(metadata.title) || '')
          .replace(/<[^>]*>/g, '').slice(0, 2900)}`,
        website: `https://archive.org/details/${encodeURIComponent(identifier)}`
      }
    };
  } catch (error) {
    console.error('Meta error:', error.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  if (String(id).startsWith('pt_')) {
    const meta = decodePlayTubeId(id);
    if (!meta) return { streams: [] };
    try {
      const ytId = await findEmbeddedYouTubeId(meta.website);
      if (ytId) {
        return {
          streams: [{
            name: 'PlayTube.tv · YouTube',
            description: 'YouTube video embedded by PlayTube.tv',
            ytId
          }]
        };
      }
    } catch (error) {
      console.error('PlayTube stream lookup error:', error.message);
    }
    return {
      streams: [{
        name: 'PlayTube.tv',
        description: 'No embedded YouTube video found. Open the PlayTube page in a browser.',
        externalUrl: meta.website
      }]
    };
  }

  const identifier = String(id).replace(/^ia_/, '');
  const response = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`
  );
  if (!response.ok) return { streams: [] };

  const data = await response.json();
  const license = String(first(data.metadata?.licenseurl) || '').toLowerCase();

  // Only expose Internet Archive items explicitly marked as public domain.
  if (!license.includes('publicdomain')) return { streams: [] };

  const files = (data.files || []).filter(file => {
    const name = String(file.name || '').toLowerCase();
    const format = String(file.format || '').toLowerCase();
    return !file.private &&
      /\.(mp4|m4v|webm|ogv)$/.test(name) &&
      /mpeg4|h\.264|webm|ogg video|quicktime/i.test(format);
  });

  const file = files.find(f => /\.mp4$/i.test(f.name)) || files[0];
  if (!file) return { streams: [] };

  const streamUrl =
    `https://archive.org/download/${encodeURIComponent(identifier)}/` +
    file.name.split('/').map(encodeURIComponent).join('/');

  return {
    streams: [{
      title: 'Internet Archive · marked public domain (verify item rights)',
      name: file.name,
      url: streamUrl
    }]
  };
});

const PORT = Number(process.env.PORT) || 7001;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Public Movies running on port ${PORT}`);
