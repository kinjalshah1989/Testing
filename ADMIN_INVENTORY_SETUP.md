# Global Rani inventory admin setup

The private inventory screen is at `/admin-inventory.html`. It is intentionally not linked from the customer storefront.

## One-time Netlify setup

1. In Netlify, open **Project configuration → Environment variables**.
2. Add `GLOBAL_RANI_ADMIN_EMAILS`.
3. Set its value to the Firebase login email(s) allowed to edit inventory. Separate multiple emails with commas.
4. Confirm the existing Firebase server variables used by order history are still configured (`FIREBASE_SERVICE_ACCOUNT_JSON` or `FIREBASE_SERVICE_ACCOUNT_BASE64`).
5. Redeploy the site.

Example:

```text
GLOBAL_RANI_ADMIN_EMAILS=owner@example.com
```

## Use

Sign in at `/admin-inventory.html` with the authorized Firebase account. Each product has a **Mark Sold Out** or **Mark Available** button. The status is saved in the Firestore `productAvailability` collection.

Customers cannot call the update endpoint successfully: every write requires a current Firebase ID token and an email on the server-side allowlist. Sold-out products are also rejected again during server-side checkout validation, even if someone tampers with the browser cart.
