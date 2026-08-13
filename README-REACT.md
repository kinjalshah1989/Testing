# Global Rani — React migration

This package moves the Global Rani front end onto React + Vite while preserving the existing HTML page markup and existing Netlify serverless backend.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy to Netlify

Upload/connect this project to Netlify. `netlify.toml` already uses:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

The SPA redirect keeps existing links such as `/account.html` and `/categories/jewelry-sets.html` working through React.

## Migration approach

The original pages are kept in `public/legacy/` as page templates and loaded by the React root. This is a compatibility-first migration: it gets the site onto React without rewriting thousands of lines at once and without intentionally changing checkout, inventory, AR try-on, or product behavior.

For future development, individual sections can now be extracted into native React components one at a time.
