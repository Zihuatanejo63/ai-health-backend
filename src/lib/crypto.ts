/**
 * AES-256-GCM encryption for health data at rest.
 * Uses Web Crypto API (available in Cloudflare Workers).
 *
 * Encryption key is derived from DATA_ENCRYPTION_KEY environment variable
 * using SHA-256 to produce a consistent 256-bit key.
 */

const ENCRYPTION_ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for GCM

async function getKey(envKey: string): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(envKey);
  const hash = await crypto.subtle.digest("SHA-256", keyMaterial);
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: ENCRYPTION_ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(data: unknown, envKey: string): Promise<string> {
  if (!envKey) throw new Error("DATA_ENCRYPTION_KEY is not configured.");

  const key = await getKey(envKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = await crypto.subtle.encrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    plaintext
  );

  // Pack IV + ciphertext into a single base64 string
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptJson<T = unknown>(encrypted: string, envKey: string): Promise<T> {
  if (!envKey) throw new Error("DATA_ENCRYPTION_KEY is not configured.");

  const key = await getKey(envKey);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
