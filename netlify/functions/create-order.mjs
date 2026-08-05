import crypto from 'node:crypto';


function parseServiceAccount(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return null;

  // Remove one wrapping layer of quotes if Netlify stored the value that way.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); }
    catch { value = value.slice(1, -1); }
  }
  value = String(value).trim();

  const parseJson = (candidate) => {
    try {
      const parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  };

  let account = parseJson(value);
  if (!account && /^[A-Za-z0-9+/=_-]+$/.test(value.replace(/\s/g, ''))) {
    try {
      const decoded = Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8').trim();
      account = parseJson(decoded);
      if (!account && decoded.includes('BEGIN ')) account = { private_key: decoded };
    } catch {}
  }
  return account;
}

function normalizePrivateKey(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';
  value = value
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  const match = value.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/);
  if (!match) return '';
  const label = value.includes('BEGIN RSA PRIVATE KEY') ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) return '';
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function getFirebaseCredentials() {
  const serviceAccount =
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) ||
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) ||
    {};

  const projectId = String(
    serviceAccount.project_id || serviceAccount.projectId || process.env.FIREBASE_PROJECT_ID || ''
  ).trim();
  const clientEmail = String(
    serviceAccount.client_email || serviceAccount.clientEmail || process.env.FIREBASE_CLIENT_EMAIL || ''
  ).trim();

  const privateKeyCandidates = [
    serviceAccount.private_key,
    serviceAccount.privateKey,
    process.env.FIREBASE_PRIVATE_KEY_BASE64
      ? (() => { try { return Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8'); } catch { return ''; } })()
      : '',
    process.env.FIREBASE_PRIVATE_KEY
  ];
  let privateKey = '';
  for (const candidate of privateKeyCandidates) {
    privateKey = normalizePrivateKey(candidate);
    if (privateKey) break;
  }
  return { projectId, clientEmail, privateKey };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map(item => ({
    name: cleanText(item?.name, 180),
    quantity: Math.max(1, Math.min(99, Number(item?.quantity) || 1)),
    image: cleanText(item?.image, 1000),
    priceUSD: Number.isFinite(Number(item?.priceUSD)) ? Number(item.priceUSD) : null
  })).filter(item => item.name);
}


function verifyCheckoutToken(token, paymentProvider) {
  const providerSecret = paymentProvider === 'razorpay'
    ? process.env.RAZORPAY_KEY_SECRET
    : process.env.PAYPAL_CLIENT_SECRET;
  const secret = process.env.CHECKOUT_SIGNING_SECRET || providerSecret;
  if (!secret) throw new Error('Checkout signing secret is not configured.');
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw new Error('Secure checkout token is missing.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Checkout validation failed.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload?.exp || Date.now() > Number(payload.exp)) throw new Error('Checkout session expired. Please try again.');
  return payload;
}

function razorpayCredentials() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) throw new Error('Razorpay server credentials are not configured.');
  return { keyId, keySecret };
}

async function razorpayRequest(path, options = {}) {
  const { keyId, keySecret } = razorpayCredentials();
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.description || `Razorpay verification failed (${response.status}).`);
  }
  return data;
}

async function verifyRazorpayPayment({ serverOrderId, paymentId, signature, secureCheckout }) {
  const { keySecret } = razorpayCredentials();
  const expected = crypto.createHmac('sha256', keySecret)
    .update(`${serverOrderId}|${paymentId}`)
    .digest('hex');
  const suppliedBuffer = Buffer.from(String(signature || ''));
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error('Razorpay payment signature is invalid.');
  }

  let payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`);
  if (payment?.order_id !== serverOrderId) throw new Error('Razorpay payment does not belong to this order.');
  if (Number(payment?.amount) !== Number(secureCheckout?.amountSubunits)) throw new Error('Paid amount does not match the secure server price.');
  if (String(payment?.currency || '').toUpperCase() !== 'INR') throw new Error('Razorpay payment currency must be INR.');

  if (payment?.status === 'authorized') {
    payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}/capture`, {
      method: 'POST',
      body: JSON.stringify({ amount: Number(secureCheckout.amountSubunits), currency: 'INR' })
    });
  }
  if (payment?.status !== 'captured' && payment?.captured !== true) {
    throw new Error('Razorpay has not confirmed a captured payment.');
  }

  const order = await razorpayRequest(`/orders/${encodeURIComponent(serverOrderId)}`);
  if (Number(order?.amount) !== Number(secureCheckout?.amountSubunits) || String(order?.currency || '').toUpperCase() !== 'INR') {
    throw new Error('Razorpay order details do not match the secure checkout.');
  }
  return { order, payment };
}
function getPayPalBaseUrl() {
  return String(process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PayPal server credentials are not configured.');
  const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status}).`);
  return (await response.json()).access_token;
}

async function verifyPayPalOrder(orderId) {
  const token = await getPayPalAccessToken();
  const response = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`PayPal order verification failed (${response.status}).`);
  const order = await response.json();
  const captures = (order.purchase_units || []).flatMap(unit => unit?.payments?.captures || []);
  const completedCapture = captures.find(capture => capture?.status === 'COMPLETED');
  if (order.status !== 'COMPLETED' || !completedCapture) throw new Error('PayPal has not confirmed a completed payment.');
  return { order, capture: completedCapture };
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

async function getGoogleAccessToken() {
  const { clientEmail, privateKey } = getFirebaseCredentials();
  if (!clientEmail || !privateKey) throw new Error('Firebase server credentials are not configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey, 'base64url');
  } catch (error) {
    throw new Error('Firebase private key could not be decoded. Use FIREBASE_SERVICE_ACCOUNT_BASE64 as described in ORDER_STORAGE_SETUP.md.');
  }
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) throw new Error(`Firebase authentication failed (${response.status}).`);
  return (await response.json()).access_token;
}

function firestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, firestoreValue(val)])) } };
  }
  return { stringValue: String(value) };
}

async function saveOrderToFirestore(orderId, orderData) {
  const { projectId } = getFirebaseCredentials();
  if (!projectId) throw new Error('Firebase project ID is not configured.');
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/orders?documentId=${encodeURIComponent(orderId)}`;
  const fields = Object.fromEntries(Object.entries(orderData).map(([key, value]) => [key, firestoreValue(value)]));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Firestore save failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

async function sendOrderEmail(orderData) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ORDER_NOTIFICATION_EMAIL;
  const from = process.env.ORDER_FROM_EMAIL;
  if (!apiKey || !to || !from) throw new Error('Order email environment variables are not configured.');
  const items = orderData.items.map(item => `<li>${escapeHtml(item.name)} × ${item.quantity}</li>`).join('');
  const address = orderData.shippingAddress;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: orderData.customerEmail || undefined,
      subject: `New Global Rani order ${orderData.orderNumber}`,
      html: `
        <h2>New paid Global Rani order</h2>
        <p><strong>Order:</strong> ${escapeHtml(orderData.orderNumber)}</p>
        <p><strong>Payment provider:</strong> ${escapeHtml(orderData.paymentProvider)}</p>
        <p><strong>Payment method:</strong> ${escapeHtml(orderData.paymentMethod)}</p>
        <p><strong>Payment reference:</strong> ${escapeHtml(orderData.paymentReference)}</p>
        <p><strong>Paid:</strong> ${escapeHtml(orderData.amount)} ${escapeHtml(orderData.currency)}</p>
        <h3>Customer</h3>
        <p>${escapeHtml(orderData.customerName)}<br>${escapeHtml(orderData.customerEmail)}<br>${escapeHtml(orderData.customerPhone)}</p>
        <h3>Shipping address</h3>
        <p>${escapeHtml(address.line1)}<br>${escapeHtml(address.line2)}<br>${escapeHtml(address.city)}, ${escapeHtml(address.state)} ${escapeHtml(address.postalCode)}<br>${escapeHtml(address.country)}</p>
        <h3>Items</h3><ul>${items}</ul>
        <p><strong>Notes:</strong> ${escapeHtml(orderData.notes)}</p>`
    })
  });
  if (!response.ok) throw new Error(`Order email failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const payload = await request.json();
    const paymentProvider = cleanText(payload?.paymentProvider, 20).toLowerCase() === 'razorpay' ? 'razorpay' : 'paypal';
    const secureCheckout = verifyCheckoutToken(payload?.checkoutToken, paymentProvider);
    if (secureCheckout?.provider && secureCheckout.provider !== paymentProvider) {
      throw new Error('Payment provider does not match the secure checkout.');
    }

    let providerOrderId = '';
    let paymentReference = '';
    let amount = '';
    let currency = '';
    let payerEmail = '';
    let paymentMethod = '';
    let paypalCaptureId = '';
    let razorpayPaymentId = '';
    let razorpayOrderId = '';

    if (paymentProvider === 'razorpay') {
      razorpayOrderId = cleanText(payload?.razorpayOrderId, 120);
      razorpayPaymentId = cleanText(payload?.razorpayPaymentId, 120);
      const razorpaySignature = cleanText(payload?.razorpaySignature, 256);
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return json({ error: 'Complete Razorpay payment confirmation is required.' }, 400);
      }
      const { payment } = await verifyRazorpayPayment({
        serverOrderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
        secureCheckout
      });
      providerOrderId = razorpayOrderId;
      paymentReference = razorpayPaymentId;
      amount = (Number(payment.amount) / 100).toFixed(2);
      currency = payment.currency || 'INR';
      payerEmail = cleanText(payment.email, 254);
      paymentMethod = cleanText(payment.method, 40);
    } else {
      const paypalOrderId = cleanText(payload?.paypalOrderId, 120);
      if (!paypalOrderId) return json({ error: 'PayPal order ID is required.' }, 400);
      const { order, capture } = await verifyPayPalOrder(paypalOrderId);
      providerOrderId = paypalOrderId;
      paypalCaptureId = cleanText(capture?.id, 120);
      paymentReference = paypalCaptureId || paypalOrderId;
      amount = capture?.amount?.value || order?.purchase_units?.[0]?.amount?.value || '';
      currency = capture?.amount?.currency_code || order?.purchase_units?.[0]?.amount?.currency_code || '';
      payerEmail = cleanText(order?.payer?.email_address, 254);
      paymentMethod = 'card';
    }

    if (String(currency).toUpperCase() !== String(secureCheckout.currency).toUpperCase()) throw new Error('Paid currency does not match the secure checkout.');
    if (Math.abs(Number(amount) - Number(secureCheckout.total)) > 0.01) throw new Error('Paid amount does not match the secure server price.');
    const profile = payload?.shipping || {};
    if (paymentProvider === 'razorpay' && String(profile?.shippingCountry || '').trim().toLowerCase() !== 'india') {
      throw new Error('Razorpay checkout is available only for orders shipping to India.');
    }
    const orderNumber = `GR-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${paymentReference.slice(-8).toUpperCase()}`;
    const orderData = {
      orderNumber,
      paymentProvider: paymentProvider === 'razorpay' ? 'Razorpay' : 'PayPal',
      paymentReference,
      paymentMethod,
      providerOrderId,
      paypalOrderId: paymentProvider === 'paypal' ? providerOrderId : '',
      paypalCaptureId,
      razorpayOrderId,
      razorpayPaymentId,
      paymentStatus: 'PAID',
      amount: cleanText(amount, 30),
      currency: cleanText(currency, 10),
      createdAt: new Date().toISOString(),
      fulfillmentStatus: 'NEW',
      firebaseUserId: cleanText(payload?.firebaseUserId, 160),
      checkoutMode: cleanText(payload?.checkoutMode, 20),
      customerName: cleanText(profile?.customerName, 180),
      customerEmail: cleanText(profile?.customerEmail, 254),
      customerPhone: cleanText(profile?.customerPhone, 60),
      shippingAddress: {
        line1: cleanText(profile?.shippingAddress1, 240),
        line2: cleanText(profile?.shippingAddress2, 240),
        city: cleanText(profile?.shippingCity, 120),
        state: cleanText(profile?.shippingState, 120),
        postalCode: cleanText(profile?.shippingZip, 40),
        country: cleanText(profile?.shippingCountry, 120)
      },
      deliveryNotes: cleanText(profile?.deliveryNotes, 1000),
      notes: cleanText(profile?.profileNotes, 1000),
      items: cleanItems(secureCheckout.items),
      tipUSD: Number(secureCheckout.tipUSD) || 0,
      payerEmail
    };
    if (!orderData.customerName || !orderData.customerEmail || !orderData.shippingAddress.line1 || !orderData.shippingAddress.city || !orderData.shippingAddress.postalCode) {
      return json({ error: 'Complete shipping details are required.' }, 400);
    }

    const results = await Promise.allSettled([
      saveOrderToFirestore(orderNumber, orderData),
      sendOrderEmail(orderData)
    ]);
    const stored = results[0].status === 'fulfilled';
    const emailed = results[1].status === 'fulfilled';
    if (!stored && !emailed) {
      console.error('Order persistence failed', results.map(result => result.status === 'rejected' ? result.reason?.message : 'ok'));
      return json({ error: `Payment succeeded, but the order record could not be delivered. Please contact support with your ${paymentProvider === 'razorpay' ? 'Razorpay payment ID' : 'PayPal order ID'}.` }, 500);
    }
    return json({ ok: true, orderNumber, stored, emailed });
  } catch (error) {
    console.error('create-order error:', error);
    return json({ error: error?.message || 'Order could not be recorded.' }, 500);
  }
}

export const config = { path: '/api/create-order' };
