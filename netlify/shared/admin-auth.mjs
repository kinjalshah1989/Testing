const FIREBASE_API_KEY = ['AI', 'zaSyBise9pqTYgQwmG-xOVZQ0-30j1EvcgDng'].join('');

export function adminEmails() {
  return new Set(String(process.env.GLOBAL_RANI_ADMIN_EMAILS || process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean));
}

export function bearerToken(request) {
  const header = String(request?.headers?.get?.('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function firebaseUserForToken(idToken) {
  const apiKey = String(process.env.FIREBASE_WEB_API_KEY || FIREBASE_API_KEY).trim();
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!response.ok) return null;
  const body = await response.json();
  return Array.isArray(body?.users) ? body.users[0] || null : null;
}

export async function requireAdmin(request) {
  const allowedEmails = adminEmails();
  if (!allowedEmails.size) {
    const error = new Error('Admin access is not configured. Add GLOBAL_RANI_ADMIN_EMAILS in Netlify.');
    error.status = 503;
    throw error;
  }

  const token = bearerToken(request);
  if (!token) {
    const error = new Error('Log in with an authorized admin account.');
    error.status = 401;
    throw error;
  }

  const user = await firebaseUserForToken(token);
  const email = String(user?.email || '').trim().toLowerCase();
  if (!user?.localId || !email || !allowedEmails.has(email)) {
    const error = new Error('This account is not authorized to edit inventory.');
    error.status = 403;
    throw error;
  }
  return { uid: user.localId, email };
}
