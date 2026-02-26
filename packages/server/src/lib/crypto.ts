import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

const DATA_DIR = resolve(homedir(), '.funny');
const KEY_PATH = resolve(DATA_DIR, 'encryption.key');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const _AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

/** Load or generate the 256-bit encryption key. */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(readFileSync(KEY_PATH, 'utf-8').trim(), 'hex');
  } else {
    cachedKey = randomBytes(32);
    writeFileSync(KEY_PATH, cachedKey.toString('hex'), { mode: 0o600 });
  }

  return cachedKey;
}

/**
 * Encrypt a plaintext string.
 * Returns a hex-encoded string in the format: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string (iv:authTag:ciphertext format).
 * Returns null if decryption fails (e.g. corrupted data or wrong key).
 */
export function decrypt(encrypted: string): string | null {
  try {
    const parts = encrypted.split(':');
    if (parts.length !== 3) return null;

    const [ivHex, authTagHex, ciphertext] = parts;
    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch {
    return null;
  }
}
