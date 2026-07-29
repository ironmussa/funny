#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rand::distributions::{Distribution, Uniform};
use rand::rngs::OsRng;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use zeroize::Zeroizing;

use crate::core::credential::{
    CredentialDelete, CredentialEnrolmentEnvelope, CredentialEnvelopeBinding, CredentialError,
    decrypt_enrolment, validate_binding_lifetime,
};
use crate::core::product::{CAPABILITIES, PRODUCT_VERSION, PROTOCOL_VERSIONS};

const PAIRING_STATE_FILE: &str = "pairing-state.json";
const PAIRING_STATE_SCHEMA_VERSION: u16 = 1;
const PAIRING_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_TTL: Duration = Duration::from_secs(10 * 60);
const RSA_KEY_BITS: usize = 2_048;

#[derive(Debug, Error)]
pub enum PairingError {
    #[error("Connector pairing state is unavailable")]
    StateUnavailable(#[source] std::io::Error),
    #[error("Connector pairing state is invalid")]
    InvalidState,
    #[error("Connector pairing cryptography failed")]
    Cryptography,
    #[error("No pairing confirmation is pending")]
    NoPendingPairing,
    #[error("Pairing confirmation is invalid")]
    InvalidConfirmation,
    #[error("Pairing confirmation has expired")]
    ExpiredConfirmation,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorHello {
    pub kind: &'static str,
    pub connector_id: String,
    pub product_version: &'static str,
    pub protocol_versions: &'static [u16],
    pub capabilities: &'static [&'static str],
    pub platform: &'static str,
    pub architecture: &'static str,
    pub isolation: &'static str,
    pub key_version: u32,
    pub public_key: String,
    pub public_key_fingerprint: String,
}

impl std::fmt::Debug for ConnectorHello {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectorHello")
            .field("connector_id", &self.connector_id)
            .field("product_version", &self.product_version)
            .field("protocol_versions", &self.protocol_versions)
            .field("capabilities", &self.capabilities)
            .field("platform", &self.platform)
            .field("architecture", &self.architecture)
            .field("isolation", &self.isolation)
            .field("key_version", &self.key_version)
            .field("public_key_fingerprint", &self.public_key_fingerprint)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRegistration {
    pub connector: ConnectorHello,
    pub pairing_code_hash: String,
    pub pairing_expires_at: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct PairingCode(String);

impl PairingCode {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for PairingCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PairingCode([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingChallenge {
    pub registration: PairingRegistration,
    pub code: PairingCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingConfirmation {
    pub connector_id: String,
    pub runner_id: String,
    pub pairing_code: String,
    pub public_key_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingBinding {
    pub connector_id: String,
    pub runner_id: String,
    pub key_version: u32,
    pub public_key_fingerprint: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPairingState {
    schema_version: u16,
    connector_id: String,
    next_key_version: u32,
    active: Option<PersistedActivePairing>,
    pending: Option<PersistedPendingPairing>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedActivePairing {
    runner_id: String,
    key: PersistedKey,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPendingPairing {
    code: String,
    code_hash: String,
    expires_at_unix_ms: u64,
    key: PersistedKey,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedKey {
    version: u32,
    private_key_pkcs8: String,
    public_key_spki: String,
    fingerprint: String,
}

pub struct PairingStore {
    path: PathBuf,
    state: PersistedPairingState,
}

impl PairingStore {
    pub fn open(data_directory: &Path, now: SystemTime) -> Result<Self, PairingError> {
        let path = data_directory.join(PAIRING_STATE_FILE);
        if path.exists() {
            let encoded = fs::read(&path).map_err(PairingError::StateUnavailable)?;
            let state: PersistedPairingState =
                serde_json::from_slice(&encoded).map_err(|_| PairingError::InvalidState)?;
            validate_state(&state)?;
            let mut store = Self { path, state };
            if store.pending_expired(now)? {
                store.state.pending = None;
                store.persist()?;
            }
            return Ok(store);
        }

        let mut connector_random = [0_u8; 16];
        OsRng.fill_bytes(&mut connector_random);
        let connector_id = format!("connector-{}", URL_SAFE_NO_PAD.encode(connector_random));
        let mut store = Self {
            path,
            state: PersistedPairingState {
                schema_version: PAIRING_STATE_SCHEMA_VERSION,
                connector_id,
                next_key_version: 1,
                active: None,
                pending: None,
            },
        };
        store.start_pairing(now)?;
        Ok(store)
    }

    pub fn connector_id(&self) -> &str {
        &self.state.connector_id
    }

    pub fn paired_runner_id(&self) -> Option<&str> {
        self.state
            .active
            .as_ref()
            .map(|active| active.runner_id.as_str())
    }

    pub fn active_binding(&self) -> Option<PairingBinding> {
        self.state.active.as_ref().map(|active| PairingBinding {
            connector_id: self.state.connector_id.clone(),
            runner_id: active.runner_id.clone(),
            key_version: active.key.version,
            public_key_fingerprint: active.key.fingerprint.clone(),
        })
    }

    pub fn hello(&self) -> Result<ConnectorHello, PairingError> {
        let key = self
            .state
            .active
            .as_ref()
            .map(|active| &active.key)
            .or_else(|| self.state.pending.as_ref().map(|pending| &pending.key))
            .ok_or(PairingError::InvalidState)?;
        Ok(connector_hello(&self.state.connector_id, key))
    }

    pub fn pending_registration(
        &mut self,
        now: SystemTime,
    ) -> Result<Option<PairingRegistration>, PairingError> {
        if self.pending_expired(now)? {
            self.state.pending = None;
            self.persist()?;
            return Ok(None);
        }
        self.state
            .pending
            .as_ref()
            .map(|pending| registration(&self.state.connector_id, pending))
            .transpose()
    }

    pub fn pending_code(&mut self, now: SystemTime) -> Result<Option<PairingCode>, PairingError> {
        if self.pending_registration(now)?.is_none() {
            return Ok(None);
        }
        Ok(self
            .state
            .pending
            .as_ref()
            .map(|pending| PairingCode(pending.code.clone())))
    }

    pub fn rotate_enrolment_key(
        &mut self,
        now: SystemTime,
    ) -> Result<PairingChallenge, PairingError> {
        self.start_pairing(now)
    }

    pub fn decrypt_credential_enrolment(
        &self,
        envelope: &CredentialEnrolmentEnvelope,
        now: SystemTime,
    ) -> Result<Zeroizing<String>, CredentialError> {
        self.validate_credential_binding(&envelope.binding, now)?;
        let active = self
            .state
            .active
            .as_ref()
            .ok_or(CredentialError::EnrolmentRejected)?;
        decrypt_enrolment(envelope, &active.key.private_key_pkcs8)
    }

    pub fn validate_credential_enrolment(
        &self,
        envelope: &CredentialEnrolmentEnvelope,
        now: SystemTime,
    ) -> Result<(), CredentialError> {
        if !envelope.conforms_to_shared_contract() {
            return Err(CredentialError::EnrolmentRejected);
        }
        self.validate_credential_binding(&envelope.binding, now)
    }

    pub fn validate_credential_delete(
        &self,
        deletion: &CredentialDelete,
        now: SystemTime,
    ) -> Result<(), CredentialError> {
        self.validate_credential_binding(&deletion.binding, now)
    }

    pub fn confirm(
        &mut self,
        confirmation: &PairingConfirmation,
        now: SystemTime,
    ) -> Result<PairingBinding, PairingError> {
        if self.pending_expired(now)? {
            self.state.pending = None;
            self.persist()?;
            return Err(PairingError::ExpiredConfirmation);
        }
        let pending = self
            .state
            .pending
            .as_ref()
            .ok_or(PairingError::NoPendingPairing)?;
        let candidate_hash = pairing_code_hash(
            &self.state.connector_id,
            &pending.key.fingerprint,
            &confirmation.pairing_code,
        );
        let valid_code: bool = candidate_hash
            .as_bytes()
            .ct_eq(pending.code_hash.as_bytes())
            .into();
        if confirmation.connector_id != self.state.connector_id
            || confirmation.runner_id.is_empty()
            || confirmation.public_key_fingerprint != pending.key.fingerprint
            || !valid_code
        {
            return Err(PairingError::InvalidConfirmation);
        }

        let pending = self
            .state
            .pending
            .take()
            .ok_or(PairingError::NoPendingPairing)?;
        let binding = PairingBinding {
            connector_id: self.state.connector_id.clone(),
            runner_id: confirmation.runner_id.to_owned(),
            key_version: pending.key.version,
            public_key_fingerprint: pending.key.fingerprint.clone(),
        };
        self.state.active = Some(PersistedActivePairing {
            runner_id: binding.runner_id.clone(),
            key: pending.key,
        });
        self.persist()?;
        Ok(binding)
    }

    fn validate_credential_binding(
        &self,
        binding: &CredentialEnvelopeBinding,
        now: SystemTime,
    ) -> Result<(), CredentialError> {
        validate_binding_lifetime(binding, now)?;
        let active = self
            .state
            .active
            .as_ref()
            .ok_or(CredentialError::EnrolmentRejected)?;
        if binding.protocol_version != PROTOCOL_VERSIONS[0]
            || binding.connector_id != self.state.connector_id
            || binding.runner_id != active.runner_id
            || binding.connector_key_version != active.key.version
            || binding.credential_version == 0
            || binding.target_id.is_empty()
        {
            return Err(CredentialError::EnrolmentRejected);
        }
        Ok(())
    }

    fn start_pairing(&mut self, now: SystemTime) -> Result<PairingChallenge, PairingError> {
        let key = generate_key(self.state.next_key_version)?;
        self.state.next_key_version = self
            .state
            .next_key_version
            .checked_add(1)
            .ok_or(PairingError::InvalidState)?;
        let code = generate_pairing_code();
        let code_hash = pairing_code_hash(&self.state.connector_id, &key.fingerprint, &code);
        let expires_at = now
            .checked_add(PAIRING_CODE_TTL)
            .ok_or(PairingError::InvalidState)?;
        let expires_at_unix_ms = unix_milliseconds(expires_at)?;
        self.state.pending = Some(PersistedPendingPairing {
            code: code.clone(),
            code_hash,
            expires_at_unix_ms,
            key,
        });
        self.persist()?;

        let pending = self
            .state
            .pending
            .as_ref()
            .ok_or(PairingError::InvalidState)?;
        Ok(PairingChallenge {
            registration: registration(&self.state.connector_id, pending)?,
            code: PairingCode(code),
        })
    }

    fn pending_expired(&self, now: SystemTime) -> Result<bool, PairingError> {
        let Some(pending) = self.state.pending.as_ref() else {
            return Ok(false);
        };
        Ok(unix_milliseconds(now)? >= pending.expires_at_unix_ms)
    }

    fn persist(&self) -> Result<(), PairingError> {
        let encoded = serde_json::to_vec(&self.state).map_err(|_| PairingError::InvalidState)?;
        let parent = self.path.parent().ok_or(PairingError::InvalidState)?;
        let mut suffix = [0_u8; 8];
        OsRng.fill_bytes(&mut suffix);
        let temporary_path = parent.join(format!(
            ".pairing-state-{}.tmp",
            URL_SAFE_NO_PAD.encode(suffix)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut temporary = options
            .open(&temporary_path)
            .map_err(PairingError::StateUnavailable)?;
        let result = (|| {
            temporary
                .write_all(&encoded)
                .map_err(PairingError::StateUnavailable)?;
            temporary
                .sync_all()
                .map_err(PairingError::StateUnavailable)?;
            fs::rename(&temporary_path, &self.path).map_err(PairingError::StateUnavailable)?;
            enforce_private_file_permissions(&self.path)?;
            sync_directory(parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

fn validate_state(state: &PersistedPairingState) -> Result<(), PairingError> {
    if state.schema_version != PAIRING_STATE_SCHEMA_VERSION
        || state.connector_id.is_empty()
        || state.next_key_version == 0
        || (state.active.is_none() && state.pending.is_none())
    {
        return Err(PairingError::InvalidState);
    }
    if let Some(active) = &state.active {
        if active.runner_id.is_empty() {
            return Err(PairingError::InvalidState);
        }
        validate_key(&active.key)?;
    }
    if let Some(pending) = &state.pending {
        if pending.code.is_empty()
            || pending.code_hash.is_empty()
            || pending.expires_at_unix_ms == 0
        {
            return Err(PairingError::InvalidState);
        }
        validate_key(&pending.key)?;
        let expected_hash =
            pairing_code_hash(&state.connector_id, &pending.key.fingerprint, &pending.code);
        let valid_hash: bool = expected_hash
            .as_bytes()
            .ct_eq(pending.code_hash.as_bytes())
            .into();
        if !valid_hash {
            return Err(PairingError::InvalidState);
        }
    }
    Ok(())
}

fn generate_key(version: u32) -> Result<PersistedKey, PairingError> {
    let private_key =
        RsaPrivateKey::new(&mut OsRng, RSA_KEY_BITS).map_err(|_| PairingError::Cryptography)?;
    let private_der = private_key
        .to_pkcs8_der()
        .map_err(|_| PairingError::Cryptography)?;
    let public_der = RsaPublicKey::from(&private_key)
        .to_public_key_der()
        .map_err(|_| PairingError::Cryptography)?;
    let public_bytes = public_der.as_ref();
    Ok(PersistedKey {
        version,
        private_key_pkcs8: URL_SAFE_NO_PAD.encode(private_der.as_bytes()),
        public_key_spki: URL_SAFE_NO_PAD.encode(public_bytes),
        fingerprint: format!(
            "SHA256:{}",
            URL_SAFE_NO_PAD.encode(Sha256::digest(public_bytes))
        ),
    })
}

fn validate_key(key: &PersistedKey) -> Result<(), PairingError> {
    if key.version == 0 {
        return Err(PairingError::InvalidState);
    }
    let private_der = URL_SAFE_NO_PAD
        .decode(&key.private_key_pkcs8)
        .map_err(|_| PairingError::InvalidState)?;
    let private_key =
        RsaPrivateKey::from_pkcs8_der(&private_der).map_err(|_| PairingError::InvalidState)?;
    let public_der = RsaPublicKey::from(&private_key)
        .to_public_key_der()
        .map_err(|_| PairingError::InvalidState)?;
    let public_bytes = public_der.as_ref();
    let public_key = URL_SAFE_NO_PAD.encode(public_bytes);
    let fingerprint = format!(
        "SHA256:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(public_bytes))
    );
    if public_key != key.public_key_spki || fingerprint != key.fingerprint {
        return Err(PairingError::InvalidState);
    }
    Ok(())
}

fn connector_hello(connector_id: &str, key: &PersistedKey) -> ConnectorHello {
    ConnectorHello {
        kind: "hello",
        connector_id: connector_id.to_owned(),
        product_version: PRODUCT_VERSION,
        protocol_versions: PROTOCOL_VERSIONS,
        capabilities: CAPABILITIES,
        platform: platform_name(),
        architecture: architecture_name(),
        isolation: "verified",
        key_version: key.version,
        public_key: key.public_key_spki.clone(),
        public_key_fingerprint: key.fingerprint.clone(),
    }
}

fn registration(
    connector_id: &str,
    pending: &PersistedPendingPairing,
) -> Result<PairingRegistration, PairingError> {
    let expires_at = OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(pending.expires_at_unix_ms) * 1_000_000,
    )
    .map_err(|_| PairingError::InvalidState)?
    .format(&Rfc3339)
    .map_err(|_| PairingError::InvalidState)?;
    Ok(PairingRegistration {
        connector: connector_hello(connector_id, &pending.key),
        pairing_code_hash: pending.code_hash.clone(),
        pairing_expires_at: expires_at,
    })
}

fn generate_pairing_code() -> String {
    let distribution = Uniform::from(0..PAIRING_CODE_ALPHABET.len());
    let mut random = OsRng;
    let mut code = String::with_capacity(9);
    for index in 0..8 {
        if index == 4 {
            code.push('-');
        }
        code.push(char::from(
            PAIRING_CODE_ALPHABET[distribution.sample(&mut random)],
        ));
    }
    code
}

pub fn pairing_code_hash(connector_id: &str, fingerprint: &str, code: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"funny-remote-connector-pairing-v1\0");
    digest.update(connector_id.as_bytes());
    digest.update(b"\0");
    digest.update(fingerprint.as_bytes());
    digest.update(b"\0");
    digest.update(code.as_bytes());
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn unix_milliseconds(time: SystemTime) -> Result<u64, PairingError> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PairingError::InvalidState)?;
    u64::try_from(duration.as_millis()).map_err(|_| PairingError::InvalidState)
}

#[cfg(target_os = "windows")]
const fn platform_name() -> &'static str {
    "win32"
}

#[cfg(target_os = "macos")]
const fn platform_name() -> &'static str {
    "darwin"
}

#[cfg(target_os = "linux")]
const fn platform_name() -> &'static str {
    "linux"
}

#[cfg(target_arch = "x86_64")]
const fn architecture_name() -> &'static str {
    "x64"
}

#[cfg(target_arch = "aarch64")]
const fn architecture_name() -> &'static str {
    "arm64"
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("funny-remote-connector supports only x64 and arm64");

#[cfg(unix)]
fn enforce_private_file_permissions(path: &Path) -> Result<(), PairingError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(PairingError::StateUnavailable)
}

#[cfg(windows)]
fn enforce_private_file_permissions(_path: &Path) -> Result<(), PairingError> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), PairingError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(PairingError::StateUnavailable)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), PairingError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::*;

    fn confirmation(store: &PairingStore, challenge: &PairingChallenge) -> PairingConfirmation {
        PairingConfirmation {
            connector_id: store.connector_id().to_owned(),
            runner_id: "runner-1".to_owned(),
            pairing_code: challenge.code.expose().to_owned(),
            public_key_fingerprint: challenge
                .registration
                .connector
                .public_key_fingerprint
                .clone(),
        }
    }

    #[test]
    fn generates_contract_conforming_public_registration_and_private_state() {
        let directory = tempdir().expect("tempdir");
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut store = PairingStore::open(directory.path(), now).expect("store");
        let registration = store
            .pending_registration(now)
            .expect("registration")
            .expect("pending registration");
        let code = store
            .pending_code(now)
            .expect("pairing code")
            .expect("pending code");

        assert_eq!(registration.connector.kind, "hello");
        assert_eq!(registration.connector.key_version, 1);
        assert!(registration.connector.public_key.len() > 16);
        assert!(
            registration
                .connector
                .public_key_fingerprint
                .starts_with("SHA256:")
        );
        assert_eq!(registration.connector.capabilities, CAPABILITIES);
        assert_eq!(code.expose().len(), 9);
        assert_eq!(code.expose().as_bytes()[4], b'-');

        let encoded = fs::read(directory.path().join(PAIRING_STATE_FILE)).expect("state");
        let persisted: Value = serde_json::from_slice(&encoded).expect("json");
        assert!(persisted["pending"]["key"]["privateKeyPkcs8"].is_string());
        assert!(
            !serde_json::to_string(&registration)
                .expect("registration")
                .contains("privateKey")
        );
        assert!(!format!("{registration:?}").contains(code.expose()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path().join(PAIRING_STATE_FILE))
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn confirms_once_and_binds_exactly_one_runner() {
        let directory = tempdir().expect("tempdir");
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut store = PairingStore::open(directory.path(), now).expect("store");
        let challenge = PairingChallenge {
            registration: store
                .pending_registration(now)
                .expect("registration")
                .expect("pending"),
            code: store.pending_code(now).expect("code").expect("pending"),
        };
        let binding = store
            .confirm(&confirmation(&store, &challenge), now)
            .expect("confirmation");
        assert_eq!(binding.runner_id, "runner-1");
        assert_eq!(store.paired_runner_id(), Some("runner-1"));
        assert!(matches!(
            store.confirm(&confirmation(&store, &challenge), now),
            Err(PairingError::NoPendingPairing)
        ));

        let reloaded = PairingStore::open(directory.path(), now).expect("reload");
        assert_eq!(reloaded.paired_runner_id(), Some("runner-1"));
        assert_eq!(reloaded.hello().expect("hello").key_version, 1);
    }

    #[test]
    fn rejects_invalid_or_expired_confirmation_without_binding() {
        let directory = tempdir().expect("tempdir");
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut store = PairingStore::open(directory.path(), now).expect("store");
        let registration = store
            .pending_registration(now)
            .expect("registration")
            .expect("pending");
        let invalid = PairingConfirmation {
            connector_id: store.connector_id().to_owned(),
            runner_id: "runner-1".to_owned(),
            pairing_code: "AAAA-AAAA".to_owned(),
            public_key_fingerprint: registration.connector.public_key_fingerprint.clone(),
        };
        assert!(matches!(
            store.confirm(&invalid, now),
            Err(PairingError::InvalidConfirmation)
        ));
        assert_eq!(store.paired_runner_id(), None);

        let expired = now + PAIRING_CODE_TTL;
        let pending_code = store.pending_code(now).expect("code").expect("pending");
        let valid_but_expired = PairingConfirmation {
            connector_id: store.connector_id().to_owned(),
            runner_id: "runner-1".to_owned(),
            pairing_code: pending_code.expose().to_owned(),
            public_key_fingerprint: registration.connector.public_key_fingerprint.clone(),
        };
        assert!(matches!(
            store.confirm(&valid_but_expired, expired),
            Err(PairingError::ExpiredConfirmation)
        ));
        assert_eq!(store.paired_runner_id(), None);
    }

    #[test]
    fn rotation_keeps_active_binding_until_new_code_is_confirmed() {
        let directory = tempdir().expect("tempdir");
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut store = PairingStore::open(directory.path(), now).expect("store");
        let initial = PairingChallenge {
            registration: store
                .pending_registration(now)
                .expect("registration")
                .expect("pending"),
            code: store.pending_code(now).expect("code").expect("pending"),
        };
        store
            .confirm(&confirmation(&store, &initial), now)
            .expect("initial confirmation");
        let active_fingerprint = store.hello().expect("active hello").public_key_fingerprint;

        let rotated = store
            .rotate_enrolment_key(now + Duration::from_secs(1))
            .expect("rotation");
        assert_eq!(rotated.registration.connector.key_version, 2);
        assert_eq!(
            store.hello().expect("still active").public_key_fingerprint,
            active_fingerprint
        );
        store
            .confirm(
                &PairingConfirmation {
                    connector_id: store.connector_id().to_owned(),
                    runner_id: "runner-2".to_owned(),
                    pairing_code: rotated.code.expose().to_owned(),
                    public_key_fingerprint: rotated
                        .registration
                        .connector
                        .public_key_fingerprint
                        .clone(),
                },
                now + Duration::from_secs(1),
            )
            .expect("rotated confirmation");
        assert_eq!(store.paired_runner_id(), Some("runner-2"));
        assert_eq!(store.hello().expect("rotated hello").key_version, 2);
    }

    #[test]
    fn rejects_tampered_private_key_state() {
        let directory = tempdir().expect("tempdir");
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        PairingStore::open(directory.path(), now).expect("store");
        let path = directory.path().join(PAIRING_STATE_FILE);
        let mut state: Value =
            serde_json::from_slice(&fs::read(&path).expect("read state")).expect("json");
        state["pending"]["key"]["publicKeySpki"] = Value::String("tampered".to_owned());
        fs::write(&path, serde_json::to_vec(&state).expect("encode")).expect("write state");
        assert!(matches!(
            PairingStore::open(directory.path(), now),
            Err(PairingError::InvalidState)
        ));
    }
}
