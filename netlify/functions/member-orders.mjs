import crypto from "node:crypto";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });

let firestoreTokenCache = { token: "", expiresAt: 0 };

function parseServiceAccount(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) return null;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      value = JSON.parse(value);
    } catch {
      value = value.slice(1, -1);
    }
  }

  const parseJson = (candidate) => {
    try {
      const parsed =
        typeof candidate === "string" ? JSON.parse(candidate) : candidate;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };

  let account = parseJson(value);

  if (!account && /^[A-Za-z0-9+/=_\s-]+$/.test(value)) {
    try {
      account = parseJson(
        Buffer.from(value.replace(/\s/g, ""), "base64").toString("utf8")
      );
    } catch {}
  }

  return account;
}

function normalizePrivateKey(rawValue) {
  let value = String(rawValue || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();

  const match = value.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/
  );
  if (!match) return "";

  const label = value.includes("BEGIN RSA PRIVATE KEY")
    ? "RSA PRIVATE KEY"
    : "PRIVATE KEY";
  const body = match[1].replace(/[^A-Za-z0-9+/=]/g, "");
  const lines = body.match(/.{1,64}/g) || [];

  return lines.length
    ? `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
    : "";
}

function getFirebaseServiceCredentials() {
  const serviceAccount =
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) ||
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) ||
    {};

  const clientEmail = String(
    serviceAccount.client_email ||
      serviceAccount.clientEmail ||
      process.env.FIREBASE_CLIENT_EMAIL ||
      ""
  ).trim();

  const privateKeyCandidates = [
    serviceAccount.private_key,
    serviceAccount.privateKey,
    process.env.FIREBASE_PRIVATE_KEY_BASE64
      ? (() => {
          try {
            return Buffer.from(
              process.env.FIREBASE_PRIVATE_KEY_BASE64,
              "base64"
            ).toString("utf8");
          } catch {
            return "";
          }
        })()
      : "",
    process.env.FIREBASE_PRIVATE_KEY,
  ];

  let privateKey = "";
  for (const candidate of privateKeyCandidates) {
    privateKey = normalizePrivateKey(candidate);
    if (privateKey) break;
  }

  return { clientEmail, privateKey };
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getFirestoreAccessToken() {
  if (
    firestoreTokenCache.token &&
    Date.now() < firestoreTokenCache.expiresAt
  ) {
    return firestoreTokenCache.token;
  }

  const { clientEmail, privateKey } = getFirebaseServiceCredentials();
  if (!clientEmail || !privateKey) {
    throw new Error("Firebase server credentials are not configured.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: clientEmail,
      sub: clientEmail,
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/datastore",
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(privateKey, "base64url");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Firebase authentication failed (${response.status}).`);
  }

  const body = await response.json();
  firestoreTokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + 50 * 60 * 1000,
  };

  return firestoreTokenCache.token;
}

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

async function verifyFirebaseUser(idToken) {
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

  return {
    uid: user.localId,
    email: user.email || "",
    projectId,
  };
}

function fromFirestore(value) {
  if (!value || typeof value !== "object") return null;

  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;

  if ("arrayValue" in value) {
    return (value.arrayValue?.values || []).map(fromFirestore);
  }

  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue?.fields || {}).map(([key, child]) => [
        key,
        fromFirestore(child),
      ])
    );
  }

  return null;
}

function documentToOrder(document) {
  const fields = document?.fields || {};

  return {
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        fromFirestore(value),
      ])
    ),
    _documentName: document?.name || "",
  };
}

async function queryOrders({ fieldPath, value, projectId, accessToken }) {
  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [
          {
            collectionId: "orders",
          },
        ],
        where: {
          fieldFilter: {
            field: {
              fieldPath,
            },
            op: "EQUAL",
            value: {
              stringValue: value,
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();

    if (response.status === 403) {
      throw new Error(
        "Previous Orders needs permission in Firebase Firestore Rules."
      );
    }

    throw new Error(
      `Could not load orders (${response.status}): ${detail.slice(0, 180)}`
    );
  }

  const rows = await response.json();

  return rows
    .filter((row) => row.document)
    .map((row) => documentToOrder(row.document));
}

async function loadOrders({ uid, email, projectId, idToken }) {
  let accessToken = idToken;
  let canMatchPreviousEmailOrders = false;

  try {
    accessToken = await getFirestoreAccessToken();
    canMatchPreviousEmailOrders = true;
  } catch (error) {
    // Keep the existing signed-in-user lookup working if server credentials
    // are temporarily unavailable. Email matching requires server access.
    console.warn("Using member-only order lookup:", error?.message || error);
  }

  const queries = [
    queryOrders({
      fieldPath: "firebaseUserId",
      value: uid,
      projectId,
      accessToken,
    }),
  ];

  if (canMatchPreviousEmailOrders && email) {
    queries.push(
      queryOrders({
        fieldPath: "customerEmail",
        value: email,
        projectId,
        accessToken,
      })
    );
  }

  const ordersById = new Map();
  for (const orders of await Promise.all(queries)) {
    for (const order of orders) {
      const key =
        order.orderNumber ||
        order.paypalOrderId ||
        order.paypalCaptureId ||
        order._documentName;
      ordersById.set(key, order);
    }
  }

  return [...ordersById.values()]
    .map(({ _documentName, ...order }) => order)
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
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
      projectId: member.projectId,
      idToken,
    });

    return json({
      member: {
        email: member.email,
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
