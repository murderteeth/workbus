// Dashboard auth: signed session cookies + small cookie/OAuth helpers.
// Sessions are stateless: a base64url(JSON) payload + HMAC-SHA256 signature,
// signed with a per-deployment secret stored in app_config.session_secret.

const enc = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Session {
  login: string;
  exp: number; // unix seconds
}

export async function signSession(secret: string, session: Session): Promise<string> {
  const payload = bytesToB64url(enc.encode(JSON.stringify(session)));
  const sig = bytesToB64url(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

export async function verifySession(secret: string, token: string | undefined): Promise<Session | undefined> {
  if (!token) return undefined;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return undefined;
  const expected = bytesToB64url(await hmac(secret, payload));
  if (!timingSafeEqual(expected, sig)) return undefined;
  try {
    const session = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as Session;
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return undefined;
    return session;
  } catch {
    return undefined;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { maxAge?: number } = {}): string {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${opts.maxAge}`;
  return c;
}

export function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
