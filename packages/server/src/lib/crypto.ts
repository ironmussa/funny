/**
 * Server-side crypto wrapper.
 *
 * The actual implementation now lives in `@funny/shared/lib/crypto` and is
 * shared with the runtime (Security ME-11). This file just wires in the
 * server's keyring source and structured logger and re-exports the public API
 * so existing imports (`from '../lib/crypto.js'`) keep working.
 */
import { createCrypto, type CryptoApi } from '@funny/shared/lib/crypto';

import { log } from './logger.js';
import { serverKeyringSource } from './server-secrets.js';

// The keyring source (data dir files, or FUNNY_ENCRYPTION_KEYS) is chosen by
// server-secrets.ts and resolved on first use.
const api: CryptoApi = createCrypto({
  keyring: serverKeyringSource,
  log: {
    warn: (msg, meta) => log.warn(msg, meta),
    info: (msg, meta) => log.info(msg, meta),
  },
});

export const encrypt = (plaintext: string) => api.encrypt(plaintext);
export const decrypt = (encrypted: string) => api.decrypt(encrypted);
export const rotateKey = () => api.rotateKey();
export const reencrypt = (encrypted: string) => api.reencrypt(encrypted);
export const isLegacyCiphertext = (encrypted: string) => api.isLegacyCiphertext(encrypted);
export const isEncryptedWithActiveKey = (encrypted: string) =>
  api.isEncryptedWithActiveKey(encrypted);
