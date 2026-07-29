use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformPaths {
    pub data_directory: PathBuf,
    pub ipc_directory: Option<PathBuf>,
    pub ipc_endpoint: String,
}

impl PlatformPaths {
    pub fn discover(
        data_directory_override: Option<PathBuf>,
        ipc_endpoint_override: Option<String>,
    ) -> Self {
        let defaults = default_paths();
        let ipc_endpoint = ipc_endpoint_override.unwrap_or(defaults.ipc_endpoint);
        let ipc_directory = if cfg!(windows) {
            None
        } else {
            std::path::Path::new(&ipc_endpoint)
                .parent()
                .map(std::path::Path::to_path_buf)
        };
        Self {
            data_directory: data_directory_override.unwrap_or(defaults.data_directory),
            ipc_directory,
            ipc_endpoint,
        }
    }
}

#[cfg(target_os = "linux")]
fn default_paths() -> PlatformPaths {
    PlatformPaths {
        data_directory: PathBuf::from("/var/lib/funny-remote-connector"),
        ipc_directory: Some(PathBuf::from("/run/funny-remote-connector")),
        ipc_endpoint: "/run/funny-remote-connector/connector.sock".to_owned(),
    }
}

#[cfg(target_os = "macos")]
fn default_paths() -> PlatformPaths {
    PlatformPaths {
        data_directory: PathBuf::from("/Library/Application Support/Funny Remote Connector"),
        ipc_directory: Some(PathBuf::from("/var/run/funny-remote-connector")),
        ipc_endpoint: "/var/run/funny-remote-connector/connector.sock".to_owned(),
    }
}

#[cfg(windows)]
fn default_paths() -> PlatformPaths {
    let program_data = std::env::var_os("ProgramData").unwrap_or_else(|| r"C:\ProgramData".into());
    PlatformPaths {
        data_directory: PathBuf::from(program_data)
            .join("Funny")
            .join("RemoteConnector"),
        ipc_directory: None,
        ipc_endpoint: r"\\.\pipe\funny-remote-connector".to_owned(),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn default_paths() -> PlatformPaths {
    PlatformPaths {
        data_directory: PathBuf::new(),
        ipc_directory: None,
        ipc_endpoint: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_are_kept_outside_the_repository() {
        let paths = PlatformPaths::discover(
            Some(PathBuf::from("/service-owned/data")),
            Some("/service-owned/run/connector.sock".to_owned()),
        );
        assert_eq!(paths.data_directory, PathBuf::from("/service-owned/data"));
        assert_eq!(paths.ipc_endpoint, "/service-owned/run/connector.sock");
    }
}
