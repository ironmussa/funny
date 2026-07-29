use std::path::PathBuf;

use clap::Args;
use semver::Version;
use serde::Serialize;
use thiserror::Error;

use crate::core::product::MINIMUM_RUNTIME_VERSION;
use crate::core::target_config::TargetConfigAuthority;
use crate::platform::isolation::IsolationPolicy;
use crate::platform::paths::PlatformPaths;
use crate::service::protocol::CompatibilityPolicy;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("Connector service identity is required")]
    MissingServiceIdentity,
    #[error("At least one distinct runtime or agent identity is required")]
    MissingForbiddenIdentity,
    #[error("Unix runtime group id is required")]
    MissingRuntimeGroup,
    #[error("Windows service and runtime SIDs are required")]
    MissingWindowsSid,
    #[error("Runtime compatibility version policy is invalid")]
    InvalidCompatibilityVersion,
    #[error("Target configuration authority public key is required")]
    MissingTargetAuthority,
    #[error("Target configuration authority public key is invalid")]
    InvalidTargetAuthority,
}

#[derive(Debug, Clone, Args)]
pub struct ServiceOptions {
    #[arg(long, env = "FUNNY_CONNECTOR_DATA_DIR")]
    pub data_directory: Option<PathBuf>,
    #[arg(long, env = "FUNNY_CONNECTOR_IPC_ENDPOINT")]
    pub ipc_endpoint: Option<String>,
    #[arg(long, env = "FUNNY_CONNECTOR_SERVICE_IDENTITY")]
    pub service_identity: Option<String>,
    #[arg(
        long,
        env = "FUNNY_CONNECTOR_FORBIDDEN_IDENTITIES",
        value_delimiter = ','
    )]
    pub forbidden_identities: Vec<String>,
    #[arg(long, env = "FUNNY_CONNECTOR_RUNTIME_GID")]
    pub runtime_group_id: Option<u32>,
    #[arg(long, env = "FUNNY_CONNECTOR_SERVICE_SID")]
    pub service_sid: Option<String>,
    #[arg(long, env = "FUNNY_CONNECTOR_RUNTIME_SID")]
    pub runtime_sid: Option<String>,
    #[arg(
        long,
        env = "FUNNY_CONNECTOR_MINIMUM_RUNTIME_VERSION",
        default_value = MINIMUM_RUNTIME_VERSION
    )]
    pub minimum_runtime_version: String,
    #[arg(
        long,
        env = "FUNNY_CONNECTOR_REVOKED_RUNTIME_VERSIONS",
        value_delimiter = ','
    )]
    pub revoked_runtime_versions: Vec<String>,
    #[arg(long, env = "FUNNY_CONNECTOR_TARGET_AUTHORITY_PUBLIC_KEY")]
    pub target_authority_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub paths: PlatformPaths,
    #[serde(skip)]
    pub isolation_policy: IsolationPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_sid: Option<String>,
    #[serde(skip)]
    pub compatibility_policy: CompatibilityPolicy,
    #[serde(skip)]
    pub target_config_authority: TargetConfigAuthority,
}

impl ServiceOptions {
    pub fn resolve(self) -> Result<ServiceConfig, ConfigError> {
        let service_identity = self
            .service_identity
            .filter(|value| !value.trim().is_empty())
            .ok_or(ConfigError::MissingServiceIdentity)?;
        if self.forbidden_identities.is_empty() {
            return Err(ConfigError::MissingForbiddenIdentity);
        }
        if cfg!(unix) && self.runtime_group_id.is_none() {
            return Err(ConfigError::MissingRuntimeGroup);
        }
        if cfg!(windows) && (self.service_sid.is_none() || self.runtime_sid.is_none()) {
            return Err(ConfigError::MissingWindowsSid);
        }
        let minimum_runtime_version = Version::parse(&self.minimum_runtime_version)
            .map_err(|_| ConfigError::InvalidCompatibilityVersion)?;
        let revoked_runtime_versions = self
            .revoked_runtime_versions
            .iter()
            .map(|version| {
                Version::parse(version).map_err(|_| ConfigError::InvalidCompatibilityVersion)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let target_authority_public_key = self
            .target_authority_public_key
            .filter(|value| !value.trim().is_empty())
            .ok_or(ConfigError::MissingTargetAuthority)?;
        let target_config_authority =
            TargetConfigAuthority::from_base64_url(&target_authority_public_key)
                .map_err(|_| ConfigError::InvalidTargetAuthority)?;

        Ok(ServiceConfig {
            paths: PlatformPaths::discover(self.data_directory, self.ipc_endpoint),
            isolation_policy: IsolationPolicy {
                expected_service_identity: service_identity,
                expected_service_sid: self.service_sid.clone(),
                forbidden_identities: self.forbidden_identities,
                runtime_group_id: self.runtime_group_id,
            },
            service_sid: self.service_sid,
            runtime_sid: self.runtime_sid,
            compatibility_policy: CompatibilityPolicy::new(
                minimum_runtime_version,
                revoked_runtime_versions,
            ),
            target_config_authority,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> ServiceOptions {
        let target_authority_public_key =
            ed25519_dalek::SigningKey::from_bytes(&[7_u8; 32]).verifying_key();
        ServiceOptions {
            data_directory: Some(PathBuf::from("/service/data")),
            ipc_endpoint: Some("/service/run/connector.sock".to_owned()),
            service_identity: Some("funny-connector".to_owned()),
            forbidden_identities: vec!["funny-runtime".to_owned(), "funny-agent".to_owned()],
            runtime_group_id: Some(4001),
            service_sid: Some("S-1-5-80-100".to_owned()),
            runtime_sid: Some("S-1-5-21-200".to_owned()),
            minimum_runtime_version: MINIMUM_RUNTIME_VERSION.to_owned(),
            revoked_runtime_versions: Vec::new(),
            target_authority_public_key: Some(base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                target_authority_public_key.as_bytes(),
            )),
        }
    }

    #[test]
    fn requires_explicit_identity_separation() {
        let mut missing = options();
        missing.forbidden_identities.clear();
        assert!(matches!(
            missing.resolve(),
            Err(ConfigError::MissingForbiddenIdentity)
        ));
    }

    #[test]
    fn resolves_non_secret_platform_configuration() {
        let config = options().resolve().expect("config");
        assert_eq!(
            config.isolation_policy.expected_service_identity,
            "funny-connector"
        );
        assert_eq!(config.paths.data_directory, PathBuf::from("/service/data"));
    }
}
