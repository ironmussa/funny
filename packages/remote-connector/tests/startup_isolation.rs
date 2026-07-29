#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use nix::unistd::{User, getegid, geteuid};
use tempfile::tempdir;

#[test]
fn executable_refuses_an_interactive_or_elevated_identity() {
    let data = tempdir().expect("data directory");
    let ipc = tempdir().expect("IPC directory");
    fs::set_permissions(data.path(), fs::Permissions::from_mode(0o700))
        .expect("set data permissions");
    fs::set_permissions(ipc.path(), fs::Permissions::from_mode(0o710))
        .expect("set IPC permissions");
    let username = User::from_uid(geteuid())
        .expect("inspect user")
        .expect("current user")
        .name;
    let endpoint = ipc.path().join("connector.sock");
    let target_authority_public_key = URL_SAFE_NO_PAD.encode(
        SigningKey::from_bytes(&[7_u8; 32])
            .verifying_key()
            .as_bytes(),
    );

    let output = Command::new(env!("CARGO_BIN_EXE_funny-remote-connector"))
        .args([
            "describe",
            "--data-directory",
            data.path().to_str().expect("data path"),
            "--ipc-endpoint",
            endpoint.to_str().expect("IPC endpoint"),
            "--service-identity",
            &username,
            "--forbidden-identities",
            "funny-runtime,funny-agent",
            "--runtime-group-id",
            &getegid().as_raw().to_string(),
            "--target-authority-public-key",
            &target_authority_public_key,
        ])
        .output()
        .expect("run Connector");

    assert_eq!(output.status.code(), Some(2));
    let description: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse description");
    assert_eq!(description["isolation"]["verified"], false);
    assert!(
        description["isolation"]["failures"]
            .as_array()
            .is_some_and(|failures| !failures.is_empty())
    );
}
