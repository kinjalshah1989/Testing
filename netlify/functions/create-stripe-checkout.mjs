import crypto from 'node:crypto';
import { resolveCart, usdRate, pricedUSD } from '../shared/secure-catalog.mjs';

const SUPPORTED_CURRENCIES = new Set([
  'AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
  'HKD', 'HUF', 'ILS', 'INR', 'JPY', 'MYR', 'MXN', 'NOK', 'NZD', 'PHP',
  'PLN', 'QAR', 'SAR', 'SEK', 'SGD', 'THB', 'TWD', 'USD', 'ZAR'
]);
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function signingSecret() {
  const secret = process.env.CHECKOUT_SIGNING_SECRET || process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('Stripe checkout is not configured.');
  return secret;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function toMinorUnits(amount, currency) {
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return Math.round(Number(amount) * multiplier);
}

function fromMinorUnits(amount, currency) {
  const divisor = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return Number((Number(amount) / divisor).toFixed(ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2));
}

function cleanEmail(value) {
  const email = String(value || '').trim().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function siteOrigin(request) {
  const configured = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').trim();
  const candidate = configured || new URL(request.url).origin;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The checkout return URL is invalid.');
  return parsed.origin;
}

async function createStripeSession(params) {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured in Netlify.');
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: params
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id || !data?.url) {
    throw new Error(data?.error?.message || 'Stripe Checkout could not be created.');
  }
  return data;
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const payload = await request.json();
    const currency = String(payload?.currency || 'USD').trim().toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) return json({ error: 'Unsupported currency.' }, 400);

    const shipping = payload?.shipping || {};
    const customerEmail = cleanEmail(shipping?.customerEmail);
    if (!cleanText(shipping?.customerName, 180) || !customerEmail || !cleanText(shipping?.shippingAddress1, 240) || !cleanText(shipping?.shippingCity, 120) || !cleanText(shipping?.shippingZip, 40)) {
      return json({ error: 'Complete shipping details are required before payment.' }, 400);
    }

    const items = await resolveCart(payload?.items);
    const itemsUSD = pricedUSD(items, currency);
    const requestedTip = Math.max(0, Number(payload?.tipUSD) || 0);
    const maxTip = Math.max(25, itemsUSD * 0.30);
    const tipUSD = Math.min(requestedTip, maxTip);
    const rate = await usdRate(currency);
    const indiaDiscount = currency === 'INR' ? 0.5 : 1;
    const reference = crypto.randomUUID();
    const origin = siteOrigin(request);
    const params = new URLSearchParams({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      success_url: `${origin}/checkout.html?stripe_session_id={CHECKOUT_SESSION_ID}#checkout`,
      cancel_url: `${origin}/checkout.html?stripe_cancelled=1#checkout`,
      client_reference_id: reference,
      submit_type: 'pay',
      'metadata[store]': 'global_rani',
      'metadata[checkout_reference]': reference,
      expires_at: String(Math.floor(Date.now() / 1000) + (30 * 60)),
      'payment_intent_data[description]': 'The Global Rani jewelry order',
      'payment_intent_data[metadata][store]': 'global_rani',
      'payment_intent_data[metadata][checkout_reference]': reference
    });

    params.set('customer_email', customerEmail);

    let amountTotal = 0;
    items.forEach((item, index) => {
      const unitAmount = toMinorUnits(item.priceUSD * indiaDiscount * rate, currency);
      if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) throw new Error(`Invalid price for ${item.name}.`);
      amountTotal += unitAmount * item.quantity;
      params.set(`line_items[${index}][quantity]`, String(item.quantity));
      params.set(`line_items[${index}][price_data][currency]`, currency.toLowerCase());
      params.set(`line_items[${index}][price_data][unit_amount]`, String(unitAmount));
      params.set(`line_items[${index}][price_data][product_data][name]`, String(item.name).slice(0, 180));
      if (/^https:\/\//i.test(String(item.image || ''))) {
        params.set(`line_items[${index}][price_data][product_data][images][0]`, String(item.image).slice(0, 1000));
      }
    });

    const tipAmount = toMinorUnits(tipUSD * rate, currency);
    if (tipAmount > 0) {
      if (items.length >= 100) return json({ error: 'The cart has too many separate items to add a tip.' }, 400);
      const index = items.length;
      amountTotal += tipAmount;
      params.set(`line_items[${index}][quantity]`, '1');
      params.set(`line_items[${index}][price_data][currency]`, currency.toLowerCase());
      params.set(`line_items[${index}][price_data][unit_amount]`, String(tipAmount));
      params.set(`line_items[${index}][price_data][product_data][name]`, 'Tip');
    }

    if (!Number.isSafeInteger(amountTotal) || amountTotal <= 0) {
      return json({ error: 'Invalid order total.' }, 400);
    }

    const checkoutPayload = {
      reference,
      items: items.map(item => ({
        name: item.name,
        priceUSD: item.priceUSD,
        quantity: item.quantity,
        image: item.image
      })),
      currency,
      amountTotal,
      itemsUSD: Number(itemsUSD.toFixed(2)),
      tipUSD: Number(tipUSD.toFixed(2)),
      exp: Date.now() + 35 * 60 * 1000
    };
    const checkoutToken = sign(checkoutPayload);
    const session = await createStripeSession(params);
    return json({
      ok: true,
      sessionId: session.id,
      url: session.url,
      checkoutToken,
      amountTotal,
      total: fromMinorUnits(amountTotal, currency),
      currency
    });
  } catch (error) {
    console.error('create-stripe-checkout error:', error);
    return json({ error: error?.message || 'Stripe Checkout could not be created.' }, 500);
  }
}

export const config = { path: '/api/create-stripe-checkout' };
