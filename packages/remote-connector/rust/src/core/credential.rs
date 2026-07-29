use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use rsa::pkcs8::DecodePrivateKey;
use rsa::{Oaep, RsaPrivateKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use zeroize::Zeroizing;

const ENROLMENT_ALGORITHM: &str = "RSA-OAEP-256+A256GCM";
const ENROLMENT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(5);
const AES_256_KEY_BYTES: usize = 32;
const AES_GCM_IV_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;
const MAX_PASSWORD_BYTES: usize = 4_096;
const MAX_ENCODED_FIELD_BYTES: usize = 16_384;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialEnvelopeBinding {
    pub connector_id: String,
    pub connector_key_version: u32,
    pub credential_version: u32,
    pub expires_at: String,
    pub protocol_version: u16,
    pub runner_id: String,
    pub target_id: String,
}

impl CredentialEnvelopeBinding {
    pub fn conforms_to_shared_contract(&self) -> bool {
        self.protocol_version == 1
            && self.connector_key_version > 0
            && self.credential_version > 0
            && valid_id(&self.connector_id)
            && valid_id(&self.runner_id)
            && valid_id(&self.target_id)
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialEnrolmentEnvelope {
    pub algorithm: String,
    pub binding: CredentialEnvelopeBinding,
    pub ciphertext: String,
    pub iv: String,
    pub wrapped_key: String,
}

impl std::fmt::Debug for CredentialEnrolmentEnvelope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialEnrolmentEnvelope")
            .field("algorithm", &self.algorithm)
            .field("binding", &self.binding)
            .field("ciphertext", &"[OPAQUE]")
            .field("iv", &"[OPAQUE]")
            .field("wrapped_key", &"[OPAQUE]")
            .finish()
    }
}

impl CredentialEnrolmentEnvelope {
    pub fn conforms_to_shared_contract(&self) -> bool {
        self.algorithm == ENROLMENT_ALGORITHM
            && self.binding.conforms_to_shared_contract()
            && valid_encoded_field(&self.wrapped_key)
            && valid_encoded_field(&self.iv)
            && valid_encoded_field(&self.ciphertext)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialDelete {
    pub binding: CredentialEnvelopeBinding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialProviderStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialProviderSafety {
    NoLeak,
    Unsafe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialMutationStatus {
    Stored,
    Deleted,
}

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("Credential enrolment was rejected")]
    EnrolmentRejected,
    #[error("Credential provider is unavailable")]
    ProviderUnavailable,
}

/// A provider must atomically replace a target entry and retain its credential
/// version with the secret. Implementations must reject a lower version,
/// tolerate an idempotent retry of the current version, and retain a tombstone
/// after deletion so an obsolete enrolment cannot be replayed.
pub trait CredentialProvider: Send + Sync {
    fn status(&self) -> CredentialProviderStatus;

    fn safety(&self) -> CredentialProviderSafety;

    fn resolve(
        &self,
        target_id: &str,
        credential_version: u32,
    ) -> Result<Zeroizing<String>, CredentialError>;

    fn store(
        &self,
        target_id: &str,
        credential_version: u32,
        password: &str,
    ) -> Result<(), CredentialError>;

    fn delete(&self, target_id: &str, credential_version: u32) -> Result<(), CredentialError>;
}

#[derive(Debug, Default)]
pub struct UnavailableCredentialProvider;

impl CredentialProvider for UnavailableCredentialProvider {
    fn status(&self) -> CredentialProviderStatus {
        CredentialProviderStatus::Unavailable
    }

    fn safety(&self) -> CredentialProviderSafety {
        CredentialProviderSafety::NoLeak
    }

    fn resolve(
        &self,
        _target_id: &str,
        _credential_version: u32,
    ) -> Result<Zeroizing<String>, CredentialError> {
        Err(CredentialError::ProviderUnavailable)
    }

    fn store(
        &self,
        _target_id: &str,
        _credential_version: u32,
        _password: &str,
    ) -> Result<(), CredentialError> {
        Err(CredentialError::ProviderUnavailable)
    }

    fn delete(&self, _target_id: &str, _credential_version: u32) -> Result<(), CredentialError> {
        Err(CredentialError::ProviderUnavailable)
    }
}

pub struct CredentialMutationProcessor {
    provider: Box<dyn CredentialProvider>,
}

impl CredentialMutationProcessor {
    pub fn new(provider: impl CredentialProvider + 'static) -> Self {
        Self {
            provider: Box::new(provider),
        }
    }

    pub fn provider_status(&self) -> CredentialProviderStatus {
        if self.provider.status() == CredentialProviderStatus::Available
            && self.provider.safety() == CredentialProviderSafety::NoLeak
        {
            CredentialProviderStatus::Available
        } else {
            CredentialProviderStatus::Unavailable
        }
    }

    pub fn resolve(
        &self,
        target_id: &str,
        credential_version: u32,
    ) -> Result<Zeroizing<String>, CredentialError> {
        if self.provider_status() != CredentialProviderStatus::Available {
            return Err(CredentialError::ProviderUnavailable);
        }
        self.provider.resolve(target_id, credential_version)
    }

    pub fn store(
        &self,
        target_id: &str,
        credential_version: u32,
        password: &Zeroizing<String>,
    ) -> Result<CredentialMutationStatus, CredentialError> {
        if self.provider_status() != CredentialProviderStatus::Available {
            return Err(CredentialError::ProviderUnavailable);
        }
        self.provider
            .store(target_id, credential_version, password)?;
        Ok(CredentialMutationStatus::Stored)
    }

    pub fn delete(
        &self,
        target_id: &str,
        credential_version: u32,
    ) -> Result<CredentialMutationStatus, CredentialError> {
        if self.provider_status() != CredentialProviderStatus::Available {
            return Err(CredentialError::ProviderUnavailable);
        }
        self.provider.delete(target_id, credential_version)?;
        Ok(CredentialMutationStatus::Deleted)
    }
}

pub(crate) fn decrypt_enrolment(
    envelope: &CredentialEnrolmentEnvelope,
    private_key_pkcs8: &str,
) -> Result<Zeroizing<String>, CredentialError> {
    if !envelope.conforms_to_shared_contract() {
        return Err(CredentialError::EnrolmentRejected);
    }

    let private_der = Zeroizing::new(
        decode_base64_url(private_key_pkcs8).map_err(|_| CredentialError::EnrolmentRejected)?,
    );
    let private_key = RsaPrivateKey::from_pkcs8_der(&private_der)
        .map_err(|_| CredentialError::EnrolmentRejected)?;
    let wrapped_key =
        decode_base64_url(&envelope.wrapped_key).map_err(|_| CredentialError::EnrolmentRejected)?;
    let content_key = Zeroizing::new(
        private_key
            .decrypt(Oaep::new::<Sha256>(), &wrapped_key)
            .map_err(|_| CredentialError::EnrolmentRejected)?,
    );
    if content_key.len() != AES_256_KEY_BYTES {
        return Err(CredentialError::EnrolmentRejected);
    }

    let iv = decode_base64_url(&envelope.iv).map_err(|_| CredentialError::EnrolmentRejected)?;
    if iv.len() != AES_GCM_IV_BYTES {
        return Err(CredentialError::EnrolmentRejected);
    }
    let ciphertext =
        decode_base64_url(&envelope.ciphertext).map_err(|_| CredentialError::EnrolmentRejected)?;
    if ciphertext.len() <= AES_GCM_TAG_BYTES {
        return Err(CredentialError::EnrolmentRejected);
    }

    let aad =
        serde_json::to_vec(&envelope.binding).map_err(|_| CredentialError::EnrolmentRejected)?;
    let cipher =
        Aes256Gcm::new_from_slice(&content_key).map_err(|_| CredentialError::EnrolmentRejected)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                iv.as_slice().into(),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| CredentialError::EnrolmentRejected)?,
    );
    if plaintext.is_empty() || plaintext.len() > MAX_PASSWORD_BYTES {
        return Err(CredentialError::EnrolmentRejected);
    }
    std::str::from_utf8(&plaintext).map_err(|_| CredentialError::EnrolmentRejected)?;
    let password =
        String::from_utf8(plaintext.to_vec()).expect("credential plaintext was validated as UTF-8");
    Ok(Zeroizing::new(password))
}

pub(crate) fn validate_binding_lifetime(
    binding: &CredentialEnvelopeBinding,
    now: SystemTime,
) -> Result<(), CredentialError> {
    if !binding.conforms_to_shared_contract() {
        return Err(CredentialError::EnrolmentRejected);
    }
    let expires_at = OffsetDateTime::parse(&binding.expires_at, &Rfc3339)
        .map_err(|_| CredentialError::EnrolmentRejected)?;
    let now_ms = unix_milliseconds(now)?;
    let expires_at_ms = u64::try_from(expires_at.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| CredentialError::EnrolmentRejected)?;
    let maximum_expiry = now
        .checked_add(ENROLMENT_TTL + MAX_CLOCK_SKEW)
        .ok_or(CredentialError::EnrolmentRejected)?;
    if expires_at_ms <= now_ms || expires_at_ms > unix_milliseconds(maximum_expiry)? {
        return Err(CredentialError::EnrolmentRejected);
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn unix_milliseconds(time: SystemTime) -> Result<u64, CredentialError> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CredentialError::EnrolmentRejected)?;
    u64::try_from(duration.as_millis()).map_err(|_| CredentialError::EnrolmentRejected)
}

fn valid_encoded_field(value: &str) -> bool {
    let unpadded_length = value.trim_end_matches('=').len();
    let padding_length = value.len() - unpadded_length;
    value.len() >= 16
        && value.len() <= MAX_ENCODED_FIELD_BYTES
        && padding_length <= 2
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-')
                || (byte == b'=' && index >= unpadded_length)
        })
}

fn decode_base64_url(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
}

#[cfg(test)]
use std::sync::{Arc, Mutex};

#[cfg(test)]
#[derive(Clone)]
pub struct MemoryCredentialProvider {
    entries: Arc<Mutex<std::collections::BTreeMap<String, MemoryCredentialEntry>>>,
}

#[cfg(test)]
struct MemoryCredentialEntry {
    version: u32,
    password: Option<Zeroizing<String>>,
}

#[cfg(test)]
impl Default for MemoryCredentialProvider {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
        }
    }
}

#[cfg(test)]
impl MemoryCredentialProvider {
    pub fn password(&self, target_id: &str) -> Option<String> {
        self.entries
            .lock()
            .expect("memory provider lock")
            .get(target_id)
            .and_then(|entry| entry.password.as_ref())
            .map(|password| password.to_string())
    }
}

#[cfg(test)]
impl CredentialProvider for MemoryCredentialProvider {
    fn status(&self) -> CredentialProviderStatus {
        CredentialProviderStatus::Available
    }

    fn safety(&self) -> CredentialProviderSafety {
        CredentialProviderSafety::NoLeak
    }

    fn resolve(
        &self,
        target_id: &str,
        credential_version: u32,
    ) -> Result<Zeroizing<String>, CredentialError> {
        self.entries
            .lock()
            .expect("memory provider lock")
            .get(target_id)
            .filter(|entry| entry.version == credential_version)
            .and_then(|entry| entry.password.as_ref())
            .map(|password| Zeroizing::new(password.to_string()))
            .ok_or(CredentialError::ProviderUnavailable)
    }

    fn store(
        &self,
        target_id: &str,
        credential_version: u32,
        password: &str,
    ) -> Result<(), CredentialError> {
        let mut entries = self.entries.lock().expect("memory provider lock");
        if let Some(entry) = entries.get(target_id) {
            if credential_version < entry.version {
                return Err(CredentialError::EnrolmentRejected);
            }
            if credential_version == entry.version {
                return match entry.password.as_ref() {
                    Some(existing) if existing.as_str() == password => Ok(()),
                    _ => Err(CredentialError::EnrolmentRejected),
                };
            }
        }
        entries.insert(
            target_id.to_owned(),
            MemoryCredentialEntry {
                version: credential_version,
                password: Some(Zeroizing::new(password.to_owned())),
            },
        );
        Ok(())
    }

    fn delete(&self, target_id: &str, credential_version: u32) -> Result<(), CredentialError> {
        let mut entries = self.entries.lock().expect("memory provider lock");
        if let Some(entry) = entries.get(target_id) {
            if credential_version < entry.version {
                return Err(CredentialError::EnrolmentRejected);
            }
            if credential_version == entry.version && entry.password.is_none() {
                return Ok(());
            }
        }
        entries.insert(
            target_id.to_owned(),
            MemoryCredentialEntry {
                version: credential_version,
                password: None,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct UnsafeCredentialProvider;

    impl CredentialProvider for UnsafeCredentialProvider {
        fn status(&self) -> CredentialProviderStatus {
            CredentialProviderStatus::Available
        }

        fn safety(&self) -> CredentialProviderSafety {
            CredentialProviderSafety::Unsafe
        }

        fn resolve(
            &self,
            _target_id: &str,
            _credential_version: u32,
        ) -> Result<Zeroizing<String>, CredentialError> {
            panic!("unsafe provider must not be called")
        }

        fn store(
            &self,
            _target_id: &str,
            _credential_version: u32,
            _password: &str,
        ) -> Result<(), CredentialError> {
            panic!("unsafe provider must not be called")
        }

        fn delete(
            &self,
            _target_id: &str,
            _credential_version: u32,
        ) -> Result<(), CredentialError> {
            panic!("unsafe provider must not be called")
        }
    }

    #[test]
    fn rejects_providers_that_do_not_satisfy_the_no_leak_contract() {
        let processor = CredentialMutationProcessor::new(UnsafeCredentialProvider);
        assert_eq!(
            processor.provider_status(),
            CredentialProviderStatus::Unavailable
        );
        assert!(matches!(
            processor.resolve("target-1", 1),
            Err(CredentialError::ProviderUnavailable)
        ));
        assert!(matches!(
            processor.store(
                "target-1",
                1,
                &Zeroizing::new("must-not-be-forwarded".to_owned())
            ),
            Err(CredentialError::ProviderUnavailable)
        ));
        assert!(matches!(
            processor.delete("target-1", 1),
            Err(CredentialError::ProviderUnavailable)
        ));
    }
}
