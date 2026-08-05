# Razorpay checkout setup

The checkout now routes India orders to Razorpay in INR. Other countries continue to use PayPal.

## Before enabling live payments

1. Apply for Razorpay's foreign-merchant “Accept Payments From Indian Customers” feature and have UPI enabled for the account.
2. In the Netlify site, open **Site configuration → Environment variables**.
3. Add these server-only values:
   - `RAZORPAY_KEY_ID`
   - `RAZORPAY_KEY_SECRET`
   - `CHECKOUT_SIGNING_SECRET` (recommended; use a long random value)
4. Redeploy the site after saving the variables.

Never place `RAZORPAY_KEY_SECRET` in HTML, JavaScript, Git, or a public configuration file. The site exposes only the publishable key ID to Razorpay Checkout.

## Testing

Use Razorpay test credentials first (`rzp_test_...`). Select India as the shipping country, verify the shipping information, and proceed to payment. The checkout should show a Razorpay button and open Razorpay Standard Checkout in INR.

When the foreign-merchant account is approved, replace the test credentials with the live credentials and redeploy. UPI will appear only when it has been enabled for the live merchant account and the order/customer is eligible.
