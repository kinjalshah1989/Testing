# Stripe, Firebase, and Resend payment fulfillment

The storefront creates Stripe-hosted Checkout Sessions from Netlify Functions. Before redirecting the customer to Stripe, the server saves a pending checkout in Firebase. Stripe then calls a signed webhook after payment; that webhook creates the paid order in Firebase and triggers Resend to email Global Rani. The customer is returned directly to `thank-you.html`, which safely checks the payment status on the server.

The webhook is the source of truth. The order and email do not depend on the customer keeping the browser open or successfully returning from Stripe.

## Required Netlify environment variables

### Stripe

- `STRIPE_SECRET_KEY`: Stripe secret key. Use `sk_test_...` while testing and `sk_live_...` in production.
- `STRIPE_WEBHOOK_SECRET`: signing secret for this site's Stripe webhook endpoint. It begins with `whsec_...`.
- `CHECKOUT_SIGNING_SECRET`: a long random secret used only by this site to sign checkout totals.

### Firebase / Firestore

Use one complete service-account value:

- `FIREBASE_SERVICE_ACCOUNT_BASE64`: base64-encoded Firebase service-account JSON; or
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete service-account JSON.

The service account needs permission to read and write Cloud Firestore. The code stores pending payments in `checkout_intents` and paid orders in `orders`.

The storefront is intentionally locked to Firebase project ID `the-global-rani-website` and Firestore database ID `(default)`. Do not create or configure a named `globalrani` database for checkout data. The Firebase service account must belong to `the-global-rani-website`; a key from another project is rejected with a clear configuration error.

### Resend

- `RESEND_API_KEY`: Resend API key.
- `ORDER_FROM_EMAIL`: a sender on a domain verified in Resend, such as `The Global Rani <orders@yourdomain.com>`.
- `ORDER_NOTIFICATION_EMAIL`: the Global Rani inbox that receives every paid-order email.

Every paid checkout sends two separate Resend messages:

- an internal order notification to `ORDER_NOTIFICATION_EMAIL`; and
- a customer confirmation to the validated customer email collected by checkout or Stripe.

No separate customer-recipient environment variable is needed. Both messages use `ORDER_FROM_EMAIL`, so its domain must be verified in Resend. Each message has its own idempotency key based on the Global Rani order number, and Firestore tracks `adminEmailStatus` and `customerEmailStatus` independently so Stripe webhook retries do not resend a message that already succeeded.

The member Previous Orders page matches paid orders by Firebase user ID. After Firebase verifies that the member owns the email address, it also includes earlier guest purchases made with that email. Results from `customerEmail`, Stripe `payerEmail`, and normalized email fields are combined, deduplicated by order number, and displayed newest first. New accounts automatically receive a Firebase verification email, and existing members can use the Verify Email button in Order Summary.

## Add the Stripe webhook

After deploying the site:

1. In Stripe Dashboard, open **Developers → Webhooks** and add an endpoint.
2. Use `https://YOUR-SITE-DOMAIN/api/stripe-webhook` as the endpoint URL.
3. Subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Copy the endpoint's `whsec_...` signing secret into Netlify as `STRIPE_WEBHOOK_SECRET`.
5. Redeploy after adding or changing environment variables.

## Test the complete flow

1. Configure Stripe test-mode keys and the test webhook signing secret.
2. Add an item, complete shipping information, and continue to Stripe Checkout.
3. Use Stripe test card `4242 4242 4242 4242`, any future expiration date, and any CVC.
4. Confirm the browser opens `thank-you.html` and shows the paid order number.
5. Confirm Firestore contains the paid order under `orders` and its matching record under `checkout_intents`.
6. Confirm `ORDER_NOTIFICATION_EMAIL` receives the Resend paid-order notification.
7. Confirm the checkout/customer email receives the customer-friendly order confirmation.
8. In Firestore, confirm the order has both `adminEmailStatus: SENT` and `customerEmailStatus: SENT`.

Never place Stripe, Firebase, or Resend secrets in HTML, browser JavaScript, source control, or a return URL.
