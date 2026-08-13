import { requireAdmin } from '../shared/admin-auth.mjs';
import { listAvailability, saveAvailability } from '../shared/inventory-status.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

export default async function handler(request) {
  if (!['GET', 'POST'].includes(request.method)) {
    return json({ error: 'Method not allowed.' }, 405);
  }
  try {
    const admin = await requireAdmin(request);
    if (request.method === 'GET') {
      const overrides = await listAvailability({ fresh: true, strict: true });
      return json({ authorized: true, email: admin.email, overrides });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request body.' }, 400);
    const product = await saveAvailability({
      productType: body.productType,
      productId: body.productId,
      productName: body.productName,
      available: body.available,
      updatedBy: admin.email
    });
    return json({ ok: true, product });
  } catch (error) {
    return json({ error: error?.message || 'Inventory update failed.' }, Number(error?.status) || 500);
  }
}

export const config = { path: '/api/admin-inventory' };
