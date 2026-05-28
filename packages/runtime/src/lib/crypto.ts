/**
 * @domain subdomain: Authentication
 * @domain subdomain-type: generic
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Runtime-side crypto wrapper.
 *
 * Security ME-11: the implementation now lives in `@funny/shared/lib/crypto`
 * and is shared with the server. The previous runtime-local implementation
 * was a legacy unversioned variant that produced 3-part ciphertexts; the
 * shared module produces the `v1:keyId:iv:authTag:ciphertext` format and
 * still decrypts legacy 3-part rows. Existing on-disk keys
 * (`encryption.key`) continue to work via the `legacy` keyId path.
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
