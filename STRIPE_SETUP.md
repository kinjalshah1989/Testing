# Stripe Checkout setup

The site now creates Stripe-hosted Checkout Sessions from Netlify Functions. Prices are resolved from the server-side product catalog, and a paid Stripe Session is verified before an order is saved or emailed.

## Required Netlify environment variables

- `STRIPE_SECRET_KEY`: your Stripe secret key. Use an `sk_test_...` key while testing and an `sk_live_...` key for production.
- `CHECKOUT_SIGNING_SECRET`: a long, random secret used only by this site to sign checkout totals. Generate one with a password manager or `openssl rand -hex 32`.

The existing Firebase and Resend variables used by `netlify/functions/create-order.mjs` are still required for order storage and notification email.

## Deploy and test

1. Add the two variables in Netlify under **Site configuration → Environment variables**.
2. Redeploy the site so the functions receive the new values.
3. With a Stripe test secret key configured, add an item, complete shipping information, and continue to Stripe Checkout.
4. Use Stripe's test card `4242 4242 4242 4242`, any future expiration date, and any CVC.
5. Confirm that the browser returns to `checkout.html`, displays the Global Rani order number, and that the order appears in Firestore and/or the notification inbox.

Do not place `STRIPE_SECRET_KEY` in HTML, client-side JavaScript, source control, or the Stripe return URL.
