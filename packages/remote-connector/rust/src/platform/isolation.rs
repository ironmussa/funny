use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::platform::storage::{inspect_ipc_directory, inspect_storage, storage_failures};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolationPolicy {
    pub expected_service_identity: String,
    pub expected_service_sid: Option<String>,
    pub forbidden_identities: Vec<String>,
    pub runtime_group_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentitySnapshot {
    pub name: String,
    pub uid: u32,
    pub primary_group_id: u32,
    pub security_identifier: Option<String>,
    pub elevated: bool,
    pub non_login: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[serde(rename_all = "kebab-case")]
pub enum IsolationFailure {
    #[error("service identity is elevated")]
    ElevatedIdentity,
    #[error("service identity permits interactive login")]
    LoginIdentity,
    #[error("service identity does not match configuration")]
    ServiceIdentityMismatch,
    #[error("service identity is shared with an untrusted process")]
    SharedWithUntrustedIdentity,
    #[error("runtime IPC group is not configured")]
    MissingRuntimeGroup,
    #[error("{0} is missing")]
    MissingDirectory(&'static str),
    #[error("{0} is not a directory")]
    NotDirectory(&'static str),
    #[error("{0} has the wrong owner")]
    WrongOwner(&'static str),
    #[error("{0} has unsafe permissions")]
    UnsafePermissions(&'static str),
    #[error("platform is unsupported")]
    UnsupportedPlatform,
    #[error("isolation inspection failed")]
    InspectionFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationReport {
    pub verified: bool,
    pub service_identity: String,
    pub failures: Vec<IsolationFailure>,
}

pub fn assess_isolation(
    identity: &IdentitySnapshot,
    policy: &IsolationPolicy,
    data_directory: &Path,
    ipc_directory: Option<&Path>,
) -> IsolationReport {
    let mut failures = Vec::new();
    if identity.elevated {
        failures.push(IsolationFailure::ElevatedIdentity);
    }
    if !identity.non_login {
        failures.push(IsolationFailure::LoginIdentity);
    }
    if identity.name != policy.expected_service_identity {
        failures.push(IsolationFailure::ServiceIdentityMismatch);
    }
    if let Some(expected_sid) = &policy.expected_service_sid
        && identity.security_identifier.as_ref() != Some(expected_sid)
    {
        failures.push(IsolationFailure::ServiceIdentityMismatch);
    }
    if policy
        .forbidden_identities
        .iter()
        .any(|candidate| candidate == &identity.name)
    {
        failures.push(IsolationFailure::SharedWithUntrustedIdentity);
    }
    if policy.runtime_group_id.is_none() {
        failures.push(IsolationFailure::MissingRuntimeGroup);
    }

    failures.extend(storage_failures(
        "data-directory",
        &inspect_storage(data_directory, identity),
    ));
    if let Some(directory) = ipc_directory {
        failures.extend(storage_failures(
            "ipc-directory",
            &inspect_ipc_directory(directory, identity, policy.runtime_group_id),
        ));
    }

    IsolationReport {
        verified: failures.is_empty(),
        service_identity: identity.name.clone(),
        failures,
    }
}

#[cfg(unix)]
pub fn current_identity() -> Result<IdentitySnapshot, IsolationFailure> {
    use nix::unistd::{User, getegid, geteuid};

    let uid = geteuid();
    let user = User::from_uid(uid)
        .map_err(|_| IsolationFailure::InspectionFailed)?
        .ok_or(IsolationFailure::InspectionFailed)?;
    let shell = user.shell.to_string_lossy();
    let non_login = matches!(
        shell.as_ref(),
        "/bin/false" | "/usr/bin/false" | "/sbin/nologin" | "/usr/sbin/nologin"
    );
    Ok(IdentitySnapshot {
        name: user.name,
        uid: uid.as_raw(),
        primary_group_id: getegid().as_raw(),
        security_identifier: None,
        elevated: uid.is_root(),
        non_login,
    })
}

#[cfg(windows)]
pub fn current_identity() -> Result<IdentitySnapshot, IsolationFailure> {
    crate::platform::windows_security::current_identity()
}

#[cfg(not(any(unix, windows)))]
pub fn current_identity() -> Result<IdentitySnapshot, IsolationFailure> {
    Err(IsolationFailure::UnsupportedPlatform)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use nix::unistd::getegid;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn requires_distinct_non_login_non_root_service_identity() {
        let data = tempdir().expect("data");
        let ipc = tempdir().expect("ipc");
        fs::set_permissions(data.path(), fs::Permissions::from_mode(0o700)).expect("data mode");
        fs::set_permissions(ipc.path(), fs::Permissions::from_mode(0o710)).expect("ipc mode");
        let uid = data.path().metadata().expect("metadata").uid();
        let identity = IdentitySnapshot {
            name: "funny-connector".to_owned(),
            uid,
            primary_group_id: 4000,
            security_identifier: None,
            elevated: false,
            non_login: true,
        };
        let policy = IsolationPolicy {
            expected_service_identity: "funny-connector".to_owned(),
            expected_service_sid: None,
            forbidden_identities: vec!["funny-runtime".to_owned(), "funny-agent".to_owned()],
            runtime_group_id: Some(getegid().as_raw()),
        };

        assert!(assess_isolation(&identity, &policy, data.path(), Some(ipc.path())).verified);

        let report = assess_isolation(
            &IdentitySnapshot {
                elevated: true,
                non_login: false,
                ..identity
            },
            &policy,
            data.path(),
            Some(ipc.path()),
        );
        assert!(!report.verified);
        assert!(
            report
                .failures
                .contains(&IsolationFailure::ElevatedIdentity)
        );
        assert!(report.failures.contains(&IsolationFailure::LoginIdentity));
    }
}
