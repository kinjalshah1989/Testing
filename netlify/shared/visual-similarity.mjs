import crypto from 'node:crypto';
import sharp from 'sharp';

const DEFAULT_THRESHOLD = 0.89;
const HASH_WIDTH = 17;
const HASH_HEIGHT = 16;

function transformedImageKitUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  // Ask ImageKit for a tiny, low-bandwidth source. Sharp still performs the
  // final grayscale normalization before the comparison.
  if (/\/tr:[^/]+\//i.test(url)) return url;
  return url.replace('/k0wpvuatq/', '/k0wpvuatq/tr:w-96,h-96,c-at_max,q-60/');
}

async function fetchBuffer(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function differenceHash(imageUrl) {
  const buffer = await fetchBuffer(transformedImageKitUrl(imageUrl));
  const { data } = await sharp(buffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .grayscale()
    .normalize()
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bits = [];
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    const row = y * HASH_WIDTH;
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      bits.push(data[row + x] > data[row + x + 1] ? 1 : 0);
    }
  }
  return bits;
}

function similarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1;
  return same / a.length;
}

function normalizedDesignWords(product) {
  const ignored = new Set([
    'set','jewelry','jewellery','necklace','earring','earrings','the',
    'red','ruby','green','blue','pink','gulabi','topaz','black','white','gold',
    'golden','silver','purple','yellow','orange','teal','maroon','multicolor',
    'navratna','emerald','panna','neelam','pukhraj','scarlet','pastel'
  ]);
  return String(product?.name || product?.id || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word && !ignored.has(word));
}

function nameSimilarity(a, b) {
  const left = new Set(normalizedDesignWords(a));
  const right = new Set(normalizedDesignWords(b));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach(word => { if (right.has(word)) overlap += 1; });
  return overlap / Math.max(left.size, right.size);
}

function groupIdForMembers(members) {
  const ids = members.map(item => String(item.id)).sort().join('|');
  return `visual-${crypto.createHash('sha256').update(ids).digest('hex').slice(0, 16)}`;
}

export async function assignVisualPriceGroups(products, options = {}) {
  const threshold = Number(options.threshold ?? process.env.SET_VISUAL_SIMILARITY_THRESHOLD ?? DEFAULT_THRESHOLD);
  const items = Array.isArray(products) ? products : [];
  const hashes = await Promise.all(items.map(async product => {
    const override = String(product.visualGroupOverride || '').trim();
    if (override) return { override, hash: null, error: '' };
    try {
      return { override: '', hash: await differenceHash(product.image || product.images?.[0]), error: '' };
    } catch (error) {
      return { override: '', hash: null, error: error?.message || String(error) };
    }
  }));

  const parent = items.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (hashes[i].override || hashes[j].override) {
        if (hashes[i].override && hashes[i].override === hashes[j].override) union(i, j);
        continue;
      }
      if (!hashes[i].hash || !hashes[j].hash) continue;
      const visualScore = similarity(hashes[i].hash, hashes[j].hash);
      const designNameScore = nameSimilarity(items[i], items[j]);
      // A strong image match groups automatically. A slightly weaker image
      // match is accepted only when the color-stripped design names also agree.
      const matched = visualScore >= threshold || (visualScore >= threshold - 0.045 && designNameScore >= 0.66);
      if (matched) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, index) => {
    const override = hashes[index].override;
    const key = override ? `override:${override}` : `root:${find(index)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, index });
  });

  const diagnostics = [];
  for (const members of groups.values()) {
    const groupItems = members.map(entry => entry.item);
    const explicit = members.map(entry => hashes[entry.index].override).find(Boolean);
    const groupId = explicit ? `visual-${explicit}` : groupIdForMembers(groupItems);
    for (const { item, index } of members) {
      item.visualPriceGroup = groupId;
      item.visualSimilarityStatus = hashes[index].hash || explicit ? 'grouped' : 'fallback';
      if (hashes[index].error) item.visualSimilarityError = hashes[index].error;
    }
    diagnostics.push({
      groupId,
      productIds: groupItems.map(item => item.id),
      count: groupItems.length
    });
  }

  return { products: items, groups: diagnostics, threshold };
}
