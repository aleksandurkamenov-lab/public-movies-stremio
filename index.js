const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const manifest = {
  id: 'org.aleksandarkamenov.publicmovies',
  version: '1.1.0',
  name: 'Public Movies',
  description: 'Search public-domain movies on Internet Archive',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['ia_'],
  catalogs: [{
    type: 'movie',
    id: 'public-movies',
    name: 'Internet Archive Movies',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false }
    ]
  }]
};

const builder = new addonBuilder(manifest);

const PAGE_SIZE = 30;

// Internet Archive sometimes returns fields as arrays
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

function toMeta(item) {
  return {
    id: `ia_${item.identifier}`,
    type: 'movie',
    name: first(item.title) || item.identifier,
    poster: `https://archive.org/services/img/${encodeURIComponent(item.identifier)}`,
    description: item.description
      ? String(first(item.description)).replace(/<[^>]*>/g, '').slice(0, 1200)
      : 'Public-domain movie from Internet Archive.',
    year: item.year ? Number(String(first(item.year)).slice(0, 4)) || undefined : undefined,
    website: `https://archive.org/details/${encodeURIComponent(item.identifier)}`
  };
}

builder.defineCatalogHandler(async ({ extra }) => {
  try {
    const docs = await searchArchive(extra?.search || '', Number(extra?.skip) || 0);
    return { metas: docs.map(toMeta) };
  } catch (error) {
    console.error('Catalog error:', error.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const identifier = id.replace(/^ia_/, '');
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
        description: String(first(metadata.description) || first(metadata.title) || '')
          .replace(/<[^>]*>/g, '').slice(0, 3000),
        website: `https://archive.org/details/${encodeURIComponent(identifier)}`
      }
    };
  } catch (error) {
    console.error('Meta error:', error.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  const identifier = id.replace(/^ia_/, '');
  const response = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`
  );
  if (!response.ok) return { streams: [] };

  const data = await response.json();
  const license = String(first(data.metadata?.licenseurl) || '').toLowerCase();

  // Only expose items explicitly marked as public domain.
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
      title: 'Internet Archive · Public Domain',
      name: file.name,
      url: streamUrl
    }]
  };
});

const PORT = Number(process.env.PORT) || 7001;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Public Movies running on port ${PORT}`);
