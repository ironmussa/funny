use std::path::Path;

use serde::Serialize;

use crate::platform::isolation::{IdentitySnapshot, IsolationFailure};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInspection {
    pub path_exists: bool,
    pub directory: bool,
    pub owner_matches: bool,
    pub private_permissions: bool,
}

#[cfg(unix)]
pub fn inspect_storage(path: &Path, identity: &IdentitySnapshot) -> StorageInspection {
    use std::os::unix::fs::MetadataExt;

    let Ok(metadata) = path.metadata() else {
        return StorageInspection {
            path_exists: false,
            directory: false,
            owner_matches: false,
            private_permissions: false,
        };
    };
    StorageInspection {
        path_exists: true,
        directory: metadata.is_dir(),
        owner_matches: metadata.uid() == identity.uid,
        private_permissions: metadata.mode() & 0o077 == 0,
    }
}

#[cfg(windows)]
pub fn inspect_storage(path: &Path, identity: &IdentitySnapshot) -> StorageInspection {
    let path_exists = path.exists();
    let expected_sid = identity.security_identifier.as_deref();
    let private = expected_sid
        .and_then(|sid| {
            crate::platform::windows_security::inspect_directory_security(path, sid).ok()
        })
        .unwrap_or(false);
    StorageInspection {
        path_exists,
        directory: path.is_dir(),
        owner_matches: private,
        private_permissions: private,
    }
}

pub fn storage_failures(
    label: &'static str,
    inspection: &StorageInspection,
) -> Vec<IsolationFailure> {
    let mut failures = Vec::new();
    if !inspection.path_exists {
        failures.push(IsolationFailure::MissingDirectory(label));
    } else if !inspection.directory {
        failures.push(IsolationFailure::NotDirectory(label));
    }
    if inspection.path_exists && !inspection.owner_matches {
        failures.push(IsolationFailure::WrongOwner(label));
    }
    if inspection.path_exists && !inspection.private_permissions {
        failures.push(IsolationFailure::UnsafePermissions(label));
    }
    failures
}

#[cfg(unix)]
pub fn inspect_ipc_directory(
    path: &Path,
    identity: &IdentitySnapshot,
    runtime_group_id: Option<u32>,
) -> StorageInspection {
    use std::os::unix::fs::MetadataExt;

    let Ok(metadata) = path.metadata() else {
        return StorageInspection {
            path_exists: false,
            directory: false,
            owner_matches: false,
            private_permissions: false,
        };
    };
    StorageInspection {
        path_exists: true,
        directory: metadata.is_dir(),
        owner_matches: metadata.uid() == identity.uid && runtime_group_id == Some(metadata.gid()),
        private_permissions: metadata.mode() & 0o777 == 0o710,
    }
}

#[cfg(windows)]
pub fn inspect_ipc_directory(
    path: &Path,
    identity: &IdentitySnapshot,
    _runtime_group_id: Option<u32>,
) -> StorageInspection {
    inspect_storage(path, identity)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn rejects_agent_readable_storage() {
        let temporary = tempdir().expect("tempdir");
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o755)).expect("set mode");
        let uid = temporary.path().metadata().expect("metadata").uid();
        let inspection = inspect_storage(
            temporary.path(),
            &IdentitySnapshot {
                name: "connector".to_owned(),
                uid,
                primary_group_id: 0,
                security_identifier: None,
                elevated: false,
                non_login: true,
            },
        );
        assert!(!inspection.private_permissions);
        assert_eq!(
            storage_failures("data", &inspection),
            vec![IsolationFailure::UnsafePermissions("data")]
        );
    }

    #[test]
    fn ipc_directory_allows_traversal_only_to_runtime_group() {
        let temporary = tempdir().expect("tempdir");
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o710)).expect("set mode");
        let metadata = temporary.path().metadata().expect("metadata");
        let identity = IdentitySnapshot {
            name: "connector".to_owned(),
            uid: metadata.uid(),
            primary_group_id: metadata.gid(),
            security_identifier: None,
            elevated: false,
            non_login: true,
        };
        assert!(
            inspect_ipc_directory(temporary.path(), &identity, Some(metadata.gid()))
                .private_permissions
        );
        assert!(
            !inspect_ipc_directory(temporary.path(), &identity, Some(metadata.gid() + 1))
                .owner_matches
        );
    }
}
