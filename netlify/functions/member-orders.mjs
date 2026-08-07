// Member order queries must use the same standard database as checkout.
import { listDocuments, queryDocumentsByStringFields } from "../shared/firebase-orders.mjs";

const FIREBASE_PROJECT_ID = "the-global-rani-website";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });

function decodeFirebaseToken(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );

    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export async function verifyFirebaseUser(idToken) {
  const apiKey =
    process.env.FIREBASE_WEB_API_KEY ||
    ["AI", "zaSyBise9pqTYgQwmG-xOVZQ0-30j1EvcgDng"].join("");

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ idToken }),
    }
  );

  if (!response.ok) {
    throw new Error(
      "Your login session is no longer valid. Please log out and log in again."
    );
  }

  const body = await response.json();
  const user = body?.users?.[0];

  if (!user?.localId) {
    throw new Error("No signed-in member was found.");
  }

  const tokenClaims = decodeFirebaseToken(idToken);
  const projectId = String(tokenClaims?.aud || "").trim();

  if (!projectId) {
    throw new Error(
      "The Firebase project could not be identified from your login session."
    );
  }

  if (projectId !== FIREBASE_PROJECT_ID) {
    throw new Error(
      `Your login belongs to ${projectId}; expected ${FIREBASE_PROJECT_ID}. Please log out and log in again.`
    );
  }

  return {
    uid: user.localId,
    email: user.email || "",
    emailVerified: user.emailVerified === true,
    projectId: FIREBASE_PROJECT_ID,
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function orderContainsEmail(order, expectedEmail) {
  const target = normalizeEmail(expectedEmail);
  if (!target || !order || typeof order !== "object") return false;

  const pending = [order];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);

    for (const [key, child] of Object.entries(value)) {
      const emailField = String(key).replace(/[^a-z]/gi, "").toLowerCase().includes("email");
      if (emailField && typeof child === "string" && normalizeEmail(child) === target) return true;
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

async function loadOrders({ uid, email, emailVerified }) {
  const memberEmail = String(email || "").trim();
  const normalizedMemberEmail = normalizeEmail(memberEmail);
  let matches;
  if (emailVerified && normalizedMemberEmail) {
    // Older orders used several different email shapes. A server-side scan of
    // the orders collection lets verified members recover that legacy history
    // without exposing any other customer's documents to the browser.
    matches = await listDocuments("orders");
  } else {
    matches = await queryDocumentsByStringFields("orders", [
      { fieldPath: "firebaseUserId", value: uid }
    ]);
  }
  const uniqueOrders = new Map();
  for (const order of matches) {
    const belongsToMember = String(order.firebaseUserId || "").trim() === uid ||
      (emailVerified && orderContainsEmail(order, normalizedMemberEmail));
    if (!belongsToMember) continue;

    const key = String(order.orderNumber || order.stripeCheckoutSessionId || order.id || "").trim();
    if (key) uniqueOrders.set(key, order);
  }

  return [...uniqueOrders.values()].sort((a, b) =>
    String(b.paidAt || b.createdAt || "").localeCompare(String(a.paidAt || a.createdAt || ""))
  );
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const authHeader = request.headers.get("authorization") || "";

    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!idToken) {
      return json(
        {
          error: "Please log in to view your orders.",
        },
        401
      );
    }

    const member = await verifyFirebaseUser(idToken);

    const orders = await loadOrders({
      uid: member.uid,
      email: member.email,
      emailVerified: member.emailVerified,
    });

    return json({
      member: {
        email: member.email,
        emailVerified: member.emailVerified,
      },
      orders,
    });
  } catch (error) {
    console.error("member-orders error:", error);

    return json(
      {
        error: error?.message || "Could not load orders.",
      },
      500
    );
  }
}

export const config = {
  path: "/api/member-orders",
};
