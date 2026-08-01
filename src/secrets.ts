// Envelope encryption for user-provided workflow secrets (AES-256-GCM).
//
// The 256-bit master key lives ONLY as a Worker secret (SECRETS_MASTER_KEY),
// never in D1 alongside the ciphertext. Each value is stored as
// base64(iv[12] || ciphertext+tag).

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(masterKeyB64);
  if (raw.length !== 32) throw new Error("SECRETS_MASTER_KEY must be 32 bytes (base64-encoded)");
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(masterKeyB64: string, plaintext: string): Promise<string> {
  const key = await importMasterKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

export async function decryptSecret(masterKeyB64: string, blob: string): Promise<string> {
  const key = await importMasterKey(masterKeyB64);
  const data = base64ToBytes(blob);
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct as unknown as ArrayBuffer);
  return new TextDecoder().decode(pt);
}

// Workflow secret names follow the GitHub/env-var convention.
export function isValidSecretName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}
