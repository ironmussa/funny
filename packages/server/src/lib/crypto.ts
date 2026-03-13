import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import { DATA_DIR } from './data-dir.js';

const KEY_PATH = resolve(DATA_DIR, 'encryption.key');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  if (existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(readFileSync(KEY_PATH, 'utf-8').trim(), 'hex');
  } else {
    cachedKey = randomBytes(32);
    writeFileSync(KEY_PATH, cachedKey.toString('hex'), { mode: 0o600 });
  }

  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

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
