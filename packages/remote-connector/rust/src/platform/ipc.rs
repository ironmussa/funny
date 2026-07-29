use std::pin::Pin;
use std::task::{Context, Poll};

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("IPC endpoint configuration is invalid")]
    InvalidEndpoint,
    #[error("IPC endpoint permissions could not be established")]
    UnsafePermissions,
    #[error("IPC endpoint could not be created")]
    CreateFailed(#[source] std::io::Error),
}

pub struct AuthorizedIpcConnection<S> {
    stream: S,
}

impl<S> AuthorizedIpcConnection<S> {
    fn from_protected_endpoint(stream: S) -> Self {
        Self { stream }
    }

    #[cfg(test)]
    pub(crate) fn for_test(stream: S) -> Self {
        Self { stream }
    }
}

impl<S> AsyncRead for AuthorizedIpcConnection<S>
where
    S: AsyncRead + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}

impl<S> AsyncWrite for AuthorizedIpcConnection<S>
where
    S: AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.stream).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.stream).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
}

#[cfg(unix)]
mod implementation {
    use std::fs;
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    use nix::unistd::{Gid, chown, geteuid};
    use tokio::net::{UnixListener, UnixStream};

    use super::{AuthorizedIpcConnection, IpcError};

    #[derive(Debug)]
    pub struct PlatformIpcListener {
        listener: UnixListener,
        endpoint: PathBuf,
    }

    impl PlatformIpcListener {
        pub fn bind(endpoint: &Path, runtime_group_id: u32) -> Result<Self, IpcError> {
            if !endpoint.is_absolute() {
                return Err(IpcError::InvalidEndpoint);
            }
            if endpoint.exists() {
                let metadata = endpoint
                    .symlink_metadata()
                    .map_err(IpcError::CreateFailed)?;
                if !metadata.file_type().is_socket() || metadata.uid() != geteuid().as_raw() {
                    return Err(IpcError::UnsafePermissions);
                }
                fs::remove_file(endpoint).map_err(IpcError::CreateFailed)?;
            }

            let listener = UnixListener::bind(endpoint).map_err(IpcError::CreateFailed)?;
            fs::set_permissions(endpoint, fs::Permissions::from_mode(0o660))
                .map_err(IpcError::CreateFailed)?;
            chown(endpoint, None, Some(Gid::from_raw(runtime_group_id)))
                .map_err(|error| IpcError::CreateFailed(error.into()))?;

            Ok(Self {
                listener,
                endpoint: endpoint.to_path_buf(),
            })
        }

        pub async fn accept(&self) -> Result<AuthorizedIpcConnection<UnixStream>, IpcError> {
            self.listener
                .accept()
                .await
                .map(|(stream, _)| AuthorizedIpcConnection::from_protected_endpoint(stream))
                .map_err(IpcError::CreateFailed)
        }

        pub fn endpoint(&self) -> &Path {
            &self.endpoint
        }
    }

    impl Drop for PlatformIpcListener {
        fn drop(&mut self) {
            if let Ok(metadata) = self.endpoint.symlink_metadata()
                && metadata.file_type().is_socket()
                && metadata.uid() == geteuid().as_raw()
            {
                let _ = fs::remove_file(&self.endpoint);
            }
        }
    }

    pub use PlatformIpcListener as Listener;
}

#[cfg(windows)]
mod implementation {
    use std::ffi::c_void;
    use std::path::Path;
    use std::ptr;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

    use super::{AuthorizedIpcConnection, IpcError};
    use crate::platform::windows_security::pipe_sddl;

    #[derive(Debug)]
    pub struct PlatformIpcListener {
        endpoint: String,
        service_sid: String,
        runtime_sid: String,
    }

    impl PlatformIpcListener {
        pub fn bind(
            endpoint: &Path,
            service_sid: String,
            runtime_sid: String,
        ) -> Result<Self, IpcError> {
            let endpoint = endpoint
                .to_str()
                .filter(|value| value.starts_with(r"\\.\pipe\"))
                .ok_or(IpcError::InvalidEndpoint)?
                .to_owned();
            Ok(Self {
                endpoint,
                service_sid,
                runtime_sid,
            })
        }

        pub async fn accept(&self) -> Result<AuthorizedIpcConnection<NamedPipeServer>, IpcError> {
            let sddl = pipe_sddl(&self.service_sid, &self.runtime_sid)
                .map_err(|_| IpcError::UnsafePermissions)?;
            let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
            let mut descriptor: *mut c_void = ptr::null_mut();
            let converted = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            };
            if converted == 0 || descriptor.is_null() {
                return Err(IpcError::UnsafePermissions);
            }

            let mut attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let server = unsafe {
                ServerOptions::new().create_with_security_attributes_raw(
                    &self.endpoint,
                    (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
                )
            }
            .map_err(IpcError::CreateFailed);
            unsafe {
                LocalFree(descriptor.cast());
            }
            let server = server?;
            server.connect().await.map_err(IpcError::CreateFailed)?;
            Ok(AuthorizedIpcConnection::from_protected_endpoint(server))
        }

        pub fn endpoint(&self) -> &Path {
            Path::new(&self.endpoint)
        }
    }

    pub use PlatformIpcListener as Listener;
}

#[cfg(not(any(unix, windows)))]
compile_error!("funny-remote-connector supports only Unix and Windows platforms");

pub use implementation::Listener as PlatformIpcListener;

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use nix::unistd::getegid;
    use tempfile::tempdir;
    use tokio::net::UnixStream;

    use super::*;

    #[tokio::test]
    async fn unix_socket_has_bounded_permissions_and_is_removed() {
        let directory = tempdir().expect("tempdir");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("directory mode");
        let endpoint = directory.path().join("connector.sock");
        {
            let listener =
                PlatformIpcListener::bind(&endpoint, getegid().as_raw()).expect("bind listener");
            let client = UnixStream::connect(&endpoint);
            let server = listener.accept();
            let (_client, _server) = tokio::join!(client, server);
            let metadata = endpoint.metadata().expect("socket metadata");
            assert_eq!(metadata.mode() & 0o777, 0o660);
            assert_eq!(metadata.gid(), getegid().as_raw());
        }
        assert!(!endpoint.exists());
    }
}
