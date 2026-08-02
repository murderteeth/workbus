// GitHub App integration: App JWT signing, installation-token minting,
// webhook signature verification, and App Manifest code exchange.
//
// All crypto uses Web Crypto (available in the Workers runtime). GitHub App
// private keys are delivered in PKCS#1 ("BEGIN RSA PRIVATE KEY"), which
// crypto.subtle cannot import directly, so we wrap them into PKCS#8 first.

export interface AppConfig {
  appId: number;
  privateKey: string; // PEM (PKCS#1 or PKCS#8)
  webhookSecret?: string;
  slug?: string;
  clientId?: string;
}

export interface ManifestConversion {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
  html_url: string;
}

const GH_API = "https://api.github.com";
const UA = "workbus";

// ---------------------------------------------------------------------------
// base64 / base64url helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Private key import (PKCS#1 -> PKCS#8 when needed)
// ---------------------------------------------------------------------------

// DER length prefix for a value of `n` bytes.
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

// Wrap a raw PKCS#1 RSAPrivateKey (DER) into a PKCS#8 PrivateKeyInfo (DER).
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: SEQUENCE { OID rsaEncryption, NULL }
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [...version, ...algId, ...octet];
  const seq = [0x30, ...derLength(body.length), ...body];
  return new Uint8Array(seq);
}

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return base64ToBytes(b64);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemBody(pem);
  // "BEGIN RSA PRIVATE KEY" is PKCS#1; "BEGIN PRIVATE KEY" is PKCS#8.
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// ---------------------------------------------------------------------------
// App JWT + installation tokens
// ---------------------------------------------------------------------------

export async function signAppJwt(appId: number, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
const tokenCache = new Map<number, CachedToken>();

// Mint (or return a cached) installation access token scoped to one installation.
export async function getInstallationToken(cfg: AppConfig, installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;

  const jwt = await signAppJwt(cfg.appId, cfg.privateKey);
  const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: ghHeaders(`Bearer ${jwt}`)
  });
  if (!res.ok) {
    throw new Error(`installation token mint failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
  return data.token;
}

export function ghHeaders(authorization: string): Record<string, string> {
  return {
    authorization,
    accept: "application/vnd.github+json",
    "user-agent": UA,
    "x-github-api-version": "2022-11-28"
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

export async function verifyWebhookSignature(secret: string, rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = `sha256=${bytesToHex(new Uint8Array(mac))}`;
  return timingSafeEqual(expected, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// App Manifest code -> credentials
// ---------------------------------------------------------------------------

export async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`${GH_API}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" }
  });
  if (!res.ok) {
    throw new Error(`manifest conversion failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as ManifestConversion;
}
