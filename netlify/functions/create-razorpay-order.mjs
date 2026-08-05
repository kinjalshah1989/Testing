import crypto from 'node:crypto';
import { resolveCart, usdRate, pricedUSD } from '../shared/secure-catalog.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function credentials() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) throw new Error('Razorpay is not configured yet. Add the Razorpay API credentials in Netlify.');
  return { keyId, keySecret };
}

function signCheckout(payload, keySecret) {
  const secret = process.env.CHECKOUT_SIGNING_SECRET || keySecret;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const payload = await request.json();
    const { keyId, keySecret } = credentials();
    const items = await resolveCart(payload?.items);
    const itemsUSD = pricedUSD(items, 'INR');
    const requestedTipUSD = Math.max(0, Number(payload?.tipUSD) || 0);
    const maximumTipUSD = Math.max(25, itemsUSD * 0.30);
    const tipUSD = Math.min(requestedTipUSD, maximumTipUSD);
    const rate = await usdRate('INR');
    const amountSubunits = Math.round((itemsUSD + tipUSD) * rate * 100);

    if (!Number.isSafeInteger(amountSubunits) || amountSubunits < 100) {
      return json({ error: 'The INR order total is invalid.' }, 400);
    }

    const receipt = `gr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const secureCheckout = {
      provider: 'razorpay',
      items: items.map(item => ({
        name: item.name,
        priceUSD: item.priceUSD,
        quantity: item.quantity,
        image: item.image
      })),
      currency: 'INR',
      itemsUSD: Number(itemsUSD.toFixed(2)),
      tipUSD: Number(tipUSD.toFixed(2)),
      total: Number((amountSubunits / 100).toFixed(2)),
      amountSubunits,
      exp: Date.now() + 30 * 60 * 1000
    };

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: amountSubunits,
        currency: 'INR',
        receipt,
        partial_payment: false,
        notes: {
          store: 'The Global Rani',
          destination_country: 'India'
        }
      })
    });
    const order = await response.json().catch(() => ({}));
    if (!response.ok || !order?.id) {
      console.error('Razorpay order creation failed:', response.status, order?.error?.code || order?.error?.description || 'Unknown error');
      throw new Error(order?.error?.description || 'Razorpay checkout could not be created.');
    }

    return json({
      ok: true,
      keyId,
      environment: keyId.startsWith('rzp_test_') ? 'test' : 'live',
      orderId: order.id,
      amountSubunits,
      total: secureCheckout.total.toFixed(2),
      currency: 'INR',
      checkoutToken: signCheckout(secureCheckout, keySecret)
    });
  } catch (error) {
    console.error('create-razorpay-order error:', error);
    return json({ error: error?.message || 'Razorpay checkout could not be created.' }, 500);
  }
}

export const config = { path: '/api/create-razorpay-order' };
