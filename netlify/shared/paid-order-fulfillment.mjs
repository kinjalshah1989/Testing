import { createDocument, getDocument, patchDocument } from './firebase-orders.mjs';

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanEmail(value) {
  const email = cleanText(value, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map(item => ({
    name: cleanText(item?.name, 180),
    quantity: Math.max(1, Math.min(99, Math.floor(Number(item?.quantity) || 1))),
    image: cleanText(item?.image, 1000),
    priceUSD: Number.isFinite(Number(item?.priceUSD)) ? Number(item.priceUSD) : null
  })).filter(item => item.name);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function displayAmount(amountMinor, currency) {
  if (!Number.isSafeInteger(Number(amountMinor))) return '';
  return ZERO_DECIMAL_CURRENCIES.has(currency)
    ? String(amountMinor)
    : (Number(amountMinor) / 100).toFixed(2);
}

export function orderNumberForSession(session) {
  const createdAt = Number(session?.created) > 0 ? new Date(Number(session.created) * 1000) : new Date();
  const date = createdAt.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = cleanText(session?.id, 180).replace(/[^A-Za-z0-9]/g, '').slice(-12).toUpperCase();
  if (!suffix) throw new Error('Stripe Checkout session ID is missing.');
  return `GR-${date}-${suffix}`;
}

function validatePaidSession(session) {
  if (session?.mode !== 'payment' || session?.metadata?.store !== 'global_rani') {
    throw new Error('This Stripe Checkout session does not belong to The Global Rani.');
  }
  if (session?.status !== 'complete' || session?.payment_status !== 'paid') {
    throw new Error('Stripe has not confirmed a paid Checkout Session.');
  }
  const reference = cleanText(session?.metadata?.checkout_reference || session?.client_reference_id, 180);
  if (!reference) throw new Error('Stripe Checkout reference is missing.');
  return reference;
}

function buildOrderData(session, pending, stripeEventId) {
  const reference = validatePaidSession(session);
  if (reference !== cleanText(pending?.reference, 180)) throw new Error('Stripe and Firebase checkout references do not match.');
  const amountMinor = Number(session?.amount_total);
  const currency = cleanText(session?.currency, 10).toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Stripe payment amount is invalid.');
  if (amountMinor !== Number(pending?.amountMinor)) throw new Error('Stripe payment amount does not match the pending Firebase order.');
  if (currency !== cleanText(pending?.currency, 10).toUpperCase()) throw new Error('Stripe currency does not match the pending Firebase order.');

  const orderNumber = orderNumberForSession(session);
  const shipping = pending?.shippingAddress || {};
  return {
    orderNumber,
    checkoutReference: reference,
    stripeCheckoutSessionId: cleanText(session.id, 180),
    stripePaymentIntentId: cleanText(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id, 180),
    stripeEventId: cleanText(stripeEventId, 180),
    paymentStatus: 'PAID',
    amountMinor,
    amount: displayAmount(amountMinor, currency),
    currency,
    createdAt: new Date().toISOString(),
    paidAt: Number(session.created) > 0 ? new Date(Number(session.created) * 1000).toISOString() : new Date().toISOString(),
    fulfillmentStatus: 'NEW',
    emailStatus: 'PENDING',
    firebaseUserId: cleanText(pending?.firebaseUserId, 180),
    checkoutMode: cleanText(pending?.checkoutMode, 30),
    customerName: cleanText(pending?.customerName, 180),
    customerEmail: cleanEmail(pending?.customerEmail),
    customerPhone: cleanText(pending?.customerPhone, 60),
    shippingAddress: {
      line1: cleanText(shipping?.line1, 240),
      line2: cleanText(shipping?.line2, 240),
      city: cleanText(shipping?.city, 120),
      state: cleanText(shipping?.state, 120),
      postalCode: cleanText(shipping?.postalCode, 40),
      country: cleanText(shipping?.country, 120)
    },
    deliveryNotes: cleanText(pending?.deliveryNotes, 1000),
    notes: cleanText(pending?.notes, 1000),
    items: cleanItems(pending?.items),
    tipUSD: Number(pending?.tipUSD) || 0,
    payerEmail: cleanEmail(session?.customer_details?.email || session?.customer_email)
  };
}

async function sendGlobalRaniEmail(order) {
  const apiKey = cleanText(process.env.RESEND_API_KEY, 500);
  const to = cleanEmail(process.env.ORDER_NOTIFICATION_EMAIL);
  const from = cleanText(process.env.ORDER_FROM_EMAIL, 254);
  if (!apiKey || !to || !from) {
    throw new Error('RESEND_API_KEY, ORDER_NOTIFICATION_EMAIL, and ORDER_FROM_EMAIL must be configured.');
  }

  const items = order.items.map(item => `<li>${escapeHtml(item.name)} × ${item.quantity}</li>`).join('');
  const address = order.shippingAddress;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `global-rani-order-${order.orderNumber}`
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: order.customerEmail || order.payerEmail || undefined,
      subject: `Paid Global Rani order ${order.orderNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#34210e;line-height:1.55">
          <h1 style="color:#9e1533">New paid Global Rani order</h1>
          <p><strong>Order:</strong> ${escapeHtml(order.orderNumber)}</p>
          <p><strong>Stripe session:</strong> ${escapeHtml(order.stripeCheckoutSessionId)}</p>
          <p><strong>Stripe payment:</strong> ${escapeHtml(order.stripePaymentIntentId)}</p>
          <p><strong>Paid:</strong> ${escapeHtml(order.amount)} ${escapeHtml(order.currency)}</p>
          <h2>Customer</h2>
          <p>${escapeHtml(order.customerName)}<br>${escapeHtml(order.customerEmail)}<br>${escapeHtml(order.customerPhone)}</p>
          <h2>Shipping address</h2>
          <p>${escapeHtml(address.line1)}<br>${escapeHtml(address.line2)}<br>${escapeHtml(address.city)}, ${escapeHtml(address.state)} ${escapeHtml(address.postalCode)}<br>${escapeHtml(address.country)}</p>
          <h2>Items</h2><ul>${items}</ul>
          <p><strong>Delivery notes:</strong> ${escapeHtml(order.deliveryNotes)}</p>
          <p><strong>Profile notes:</strong> ${escapeHtml(order.notes)}</p>
        </div>`
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.message || `Resend notification failed (${response.status}).`);
  return result;
}

export async function fulfillPaidCheckout(session, stripeEventId = '') {
  const reference = validatePaidSession(session);
  const pending = await getDocument('checkout_intents', reference);
  if (!pending) throw new Error(`Pending Firebase checkout ${reference} was not found.`);
  const order = buildOrderData(session, pending, stripeEventId);
  const created = await createDocument('orders', order.orderNumber, order);
  const existing = created.document || {};

  await patchDocument('checkout_intents', reference, {
    status: 'PAYMENT_CONFIRMED',
    orderNumber: order.orderNumber,
    stripeCheckoutSessionId: order.stripeCheckoutSessionId,
    paymentConfirmedAt: new Date().toISOString()
  });

  if (!created.created && existing.emailStatus === 'SENT') {
    return { orderNumber: order.orderNumber, alreadyProcessed: true, emailed: true };
  }

  try {
    const email = await sendGlobalRaniEmail(order);
    await patchDocument('orders', order.orderNumber, {
      emailStatus: 'SENT',
      emailId: cleanText(email?.id, 180),
      emailSentAt: new Date().toISOString(),
      emailError: ''
    });
    await patchDocument('checkout_intents', reference, {
      status: 'FULFILLED',
      notificationEmailStatus: 'SENT',
      fulfilledAt: new Date().toISOString()
    });
    return { orderNumber: order.orderNumber, alreadyProcessed: !created.created, emailed: true };
  } catch (error) {
    const message = cleanText(error?.message || error, 500);
    try {
      await patchDocument('orders', order.orderNumber, { emailStatus: 'FAILED', emailError: message });
      await patchDocument('checkout_intents', reference, { notificationEmailStatus: 'FAILED', emailError: message });
    } catch (updateError) {
      console.error('Unable to record Resend failure:', updateError?.message || updateError);
    }
    throw error;
  }
}

export async function orderStatusForSession(session) {
  const reference = validatePaidSession(session);
  const pending = await getDocument('checkout_intents', reference);
  const orderNumber = cleanText(pending?.orderNumber, 180) || orderNumberForSession(session);
  const order = await getDocument('orders', orderNumber);
  const currency = cleanText(session.currency, 10).toUpperCase();
  return {
    paid: true,
    processing: !order || order.emailStatus !== 'SENT',
    orderNumber: order?.orderNumber || orderNumber,
    customerName: cleanText(order?.customerName || pending?.customerName, 180),
    amountMinor: Number(session.amount_total) || 0,
    amount: displayAmount(Number(session.amount_total), currency),
    currency,
    emailStatus: cleanText(order?.emailStatus || pending?.notificationEmailStatus || 'PENDING', 30),
    fulfillmentStatus: cleanText(order?.fulfillmentStatus || 'NEW', 30)
  };
}
