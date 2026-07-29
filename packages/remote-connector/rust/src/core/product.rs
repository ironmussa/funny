use serde::Serialize;

pub const PRODUCT_NAME: &str = "funny-remote-connector";
pub const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MINIMUM_RUNTIME_VERSION: &str = "0.1.0";
pub const PROTOCOL_VERSIONS: &[u16] = &[1];
pub const CAPABILITIES: &[&str] = &[
    "credential-enrolment-v1",
    "password-auth-v1",
    "ssh-exec-v1",
    "output-redaction-v1",
    "production-approval-v1",
    "target-config-v1",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub protocol_versions: &'static [u16],
    pub capabilities: &'static [&'static str],
}

pub const fn product_info() -> ProductInfo {
    ProductInfo {
        name: PRODUCT_NAME,
        version: PRODUCT_VERSION,
        protocol_versions: PROTOCOL_VERSIONS,
        capabilities: CAPABILITIES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_version_is_semantic() {
        let components: Vec<_> = PRODUCT_VERSION.split('.').collect();
        assert_eq!(components.len(), 3);
        assert!(
            components
                .iter()
                .all(|component| component.parse::<u64>().is_ok())
        );
    }

    #[test]
    fn workspace_manifest_version_matches_cargo() {
        let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("package.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest_path).expect("read workspace manifest"))
                .expect("parse workspace manifest");
        assert_eq!(manifest["version"], PRODUCT_VERSION);
        assert_eq!(manifest["private"], true);
    }
}
