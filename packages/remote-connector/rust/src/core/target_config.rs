use std::collections::{BTreeMap, BTreeSet};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use rand::RngCore;
use rand::rngs::OsRng;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::core::pairing::PairingBinding;
use crate::core::product::PROTOCOL_VERSIONS;

const TARGET_CONFIG_CACHE_FILE: &str = "target-config-cache.json";
const TARGET_CONFIG_CACHE_SCHEMA_VERSION: u16 = 1;
const TARGET_SIGNATURE_ALGORITHM: &str = "Ed25519";
const TARGET_SIGNATURE_DOMAIN: &str = "funny-remote-connector-target-config-v1";
const TARGET_CONFIG_MAX_LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: u32 = 256 * 1_024;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug, Error)]
pub enum TargetConfigError {
    #[error("Target configuration cache is unavailable")]
    CacheUnavailable(#[source] std::io::Error),
    #[error("Target configuration cache is invalid")]
    InvalidCache,
    #[error("Target configuration was rejected")]
    Rejected,
    #[error("Target configuration authority is invalid")]
    InvalidAuthority,
}

#[derive(Clone)]
pub struct TargetConfigAuthority {
    verifying_key: VerifyingKey,
    fingerprint: String,
}

impl std::fmt::Debug for TargetConfigAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TargetConfigAuthority")
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

impl TargetConfigAuthority {
    pub fn from_base64_url(public_key: &str) -> Result<Self, TargetConfigError> {
        let decoded =
            decode_base64_url(public_key).map_err(|_| TargetConfigError::InvalidAuthority)?;
        let key_bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| TargetConfigError::InvalidAuthority)?;
        let verifying_key = VerifyingKey::from_bytes(&key_bytes)
            .map_err(|_| TargetConfigError::InvalidAuthority)?;
        let fingerprint = format!(
            "SHA256:{}",
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifying_key.as_bytes()))
        );
        Ok(Self {
            verifying_key,
            fingerprint,
        })
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub(crate) fn verifies(&self, payload: &[u8], encoded_signature: &str) -> bool {
        let Ok(signature_bytes) = decode_base64_url(encoded_signature) else {
            return false;
        };
        let Ok(signature) = Signature::from_slice(&signature_bytes) else {
            return false;
        };
        self.verifying_key
            .verify_strict(payload, &signature)
            .is_ok()
    }

    fn verify(&self, signed: &SignedTargetConfig) -> Result<(), TargetConfigError> {
        if signed.signature_algorithm != TARGET_SIGNATURE_ALGORITHM
            || signed.authority_key_fingerprint != self.fingerprint
        {
            return Err(TargetConfigError::Rejected);
        }
        if self.verifies(&signature_payload(signed)?, &signed.signature) {
            Ok(())
        } else {
            Err(TargetConfigError::Rejected)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedTargetConfig {
    pub config: RemoteTargetConfig,
    pub issued_at: String,
    pub expires_at: String,
    pub config_digest: String,
    pub signature_algorithm: String,
    pub authority_key_fingerprint: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTargetConfig {
    pub protocol_version: u16,
    pub target_id: String,
    pub config_version: u32,
    pub runner_id: String,
    pub connector_id: String,
    pub name: String,
    pub environment: RemoteEnvironment,
    pub enabled: bool,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub host_key_fingerprints: Vec<String>,
    pub credential_ref: String,
    pub credential_version: u32,
    pub connect_timeout_ms: u32,
    pub operations: Vec<RemoteOperation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteEnvironment {
    Development,
    Staging,
    Production,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperation {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub argv: Vec<RemoteCommandToken>,
    pub arguments: BTreeMap<String, RemoteArgumentDefinition>,
    pub timeout_ms: u32,
    #[serde(default = "default_output_limit")]
    pub output_limit_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum RemoteCommandToken {
    Literal { literal: String },
    Argument { argument: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum RemoteArgumentDefinition {
    String {
        #[serde(default = "default_true")]
        required: bool,
        #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
        allowed_values: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
        #[serde(default = "default_argument_max_length")]
        max_length: u32,
    },
    Integer {
        #[serde(default = "default_true")]
        required: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        maximum: Option<i64>,
    },
    Boolean {
        #[serde(default = "default_true")]
        required: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedTargetConfigCache {
    schema_version: u16,
    targets: BTreeMap<String, SignedTargetConfig>,
}

pub struct TargetConfigStore {
    path: PathBuf,
    state: PersistedTargetConfigCache,
}

impl TargetConfigStore {
    pub fn open(data_directory: &Path) -> Result<Self, TargetConfigError> {
        let path = data_directory.join(TARGET_CONFIG_CACHE_FILE);
        if !path.exists() {
            return Ok(Self {
                path,
                state: PersistedTargetConfigCache {
                    schema_version: TARGET_CONFIG_CACHE_SCHEMA_VERSION,
                    targets: BTreeMap::new(),
                },
            });
        }

        let encoded = fs::read(&path).map_err(TargetConfigError::CacheUnavailable)?;
        let state: PersistedTargetConfigCache =
            serde_json::from_slice(&encoded).map_err(|_| TargetConfigError::InvalidCache)?;
        validate_cache_shape(&state)?;
        enforce_private_file_permissions(&path)?;
        Ok(Self { path, state })
    }

    pub fn install(
        &mut self,
        signed: SignedTargetConfig,
        authority: &TargetConfigAuthority,
        binding: &PairingBinding,
        now: SystemTime,
    ) -> Result<(), TargetConfigError> {
        validate_signed_target(&signed, authority, binding, now)?;
        let target_id = signed.config.target_id.clone();
        if let Some(current) = self.state.targets.get(&target_id) {
            if signed.config.config_version < current.config.config_version {
                return Err(TargetConfigError::Rejected);
            }
            if signed.config.config_version == current.config.config_version {
                return if current == &signed {
                    Ok(())
                } else {
                    Err(TargetConfigError::Rejected)
                };
            }
        }

        let previous = self.state.targets.insert(target_id.clone(), signed);
        if let Err(error) = self.persist() {
            match previous {
                Some(previous) => {
                    self.state.targets.insert(target_id, previous);
                }
                None => {
                    self.state.targets.remove(&target_id);
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn validate_all(
        &self,
        authority: &TargetConfigAuthority,
        binding: &PairingBinding,
        now: SystemTime,
    ) -> Result<(), TargetConfigError> {
        for target in self.state.targets.values() {
            validate_signed_target(target, authority, binding, now)?;
        }
        Ok(())
    }

    pub fn target(&self, target_id: &str) -> Option<&SignedTargetConfig> {
        self.state.targets.get(target_id)
    }

    pub(crate) fn validated_target(
        &self,
        target_id: &str,
        authority: &TargetConfigAuthority,
        binding: &PairingBinding,
        now: SystemTime,
    ) -> Result<&SignedTargetConfig, TargetConfigError> {
        let target = self
            .state
            .targets
            .get(target_id)
            .ok_or(TargetConfigError::Rejected)?;
        validate_signed_target(target, authority, binding, now)?;
        Ok(target)
    }

    pub fn is_empty(&self) -> bool {
        self.state.targets.is_empty()
    }

    fn persist(&self) -> Result<(), TargetConfigError> {
        let encoded =
            serde_json::to_vec(&self.state).map_err(|_| TargetConfigError::InvalidCache)?;
        let parent = self.path.parent().ok_or(TargetConfigError::InvalidCache)?;
        let mut suffix = [0_u8; 8];
        OsRng.fill_bytes(&mut suffix);
        let temporary_path = parent.join(format!(
            ".target-config-cache-{}.tmp",
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
            .map_err(TargetConfigError::CacheUnavailable)?;
        let result = (|| {
            temporary
                .write_all(&encoded)
                .map_err(TargetConfigError::CacheUnavailable)?;
            temporary
                .sync_all()
                .map_err(TargetConfigError::CacheUnavailable)?;
            fs::rename(&temporary_path, &self.path).map_err(TargetConfigError::CacheUnavailable)?;
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

fn validate_cache_shape(state: &PersistedTargetConfigCache) -> Result<(), TargetConfigError> {
    if state.schema_version != TARGET_CONFIG_CACHE_SCHEMA_VERSION {
        return Err(TargetConfigError::InvalidCache);
    }
    if state
        .targets
        .iter()
        .any(|(target_id, signed)| target_id != &signed.config.target_id)
    {
        return Err(TargetConfigError::InvalidCache);
    }
    Ok(())
}

fn validate_signed_target(
    signed: &SignedTargetConfig,
    authority: &TargetConfigAuthority,
    binding: &PairingBinding,
    now: SystemTime,
) -> Result<(), TargetConfigError> {
    validate_target(&signed.config)?;
    if signed.config.protocol_version != PROTOCOL_VERSIONS[0]
        || signed.config.connector_id != binding.connector_id
        || signed.config.runner_id != binding.runner_id
        || !valid_fingerprint(&signed.authority_key_fingerprint)
        || !valid_encoded_field(&signed.config_digest)
        || !valid_encoded_field(&signed.signature)
    {
        return Err(TargetConfigError::Rejected);
    }

    let issued_at = parse_timestamp(&signed.issued_at)?;
    let expires_at = parse_timestamp(&signed.expires_at)?;
    let now_ms = unix_milliseconds(now)?;
    let maximum_issued_at = unix_milliseconds(
        now.checked_add(MAX_CLOCK_SKEW)
            .ok_or(TargetConfigError::Rejected)?,
    )?;
    if issued_at > maximum_issued_at
        || expires_at <= now_ms
        || expires_at <= issued_at
        || expires_at - issued_at
            > u64::try_from(TARGET_CONFIG_MAX_LIFETIME.as_millis())
                .map_err(|_| TargetConfigError::Rejected)?
    {
        return Err(TargetConfigError::Rejected);
    }

    if target_config_digest(&signed.config)? != signed.config_digest {
        return Err(TargetConfigError::Rejected);
    }
    authority.verify(signed)
}

fn validate_target(config: &RemoteTargetConfig) -> Result<(), TargetConfigError> {
    if config.protocol_version != PROTOCOL_VERSIONS[0]
        || config.config_version == 0
        || config.credential_version == 0
        || !valid_id(&config.target_id)
        || !valid_id(&config.runner_id)
        || !valid_id(&config.connector_id)
        || !valid_id(&config.credential_ref)
        || config.name.is_empty()
        || config.name.len() > 160
        || config.host.is_empty()
        || config.host.len() > 253
        || config.username.is_empty()
        || config.username.len() > 128
        || config.port == 0
        || !(1_000..=120_000).contains(&config.connect_timeout_ms)
        || config.host_key_fingerprints.is_empty()
        || config.host_key_fingerprints.len() > 8
        || config.operations.is_empty()
        || config.operations.len() > 100
    {
        return Err(TargetConfigError::Rejected);
    }
    if config
        .host_key_fingerprints
        .iter()
        .any(|fingerprint| !valid_fingerprint(fingerprint))
        || config
            .host_key_fingerprints
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != config.host_key_fingerprints.len()
    {
        return Err(TargetConfigError::Rejected);
    }

    let mut operation_ids = BTreeSet::new();
    for operation in &config.operations {
        if !operation_ids.insert(&operation.id) {
            return Err(TargetConfigError::Rejected);
        }
        validate_operation(operation)?;
    }
    Ok(())
}

fn validate_operation(operation: &RemoteOperation) -> Result<(), TargetConfigError> {
    if !valid_id(&operation.id)
        || operation.name.is_empty()
        || operation.name.len() > 160
        || operation.executable.is_empty()
        || operation.executable.len() > 1_024
        || operation.argv.len() > 128
        || operation.arguments.len() > 128
        || !(1_000..=15 * 60_000).contains(&operation.timeout_ms)
        || !(1_024..=MAX_OUTPUT_BYTES).contains(&operation.output_limit_bytes)
        || operation
            .arguments
            .keys()
            .any(|argument| !valid_id(argument))
    {
        return Err(TargetConfigError::Rejected);
    }
    for token in &operation.argv {
        match token {
            RemoteCommandToken::Literal { literal }
                if literal.is_empty() || literal.len() > 4_096 =>
            {
                return Err(TargetConfigError::Rejected);
            }
            RemoteCommandToken::Argument { argument }
                if !valid_id(argument) || !operation.arguments.contains_key(argument) =>
            {
                return Err(TargetConfigError::Rejected);
            }
            _ => {}
        }
    }
    for definition in operation.arguments.values() {
        validate_argument_definition(definition)?;
    }
    Ok(())
}

fn validate_argument_definition(
    definition: &RemoteArgumentDefinition,
) -> Result<(), TargetConfigError> {
    match definition {
        RemoteArgumentDefinition::String {
            allowed_values,
            pattern,
            max_length,
            ..
        } => {
            if !(1..=4_096).contains(max_length) {
                return Err(TargetConfigError::Rejected);
            }
            if let Some(values) = allowed_values {
                if values.is_empty()
                    || values.len() > 100
                    || values.iter().any(|value| value.len() > 512)
                    || values.iter().collect::<BTreeSet<_>>().len() != values.len()
                {
                    return Err(TargetConfigError::Rejected);
                }
            }
            if let Some(pattern) = pattern {
                if pattern.len() > 512 || Regex::new(pattern).is_err() {
                    return Err(TargetConfigError::Rejected);
                }
            }
        }
        RemoteArgumentDefinition::Integer {
            minimum, maximum, ..
        } => {
            if matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum > maximum) {
                return Err(TargetConfigError::Rejected);
            }
        }
        RemoteArgumentDefinition::Boolean { .. } => {}
    }
    Ok(())
}

pub fn target_config_digest(config: &RemoteTargetConfig) -> Result<String, TargetConfigError> {
    let value = serde_json::to_value(config).map_err(|_| TargetConfigError::Rejected)?;
    let canonical = canonical_json(&value)?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical)))
}

fn signature_payload(signed: &SignedTargetConfig) -> Result<Vec<u8>, TargetConfigError> {
    let metadata = serde_json::json!({
        "authorityKeyFingerprint": signed.authority_key_fingerprint,
        "configDigest": signed.config_digest,
        "expiresAt": signed.expires_at,
        "issuedAt": signed.issued_at,
        "signatureAlgorithm": signed.signature_algorithm,
    });
    let canonical = canonical_json(&metadata)?;
    let mut payload = Vec::with_capacity(TARGET_SIGNATURE_DOMAIN.len() + 1 + canonical.len());
    payload.extend_from_slice(TARGET_SIGNATURE_DOMAIN.as_bytes());
    payload.push(0);
    payload.extend_from_slice(&canonical);
    Ok(payload)
}

fn canonical_json(value: &serde_json::Value) -> Result<Vec<u8>, TargetConfigError> {
    fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(entries) => serde_json::Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), canonicalize(value)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }

    serde_json::to_vec(&canonicalize(value)).map_err(|_| TargetConfigError::Rejected)
}

fn default_true() -> bool {
    true
}

fn default_ssh_port() -> u16 {
    22
}

fn default_argument_max_length() -> u32 {
    512
}

fn default_output_limit() -> u32 {
    MAX_OUTPUT_BYTES
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn valid_fingerprint(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("SHA256:") else {
        return false;
    };
    let unpadded_length = encoded.trim_end_matches('=').len();
    let padding_length = encoded.len() - unpadded_length;
    value.len() >= 16
        && value.len() <= 256
        && padding_length <= 2
        && encoded.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'+' | b'/' | b'_' | b'-')
                || (byte == b'=' && index >= unpadded_length)
        })
}

fn valid_encoded_field(value: &str) -> bool {
    value.len() >= 16 && value.len() <= 16_384 && valid_base64_url(value)
}

fn valid_base64_url(value: &str) -> bool {
    let unpadded_length = value.trim_end_matches('=').len();
    let padding_length = value.len() - unpadded_length;
    padding_length <= 2
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

fn parse_timestamp(value: &str) -> Result<u64, TargetConfigError> {
    let timestamp =
        OffsetDateTime::parse(value, &Rfc3339).map_err(|_| TargetConfigError::Rejected)?;
    u64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| TargetConfigError::Rejected)
}

fn unix_milliseconds(time: SystemTime) -> Result<u64, TargetConfigError> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| TargetConfigError::Rejected)?;
    u64::try_from(duration.as_millis()).map_err(|_| TargetConfigError::Rejected)
}

#[cfg(unix)]
fn enforce_private_file_permissions(path: &Path) -> Result<(), TargetConfigError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(TargetConfigError::CacheUnavailable)
}

#[cfg(windows)]
fn enforce_private_file_permissions(_path: &Path) -> Result<(), TargetConfigError> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), TargetConfigError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(TargetConfigError::CacheUnavailable)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), TargetConfigError> {
    Ok(())
}

#[cfg(test)]
pub(crate) fn sign_target_for_test(
    config: RemoteTargetConfig,
    issued_at: String,
    expires_at: String,
    signing_key: &ed25519_dalek::SigningKey,
) -> SignedTargetConfig {
    use ed25519_dalek::Signer;

    let authority = TargetConfigAuthority::from_base64_url(
        &URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()),
    )
    .expect("test authority");
    let mut signed = SignedTargetConfig {
        config_digest: target_config_digest(&config).expect("target digest"),
        config,
        issued_at,
        expires_at,
        signature_algorithm: TARGET_SIGNATURE_ALGORITHM.to_owned(),
        authority_key_fingerprint: authority.fingerprint().to_owned(),
        signature: String::new(),
    };
    signed.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(&signature_payload(&signed).expect("target signature payload"))
            .to_bytes(),
    );
    signed
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::tempdir;

    use super::*;

    const SHARED_CONTRACT_DIGEST: &str = "e3EJ64CkxvY9Irta1bg2ZTS3Ado--U4ZsXu4ZWkyHo8";

    fn fixed_now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_775_000_000)
    }

    fn timestamp(time: SystemTime) -> String {
        let nanoseconds = time
            .duration_since(UNIX_EPOCH)
            .expect("timestamp after epoch")
            .as_nanos();
        OffsetDateTime::from_unix_timestamp_nanos(
            i128::try_from(nanoseconds).expect("timestamp fits i128"),
        )
        .expect("valid timestamp")
        .format(&Rfc3339)
        .expect("format timestamp")
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7_u8; 32])
    }

    fn authority(signing_key: &SigningKey) -> TargetConfigAuthority {
        TargetConfigAuthority::from_base64_url(
            &URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()),
        )
        .expect("target authority")
    }

    fn pairing_binding() -> PairingBinding {
        PairingBinding {
            connector_id: "connector-1".to_owned(),
            runner_id: "runner-1".to_owned(),
            key_version: 1,
            public_key_fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".to_owned(),
        }
    }

    fn target(config_version: u32) -> RemoteTargetConfig {
        let arguments = BTreeMap::from([(
            "lines".to_owned(),
            RemoteArgumentDefinition::Integer {
                required: true,
                minimum: Some(1),
                maximum: Some(100),
            },
        )]);
        RemoteTargetConfig {
            protocol_version: 1,
            target_id: "target-1".to_owned(),
            config_version,
            runner_id: "runner-1".to_owned(),
            connector_id: "connector-1".to_owned(),
            name: "API staging".to_owned(),
            environment: RemoteEnvironment::Staging,
            enabled: true,
            host: "staging.internal".to_owned(),
            port: 22,
            username: "deploy".to_owned(),
            host_key_fingerprints: vec![
                "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".to_owned(),
            ],
            credential_ref: "credential-1".to_owned(),
            credential_version: 1,
            connect_timeout_ms: 10_000,
            operations: vec![RemoteOperation {
                id: "logs".to_owned(),
                name: "Read logs".to_owned(),
                executable: "/usr/bin/journalctl".to_owned(),
                argv: vec![
                    RemoteCommandToken::Literal {
                        literal: "--lines".to_owned(),
                    },
                    RemoteCommandToken::Argument {
                        argument: "lines".to_owned(),
                    },
                ],
                arguments,
                timeout_ms: 30_000,
                output_limit_bytes: 16_384,
            }],
        }
    }

    fn signed_target(
        config: RemoteTargetConfig,
        issued_at: SystemTime,
        expires_at: SystemTime,
        signing_key: &SigningKey,
    ) -> SignedTargetConfig {
        let authority = authority(signing_key);
        let mut signed = SignedTargetConfig {
            config_digest: target_config_digest(&config).expect("target digest"),
            config,
            issued_at: timestamp(issued_at),
            expires_at: timestamp(expires_at),
            signature_algorithm: TARGET_SIGNATURE_ALGORITHM.to_owned(),
            authority_key_fingerprint: authority.fingerprint().to_owned(),
            signature: String::new(),
        };
        signed.signature = URL_SAFE_NO_PAD.encode(
            signing_key
                .sign(&signature_payload(&signed).expect("signature payload"))
                .to_bytes(),
        );
        signed
    }

    fn current_signed_target(config_version: u32) -> SignedTargetConfig {
        let now = fixed_now();
        signed_target(
            target(config_version),
            now - Duration::from_secs(1),
            now + Duration::from_secs(60 * 60),
            &signing_key(),
        )
    }

    #[test]
    fn digest_matches_the_shared_canonical_json_contract() {
        assert_eq!(
            target_config_digest(&target(1)).expect("target digest"),
            SHARED_CONTRACT_DIGEST
        );
    }

    #[test]
    fn verifies_persists_and_reopens_a_runner_bound_signed_target() {
        let directory = tempdir().expect("target cache directory");
        let signing_key = signing_key();
        let authority = authority(&signing_key);
        let binding = pairing_binding();
        let signed = current_signed_target(1);

        let mut store = TargetConfigStore::open(directory.path()).expect("target store");
        store
            .install(signed.clone(), &authority, &binding, fixed_now())
            .expect("install signed target");
        assert_eq!(store.target("target-1"), Some(&signed));

        let reopened = TargetConfigStore::open(directory.path()).expect("reopen target store");
        reopened
            .validate_all(&authority, &binding, fixed_now())
            .expect("validate persisted target");
        assert_eq!(reopened.target("target-1"), Some(&signed));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(directory.path().join(TARGET_CONFIG_CACHE_FILE))
                .expect("target cache metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn versions_are_monotonic_and_exact_retries_are_idempotent() {
        let directory = tempdir().expect("target cache directory");
        let signing_key = signing_key();
        let authority = authority(&signing_key);
        let binding = pairing_binding();
        let mut store = TargetConfigStore::open(directory.path()).expect("target store");
        let first = current_signed_target(1);
        store
            .install(first.clone(), &authority, &binding, fixed_now())
            .expect("install first target");

        let mut second_config = target(2);
        second_config.name = "API staging v2".to_owned();
        let second = signed_target(
            second_config,
            fixed_now() - Duration::from_secs(1),
            fixed_now() + Duration::from_secs(60 * 60),
            &signing_key,
        );
        store
            .install(second.clone(), &authority, &binding, fixed_now())
            .expect("install second target");
        store
            .install(second.clone(), &authority, &binding, fixed_now())
            .expect("retry second target");

        let mut conflicting_config = target(2);
        conflicting_config.name = "conflicting v2".to_owned();
        let conflicting = signed_target(
            conflicting_config,
            fixed_now() - Duration::from_secs(1),
            fixed_now() + Duration::from_secs(60 * 60),
            &signing_key,
        );
        assert!(matches!(
            store.install(conflicting, &authority, &binding, fixed_now()),
            Err(TargetConfigError::Rejected)
        ));
        assert!(matches!(
            store.install(first, &authority, &binding, fixed_now()),
            Err(TargetConfigError::Rejected)
        ));
        assert_eq!(store.target("target-1"), Some(&second));
    }

    #[test]
    fn rejects_forged_expired_or_mismatched_updates_without_mutating_the_cache() {
        let directory = tempdir().expect("target cache directory");
        let signing_key = signing_key();
        let authority = authority(&signing_key);
        let binding = pairing_binding();
        let mut store = TargetConfigStore::open(directory.path()).expect("target store");
        let first = current_signed_target(1);
        store
            .install(first.clone(), &authority, &binding, fixed_now())
            .expect("install first target");
        let persisted_before =
            fs::read(directory.path().join(TARGET_CONFIG_CACHE_FILE)).expect("read target cache");

        let mut forged = current_signed_target(2);
        forged.signature.replace_range(
            ..1,
            if forged.signature.starts_with('A') {
                "B"
            } else {
                "A"
            },
        );
        let expired = signed_target(
            target(2),
            fixed_now() - Duration::from_secs(120),
            fixed_now() - Duration::from_secs(60),
            &signing_key,
        );
        let mut wrong_runner_config = target(2);
        wrong_runner_config.runner_id = "runner-2".to_owned();
        let wrong_runner = signed_target(
            wrong_runner_config,
            fixed_now() - Duration::from_secs(1),
            fixed_now() + Duration::from_secs(60),
            &signing_key,
        );

        for rejected in [forged, expired, wrong_runner] {
            assert!(matches!(
                store.install(rejected, &authority, &binding, fixed_now()),
                Err(TargetConfigError::Rejected)
            ));
            assert_eq!(store.target("target-1"), Some(&first));
            assert_eq!(
                fs::read(directory.path().join(TARGET_CONFIG_CACHE_FILE))
                    .expect("read unchanged target cache"),
                persisted_before
            );
        }
    }

    #[test]
    fn rejects_invalid_pins_limits_templates_and_argument_allowlists() {
        let directory = tempdir().expect("target cache directory");
        let signing_key = signing_key();
        let authority = authority(&signing_key);
        let binding = pairing_binding();
        let mut store = TargetConfigStore::open(directory.path()).expect("target store");

        let mut duplicate_pin = target(1);
        duplicate_pin
            .host_key_fingerprints
            .push(duplicate_pin.host_key_fingerprints[0].clone());

        let mut invalid_limit = target(1);
        invalid_limit.operations[0].output_limit_bytes = MAX_OUTPUT_BYTES + 1;

        let mut unknown_template_argument = target(1);
        unknown_template_argument.operations[0]
            .argv
            .push(RemoteCommandToken::Argument {
                argument: "unconfigured".to_owned(),
            });

        let mut invalid_integer_range = target(1);
        invalid_integer_range.operations[0].arguments.insert(
            "range".to_owned(),
            RemoteArgumentDefinition::Integer {
                required: true,
                minimum: Some(10),
                maximum: Some(1),
            },
        );

        let mut duplicate_string_allowlist = target(1);
        duplicate_string_allowlist.operations[0].arguments.insert(
            "scope".to_owned(),
            RemoteArgumentDefinition::String {
                required: true,
                allowed_values: Some(vec!["api".to_owned(), "api".to_owned()]),
                pattern: Some("^[a-z]+$".to_owned()),
                max_length: 32,
            },
        );

        for invalid in [
            duplicate_pin,
            invalid_limit,
            unknown_template_argument,
            invalid_integer_range,
            duplicate_string_allowlist,
        ] {
            let signed = signed_target(
                invalid,
                fixed_now() - Duration::from_secs(1),
                fixed_now() + Duration::from_secs(60),
                &signing_key,
            );
            assert!(matches!(
                store.install(signed, &authority, &binding, fixed_now()),
                Err(TargetConfigError::Rejected)
            ));
            assert!(store.is_empty());
        }
    }
}
