import crypto from 'node:crypto';
import { listDocuments, setDocument } from './firebase-orders.mjs';

const COLLECTION = 'productAvailability';
const CACHE_TTL = 2 * 1000;
let cache = { savedAt: 0, documents: [] };

export function inventoryKey(productType, productId) {
  const type = String(productType || '').trim().toLowerCase();
  const id = String(productId || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(type) || !id || id.length > 180) {
    throw new Error('A valid product type and product ID are required.');
  }
  return `${type}:${id}`;
}

function documentIdFor(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function normalizeProductName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function listAvailability({ fresh = false, strict = false } = {}) {
  if (!fresh && cache.savedAt && Date.now() - cache.savedAt < CACHE_TTL) {
    return cache.documents;
  }
  try {
    const documents = await listDocuments(COLLECTION, { pageSize: 300, maxPages: 20 });
    cache = { savedAt: Date.now(), documents };
    return documents;
  } catch (error) {
    if (strict) throw error;
    console.warn(`Inventory availability could not be read: ${error?.message || error}`);
    return cache.documents;
  }
}

export function availabilityIndexes(documents = []) {
  const byKey = new Map();
  const byName = new Map();
  for (const document of documents) {
    const key = String(document?.productKey || '').trim().toLowerCase();
    const name = normalizeProductName(document?.productName);
    if (key) byKey.set(key, document);
    if (name) byName.set(name, document);
  }
  return { byKey, byName };
}

export function applyAvailability(products, productType, documents = []) {
  const { byKey, byName } = availabilityIndexes(documents);
  return (Array.isArray(products) ? products : []).map(product => {
    const key = inventoryKey(productType, product?.id);
    const override = byKey.get(key) || byName.get(normalizeProductName(product?.name));
    const available = override ? override.available !== false : true;
    return {
      ...product,
      productType,
      availabilityKey: key,
      available,
      availabilityLabel: available ? 'Available' : 'Sold Out'
    };
  });
}

export async function decorateCatalogPayload(payload, productType) {
  const documents = await listAvailability();
  const copy = JSON.parse(JSON.stringify(payload || {}));
  copy.products = applyAvailability(copy.products, productType, documents);

  if (Array.isArray(copy.collections)) {
    const productsById = new Map(copy.products.map(product => [String(product.id), product]));
    copy.collections = copy.collections.map(collection => {
      const variants = (Array.isArray(collection.variants) ? collection.variants : []).map(variant =>
        productsById.get(String(variant.id)) || applyAvailability([variant], productType, documents)[0]
      );
      const available = variants.length ? variants.some(variant => variant.available !== false) : true;
      return {
        ...collection,
        variants,
        available,
        availabilityLabel: available ? 'Available' : 'Sold Out'
      };
    });
  }
  return copy;
}

export async function applyAvailabilityToSecureCatalog(catalog) {
  const documents = await listAvailability();
  const { byName } = availabilityIndexes(documents);
  return Object.fromEntries(Object.entries(catalog || {}).map(([key, product]) => {
    const override = byName.get(normalizeProductName(product?.name));
    return [key, { ...product, available: override ? override.available !== false : true }];
  }));
}

export async function saveAvailability({ productType, productId, productName, available, updatedBy }) {
  const key = inventoryKey(productType, productId);
  const name = String(productName || '').trim().slice(0, 160);
  if (!name) throw new Error('Product name is required.');
  if (typeof available !== 'boolean') throw new Error('Availability must be true or false.');

  const document = await setDocument(COLLECTION, documentIdFor(key), {
    productKey: key,
    productType: String(productType).trim().toLowerCase(),
    productId: String(productId).trim(),
    productName: name,
    available,
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || '').trim().toLowerCase()
  });
  cache = { savedAt: 0, documents: [] };
  return document;
}

export function resetAvailabilityCacheForTests() {
  cache = { savedAt: 0, documents: [] };
}
