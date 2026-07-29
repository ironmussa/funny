use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
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
use crate::core::target_config::{
    RemoteArgumentDefinition, RemoteCommandToken, RemoteEnvironment, RemoteOperation,
    RemoteTargetConfig, TargetConfigAuthority, TargetConfigStore,
};

const REPLAY_STATE_FILE: &str = "execution-replay-state.json";
const REPLAY_STATE_SCHEMA_VERSION: u16 = 1;
const REQUEST_SIGNATURE_DOMAIN: &str = "funny-remote-connector-request-v1";
const APPROVAL_SIGNATURE_DOMAIN: &str = "funny-remote-connector-production-approval-v1";
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(5);
const MAX_REQUEST_AGE: Duration = Duration::from_secs(60);
const MAX_REQUEST_LIFETIME: Duration = Duration::from_secs(60);
const MAX_ID_BYTES: usize = 128;
const MAX_ENCODED_FIELD_BYTES: usize = 16_384;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_ACTIVE_REPLAY_RECORDS: usize = 10_000;
const MAX_REPLAY_STATE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
enum LifetimeError {
    Authorization,
    Approval,
}

#[derive(Debug, Error)]
pub enum AuthorizationError {
    #[error("Remote execution authorization state is unavailable")]
    StateUnavailable(#[source] std::io::Error),
    #[error("Remote execution authorization state is invalid")]
    InvalidState,
    #[error("Remote execution request is unauthorized")]
    AuthorizationDenied,
    #[error("Remote execution target is unavailable")]
    TargetUnavailable,
    #[error("Remote operation is denied")]
    OperationDenied,
    #[error("Production approval is required")]
    ApprovalRequired,
    #[error("Production approval is invalid")]
    ApprovalInvalid,
    #[error("Remote execution replay was detected")]
    ReplayDetected,
}

impl AuthorizationError {
    pub const fn error_code(&self) -> &'static str {
        match self {
            Self::StateUnavailable(_) | Self::InvalidState => "INTERNAL_ERROR",
            Self::AuthorizationDenied => "AUTHORIZATION_DENIED",
            Self::TargetUnavailable => "TARGET_UNAVAILABLE",
            Self::OperationDenied => "OPERATION_DENIED",
            Self::ApprovalRequired => "APPROVAL_REQUIRED",
            Self::ApprovalInvalid => "APPROVAL_INVALID",
            Self::ReplayDetected => "REPLAY_DETECTED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteExecutionRequest {
    pub kind: RemoteExecutionRequestKind,
    pub protocol_version: u16,
    pub request_id: String,
    pub runner_id: String,
    pub connector_id: String,
    pub project_id: String,
    pub thread_id: Option<String>,
    pub target_id: String,
    pub operation_id: String,
    pub arguments: BTreeMap<String, RemoteArgumentValue>,
    pub actor: RemoteExecutionActor,
    pub issued_at: String,
    pub expires_at: String,
    pub nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<RemoteProductionApproval>,
    pub request_digest: String,
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum RemoteExecutionRequestKind {
    #[serde(rename = "execute")]
    Execute,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteExecutionActor {
    pub user_id: String,
    pub kind: RemoteExecutionActorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteExecutionActorKind {
    Human,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteProductionApproval {
    pub approval_id: String,
    pub request_digest: String,
    pub approved_by: String,
    pub issued_at: String,
    pub expires_at: String,
    pub nonce: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum RemoteArgumentValue {
    String(String),
    Integer(i64),
    Boolean(bool),
}

impl RemoteArgumentValue {
    fn as_argument(&self) -> String {
        match self {
            Self::String(value) => value.clone(),
            Self::Integer(value) => value.to_string(),
            Self::Boolean(value) => value.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedExecution {
    pub request_id: String,
    pub request_digest: String,
    pub actor: RemoteExecutionActor,
    pub project_id: String,
    pub thread_id: Option<String>,
    pub target: RemoteTargetConfig,
    pub operation_id: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub timeout_ms: u32,
    pub output_limit_bytes: u32,
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedReplayState {
    schema_version: u16,
    requests: BTreeMap<String, ReplayRecord>,
    request_nonces: BTreeMap<String, u64>,
    request_digests: BTreeMap<String, u64>,
    approvals: BTreeMap<String, ReplayRecord>,
    approval_nonces: BTreeMap<String, u64>,
}

impl Default for PersistedReplayState {
    fn default() -> Self {
        Self {
            schema_version: REPLAY_STATE_SCHEMA_VERSION,
            requests: BTreeMap::new(),
            request_nonces: BTreeMap::new(),
            request_digests: BTreeMap::new(),
            approvals: BTreeMap::new(),
            approval_nonces: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayRecord {
    nonce: String,
    digest: String,
    expires_at_unix_ms: u64,
}

pub struct ExecutionAuthorizer {
    replay_path: PathBuf,
    replay: PersistedReplayState,
}

impl ExecutionAuthorizer {
    pub fn open(data_directory: &Path) -> Result<Self, AuthorizationError> {
        let replay_path = data_directory.join(REPLAY_STATE_FILE);
        if !replay_path.exists() {
            return Ok(Self {
                replay_path,
                replay: PersistedReplayState::default(),
            });
        }
        let metadata = fs::metadata(&replay_path).map_err(AuthorizationError::StateUnavailable)?;
        if metadata.len() > MAX_REPLAY_STATE_BYTES {
            return Err(AuthorizationError::InvalidState);
        }
        let encoded = fs::read(&replay_path).map_err(AuthorizationError::StateUnavailable)?;
        let replay: PersistedReplayState =
            serde_json::from_slice(&encoded).map_err(|_| AuthorizationError::InvalidState)?;
        validate_replay_state(&replay)?;
        enforce_private_file_permissions(&replay_path)?;
        Ok(Self {
            replay_path,
            replay,
        })
    }

    pub fn authorize(
        &mut self,
        request: RemoteExecutionRequest,
        target_store: &TargetConfigStore,
        authority: &TargetConfigAuthority,
        binding: &PairingBinding,
        now: SystemTime,
    ) -> Result<AuthorizedExecution, AuthorizationError> {
        validate_request_shape(&request)?;
        validate_request_binding_and_lifetime(&request, binding, now)?;

        let expected_digest = request_digest(&request)?;
        if request.request_digest != expected_digest
            || !authority.verifies(
                &signature_payload(REQUEST_SIGNATURE_DOMAIN, &request.request_digest),
                &request.signature,
            )
        {
            return Err(AuthorizationError::AuthorizationDenied);
        }

        let signed_target = target_store
            .validated_target(&request.target_id, authority, binding, now)
            .map_err(|_| AuthorizationError::TargetUnavailable)?;
        let target = &signed_target.config;
        if !target.enabled {
            return Err(AuthorizationError::TargetUnavailable);
        }
        let operation = target
            .operations
            .iter()
            .find(|operation| operation.id == request.operation_id)
            .ok_or(AuthorizationError::OperationDenied)?;
        let arguments = validate_arguments(operation, &request.arguments)?;

        if target.environment == RemoteEnvironment::Production && request.approval.is_none() {
            return Err(AuthorizationError::ApprovalRequired);
        }
        if let Some(approval) = &request.approval {
            validate_approval(approval, &request, authority, now)?;
        }

        self.consume_replay_records(&request, now)?;
        let argv = operation
            .argv
            .iter()
            .filter_map(|token| match token {
                RemoteCommandToken::Literal { literal } => Some(literal.clone()),
                RemoteCommandToken::Argument { argument } => arguments
                    .get(argument)
                    .map(RemoteArgumentValue::as_argument),
            })
            .collect();

        Ok(AuthorizedExecution {
            request_id: request.request_id,
            request_digest: request.request_digest,
            actor: request.actor,
            project_id: request.project_id,
            thread_id: request.thread_id,
            target: target.clone(),
            operation_id: operation.id.clone(),
            executable: operation.executable.clone(),
            argv,
            timeout_ms: operation.timeout_ms,
            output_limit_bytes: operation.output_limit_bytes,
            approval_id: request.approval.map(|approval| approval.approval_id),
        })
    }

    fn consume_replay_records(
        &mut self,
        request: &RemoteExecutionRequest,
        now: SystemTime,
    ) -> Result<(), AuthorizationError> {
        let now_ms = unix_milliseconds(now)?;
        prune_expired(&mut self.replay, now_ms);
        if self.replay.requests.contains_key(&request.request_id)
            || self.replay.request_nonces.contains_key(&request.nonce)
            || self
                .replay
                .request_digests
                .contains_key(&request.request_digest)
            || request.approval.as_ref().is_some_and(|approval| {
                self.replay.approvals.contains_key(&approval.approval_id)
                    || self.replay.approval_nonces.contains_key(&approval.nonce)
            })
        {
            return Err(AuthorizationError::ReplayDetected);
        }
        if active_record_count(&self.replay) >= MAX_ACTIVE_REPLAY_RECORDS {
            return Err(AuthorizationError::InvalidState);
        }

        let previous = self.replay.clone();
        let request_expiry = parse_timestamp(&request.expires_at)
            .map_err(|_| AuthorizationError::AuthorizationDenied)?;
        self.replay.requests.insert(
            request.request_id.clone(),
            ReplayRecord {
                nonce: request.nonce.clone(),
                digest: request.request_digest.clone(),
                expires_at_unix_ms: request_expiry,
            },
        );
        self.replay
            .request_nonces
            .insert(request.nonce.clone(), request_expiry);
        self.replay
            .request_digests
            .insert(request.request_digest.clone(), request_expiry);
        if let Some(approval) = &request.approval {
            let approval_expiry = parse_timestamp(&approval.expires_at)
                .map_err(|_| AuthorizationError::ApprovalInvalid)?;
            self.replay.approvals.insert(
                approval.approval_id.clone(),
                ReplayRecord {
                    nonce: approval.nonce.clone(),
                    digest: approval.request_digest.clone(),
                    expires_at_unix_ms: approval_expiry,
                },
            );
            self.replay
                .approval_nonces
                .insert(approval.nonce.clone(), approval_expiry);
        }
        if let Err(error) = self.persist() {
            self.replay = previous;
            return Err(error);
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), AuthorizationError> {
        let encoded =
            serde_json::to_vec(&self.replay).map_err(|_| AuthorizationError::InvalidState)?;
        let parent = self
            .replay_path
            .parent()
            .ok_or(AuthorizationError::InvalidState)?;
        let mut suffix = [0_u8; 8];
        OsRng.fill_bytes(&mut suffix);
        let temporary_path = parent.join(format!(
            ".execution-replay-state-{}.tmp",
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
            .map_err(AuthorizationError::StateUnavailable)?;
        let result = (|| {
            temporary
                .write_all(&encoded)
                .map_err(AuthorizationError::StateUnavailable)?;
            temporary
                .sync_all()
                .map_err(AuthorizationError::StateUnavailable)?;
            atomic_replace(&temporary_path, &self.replay_path)?;
            enforce_private_file_permissions(&self.replay_path)?;
            sync_directory(parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

fn validate_request_shape(request: &RemoteExecutionRequest) -> Result<(), AuthorizationError> {
    let ids = [
        request.request_id.as_str(),
        request.runner_id.as_str(),
        request.connector_id.as_str(),
        request.project_id.as_str(),
        request.target_id.as_str(),
        request.operation_id.as_str(),
        request.actor.user_id.as_str(),
    ];
    if request.protocol_version != PROTOCOL_VERSIONS[0]
        || ids.into_iter().any(|value| !valid_id(value))
        || request.thread_id.as_deref().is_some_and(|id| !valid_id(id))
        || request.arguments.len() > 128
        || request.arguments.keys().any(|name| !valid_id(name))
        || !valid_encoded_field(&request.nonce)
        || !valid_encoded_field(&request.request_digest)
        || !valid_encoded_field(&request.signature)
        || request.arguments.values().any(|value| {
            matches!(value, RemoteArgumentValue::String(value) if value.encode_utf16().count() > 4_096)
                || matches!(value, RemoteArgumentValue::Integer(value) if value.unsigned_abs() > MAX_SAFE_INTEGER as u64)
        })
    {
        return Err(AuthorizationError::AuthorizationDenied);
    }
    if let Some(approval) = &request.approval {
        let approval_ids = [approval.approval_id.as_str(), approval.approved_by.as_str()];
        if approval_ids.into_iter().any(|value| !valid_id(value))
            || !valid_encoded_field(&approval.request_digest)
            || !valid_encoded_field(&approval.nonce)
            || !valid_encoded_field(&approval.signature)
        {
            return Err(AuthorizationError::ApprovalInvalid);
        }
    }
    Ok(())
}

fn validate_request_binding_and_lifetime(
    request: &RemoteExecutionRequest,
    binding: &PairingBinding,
    now: SystemTime,
) -> Result<(), AuthorizationError> {
    if request.runner_id != binding.runner_id || request.connector_id != binding.connector_id {
        return Err(AuthorizationError::AuthorizationDenied);
    }
    validate_lifetime(
        &request.issued_at,
        &request.expires_at,
        now,
        true,
        LifetimeError::Authorization,
    )
}

fn validate_approval(
    approval: &RemoteProductionApproval,
    request: &RemoteExecutionRequest,
    authority: &TargetConfigAuthority,
    now: SystemTime,
) -> Result<(), AuthorizationError> {
    if approval.request_digest != request.request_digest {
        return Err(AuthorizationError::ApprovalInvalid);
    }
    validate_lifetime(
        &approval.issued_at,
        &approval.expires_at,
        now,
        false,
        LifetimeError::Approval,
    )?;
    let payload = approval_signature_payload(approval)?;
    if !authority.verifies(&payload, &approval.signature) {
        return Err(AuthorizationError::ApprovalInvalid);
    }
    Ok(())
}

fn validate_lifetime(
    issued_at: &str,
    expires_at: &str,
    now: SystemTime,
    enforce_age: bool,
    error: LifetimeError,
) -> Result<(), AuthorizationError> {
    let issued_at = parse_timestamp(issued_at).map_err(|_| lifetime_error(error))?;
    let expires_at = parse_timestamp(expires_at).map_err(|_| lifetime_error(error))?;
    let now_ms = unix_milliseconds(now)?;
    let clock_skew_ms = duration_milliseconds(MAX_CLOCK_SKEW)?;
    let maximum_lifetime_ms = duration_milliseconds(MAX_REQUEST_LIFETIME)?;
    let maximum_age_ms = duration_milliseconds(MAX_REQUEST_AGE)?;
    if issued_at > now_ms.saturating_add(clock_skew_ms)
        || (enforce_age && issued_at < now_ms.saturating_sub(maximum_age_ms))
        || expires_at <= now_ms
        || expires_at <= issued_at
        || expires_at - issued_at > maximum_lifetime_ms
    {
        return Err(lifetime_error(error));
    }
    Ok(())
}

fn request_digest(request: &RemoteExecutionRequest) -> Result<String, AuthorizationError> {
    let payload = serde_json::json!({
        "actor": request.actor,
        "arguments": request.arguments,
        "connectorId": request.connector_id,
        "expiresAt": request.expires_at,
        "issuedAt": request.issued_at,
        "kind": request.kind,
        "nonce": request.nonce,
        "operationId": request.operation_id,
        "projectId": request.project_id,
        "protocolVersion": request.protocol_version,
        "requestId": request.request_id,
        "runnerId": request.runner_id,
        "targetId": request.target_id,
        "threadId": request.thread_id,
    });
    let canonical = canonical_json(&payload)?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical)))
}

fn approval_signature_payload(
    approval: &RemoteProductionApproval,
) -> Result<Vec<u8>, AuthorizationError> {
    let payload = serde_json::json!({
        "approvalId": approval.approval_id,
        "approvedBy": approval.approved_by,
        "expiresAt": approval.expires_at,
        "issuedAt": approval.issued_at,
        "nonce": approval.nonce,
        "requestDigest": approval.request_digest,
    });
    let canonical = canonical_json(&payload)?;
    let mut encoded = Vec::with_capacity(APPROVAL_SIGNATURE_DOMAIN.len() + 1 + canonical.len());
    encoded.extend_from_slice(APPROVAL_SIGNATURE_DOMAIN.as_bytes());
    encoded.push(0);
    encoded.extend_from_slice(&canonical);
    Ok(encoded)
}

fn signature_payload(domain: &str, digest: &str) -> Vec<u8> {
    let mut payload = Vec::with_capacity(domain.len() + 1 + digest.len());
    payload.extend_from_slice(domain.as_bytes());
    payload.push(0);
    payload.extend_from_slice(digest.as_bytes());
    payload
}

fn validate_arguments(
    operation: &RemoteOperation,
    values: &BTreeMap<String, RemoteArgumentValue>,
) -> Result<BTreeMap<String, RemoteArgumentValue>, AuthorizationError> {
    if values
        .keys()
        .any(|name| !operation.arguments.contains_key(name))
    {
        return Err(AuthorizationError::OperationDenied);
    }
    let mut validated = BTreeMap::new();
    for (name, definition) in &operation.arguments {
        let Some(value) = values.get(name) else {
            if definition_required(definition) {
                return Err(AuthorizationError::OperationDenied);
            }
            continue;
        };
        let valid = match (definition, value) {
            (
                RemoteArgumentDefinition::String {
                    allowed_values,
                    pattern,
                    max_length,
                    ..
                },
                RemoteArgumentValue::String(value),
            ) => {
                value.encode_utf16().count() <= *max_length as usize
                    && allowed_values
                        .as_ref()
                        .is_none_or(|allowed| allowed.contains(value))
                    && pattern.as_ref().is_none_or(|pattern| {
                        Regex::new(pattern).is_ok_and(|regex| regex.is_match(value))
                    })
            }
            (
                RemoteArgumentDefinition::Integer {
                    minimum, maximum, ..
                },
                RemoteArgumentValue::Integer(value),
            ) => {
                value.unsigned_abs() <= MAX_SAFE_INTEGER as u64
                    && minimum.is_none_or(|minimum| *value >= minimum)
                    && maximum.is_none_or(|maximum| *value <= maximum)
            }
            (RemoteArgumentDefinition::Boolean { .. }, RemoteArgumentValue::Boolean(_)) => true,
            _ => false,
        };
        if !valid {
            return Err(AuthorizationError::OperationDenied);
        }
        validated.insert(name.clone(), value.clone());
    }
    Ok(validated)
}

const fn definition_required(definition: &RemoteArgumentDefinition) -> bool {
    match definition {
        RemoteArgumentDefinition::String { required, .. }
        | RemoteArgumentDefinition::Integer { required, .. }
        | RemoteArgumentDefinition::Boolean { required } => *required,
    }
}

const fn lifetime_error(error: LifetimeError) -> AuthorizationError {
    match error {
        LifetimeError::Authorization => AuthorizationError::AuthorizationDenied,
        LifetimeError::Approval => AuthorizationError::ApprovalInvalid,
    }
}

fn validate_replay_state(state: &PersistedReplayState) -> Result<(), AuthorizationError> {
    if state.schema_version != REPLAY_STATE_SCHEMA_VERSION
        || active_record_count(state) > MAX_ACTIVE_REPLAY_RECORDS
        || state.requests.len() != state.request_nonces.len()
        || state.requests.len() != state.request_digests.len()
        || state.approvals.len() != state.approval_nonces.len()
        || state.requests.iter().any(|(id, record)| {
            !valid_id(id)
                || !valid_encoded_field(&record.nonce)
                || !valid_encoded_field(&record.digest)
                || state.request_nonces.get(&record.nonce) != Some(&record.expires_at_unix_ms)
                || state.request_digests.get(&record.digest) != Some(&record.expires_at_unix_ms)
        })
        || state.approvals.iter().any(|(id, record)| {
            !valid_id(id)
                || !valid_encoded_field(&record.nonce)
                || !valid_encoded_field(&record.digest)
                || state.approval_nonces.get(&record.nonce) != Some(&record.expires_at_unix_ms)
        })
    {
        return Err(AuthorizationError::InvalidState);
    }
    Ok(())
}

fn active_record_count(state: &PersistedReplayState) -> usize {
    state.requests.len() + state.approvals.len()
}

fn prune_expired(state: &mut PersistedReplayState, now_ms: u64) {
    state
        .requests
        .retain(|_, record| record.expires_at_unix_ms > now_ms);
    state
        .approvals
        .retain(|_, record| record.expires_at_unix_ms > now_ms);
    state.request_nonces.retain(|_, expiry| *expiry > now_ms);
    state.request_digests.retain(|_, expiry| *expiry > now_ms);
    state.approval_nonces.retain(|_, expiry| *expiry > now_ms);
}

fn canonical_json(value: &serde_json::Value) -> Result<Vec<u8>, AuthorizationError> {
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
    serde_json::to_vec(&canonicalize(value)).map_err(|_| AuthorizationError::AuthorizationDenied)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn valid_encoded_field(value: &str) -> bool {
    value.len() >= 16 && value.len() <= MAX_ENCODED_FIELD_BYTES && valid_base64_url(value)
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

fn parse_timestamp(value: &str) -> Result<u64, AuthorizationError> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| AuthorizationError::AuthorizationDenied)?;
    u64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| AuthorizationError::AuthorizationDenied)
}

fn unix_milliseconds(time: SystemTime) -> Result<u64, AuthorizationError> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AuthorizationError::AuthorizationDenied)?;
    u64::try_from(duration.as_millis()).map_err(|_| AuthorizationError::AuthorizationDenied)
}

fn duration_milliseconds(duration: Duration) -> Result<u64, AuthorizationError> {
    u64::try_from(duration.as_millis()).map_err(|_| AuthorizationError::AuthorizationDenied)
}

#[cfg(unix)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), AuthorizationError> {
    fs::rename(source, destination).map_err(AuthorizationError::StateUnavailable)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), AuthorizationError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(AuthorizationError::StateUnavailable(
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn enforce_private_file_permissions(path: &Path) -> Result<(), AuthorizationError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(AuthorizationError::StateUnavailable)
}

#[cfg(windows)]
fn enforce_private_file_permissions(_path: &Path) -> Result<(), AuthorizationError> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AuthorizationError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(AuthorizationError::StateUnavailable)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), AuthorizationError> {
    Ok(())
}

#[cfg(test)]
pub(crate) fn sign_request_for_test(
    request: &mut RemoteExecutionRequest,
    signing_key: &ed25519_dalek::SigningKey,
) {
    use ed25519_dalek::Signer;

    request.request_digest = request_digest(request).expect("request digest");
    request.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(&signature_payload(
                REQUEST_SIGNATURE_DOMAIN,
                &request.request_digest,
            ))
            .to_bytes(),
    );
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::{TempDir, tempdir};

    use super::*;
    use crate::core::target_config::{SignedTargetConfig, target_config_digest};

    const SHARED_REQUEST_DIGEST: &str = "dw9IU6Mwh_Hh11MKtSGxvUj-_8EAMi2QEf8Kik12LCE";
    const ENCODED_VALUE: &str = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const TARGET_SIGNATURE_DOMAIN: &str = "funny-remote-connector-target-config-v1";

    fn fixed_now() -> SystemTime {
        let timestamp =
            OffsetDateTime::parse("2026-07-23T12:00:30.000Z", &Rfc3339).expect("fixed timestamp");
        UNIX_EPOCH
            + Duration::from_nanos(
                u64::try_from(timestamp.unix_timestamp_nanos()).expect("positive timestamp"),
            )
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

    fn authority(key: &SigningKey) -> TargetConfigAuthority {
        TargetConfigAuthority::from_base64_url(
            &URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()),
        )
        .expect("authority")
    }

    fn binding() -> PairingBinding {
        PairingBinding {
            connector_id: "connector-1".to_owned(),
            runner_id: "runner-1".to_owned(),
            key_version: 1,
            public_key_fingerprint: format!("SHA256:{ENCODED_VALUE}"),
        }
    }

    fn target(environment: RemoteEnvironment) -> RemoteTargetConfig {
        RemoteTargetConfig {
            protocol_version: 1,
            target_id: "target-1".to_owned(),
            config_version: 1,
            runner_id: "runner-1".to_owned(),
            connector_id: "connector-1".to_owned(),
            name: "API".to_owned(),
            environment,
            enabled: true,
            host: "api.internal".to_owned(),
            port: 22,
            username: "deploy".to_owned(),
            host_key_fingerprints: vec![format!("SHA256:{ENCODED_VALUE}")],
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
                arguments: BTreeMap::from([(
                    "lines".to_owned(),
                    RemoteArgumentDefinition::Integer {
                        required: true,
                        minimum: Some(1),
                        maximum: Some(100),
                    },
                )]),
                timeout_ms: 30_000,
                output_limit_bytes: 16_384,
            }],
        }
    }

    fn signed_target(
        environment: RemoteEnvironment,
        key: &SigningKey,
        now: SystemTime,
    ) -> SignedTargetConfig {
        let authority = authority(key);
        let config = target(environment);
        let mut signed = SignedTargetConfig {
            config_digest: target_config_digest(&config).expect("target digest"),
            config,
            issued_at: timestamp(now - Duration::from_secs(30)),
            expires_at: timestamp(now + Duration::from_secs(60 * 60)),
            signature_algorithm: "Ed25519".to_owned(),
            authority_key_fingerprint: authority.fingerprint().to_owned(),
            signature: String::new(),
        };
        let metadata = serde_json::json!({
            "authorityKeyFingerprint": signed.authority_key_fingerprint,
            "configDigest": signed.config_digest,
            "expiresAt": signed.expires_at,
            "issuedAt": signed.issued_at,
            "signatureAlgorithm": signed.signature_algorithm,
        });
        let canonical = canonical_json(&metadata).expect("target signature metadata");
        let mut payload = TARGET_SIGNATURE_DOMAIN.as_bytes().to_vec();
        payload.push(0);
        payload.extend_from_slice(&canonical);
        signed.signature = URL_SAFE_NO_PAD.encode(key.sign(&payload).to_bytes());
        signed
    }

    fn dependencies(
        environment: RemoteEnvironment,
    ) -> (
        TempDir,
        TargetConfigStore,
        TargetConfigAuthority,
        PairingBinding,
        SigningKey,
    ) {
        let directory = tempdir().expect("data directory");
        let key = signing_key();
        let authority = authority(&key);
        let binding = binding();
        let mut store = TargetConfigStore::open(directory.path()).expect("target store");
        store
            .install(
                signed_target(environment, &key, fixed_now()),
                &authority,
                &binding,
                fixed_now(),
            )
            .expect("install target");
        (directory, store, authority, binding, key)
    }

    fn request() -> RemoteExecutionRequest {
        RemoteExecutionRequest {
            kind: RemoteExecutionRequestKind::Execute,
            protocol_version: 1,
            request_id: "request-1".to_owned(),
            runner_id: "runner-1".to_owned(),
            connector_id: "connector-1".to_owned(),
            project_id: "project-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            target_id: "target-1".to_owned(),
            operation_id: "logs".to_owned(),
            arguments: BTreeMap::from([("lines".to_owned(), RemoteArgumentValue::Integer(20))]),
            actor: RemoteExecutionActor {
                user_id: "user-1".to_owned(),
                kind: RemoteExecutionActorKind::Human,
            },
            issued_at: "2026-07-23T12:00:00.000Z".to_owned(),
            expires_at: "2026-07-23T12:01:00.000Z".to_owned(),
            nonce: ENCODED_VALUE.to_owned(),
            approval: None,
            request_digest: String::new(),
            signature: String::new(),
        }
    }

    fn sign_request(request: &mut RemoteExecutionRequest, key: &SigningKey) {
        request.request_digest = request_digest(request).expect("request digest");
        request.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&signature_payload(
                REQUEST_SIGNATURE_DOMAIN,
                &request.request_digest,
            ))
            .to_bytes(),
        );
    }

    fn approval(request_digest: &str, key: &SigningKey) -> RemoteProductionApproval {
        let mut approval = RemoteProductionApproval {
            approval_id: "approval-1".to_owned(),
            request_digest: request_digest.to_owned(),
            approved_by: "user-2".to_owned(),
            issued_at: "2026-07-23T12:00:00.000Z".to_owned(),
            expires_at: "2026-07-23T12:01:00.000Z".to_owned(),
            nonce: ENCODED_VALUE.to_owned(),
            signature: String::new(),
        };
        approval.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&approval_signature_payload(&approval).expect("approval payload"))
                .to_bytes(),
        );
        approval
    }

    #[test]
    fn request_digest_matches_the_shared_typescript_contract() {
        assert_eq!(
            request_digest(&request()).expect("request digest"),
            SHARED_REQUEST_DIGEST
        );
        assert_eq!(
            signature_payload(REQUEST_SIGNATURE_DOMAIN, SHARED_REQUEST_DIGEST),
            format!("{REQUEST_SIGNATURE_DOMAIN}\0{SHARED_REQUEST_DIGEST}").as_bytes()
        );
        assert_eq!(
            approval_signature_payload(&approval(SHARED_REQUEST_DIGEST, &signing_key()))
                .expect("approval payload"),
            format!(
                "{APPROVAL_SIGNATURE_DOMAIN}\0{{\"approvalId\":\"approval-1\",\"approvedBy\":\"user-2\",\"expiresAt\":\"2026-07-23T12:01:00.000Z\",\"issuedAt\":\"2026-07-23T12:00:00.000Z\",\"nonce\":\"{ENCODED_VALUE}\",\"requestDigest\":\"{SHARED_REQUEST_DIGEST}\"}}"
            )
            .as_bytes()
        );
    }

    #[test]
    fn authorizes_a_signed_bound_allowlisted_operation() {
        let (directory, target_store, authority, binding, key) =
            dependencies(RemoteEnvironment::Staging);
        let mut request = request();
        sign_request(&mut request, &key);
        let mut authorizer = ExecutionAuthorizer::open(directory.path()).expect("authorizer");

        let plan = authorizer
            .authorize(request, &target_store, &authority, &binding, fixed_now())
            .expect("authorized plan");
        assert_eq!(plan.executable, "/usr/bin/journalctl");
        assert_eq!(plan.argv, ["--lines", "20"]);
        assert_eq!(plan.target.host, "api.internal");
        assert_eq!(plan.target.credential_ref, "credential-1");
    }

    #[test]
    fn rejects_forged_expired_mismatched_and_disallowed_requests() {
        let (directory, target_store, authority, binding, key) =
            dependencies(RemoteEnvironment::Staging);
        let candidates = [
            {
                let mut request = request();
                sign_request(&mut request, &key);
                request.signature = URL_SAFE_NO_PAD.encode([0_u8; 64]);
                request
            },
            {
                let mut request = request();
                request.runner_id = "runner-2".to_owned();
                sign_request(&mut request, &key);
                request
            },
            {
                let mut request = request();
                request.expires_at = "2026-07-23T12:00:29.000Z".to_owned();
                sign_request(&mut request, &key);
                request
            },
            {
                let mut request = request();
                request.operation_id = "shell".to_owned();
                sign_request(&mut request, &key);
                request
            },
            {
                let mut request = request();
                request.arguments.insert(
                    "lines".to_owned(),
                    RemoteArgumentValue::String("$(whoami)".to_owned()),
                );
                sign_request(&mut request, &key);
                request
            },
        ];

        for (index, candidate) in candidates.into_iter().enumerate() {
            let mut authorizer =
                ExecutionAuthorizer::open(directory.path()).expect("open authorizer");
            assert!(
                authorizer
                    .authorize(candidate, &target_store, &authority, &binding, fixed_now(),)
                    .is_err(),
                "candidate {index} must be rejected"
            );
        }
    }

    #[test]
    fn production_requires_a_valid_digest_bound_human_confirmation() {
        let (directory, target_store, authority, binding, key) =
            dependencies(RemoteEnvironment::Production);
        let mut missing = request();
        sign_request(&mut missing, &key);
        let mut authorizer = ExecutionAuthorizer::open(directory.path()).expect("authorizer");
        assert!(matches!(
            authorizer.authorize(missing, &target_store, &authority, &binding, fixed_now()),
            Err(AuthorizationError::ApprovalRequired)
        ));

        let mut forged = request();
        sign_request(&mut forged, &key);
        forged.approval = Some(approval(&forged.request_digest, &key));
        forged.approval.as_mut().expect("approval").approved_by = "attacker".to_owned();
        assert!(matches!(
            authorizer.authorize(forged, &target_store, &authority, &binding, fixed_now()),
            Err(AuthorizationError::ApprovalInvalid)
        ));

        let mut approved = request();
        sign_request(&mut approved, &key);
        approved.approval = Some(approval(&approved.request_digest, &key));
        let plan = authorizer
            .authorize(approved, &target_store, &authority, &binding, fixed_now())
            .expect("approved operation");
        assert_eq!(plan.approval_id.as_deref(), Some("approval-1"));
    }

    #[test]
    fn replay_protection_survives_reopening_and_consumes_approvals_once() {
        let (directory, target_store, authority, binding, key) =
            dependencies(RemoteEnvironment::Production);
        let mut first = request();
        sign_request(&mut first, &key);
        first.approval = Some(approval(&first.request_digest, &key));
        let mut authorizer = ExecutionAuthorizer::open(directory.path()).expect("authorizer");
        authorizer
            .authorize(
                first.clone(),
                &target_store,
                &authority,
                &binding,
                fixed_now(),
            )
            .expect("first use");
        assert!(matches!(
            authorizer.authorize(
                first.clone(),
                &target_store,
                &authority,
                &binding,
                fixed_now()
            ),
            Err(AuthorizationError::ReplayDetected)
        ));

        let mut reopened = ExecutionAuthorizer::open(directory.path()).expect("reopen authorizer");
        assert!(matches!(
            reopened.authorize(first, &target_store, &authority, &binding, fixed_now()),
            Err(AuthorizationError::ReplayDetected)
        ));

        let mut second = request();
        second.request_id = "request-2".to_owned();
        second.nonce = "zyxwvutsrqponmlkjihgfedcba9876543210GFEDCBA".to_owned();
        sign_request(&mut second, &key);
        let mut reused_approval = approval(&second.request_digest, &key);
        reused_approval.approval_id = "approval-1".to_owned();
        reused_approval.signature = URL_SAFE_NO_PAD.encode(
            key.sign(
                &approval_signature_payload(&reused_approval).expect("reused approval payload"),
            )
            .to_bytes(),
        );
        second.approval = Some(reused_approval);
        assert!(matches!(
            reopened.authorize(second, &target_store, &authority, &binding, fixed_now()),
            Err(AuthorizationError::ReplayDetected)
        ));
    }

    #[test]
    fn replay_state_atomically_replaces_an_existing_file() {
        let (directory, target_store, authority, binding, key) =
            dependencies(RemoteEnvironment::Staging);
        let mut authorizer = ExecutionAuthorizer::open(directory.path()).expect("authorizer");
        let mut first = request();
        sign_request(&mut first, &key);
        authorizer
            .authorize(first, &target_store, &authority, &binding, fixed_now())
            .expect("first request");

        let mut second = request();
        second.request_id = "request-2".to_owned();
        second.nonce = "zyxwvutsrqponmlkjihgfedcba9876543210GFEDCBA".to_owned();
        sign_request(&mut second, &key);
        authorizer
            .authorize(second, &target_store, &authority, &binding, fixed_now())
            .expect("second request");

        let reopened = ExecutionAuthorizer::open(directory.path()).expect("reopen authorizer");
        assert_eq!(reopened.replay.requests.len(), 2);
    }

    #[test]
    fn rejects_inconsistent_replay_state() {
        let directory = tempdir().expect("data directory");
        let path = directory.path().join(REPLAY_STATE_FILE);
        let state = serde_json::json!({
            "schemaVersion": REPLAY_STATE_SCHEMA_VERSION,
            "requests": {},
            "requestNonces": { ENCODED_VALUE: 1_000_000_u64 },
            "requestDigests": {},
            "approvals": {},
            "approvalNonces": {},
        });
        fs::write(path, serde_json::to_vec(&state).expect("state")).expect("write state");

        assert!(matches!(
            ExecutionAuthorizer::open(directory.path()),
            Err(AuthorizationError::InvalidState)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn replay_state_is_private_and_contains_only_authorization_metadata() {
        use std::os::unix::fs::PermissionsExt;

        let (directory, target_store, authority, binding, key) =
            dependencies(RemoteEnvironment::Staging);
        let mut request = request();
        sign_request(&mut request, &key);
        ExecutionAuthorizer::open(directory.path())
            .expect("authorizer")
            .authorize(request, &target_store, &authority, &binding, fixed_now())
            .expect("authorize");

        let path = directory.path().join(REPLAY_STATE_FILE);
        assert_eq!(
            path.metadata().expect("metadata").permissions().mode() & 0o777,
            0o600
        );
        let persisted = fs::read_to_string(path).expect("replay state");
        assert!(!persisted.contains("api.internal"));
        assert!(!persisted.contains("credential-1"));
        assert!(!persisted.contains("/usr/bin/journalctl"));
    }
}
