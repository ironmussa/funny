use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::SystemTime;

use semver::Version;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc};

use crate::core::authorization::{ExecutionAuthorizer, RemoteExecutionRequest};
use crate::core::credential::{
    CredentialDelete, CredentialEnrolmentEnvelope, CredentialEnvelopeBinding, CredentialError,
    CredentialMutationProcessor, CredentialMutationStatus, CredentialProviderStatus,
};
use crate::core::execution::{
    CancellationToken, EmbeddedSshTransport, RemoteExecutionResult, SshTransport, execute_remote,
    record_execution_audit,
};
use crate::core::pairing::{
    ConnectorHello, PairingConfirmation, PairingRegistration, PairingStore,
};
use crate::core::product::{
    CAPABILITIES, MINIMUM_RUNTIME_VERSION, PRODUCT_VERSION, PROTOCOL_VERSIONS,
};
use crate::core::target_config::{SignedTargetConfig, TargetConfigAuthority, TargetConfigStore};
use crate::platform::ipc::AuthorizedIpcConnection;

const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilityPolicy {
    minimum_runtime_version: Version,
    revoked_runtime_versions: BTreeSet<Version>,
}

impl CompatibilityPolicy {
    pub fn new(
        minimum_runtime_version: Version,
        revoked_runtime_versions: impl IntoIterator<Item = Version>,
    ) -> Self {
        Self {
            minimum_runtime_version,
            revoked_runtime_versions: revoked_runtime_versions.into_iter().collect(),
        }
    }
}

impl Default for CompatibilityPolicy {
    fn default() -> Self {
        Self::new(
            Version::parse(MINIMUM_RUNTIME_VERSION)
                .expect("minimum runtime version must be semantic"),
            [],
        )
    }
}

const MAX_PROTOCOL_VERSIONS: usize = 8;
const MAX_REQUIRED_CAPABILITIES: usize = 32;
const MAX_CAPABILITY_TOKEN_BYTES: usize = 128;
const MAX_SEMANTIC_VERSION_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NegotiationRequest {
    kind: NegotiationRequestKind,
    protocol_versions: Vec<u16>,
    required_capabilities: Vec<String>,
    runtime_version: String,
}

impl NegotiationRequest {
    fn conforms_to_shared_contract(&self) -> bool {
        let unique_protocol_versions = self
            .protocol_versions
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();

        !self.protocol_versions.is_empty()
            && self.protocol_versions.len() <= MAX_PROTOCOL_VERSIONS
            && unique_protocol_versions.len() == self.protocol_versions.len()
            && self.required_capabilities.len() <= MAX_REQUIRED_CAPABILITIES
            && self
                .required_capabilities
                .iter()
                .all(|capability| valid_capability_token(capability))
            && !self.runtime_version.is_empty()
            && self.runtime_version.len() <= MAX_SEMANTIC_VERSION_BYTES
            && Version::parse(&self.runtime_version).is_ok()
    }
}

fn valid_capability_token(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_CAPABILITY_TOKEN_BYTES {
        return false;
    }
    let Some((name, version)) = value.rsplit_once("-v") else {
        return false;
    };
    !name.is_empty()
        && name.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
        && matches!(version.as_bytes().first(), Some(b'1'..=b'9'))
        && version.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
enum NegotiationRequestKind {
    #[serde(rename = "negotiate")]
    Negotiate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum NegotiationResult {
    Compatible {
        kind: NegotiationResultKind,
        compatible: bool,
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
        capabilities: Vec<String>,
        #[serde(rename = "connectorVersion")]
        connector_version: String,
    },
    Incompatible {
        kind: NegotiationResultKind,
        compatible: bool,
        reason: IncompatibilityReason,
        #[serde(rename = "connectorVersion")]
        connector_version: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
enum NegotiationResultKind {
    #[serde(rename = "negotiated")]
    Negotiated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IncompatibilityReason {
    NoCommonProtocol,
    MissingCapability,
    PeerVersionTooOld,
    RevokedPeer,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    kind: &'static str,
    protocol_version: u16,
    error_code: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Request {
    Execute(RemoteExecutionRequest),
    Cancel(RemoteCancellation),
    Control(ControlRequest),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "kebab-case")]
enum ControlRequest {
    PairingStatus {
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
    },
    PairingConfirmation {
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
        confirmation: PairingConfirmation,
    },
    Health {
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
    },
    CredentialEnrolment {
        algorithm: String,
        binding: CredentialEnvelopeBinding,
        ciphertext: String,
        iv: String,
        #[serde(rename = "wrappedKey")]
        wrapped_key: String,
    },
    CredentialDelete {
        binding: CredentialEnvelopeBinding,
    },
    TargetConfigUpdate {
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
        #[serde(rename = "signedTarget")]
        signed_target: SignedTargetConfig,
    },
}

impl Request {
    const fn protocol_version(&self) -> u16 {
        match self {
            Self::Execute(request) => request.protocol_version,
            Self::Cancel(cancellation) => cancellation.protocol_version,
            Self::Control(ControlRequest::PairingStatus { protocol_version })
            | Self::Control(ControlRequest::PairingConfirmation {
                protocol_version, ..
            })
            | Self::Control(ControlRequest::Health { protocol_version })
            | Self::Control(ControlRequest::TargetConfigUpdate {
                protocol_version, ..
            }) => *protocol_version,
            Self::Control(ControlRequest::CredentialEnrolment { binding, .. })
            | Self::Control(ControlRequest::CredentialDelete { binding }) => {
                binding.protocol_version
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteCancellation {
    kind: RemoteCancellationKind,
    protocol_version: u16,
    request_id: String,
    reason: RemoteCancellationReason,
}

#[derive(Debug, Deserialize)]
enum RemoteCancellationKind {
    #[serde(rename = "cancel")]
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RemoteCancellationReason {
    User,
    Timeout,
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingStatusResult {
    kind: &'static str,
    protocol_version: u16,
    registration: Option<PairingRegistration>,
    paired_runner_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum PairingConfirmationResult {
    Paired {
        kind: &'static str,
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
        status: &'static str,
        #[serde(rename = "connectorId")]
        connector_id: String,
        #[serde(rename = "runnerId")]
        runner_id: String,
        #[serde(rename = "keyVersion")]
        key_version: u32,
        #[serde(rename = "publicKeyFingerprint")]
        public_key_fingerprint: String,
    },
    Rejected {
        kind: &'static str,
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
        status: &'static str,
        #[serde(rename = "errorCode")]
        error_code: &'static str,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResult {
    kind: &'static str,
    protocol_version: u16,
    connector: ConnectorHello,
    status: &'static str,
    paired_runner_id: Option<String>,
    provider_status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialMutationAcknowledgement {
    kind: &'static str,
    protocol_version: u16,
    connector_id: String,
    target_id: String,
    credential_version: u32,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetConfigAcknowledgement {
    kind: &'static str,
    protocol_version: u16,
    connector_id: String,
    target_id: String,
    config_version: u32,
    config_digest: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("IPC protocol frame is too large")]
    FrameTooLarge,
    #[error("IPC protocol frame is malformed")]
    InvalidFrame,
    #[error("IPC protocol transport failed")]
    Transport(#[source] std::io::Error),
}

fn negotiate(request: &NegotiationRequest, policy: &CompatibilityPolicy) -> NegotiationResult {
    let runtime_version = match Version::parse(&request.runtime_version) {
        Ok(version) => version,
        Err(_) => return incompatible(IncompatibilityReason::PeerVersionTooOld),
    };
    if policy.revoked_runtime_versions.contains(&runtime_version) {
        return incompatible(IncompatibilityReason::RevokedPeer);
    }
    if runtime_version < policy.minimum_runtime_version {
        return incompatible(IncompatibilityReason::PeerVersionTooOld);
    }

    let protocol_version = PROTOCOL_VERSIONS
        .iter()
        .copied()
        .filter(|version| request.protocol_versions.contains(version))
        .max();
    let Some(protocol_version) = protocol_version else {
        return incompatible(IncompatibilityReason::NoCommonProtocol);
    };
    if request
        .required_capabilities
        .iter()
        .any(|capability| !CAPABILITIES.contains(&capability.as_str()))
    {
        return incompatible(IncompatibilityReason::MissingCapability);
    }

    NegotiationResult::Compatible {
        kind: NegotiationResultKind::Negotiated,
        compatible: true,
        protocol_version,
        capabilities: CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect(),
        connector_version: PRODUCT_VERSION.to_owned(),
    }
}

fn incompatible(reason: IncompatibilityReason) -> NegotiationResult {
    NegotiationResult::Incompatible {
        kind: NegotiationResultKind::Negotiated,
        compatible: false,
        reason,
        connector_version: PRODUCT_VERSION.to_owned(),
    }
}

pub async fn serve_connection<S>(
    stream: AuthorizedIpcConnection<S>,
    policy: CompatibilityPolicy,
    pairing_store: Arc<Mutex<PairingStore>>,
    credential_processor: Arc<CredentialMutationProcessor>,
    target_config_store: Arc<Mutex<TargetConfigStore>>,
    target_config_authority: Arc<TargetConfigAuthority>,
    execution_authorizer: Arc<Mutex<ExecutionAuthorizer>>,
) -> Result<(), ProtocolError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    serve_connection_with_transport(
        stream,
        ConnectionServices {
            policy,
            pairing_store,
            credential_processor,
            target_config_store,
            target_config_authority,
            execution_authorizer,
            transport: Arc::new(EmbeddedSshTransport),
        },
    )
    .await
}

struct ConnectionServices<T> {
    policy: CompatibilityPolicy,
    pairing_store: Arc<Mutex<PairingStore>>,
    credential_processor: Arc<CredentialMutationProcessor>,
    target_config_store: Arc<Mutex<TargetConfigStore>>,
    target_config_authority: Arc<TargetConfigAuthority>,
    execution_authorizer: Arc<Mutex<ExecutionAuthorizer>>,
    transport: Arc<T>,
}

async fn serve_connection_with_transport<S, T>(
    stream: AuthorizedIpcConnection<S>,
    services: ConnectionServices<T>,
) -> Result<(), ProtocolError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    T: SshTransport + 'static,
{
    let ConnectionServices {
        policy,
        pairing_store,
        credential_processor,
        target_config_store,
        target_config_authority,
        execution_authorizer,
        transport,
    } = services;
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let Some(frame) = read_frame(&mut reader).await? else {
        return Ok(());
    };
    let request = match serde_json::from_slice::<NegotiationRequest>(&frame) {
        Ok(request) if request.conforms_to_shared_contract() => request,
        Err(_) => {
            write_json(
                &mut writer,
                &ErrorResponse {
                    kind: "error",
                    protocol_version: PROTOCOL_VERSIONS[0],
                    error_code: "INCOMPATIBLE_PROTOCOL",
                },
            )
            .await?;
            return Ok(());
        }
        Ok(_) => {
            write_json(
                &mut writer,
                &ErrorResponse {
                    kind: "error",
                    protocol_version: PROTOCOL_VERSIONS[0],
                    error_code: "INCOMPATIBLE_PROTOCOL",
                },
            )
            .await?;
            return Ok(());
        }
    };
    let result = negotiate(&request, &policy);
    let selected_protocol = match result {
        NegotiationResult::Compatible {
            protocol_version, ..
        } => Some(protocol_version),
        NegotiationResult::Incompatible { .. } => None,
    };
    write_json(&mut writer, &result).await?;
    let Some(selected_protocol) = selected_protocol else {
        return Ok(());
    };

    let (result_sender, mut result_receiver) = mpsc::channel::<(String, RemoteExecutionResult)>(8);
    let mut active = BTreeMap::<String, CancellationToken>::new();
    loop {
        let frame = tokio::select! {
            result = result_receiver.recv(), if !active.is_empty() => {
                if let Some((request_id, result)) = result {
                    active.remove(&request_id);
                    write_json(&mut writer, &result).await?;
                }
                continue;
            }
            frame = read_frame(&mut reader) => frame?,
        };
        let Some(frame) = frame else {
            for cancellation in active.values() {
                cancellation.cancel();
            }
            break;
        };
        let request = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) if request.protocol_version() == selected_protocol => request,
            _ => {
                write_error(&mut writer, selected_protocol, "INTERNAL_ERROR").await?;
                continue;
            }
        };
        match request {
            Request::Execute(request) => {
                if active.len() >= 8 {
                    write_error(&mut writer, selected_protocol, "INTERNAL_ERROR").await?;
                    continue;
                }
                let binding = {
                    let store = pairing_store.lock().await;
                    store.active_binding()
                };
                let Some(binding) = binding else {
                    write_error(&mut writer, selected_protocol, "AUTHORIZATION_DENIED").await?;
                    continue;
                };
                let authorization = {
                    let targets = target_config_store.lock().await;
                    execution_authorizer.lock().await.authorize(
                        request,
                        &targets,
                        &target_config_authority,
                        &binding,
                        SystemTime::now(),
                    )
                };
                let execution = match authorization {
                    Ok(execution) => execution,
                    Err(error) => {
                        write_error(&mut writer, selected_protocol, error.error_code()).await?;
                        continue;
                    }
                };
                let request_id = execution.request_id.clone();
                let cancellation = CancellationToken::default();
                active.insert(request_id.clone(), cancellation.clone());
                let result_sender = result_sender.clone();
                let transport = Arc::clone(&transport);
                let credential_processor = Arc::clone(&credential_processor);
                tokio::spawn(async move {
                    let result = execute_remote(
                        transport.as_ref(),
                        &execution,
                        credential_processor.as_ref(),
                        &cancellation,
                    )
                    .await;
                    record_execution_audit(&execution, &result);
                    let _ = result_sender.send((request_id, result)).await;
                });
            }
            Request::Cancel(cancellation) => {
                let _kind = cancellation.kind;
                let _reason = cancellation.reason;
                if let Some(active_cancellation) = active.get(&cancellation.request_id) {
                    active_cancellation.cancel();
                } else {
                    write_error(&mut writer, selected_protocol, "INTERNAL_ERROR").await?;
                }
            }
            Request::Control(ControlRequest::PairingStatus { .. }) => {
                let response = {
                    let mut store = pairing_store.lock().await;
                    match store.pending_registration(SystemTime::now()) {
                        Ok(registration) => Some(PairingStatusResult {
                            kind: "pairing-status-result",
                            protocol_version: selected_protocol,
                            registration,
                            paired_runner_id: store.paired_runner_id().map(str::to_owned),
                        }),
                        Err(error) => {
                            tracing::warn!(error = %error, "Connector pairing status unavailable");
                            None
                        }
                    }
                };
                if let Some(response) = response {
                    write_json(&mut writer, &response).await?;
                } else {
                    write_error(&mut writer, selected_protocol, "INTERNAL_ERROR").await?;
                }
            }
            Request::Control(ControlRequest::PairingConfirmation { confirmation, .. }) => {
                let response = {
                    let mut store = pairing_store.lock().await;
                    if !confirmation_conforms_to_shared_contract(&confirmation) {
                        PairingConfirmationResult::Rejected {
                            kind: "pairing-confirmation-result",
                            protocol_version: selected_protocol,
                            status: "rejected",
                            error_code: "PAIRING_DENIED",
                        }
                    } else {
                        match store.confirm(&confirmation, SystemTime::now()) {
                            Ok(binding) => PairingConfirmationResult::Paired {
                                kind: "pairing-confirmation-result",
                                protocol_version: selected_protocol,
                                status: "paired",
                                connector_id: binding.connector_id,
                                runner_id: binding.runner_id,
                                key_version: binding.key_version,
                                public_key_fingerprint: binding.public_key_fingerprint,
                            },
                            Err(error) => {
                                tracing::warn!(
                                    error = %error,
                                    "Connector pairing confirmation rejected"
                                );
                                PairingConfirmationResult::Rejected {
                                    kind: "pairing-confirmation-result",
                                    protocol_version: selected_protocol,
                                    status: "rejected",
                                    error_code: "PAIRING_DENIED",
                                }
                            }
                        }
                    }
                };
                write_json(&mut writer, &response).await?;
            }
            Request::Control(ControlRequest::Health { .. }) => {
                let response = {
                    let store = pairing_store.lock().await;
                    match store.hello() {
                        Ok(connector) => Some(HealthResult {
                            kind: "health-result",
                            protocol_version: selected_protocol,
                            connector,
                            status: "healthy",
                            paired_runner_id: store.paired_runner_id().map(str::to_owned),
                            provider_status: match credential_processor.provider_status() {
                                CredentialProviderStatus::Available => "available",
                                CredentialProviderStatus::Unavailable => "unavailable",
                            },
                        }),
                        Err(error) => {
                            tracing::warn!(error = %error, "Connector health unavailable");
                            None
                        }
                    }
                };
                if let Some(response) = response {
                    write_json(&mut writer, &response).await?;
                } else {
                    write_error(&mut writer, selected_protocol, "INTERNAL_ERROR").await?;
                }
            }
            Request::Control(ControlRequest::CredentialEnrolment {
                algorithm,
                binding,
                ciphertext,
                iv,
                wrapped_key,
            }) => {
                if !binding.conforms_to_shared_contract() {
                    write_error(&mut writer, selected_protocol, "ENROLMENT_REJECTED").await?;
                    continue;
                }
                let envelope = CredentialEnrolmentEnvelope {
                    algorithm,
                    binding: binding.clone(),
                    ciphertext,
                    iv,
                    wrapped_key,
                };
                let validation = {
                    let store = pairing_store.lock().await;
                    store.validate_credential_enrolment(&envelope, SystemTime::now())
                };
                let result = if let Err(error) = validation {
                    Err(error)
                } else if credential_processor.provider_status()
                    != CredentialProviderStatus::Available
                {
                    Err(CredentialError::ProviderUnavailable)
                } else {
                    let password = {
                        let store = pairing_store.lock().await;
                        store.decrypt_credential_enrolment(&envelope, SystemTime::now())
                    };
                    password.and_then(|password| {
                        credential_processor.store(
                            &binding.target_id,
                            binding.credential_version,
                            &password,
                        )
                    })
                };
                let response = credential_acknowledgement(&binding, result);
                write_json(&mut writer, &response).await?;
            }
            Request::Control(ControlRequest::CredentialDelete { binding }) => {
                if !binding.conforms_to_shared_contract() {
                    write_error(&mut writer, selected_protocol, "ENROLMENT_REJECTED").await?;
                    continue;
                }
                let validation = {
                    let store = pairing_store.lock().await;
                    store.validate_credential_delete(
                        &CredentialDelete {
                            binding: binding.clone(),
                        },
                        SystemTime::now(),
                    )
                };
                let result = validation.and_then(|()| {
                    credential_processor.delete(&binding.target_id, binding.credential_version)
                });
                let response = credential_acknowledgement(&binding, result);
                write_json(&mut writer, &response).await?;
            }
            Request::Control(ControlRequest::TargetConfigUpdate { signed_target, .. }) => {
                let binding = {
                    let store = pairing_store.lock().await;
                    store.active_binding()
                };
                let result = match binding {
                    Some(binding) => target_config_store.lock().await.install(
                        signed_target.clone(),
                        &target_config_authority,
                        &binding,
                        SystemTime::now(),
                    ),
                    None => Err(crate::core::target_config::TargetConfigError::Rejected),
                };
                if let Err(error) = &result {
                    tracing::warn!(
                        error = %error,
                        target_id = %signed_target.config.target_id,
                        config_version = signed_target.config.config_version,
                        "Target configuration rejected"
                    );
                }
                let response = TargetConfigAcknowledgement {
                    kind: "target-config-ack",
                    protocol_version: selected_protocol,
                    connector_id: signed_target.config.connector_id,
                    target_id: signed_target.config.target_id,
                    config_version: signed_target.config.config_version,
                    config_digest: signed_target.config_digest,
                    status: if result.is_ok() { "cached" } else { "rejected" },
                    error_code: result.err().map(|_| "TARGET_UNAVAILABLE"),
                };
                write_json(&mut writer, &response).await?;
            }
        }
    }
    Ok(())
}

fn credential_acknowledgement(
    binding: &CredentialEnvelopeBinding,
    result: Result<CredentialMutationStatus, CredentialError>,
) -> CredentialMutationAcknowledgement {
    match result {
        Ok(CredentialMutationStatus::Stored) => CredentialMutationAcknowledgement {
            kind: "credential-ack",
            protocol_version: binding.protocol_version,
            connector_id: binding.connector_id.clone(),
            target_id: binding.target_id.clone(),
            credential_version: binding.credential_version,
            status: "stored",
            error_code: None,
        },
        Ok(CredentialMutationStatus::Deleted) => CredentialMutationAcknowledgement {
            kind: "credential-ack",
            protocol_version: binding.protocol_version,
            connector_id: binding.connector_id.clone(),
            target_id: binding.target_id.clone(),
            credential_version: binding.credential_version,
            status: "deleted",
            error_code: None,
        },
        Err(CredentialError::ProviderUnavailable) => CredentialMutationAcknowledgement {
            kind: "credential-ack",
            protocol_version: binding.protocol_version,
            connector_id: binding.connector_id.clone(),
            target_id: binding.target_id.clone(),
            credential_version: binding.credential_version,
            status: "rejected",
            error_code: Some("CREDENTIAL_UNAVAILABLE"),
        },
        Err(CredentialError::EnrolmentRejected) => CredentialMutationAcknowledgement {
            kind: "credential-ack",
            protocol_version: binding.protocol_version,
            connector_id: binding.connector_id.clone(),
            target_id: binding.target_id.clone(),
            credential_version: binding.credential_version,
            status: "rejected",
            error_code: Some("ENROLMENT_REJECTED"),
        },
    }
}

fn confirmation_conforms_to_shared_contract(confirmation: &PairingConfirmation) -> bool {
    valid_id(&confirmation.connector_id)
        && valid_id(&confirmation.runner_id)
        && valid_pairing_code(&confirmation.pairing_code)
        && confirmation.public_key_fingerprint.len() >= 16
        && confirmation.public_key_fingerprint.len() <= 256
        && confirmation
            .public_key_fingerprint
            .strip_prefix("SHA256:")
            .is_some_and(|digest| {
                !digest.is_empty()
                    && digest.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric()
                            || matches!(byte, b'+' | b'/' | b'=' | b'_' | b'-')
                    })
            })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn valid_pairing_code(value: &str) -> bool {
    value.len() == 9
        && value.as_bytes()[4] == b'-'
        && value.bytes().enumerate().all(|(index, byte)| {
            index == 4 || byte.is_ascii_uppercase() || (byte.is_ascii_digit() && byte >= b'2')
        })
}

async fn write_error<W>(
    writer: &mut W,
    protocol_version: u16,
    error_code: &'static str,
) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    write_json(
        writer,
        &ErrorResponse {
            kind: "error",
            protocol_version,
            error_code,
        },
    )
    .await
}

async fn read_frame<R>(reader: &mut R) -> Result<Option<Vec<u8>>, ProtocolError>
where
    R: AsyncBufRead + Unpin,
{
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(ProtocolError::Transport)?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(ProtocolError::InvalidFrame)
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |position| position + 1);
        let content_length = newline.unwrap_or(buffer.len());
        if frame.len() + content_length > MAX_FRAME_BYTES {
            return Err(ProtocolError::FrameTooLarge);
        }
        frame.extend_from_slice(&buffer[..content_length]);
        reader.consume(consumed);
        if newline.is_some() {
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            return if frame.is_empty() {
                Err(ProtocolError::InvalidFrame)
            } else {
                Ok(Some(frame))
            };
        }
    }
}

async fn write_json<W, T>(writer: &mut W, value: &T) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut encoded = serde_json::to_vec(value).map_err(|_| ProtocolError::InvalidFrame)?;
    encoded.push(b'\n');
    writer
        .write_all(&encoded)
        .await
        .map_err(ProtocolError::Transport)?;
    writer.flush().await.map_err(ProtocolError::Transport)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use aes_gcm::aead::{Aead, Payload};
    use aes_gcm::{Aes256Gcm, KeyInit};
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::SigningKey;
    use rand::RngCore;
    use rand::rngs::OsRng;
    use rsa::pkcs8::DecodePublicKey;
    use rsa::{Oaep, RsaPublicKey};
    use serde_json::Value;
    use sha2::Sha256;
    use tempfile::{TempDir, tempdir};
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    use super::*;
    use crate::core::authorization::{
        RemoteArgumentValue, RemoteExecutionActor, RemoteExecutionActorKind,
        RemoteExecutionRequestKind, sign_request_for_test,
    };
    use crate::core::credential::MemoryCredentialProvider;
    use crate::core::execution::{ExecutionErrorCode, SshCommandOutput};
    use crate::core::pairing::PairingConfirmation;
    use crate::core::target_config::{
        RemoteEnvironment, RemoteOperation, RemoteTargetConfig, sign_target_for_test,
    };
    use crate::platform::ipc::AuthorizedIpcConnection;

    fn request(runtime_version: &str) -> NegotiationRequest {
        NegotiationRequest {
            kind: NegotiationRequestKind::Negotiate,
            protocol_versions: vec![1],
            required_capabilities: vec!["ssh-exec-v1".to_owned()],
            runtime_version: runtime_version.to_owned(),
        }
    }

    fn pairing_store() -> (TempDir, Arc<Mutex<PairingStore>>) {
        let directory = tempdir().expect("pairing directory");
        let store = PairingStore::open(directory.path(), SystemTime::now()).expect("pairing store");
        (directory, Arc::new(Mutex::new(store)))
    }

    fn unavailable_credential_processor() -> Arc<CredentialMutationProcessor> {
        Arc::new(CredentialMutationProcessor::new(
            crate::core::credential::UnavailableCredentialProvider,
        ))
    }

    fn target_config_dependencies(
        directory: &std::path::Path,
    ) -> (Arc<Mutex<TargetConfigStore>>, Arc<TargetConfigAuthority>) {
        let public_key = SigningKey::from_bytes(&[7_u8; 32]).verifying_key();
        let authority =
            TargetConfigAuthority::from_base64_url(&URL_SAFE_NO_PAD.encode(public_key.as_bytes()))
                .expect("target authority");
        (
            Arc::new(Mutex::new(
                TargetConfigStore::open(directory).expect("target config store"),
            )),
            Arc::new(authority),
        )
    }

    fn execution_authorizer(directory: &std::path::Path) -> Arc<Mutex<ExecutionAuthorizer>> {
        Arc::new(Mutex::new(
            ExecutionAuthorizer::open(directory).expect("execution authorizer"),
        ))
    }

    fn future_expiry() -> String {
        (OffsetDateTime::now_utc() + time::Duration::minutes(1))
            .format(&Rfc3339)
            .expect("expiry timestamp")
    }

    fn timestamp_offset(seconds: i64) -> String {
        (OffsetDateTime::now_utc() + time::Duration::seconds(seconds))
            .format(&Rfc3339)
            .expect("timestamp")
    }

    fn encrypted_enrolment(
        binding: &CredentialEnvelopeBinding,
        public_key: &str,
        password: &str,
    ) -> Value {
        let public_der = URL_SAFE_NO_PAD
            .decode(public_key)
            .expect("public key encoding");
        let public_key =
            RsaPublicKey::from_public_key_der(&public_der).expect("public enrolment key");
        let mut content_key = [0_u8; 32];
        let mut iv = [0_u8; 12];
        OsRng.fill_bytes(&mut content_key);
        OsRng.fill_bytes(&mut iv);
        let wrapped_key = public_key
            .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &content_key)
            .expect("wrap content key");
        let aad = serde_json::to_vec(binding).expect("canonical binding");
        let ciphertext = Aes256Gcm::new_from_slice(&content_key)
            .expect("AES key")
            .encrypt(
                (&iv).into(),
                Payload {
                    msg: password.as_bytes(),
                    aad: &aad,
                },
            )
            .expect("encrypt password");
        content_key.fill(0);

        serde_json::json!({
            "kind": "credential-enrolment",
            "algorithm": "RSA-OAEP-256+A256GCM",
            "binding": binding,
            "wrappedKey": URL_SAFE_NO_PAD.encode(wrapped_key),
            "iv": URL_SAFE_NO_PAD.encode(iv),
            "ciphertext": URL_SAFE_NO_PAD.encode(ciphertext),
        })
    }

    async fn exchange_frame(
        client: &mut BufReader<tokio::io::DuplexStream>,
        frame: &Value,
    ) -> Value {
        write_json(client.get_mut(), frame)
            .await
            .expect("write request");
        let mut response = String::new();
        client
            .read_line(&mut response)
            .await
            .expect("read response");
        serde_json::from_str(&response).expect("JSON response")
    }

    struct CancellationAwareTransport;

    impl SshTransport for CancellationAwareTransport {
        async fn execute(
            &self,
            _execution: &crate::core::authorization::AuthorizedExecution,
            _credentials: &CredentialMutationProcessor,
            cancellation: &CancellationToken,
        ) -> Result<SshCommandOutput, ExecutionErrorCode> {
            cancellation.cancelled().await;
            Err(ExecutionErrorCode::Cancelled)
        }
    }

    #[test]
    fn selects_compatible_protocol_and_capabilities() {
        assert!(matches!(
            negotiate(&request("0.1.0"), &CompatibilityPolicy::default()),
            NegotiationResult::Compatible {
                protocol_version: 1,
                ..
            }
        ));
    }

    #[test]
    fn rejects_unsupported_old_revoked_and_missing_capability_peers() {
        let policy = CompatibilityPolicy::new(Version::new(0, 1, 0), [Version::new(0, 1, 1)]);
        let mut unsupported = request("0.1.0");
        unsupported.protocol_versions = vec![2];
        let mut missing = request("0.1.0");
        missing.required_capabilities = vec!["future-transport-v1".to_owned()];

        for (candidate, reason) in [
            (unsupported, IncompatibilityReason::NoCommonProtocol),
            (missing, IncompatibilityReason::MissingCapability),
            (request("0.0.9"), IncompatibilityReason::PeerVersionTooOld),
            (request("0.1.1"), IncompatibilityReason::RevokedPeer),
        ] {
            assert!(matches!(
                negotiate(&candidate, &policy),
                NegotiationResult::Incompatible {
                    reason: actual,
                    ..
                } if actual == reason
            ));
        }
    }

    #[test]
    fn validates_negotiation_request_against_shared_schema_limits() {
        let mut candidate = request("0.1.0");
        assert!(candidate.conforms_to_shared_contract());

        candidate.protocol_versions = vec![1, 1];
        assert!(!candidate.conforms_to_shared_contract());
        candidate.protocol_versions = vec![1];

        candidate.required_capabilities = vec!["SSH-exec-v1".to_owned()];
        assert!(!candidate.conforms_to_shared_contract());
        candidate.required_capabilities = vec!["ssh-exec-v0".to_owned()];
        assert!(!candidate.conforms_to_shared_contract());

        candidate.required_capabilities = vec!["ssh-exec-v1".to_owned()];
        candidate.runtime_version = "not-semver".to_owned();
        assert!(!candidate.conforms_to_shared_contract());
    }

    #[test]
    fn canonical_shared_fixtures_are_accepted_and_results_match() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../shared/src/__fixtures__/remote-connector-protocol-v1.json"
        ))
        .expect("shared fixtures");
        let requests: Vec<NegotiationRequest> =
            serde_json::from_value(fixtures["negotiationRequests"].clone())
                .expect("negotiation requests");
        let policy = CompatibilityPolicy::new(Version::new(0, 1, 0), [Version::new(0, 1, 1)]);
        let results: Vec<Value> = requests
            .iter()
            .map(|candidate| serde_json::to_value(negotiate(candidate, &policy)).expect("result"))
            .collect();
        assert_eq!(Value::Array(results), fixtures["negotiationResults"]);
    }

    #[tokio::test]
    async fn rejects_execution_before_negotiation() {
        let (directory, pairing_store) = pairing_store();
        let (target_config_store, target_config_authority) =
            target_config_dependencies(directory.path());
        let (mut client, server) = tokio::io::duplex(4_096);
        let task = tokio::spawn(serve_connection(
            AuthorizedIpcConnection::for_test(server),
            CompatibilityPolicy::default(),
            pairing_store,
            unavailable_credential_processor(),
            target_config_store,
            target_config_authority,
            execution_authorizer(directory.path()),
        ));
        client
            .write_all(b"{\"kind\":\"execute\",\"protocolVersion\":1}\n")
            .await
            .expect("write request");
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .await
            .expect("read response");
        assert_eq!(
            serde_json::from_str::<Value>(&response).expect("response")["errorCode"],
            "INCOMPATIBLE_PROTOCOL"
        );
        task.await
            .expect("connection task")
            .expect("serve connection");
    }

    #[tokio::test]
    async fn rejects_malformed_negotiation_before_followup_messages() {
        let (directory, pairing_store) = pairing_store();
        let (target_config_store, target_config_authority) =
            target_config_dependencies(directory.path());
        let (mut client, server) = tokio::io::duplex(4_096);
        let task = tokio::spawn(serve_connection(
            AuthorizedIpcConnection::for_test(server),
            CompatibilityPolicy::default(),
            pairing_store,
            unavailable_credential_processor(),
            target_config_store,
            target_config_authority,
            execution_authorizer(directory.path()),
        ));
        client
            .write_all(
                b"{\"kind\":\"negotiate\",\"protocolVersions\":[1,1],\"requiredCapabilities\":[\"ssh-exec-v1\"],\"runtimeVersion\":\"0.1.0\"}\n{\"kind\":\"execute\",\"protocolVersion\":1}\n",
            )
            .await
            .expect("write requests");
        client.shutdown().await.expect("close request stream");

        let mut reader = BufReader::new(client);
        let mut response = String::new();
        reader
            .read_line(&mut response)
            .await
            .expect("read response");
        assert_eq!(
            serde_json::from_str::<Value>(&response).expect("response")["errorCode"],
            "INCOMPATIBLE_PROTOCOL"
        );
        response.clear();
        assert_eq!(
            reader.read_line(&mut response).await.expect("read EOF"),
            0,
            "the execution frame must not be processed after failed negotiation"
        );
        task.await
            .expect("connection task")
            .expect("serve connection");
    }

    #[tokio::test]
    async fn reports_health_and_confirms_pairing_exactly_once_after_negotiation() {
        let directory = tempdir().expect("pairing directory");
        let now = SystemTime::now();
        let mut store = PairingStore::open(directory.path(), now).expect("pairing store");
        let registration = store
            .pending_registration(now)
            .expect("registration")
            .expect("pending registration");
        let code = store
            .pending_code(now)
            .expect("pairing code")
            .expect("pending pairing code")
            .expose()
            .to_owned();
        let connector_id = registration.connector.connector_id.clone();
        let fingerprint = registration.connector.public_key_fingerprint.clone();
        let pairing_store = Arc::new(Mutex::new(store));
        let (target_config_store, target_config_authority) =
            target_config_dependencies(directory.path());

        let (client, server) = tokio::io::duplex(32 * 1_024);
        let task = tokio::spawn(serve_connection(
            AuthorizedIpcConnection::for_test(server),
            CompatibilityPolicy::default(),
            Arc::clone(&pairing_store),
            unavailable_credential_processor(),
            target_config_store,
            target_config_authority,
            execution_authorizer(directory.path()),
        ));
        let mut client = BufReader::new(client);
        let frames = [
            serde_json::json!({
                "kind": "negotiate",
                "protocolVersions": [1],
                "requiredCapabilities": ["credential-enrolment-v1"],
                "runtimeVersion": "0.1.0"
            }),
            serde_json::json!({"kind": "health", "protocolVersion": 1}),
            serde_json::json!({"kind": "pairing-status", "protocolVersion": 1}),
            serde_json::json!({
                "kind": "pairing-confirmation",
                "protocolVersion": 1,
                "confirmation": {
                    "connectorId": connector_id,
                    "runnerId": "runner-1",
                    "pairingCode": "AAAA-AAAA",
                    "publicKeyFingerprint": fingerprint
                }
            }),
            serde_json::json!({
                "kind": "pairing-confirmation",
                "protocolVersion": 1,
                "confirmation": {
                    "connectorId": connector_id,
                    "runnerId": "runner-1",
                    "pairingCode": code,
                    "publicKeyFingerprint": fingerprint
                }
            }),
            serde_json::json!({
                "kind": "pairing-confirmation",
                "protocolVersion": 1,
                "confirmation": {
                    "connectorId": connector_id,
                    "runnerId": "runner-1",
                    "pairingCode": code,
                    "publicKeyFingerprint": fingerprint
                }
            }),
            serde_json::json!({"kind": "pairing-status", "protocolVersion": 1}),
        ];
        for frame in frames {
            write_json(client.get_mut(), &frame)
                .await
                .expect("write request");
        }
        client.get_mut().shutdown().await.expect("close requests");

        let mut responses = Vec::new();
        for _ in 0..7 {
            let mut response = String::new();
            client
                .read_line(&mut response)
                .await
                .expect("read response");
            responses.push(serde_json::from_str::<Value>(&response).expect("response JSON"));
        }
        assert_eq!(responses[0]["compatible"], true);
        assert_eq!(responses[1]["kind"], "health-result");
        assert_eq!(responses[1]["status"], "healthy");
        assert_eq!(responses[1]["connector"]["connectorId"], connector_id);
        assert_eq!(
            responses[1]["connector"]["capabilities"],
            serde_json::json!(CAPABILITIES)
        );
        assert_eq!(responses[2]["kind"], "pairing-status-result");
        assert_eq!(
            responses[2]["registration"]["connector"]["publicKeyFingerprint"],
            fingerprint
        );
        assert_eq!(responses[3]["errorCode"], "PAIRING_DENIED");
        assert_eq!(responses[4]["status"], "paired");
        assert_eq!(responses[4]["runnerId"], "runner-1");
        assert_eq!(responses[5]["errorCode"], "PAIRING_DENIED");
        assert!(responses[6]["registration"].is_null());
        assert_eq!(responses[6]["pairedRunnerId"], "runner-1");

        let serialized_responses = serde_json::to_string(&responses).expect("serialize responses");
        assert!(!serialized_responses.contains(&code));
        assert!(!serialized_responses.contains("privateKey"));
        assert_eq!(
            pairing_store.lock().await.paired_runner_id(),
            Some("runner-1")
        );
        task.await
            .expect("connection task")
            .expect("serve connection");
    }

    #[tokio::test]
    async fn executes_an_authorized_plan_and_cancels_its_embedded_transport() {
        let directory = tempdir().expect("connector directory");
        let now = SystemTime::now();
        let mut pairing = PairingStore::open(directory.path(), now).expect("pairing store");
        let registration = pairing
            .pending_registration(now)
            .expect("registration")
            .expect("pending registration");
        let pairing_code = pairing
            .pending_code(now)
            .expect("pairing code")
            .expect("pending pairing code")
            .expose()
            .to_owned();
        let binding = pairing
            .confirm(
                &PairingConfirmation {
                    connector_id: registration.connector.connector_id.clone(),
                    runner_id: "runner-1".to_owned(),
                    pairing_code,
                    public_key_fingerprint: registration.connector.public_key_fingerprint.clone(),
                },
                now + Duration::from_secs(1),
            )
            .expect("confirm pairing");
        let pairing_store = Arc::new(Mutex::new(pairing));

        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let (target_config_store, target_config_authority) =
            target_config_dependencies(directory.path());
        let target = RemoteTargetConfig {
            protocol_version: 1,
            target_id: "target-1".to_owned(),
            config_version: 1,
            runner_id: binding.runner_id.clone(),
            connector_id: binding.connector_id.clone(),
            name: "Staging target".to_owned(),
            environment: RemoteEnvironment::Staging,
            enabled: true,
            host: "host.invalid".to_owned(),
            port: 22,
            username: "deploy".to_owned(),
            host_key_fingerprints: vec![
                "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".to_owned(),
            ],
            credential_ref: "credential-1".to_owned(),
            credential_version: 1,
            connect_timeout_ms: 1_000,
            operations: vec![RemoteOperation {
                id: "status".to_owned(),
                name: "Status".to_owned(),
                executable: "/usr/bin/true".to_owned(),
                argv: vec![],
                arguments: BTreeMap::new(),
                timeout_ms: 30_000,
                output_limit_bytes: 1_024,
            }],
        };
        target_config_store
            .lock()
            .await
            .install(
                sign_target_for_test(
                    target,
                    timestamp_offset(-1),
                    timestamp_offset(60),
                    &signing_key,
                ),
                &target_config_authority,
                &binding,
                SystemTime::now(),
            )
            .expect("install target");

        let provider = MemoryCredentialProvider::default();
        let credential_processor = Arc::new(CredentialMutationProcessor::new(provider));
        credential_processor
            .store("target-1", 1, &zeroize::Zeroizing::new("secret".to_owned()))
            .expect("store credential");

        let mut execution = RemoteExecutionRequest {
            kind: RemoteExecutionRequestKind::Execute,
            protocol_version: 1,
            request_id: "request-1".to_owned(),
            runner_id: binding.runner_id,
            connector_id: binding.connector_id,
            project_id: "project-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            target_id: "target-1".to_owned(),
            operation_id: "status".to_owned(),
            arguments: BTreeMap::<String, RemoteArgumentValue>::new(),
            actor: RemoteExecutionActor {
                user_id: "user-1".to_owned(),
                kind: RemoteExecutionActorKind::Human,
            },
            issued_at: timestamp_offset(-1),
            expires_at: timestamp_offset(30),
            nonce: "abcdefghijklmnop".to_owned(),
            approval: None,
            request_digest: "abcdefghijklmnop".to_owned(),
            signature: "abcdefghijklmnop".to_owned(),
        };
        sign_request_for_test(&mut execution, &signing_key);

        let (client, server) = tokio::io::duplex(64 * 1_024);
        let task = tokio::spawn(serve_connection_with_transport(
            AuthorizedIpcConnection::for_test(server),
            ConnectionServices {
                policy: CompatibilityPolicy::default(),
                pairing_store,
                credential_processor,
                target_config_store,
                target_config_authority,
                execution_authorizer: execution_authorizer(directory.path()),
                transport: Arc::new(CancellationAwareTransport),
            },
        ));
        let mut client = BufReader::new(client);
        let negotiated = exchange_frame(
            &mut client,
            &serde_json::json!({
                "kind": "negotiate",
                "protocolVersions": [1],
                "requiredCapabilities": ["ssh-exec-v1"],
                "runtimeVersion": "0.1.0"
            }),
        )
        .await;
        assert_eq!(negotiated["compatible"], true);

        write_json(client.get_mut(), &execution)
            .await
            .expect("write execution");
        write_json(
            client.get_mut(),
            &serde_json::json!({
                "kind": "cancel",
                "protocolVersion": 1,
                "requestId": "request-1",
                "reason": "user"
            }),
        )
        .await
        .expect("write cancellation");

        let mut response = String::new();
        client
            .read_line(&mut response)
            .await
            .expect("read cancellation result");
        let result: Value = serde_json::from_str(&response).expect("result");
        assert_eq!(result["kind"], "result");
        assert_eq!(result["requestId"], "request-1");
        assert_eq!(result["status"], "cancelled");
        assert_eq!(result["errorCode"], "CANCELLED");
        assert_eq!(result["stdout"], "");
        assert_eq!(result["stderr"], "");

        client.get_mut().shutdown().await.expect("close client");
        task.await
            .expect("connection task")
            .expect("serve connection");
    }

    #[tokio::test]
    async fn enrols_rotates_and_deletes_only_runner_bound_credentials() {
        let directory = tempdir().expect("pairing directory");
        let now = SystemTime::now();
        let mut store = PairingStore::open(directory.path(), now).expect("pairing store");
        let registration = store
            .pending_registration(now)
            .expect("registration")
            .expect("pending registration");
        let code = store
            .pending_code(now)
            .expect("pairing code")
            .expect("pending pairing code")
            .expose()
            .to_owned();
        store
            .confirm(
                &PairingConfirmation {
                    connector_id: registration.connector.connector_id.clone(),
                    runner_id: "runner-1".to_owned(),
                    pairing_code: code,
                    public_key_fingerprint: registration.connector.public_key_fingerprint.clone(),
                },
                now + Duration::from_secs(1),
            )
            .expect("confirm pairing");
        let connector_id = registration.connector.connector_id.clone();
        let public_key = registration.connector.public_key.clone();
        let key_version = registration.connector.key_version;
        let pairing_store = Arc::new(Mutex::new(store));
        let provider = MemoryCredentialProvider::default();
        let credential_processor = Arc::new(CredentialMutationProcessor::new(provider.clone()));
        let (target_config_store, target_config_authority) =
            target_config_dependencies(directory.path());

        let (client, server) = tokio::io::duplex(64 * 1_024);
        let task = tokio::spawn(serve_connection(
            AuthorizedIpcConnection::for_test(server),
            CompatibilityPolicy::default(),
            pairing_store,
            credential_processor,
            target_config_store,
            target_config_authority,
            execution_authorizer(directory.path()),
        ));
        let mut client = BufReader::new(client);
        let negotiated = exchange_frame(
            &mut client,
            &serde_json::json!({
                "kind": "negotiate",
                "protocolVersions": [1],
                "requiredCapabilities": ["credential-enrolment-v1"],
                "runtimeVersion": "0.1.0"
            }),
        )
        .await;
        assert_eq!(negotiated["compatible"], true);

        let binding = CredentialEnvelopeBinding {
            connector_id: connector_id.clone(),
            connector_key_version: key_version,
            credential_version: 1,
            expires_at: future_expiry(),
            protocol_version: 1,
            runner_id: "runner-1".to_owned(),
            target_id: "target-1".to_owned(),
        };
        let first = encrypted_enrolment(&binding, &public_key, "first-secret");
        let stored = exchange_frame(&mut client, &first).await;
        assert_eq!(stored["status"], "stored");
        assert_eq!(
            provider.password("target-1").as_deref(),
            Some("first-secret")
        );

        let rotated_binding = CredentialEnvelopeBinding {
            credential_version: 2,
            expires_at: future_expiry(),
            ..binding.clone()
        };
        let rotated = encrypted_enrolment(&rotated_binding, &public_key, "rotated-secret");
        let rotated_ack = exchange_frame(&mut client, &rotated).await;
        assert_eq!(rotated_ack["status"], "stored");
        assert_eq!(
            provider.password("target-1").as_deref(),
            Some("rotated-secret")
        );

        let conflicting_retry =
            encrypted_enrolment(&rotated_binding, &public_key, "conflicting-secret");
        let conflicting_ack = exchange_frame(&mut client, &conflicting_retry).await;
        assert_eq!(conflicting_ack["status"], "rejected");
        assert_eq!(
            provider.password("target-1").as_deref(),
            Some("rotated-secret")
        );

        let stale = exchange_frame(&mut client, &first).await;
        assert_eq!(stale["status"], "rejected");
        assert_eq!(stale["errorCode"], "ENROLMENT_REJECTED");
        assert_eq!(
            provider.password("target-1").as_deref(),
            Some("rotated-secret")
        );

        let mismatched_binding = CredentialEnvelopeBinding {
            credential_version: 3,
            expires_at: future_expiry(),
            runner_id: "runner-2".to_owned(),
            ..binding.clone()
        };
        let mismatched =
            encrypted_enrolment(&mismatched_binding, &public_key, "wrong-runner-secret");
        let mismatched_ack = exchange_frame(&mut client, &mismatched).await;
        assert_eq!(mismatched_ack["status"], "rejected");
        assert_eq!(
            provider.password("target-1").as_deref(),
            Some("rotated-secret")
        );

        let deletion_binding = CredentialEnvelopeBinding {
            credential_version: 3,
            expires_at: future_expiry(),
            ..binding
        };
        let deleted = exchange_frame(
            &mut client,
            &serde_json::json!({
                "kind": "credential-delete",
                "binding": deletion_binding,
            }),
        )
        .await;
        assert_eq!(deleted["status"], "deleted");
        assert_eq!(provider.password("target-1"), None);

        let stale_after_delete = exchange_frame(&mut client, &rotated).await;
        assert_eq!(stale_after_delete["status"], "rejected");
        assert_eq!(provider.password("target-1"), None);
        let serialized = serde_json::to_string(&[
            stored,
            rotated_ack,
            conflicting_ack,
            stale,
            mismatched_ack,
            deleted,
            stale_after_delete,
        ])
        .expect("serialize acknowledgements");
        assert!(!serialized.contains("first-secret"));
        assert!(!serialized.contains("rotated-secret"));
        assert!(!serialized.contains("conflicting-secret"));
        assert!(!serialized.contains("wrong-runner-secret"));

        client.get_mut().shutdown().await.expect("close requests");
        task.await
            .expect("connection task")
            .expect("serve connection");
    }
}
