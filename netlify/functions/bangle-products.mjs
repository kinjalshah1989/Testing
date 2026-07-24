const IMAGEKIT_FOLDER = '/global-rani-bangles';
const SERVER_CACHE_TTL = 15 * 60 * 1000;
let memoryCache = null;

function json(body, status = 200, cacheStatus = 'MISS', noStore = false) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': noStore || status !== 200
        ? 'no-store, max-age=0'
        : 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400',
      'X-Global-Rani-Cache': cacheStatus
    }
  });
}

function normalizePath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}
function filePathOf(file) { return normalizePath(file.filePath || file.path || ''); }
function parentFolder(file) {
  const path = filePathOf(file);
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
function titleFromId(id) {
  return String(id || '').split('-').filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function numberValue(value, fallback = 45) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function booleanValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off', 'inactive'].includes(String(value).trim().toLowerCase());
}
async function fetchAllFiles(privateKey) {
  const authorization = Buffer.from(`${privateKey}:`).toString('base64');
  const collected = [];
  const pageSize = 100;
  for (let skip = 0; skip < 5000; skip += pageSize) {
    const params = new URLSearchParams({ limit: String(pageSize), skip: String(skip) });
    const response = await fetch(`https://api.imagekit.io/v1/files?${params}`, {
      headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' }
    });
    const bodyText = await response.text();
    if (!response.ok) return { ok: false, status: response.status, detail: bodyText };
    let page;
    try { page = JSON.parse(bodyText); }
    catch { return { ok: false, status: 502, detail: 'ImageKit returned invalid JSON.' }; }
    if (!Array.isArray(page)) break;
    collected.push(...page);
    if (page.length < pageSize) break;
  }
  return { ok: true, files: collected };
}

function parseProductImage(filename) {
  const value = String(filename || '').trim();
  if (!/\.(png|jpe?g|webp|avif)$/i.test(value)) return null;
  if (/(?:^|-)(ar|transparent|tryon)(?:-|\.)/i.test(value)) return null;
  const numbered = value.match(/^(.*?)(?:-bangles|-bangle|-kadas|-kada|-set)?-([123])\.(png|jpe?g|webp|avif)$/i);
  if (numbered) {
    return {
      baseId: numbered[1].replace(/-(bangles?|kadas?|set)$/i, ''),
      slide: Number(numbered[2])
    };
  }
  const single = value.match(/^(.*?)\.(png|jpe?g|webp|avif)$/i);
  if (!single) return null;
  return { baseId: single[1].replace(/-(bangles?|kadas?|set)$/i, ''), slide: 1 };
}


function mediaTokens(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.(png|jpe?g|webp|avif|gif)$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean);
}
function normalizedMediaStem(value) {
  const ignored = new Set([
    'set','sets','earring','earrings','bangle','bangles','kada','kadas',
    'ar','try','on','tryon','transparent','transparency','overlay','cutout',
    'box','jewelry','jewellery','opening','open','animation','animated','gif','image','img'
  ]);
  return mediaTokens(value).filter(token => !ignored.has(token)).join('-');
}
function mediaKind(filename) {
  const name = String(filename || '').toLowerCase();
  const tokens = new Set(mediaTokens(name));
  const isGif = /\.gif(?:$|\?)/i.test(name) ||
    ((tokens.has('box') || tokens.has('jewelry') || tokens.has('jewellery')) &&
     (tokens.has('opening') || tokens.has('open') || tokens.has('animation') || tokens.has('animated')));
  const isAr = tokens.has('ar') || tokens.has('tryon') ||
    (tokens.has('try') && tokens.has('on')) || tokens.has('transparent') ||
    tokens.has('transparency') || tokens.has('overlay') || tokens.has('cutout');
  return { isGif, isAr };
}
function findAssociatedMedia(allFiles, baseId, kind) {
  const wanted = normalizedMediaStem(baseId);
  if (!wanted) return null;
  const candidates = allFiles.filter(file => {
    const detected = mediaKind(file.name);
    if (kind === 'gif' && !detected.isGif) return false;
    if (kind === 'ar' && !detected.isAr) return false;
    return normalizedMediaStem(file.name) === wanted;
  });
  // Prefer a file in a media-specific folder, then the newest upload.
  candidates.sort((a, b) => {
    const aPath = String(a.filePath || a.path || '').toLowerCase();
    const bPath = String(b.filePath || b.path || '').toLowerCase();
    const aPreferred = /(ar|try.?on|gif|box|animation)/.test(aPath) ? 1 : 0;
    const bPreferred = /(ar|try.?on|gif|box|animation)/.test(bPath) ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
  return candidates[0] || null;
}

export default async function handler(request) {
  const forceRefresh = (() => {
    try { return new URL(request.url).searchParams.get('refresh') === '1'; }
    catch { return false; }
  })();
  if (!forceRefresh && memoryCache && Date.now() - memoryCache.savedAt < SERVER_CACHE_TTL) {
    return json(memoryCache.body, 200, 'HIT');
  }

  try {
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    if (!privateKey) return json({ error: 'IMAGEKIT_PRIVATE_KEY is missing in Netlify.' }, 500);

    const result = await fetchAllFiles(privateKey);
    if (!result.ok) {
      return json({
        error: 'ImageKit could not be read.',
        status: result.status,
        imageKitMessage: result.detail
      }, 502);
    }

    const wantedFolder = normalizePath(IMAGEKIT_FOLDER);
    const allFiles = result.files;
    const files = allFiles.filter(file => {
      const folder = parentFolder(file);
      return folder === wantedFolder || folder.startsWith(`${wantedFolder}/`);
    });
    const byName = new Map(files.map(file => [String(file.name || '').trim().toLowerCase(), file]));
    const groups = new Map();

    for (const file of files) {
      const parsed = parseProductImage(file.name);
      if (!parsed || !parsed.baseId) continue;
      const key = parsed.baseId.toLowerCase();
      if (!groups.has(key)) groups.set(key, { baseId: parsed.baseId, slides: new Map() });
      if (!groups.get(key).slides.has(parsed.slide)) groups.get(key).slides.set(parsed.slide, file);
    }

    const products = [];
    for (const { baseId, slides } of groups.values()) {
      const orderedImages = [...slides.entries()].sort((a, b) => a[0] - b[0]).map(([, file]) => file);
      if (!orderedImages.length) continue;
      const first = orderedImages[0];
      const metadata = first.customMetadata || {};
      if (!booleanValue(metadata.active, true)) continue;
      const arFile = findAssociatedMedia(allFiles, baseId, 'ar');
      const gifFile = findAssociatedMedia(allFiles, baseId, 'gif');

      products.push({
        id: `${baseId}-bangles`,
        name: metadata.productName || metadata.name || titleFromId(baseId),
        description: metadata.description || metadata.productDescription || 'Statement bangles and kadas from The Global Rani collection.',
        price: numberValue(metadata.price ?? metadata.priceUSD, 45),
        category: metadata.category || 'Bangles & Kadas',
        images: orderedImages.map(file => file.url),
        image: first.url,
        arImage: arFile?.url || '',
        boxGif: gifFile?.url || ''
      });
    }

    products.sort((a, b) => a.name.localeCompare(b.name));
    const payload = {
      products,
      count: products.length,
      folder: wantedFolder,
      filesSeenInProductFolder: files.length,
      filenamesSeen: files.map(file => file.name)
    };
    memoryCache = { savedAt: Date.now(), body: payload };
    return json(payload, 200, forceRefresh ? 'REFRESH' : 'MISS', forceRefresh);
  } catch (error) {
    return json({ error: 'Bangle products could not be loaded.', detail: error?.message || String(error) }, 500);
  }
}

export const config = { path: '/api/bangle-products' };
