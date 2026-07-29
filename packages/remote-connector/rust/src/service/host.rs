use std::sync::Arc;
use std::time::SystemTime;

use serde::Serialize;
use thiserror::Error;
use tokio::sync::Mutex;

use crate::core::authorization::{AuthorizationError, ExecutionAuthorizer};
use crate::core::credential::CredentialMutationProcessor;
use crate::core::pairing::{PairingError, PairingRegistration, PairingStore};
use crate::core::product::{ProductInfo, product_info};
use crate::core::target_config::{TargetConfigError, TargetConfigStore};
use crate::platform::credential_store::NativeCredentialProvider;
use crate::platform::ipc::{IpcError, PlatformIpcListener};
use crate::platform::isolation::{
    IsolationFailure, IsolationReport, assess_isolation, current_identity,
};
use crate::service::config::ServiceConfig;
use crate::service::protocol::{ProtocolError, serve_connection};

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("Connector isolation validation failed")]
    IsolationFailed,
    #[error(transparent)]
    IsolationInspection(#[from] IsolationFailure),
    #[error(transparent)]
    Ipc(#[from] IpcError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Pairing(#[from] PairingError),
    #[error(transparent)]
    TargetConfig(#[from] TargetConfigError),
    #[error(transparent)]
    Authorization(#[from] AuthorizationError),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDescription {
    pub product: ProductInfo,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub paths: crate::platform::paths::PlatformPaths,
    pub isolation: IsolationReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPairingCode {
    pub registration: PairingRegistration,
    pub pairing_code: String,
}

impl std::fmt::Debug for LocalPairingCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalPairingCode")
            .field("registration", &self.registration)
            .field("pairing_code", &"[REDACTED]")
            .finish()
    }
}

pub struct ConnectorService {
    config: ServiceConfig,
}

impl ConnectorService {
    pub const fn new(config: ServiceConfig) -> Self {
        Self { config }
    }

    pub fn describe(&self) -> Result<ServiceDescription, ServiceError> {
        let identity = current_identity()?;
        let isolation = assess_isolation(
            &identity,
            &self.config.isolation_policy,
            &self.config.paths.data_directory,
            self.config.paths.ipc_directory.as_deref(),
        );
        Ok(ServiceDescription {
            product: product_info(),
            platform: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            paths: self.config.paths.clone(),
            isolation,
        })
    }

    pub fn local_pairing_code(&self, rotate_key: bool) -> Result<LocalPairingCode, ServiceError> {
        let description = self.describe()?;
        if !description.isolation.verified {
            return Err(ServiceError::IsolationFailed);
        }
        let now = SystemTime::now();
        let mut store = PairingStore::open(&self.config.paths.data_directory, now)?;
        if rotate_key {
            let challenge = store.rotate_enrolment_key(now)?;
            return Ok(LocalPairingCode {
                registration: challenge.registration,
                pairing_code: challenge.code.expose().to_owned(),
            });
        }
        let registration = store
            .pending_registration(now)?
            .ok_or(PairingError::NoPendingPairing)?;
        let pairing_code = store
            .pending_code(now)?
            .ok_or(PairingError::NoPendingPairing)?;
        Ok(LocalPairingCode {
            registration,
            pairing_code: pairing_code.expose().to_owned(),
        })
    }

    pub async fn run(self) -> Result<(), ServiceError> {
        let description = self.describe()?;
        if !description.isolation.verified {
            return Err(ServiceError::IsolationFailed);
        }
        let pairing_store = Arc::new(Mutex::new(PairingStore::open(
            &self.config.paths.data_directory,
            SystemTime::now(),
        )?));
        let target_config_store = {
            let store = pairing_store.lock().await;
            let target_store = TargetConfigStore::open(&self.config.paths.data_directory)?;
            if let Some(binding) = store.active_binding() {
                target_store.validate_all(
                    &self.config.target_config_authority,
                    &binding,
                    SystemTime::now(),
                )?;
            } else if !target_store.is_empty() {
                return Err(ServiceError::TargetConfig(TargetConfigError::InvalidCache));
            }
            Arc::new(Mutex::new(target_store))
        };
        let target_config_authority = Arc::new(self.config.target_config_authority.clone());
        let execution_authorizer = Arc::new(Mutex::new(ExecutionAuthorizer::open(
            &self.config.paths.data_directory,
        )?));
        let credential_processor = Arc::new(CredentialMutationProcessor::new(
            NativeCredentialProvider::discover(),
        ));

        #[cfg(unix)]
        let listener = PlatformIpcListener::bind(
            std::path::Path::new(&self.config.paths.ipc_endpoint),
            self.config
                .isolation_policy
                .runtime_group_id
                .ok_or(ServiceError::IsolationFailed)?,
        )?;

        #[cfg(windows)]
        let listener = PlatformIpcListener::bind(
            std::path::Path::new(&self.config.paths.ipc_endpoint),
            self.config
                .service_sid
                .clone()
                .ok_or(ServiceError::IsolationFailed)?,
            self.config
                .runtime_sid
                .clone()
                .ok_or(ServiceError::IsolationFailed)?,
        )?;

        tracing::info!(
            product = product_info().name,
            version = product_info().version,
            endpoint = %listener.endpoint().display(),
            "Connector service ready"
        );

        loop {
            tokio::select! {
                result = listener.accept() => {
                    let connection = result?;
                    let compatibility_policy = self.config.compatibility_policy.clone();
                    let pairing_store = Arc::clone(&pairing_store);
                    let credential_processor = Arc::clone(&credential_processor);
                    let target_config_store = Arc::clone(&target_config_store);
                    let target_config_authority = Arc::clone(&target_config_authority);
                    let execution_authorizer = Arc::clone(&execution_authorizer);
                    tokio::spawn(async move {
                        if let Err(error) = serve_connection(
                            connection,
                            compatibility_policy,
                            pairing_store,
                            credential_processor,
                            target_config_store,
                            target_config_authority,
                            execution_authorizer,
                        )
                        .await
                        {
                            tracing::warn!(error = %error, "IPC connection rejected");
                        }
                    });
                }
                signal = tokio::signal::ctrl_c() => {
                    signal.map_err(IpcError::CreateFailed)?;
                    tracing::info!("Connector service stopping");
                    return Ok(());
                }
            }
        }
    }
}
