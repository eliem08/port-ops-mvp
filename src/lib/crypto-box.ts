// Authenticated encryption for secrets stored in the database (e.g. TOTP
// seeds). AES-256-GCM with a random 96-bit IV per value.
// Key: DATA_ENCRYPTION_KEY when set (recommended, so AUTH_SECRET can rotate
// independently), otherwise derived from the session secret via HKDF.
// Format: "v1.<iv>.<tag>.<ciphertext>" (base64url parts).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getSecretBytes } from "./auth-secret";

function key(): Buffer {
  const explicit = process.env.DATA_ENCRYPTION_KEY;
  const ikm = explicit ? Buffer.from(explicit) : Buffer.from(getSecretBytes());
  return Buffer.from(hkdfSync("sha256", ikm, "portops-data-key", "aes-256-gcm v1", 32));
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Decrypts a sealed value; throws if it was tampered with or the key changed. */
export function open(sealed: string): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("malformed sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
