/**
 * Server-side crypto wrapper.
 *
 * The actual implementation now lives in `@funny/shared/lib/crypto` and is
 * shared with the runtime (Security ME-11). This file just wires in the
 * server's DATA_DIR and structured logger and re-exports the public API
 * so existing imports (`from '../lib/crypto.js'`) keep working.
 */
import { createCrypto, type CryptoApi } from '@funny/shared/lib/crypto';

import { DATA_DIR } from './data-dir.js';
import { log } from './logger.js';

const api: CryptoApi = createCrypto({
  dataDir: DATA_DIR,
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
export const __resetCryptoCacheForTests = () => api.__resetCryptoCacheForTests();
