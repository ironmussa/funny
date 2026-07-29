use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use russh::client;
use russh::keys::{HashAlg, ssh_key};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::watch;
use zeroize::{Zeroize, Zeroizing};

use crate::core::authorization::AuthorizedExecution;
use crate::core::credential::CredentialMutationProcessor;

#[derive(Clone, Debug)]
pub struct CancellationToken {
    sender: watch::Sender<bool>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub(crate) async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        let _ = receiver.changed().await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecutionErrorCode {
    HostKeyMismatch,
    CredentialUnavailable,
    SshConnectionFailed,
    SshAuthenticationFailed,
    ExecutionTimeout,
    OutputLimitExceeded,
    Cancelled,
    InternalError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecutionResult {
    pub kind: &'static str,
    pub protocol_version: u16,
    pub request_id: String,
    pub status: ExecutionStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ExecutionErrorCode>,
    pub started_at: String,
    pub completed_at: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SshCommandOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub trait SshTransport: Send + Sync {
    fn execute(
        &self,
        execution: &AuthorizedExecution,
        credentials: &CredentialMutationProcessor,
        cancellation: &CancellationToken,
    ) -> impl Future<Output = Result<SshCommandOutput, ExecutionErrorCode>> + Send;
}

#[derive(Debug, Default)]
pub struct EmbeddedSshTransport;

impl SshTransport for EmbeddedSshTransport {
    async fn execute(
        &self,
        execution: &AuthorizedExecution,
        credentials: &CredentialMutationProcessor,
        cancellation: &CancellationToken,
    ) -> Result<SshCommandOutput, ExecutionErrorCode> {
        if cancellation.is_cancelled() {
            return Err(ExecutionErrorCode::Cancelled);
        }

        let verification = HostKeyVerification::new(&execution.target.host_key_fingerprints);
        let handler = PinnedHostKeyHandler {
            verification: verification.clone(),
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            ..Default::default()
        });
        let address = (execution.target.host.as_str(), execution.target.port);
        let connect = client::connect(config, address, handler);
        let mut session = match await_phase(
            connect,
            Duration::from_millis(u64::from(execution.target.connect_timeout_ms)),
            cancellation,
            ExecutionErrorCode::SshConnectionFailed,
        )
        .await
        {
            Ok(session) => session,
            Err(ExecutionErrorCode::SshConnectionFailed)
                if verification.saw_key() && !verification.matched_key() =>
            {
                return Err(ExecutionErrorCode::HostKeyMismatch);
            }
            Err(error) => return Err(error),
        };

        let password = match credentials.resolve(
            &execution.target.target_id,
            execution.target.credential_version,
        ) {
            Ok(password) => password,
            Err(_) => {
                disconnect(&mut session).await;
                return Err(ExecutionErrorCode::CredentialUnavailable);
            }
        };
        let redactor = SecretRedactor::new(password.as_str());
        let authentication =
            session.authenticate_password(execution.target.username.clone(), password.as_str());
        let authentication = await_phase(
            authentication,
            Duration::from_millis(u64::from(execution.target.connect_timeout_ms)),
            cancellation,
            ExecutionErrorCode::SshAuthenticationFailed,
        )
        .await;
        let authenticated = match authentication {
            Ok(result) => result.success(),
            Err(error) => {
                disconnect(&mut session).await;
                return Err(error);
            }
        };
        if !authenticated {
            disconnect(&mut session).await;
            return Err(ExecutionErrorCode::SshAuthenticationFailed);
        }
        drop(password);

        let command = serialize_posix_command(&execution.executable, &execution.argv);
        let mut command_result = await_execution_phase(
            execute_command(&mut session, command, execution.output_limit_bytes as usize),
            Duration::from_millis(u64::from(execution.timeout_ms)),
            cancellation,
        )
        .await;
        if let Ok(output) = &mut command_result {
            redactor.redact_output(output);
        }
        disconnect(&mut session).await;
        command_result
    }
}

pub async fn execute_remote<T: SshTransport>(
    transport: &T,
    execution: &AuthorizedExecution,
    credentials: &CredentialMutationProcessor,
    cancellation: &CancellationToken,
) -> RemoteExecutionResult {
    let started_at = timestamp_now();
    let result = transport
        .execute(execution, credentials, cancellation)
        .await;
    let completed_at = timestamp_now();
    match result {
        Ok(output) => RemoteExecutionResult {
            kind: "result",
            protocol_version: execution.target.protocol_version,
            request_id: execution.request_id.clone(),
            status: if output.exit_code == Some(0) {
                ExecutionStatus::Succeeded
            } else {
                ExecutionStatus::Failed
            },
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            truncated: false,
            error_code: None,
            started_at,
            completed_at,
        },
        Err(error_code) => RemoteExecutionResult {
            kind: "result",
            protocol_version: execution.target.protocol_version,
            request_id: execution.request_id.clone(),
            status: if error_code == ExecutionErrorCode::Cancelled {
                ExecutionStatus::Cancelled
            } else {
                ExecutionStatus::Failed
            },
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated: error_code == ExecutionErrorCode::OutputLimitExceeded,
            error_code: Some(error_code),
            started_at,
            completed_at,
        },
    }
}

pub(crate) fn record_execution_audit(
    execution: &AuthorizedExecution,
    result: &RemoteExecutionResult,
) {
    tracing::info!(
        audit_event = "remote-execution",
        request_id = %execution.request_id,
        request_digest = %execution.request_digest,
        actor_id = %execution.actor.user_id,
        project_id = %execution.project_id,
        thread_id = execution.thread_id.as_deref(),
        runner_id = %execution.target.runner_id,
        target_id = %execution.target.target_id,
        operation_id = %execution.operation_id,
        approval_id = execution.approval_id.as_deref(),
        status = ?result.status,
        error_code = ?result.error_code,
        started_at = %result.started_at,
        completed_at = %result.completed_at,
        "Remote execution completed"
    );
}

pub fn serialize_posix_command(executable: &str, argv: &[String]) -> String {
    std::iter::once(executable)
        .chain(argv.iter().map(String::as_str))
        .map(quote_posix_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_posix_token(token: &str) -> String {
    let mut quoted = String::with_capacity(token.len() + 2);
    quoted.push('\'');
    for character in token.chars() {
        if character == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(character);
        }
    }
    quoted.push('\'');
    quoted
}

async fn execute_command(
    session: &mut client::Handle<PinnedHostKeyHandler>,
    command: String,
    output_limit: usize,
) -> Result<SshCommandOutput, ExecutionErrorCode> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|_| ExecutionErrorCode::InternalError)?;
    channel
        .exec(true, command)
        .await
        .map_err(|_| ExecutionErrorCode::InternalError)?;

    let mut stdout = Zeroizing::new(Vec::new());
    let mut stderr = Zeroizing::new(Vec::new());
    let mut exit_code = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                append_bounded(&mut stdout, &data, stderr.len(), output_limit)?;
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                append_bounded(&mut stderr, &data, stdout.len(), output_limit)?;
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = i32::try_from(exit_status).ok();
            }
            ChannelMsg::ExitSignal { .. } => {
                exit_code = None;
            }
            _ => {}
        }
    }

    Ok(SshCommandOutput {
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

struct SecretRedactor {
    secret_length: usize,
    digest: Zeroizing<[u8; 32]>,
}

impl SecretRedactor {
    fn new(secret: &str) -> Self {
        Self {
            secret_length: secret.len(),
            digest: Zeroizing::new(Sha256::digest(secret.as_bytes()).into()),
        }
    }

    fn redact_output(&self, output: &mut SshCommandOutput) {
        self.redact_text(&mut output.stdout);
        self.redact_text(&mut output.stderr);
    }

    fn redact_text(&self, text: &mut String) {
        if self.secret_length == 0 || text.len() < self.secret_length {
            return;
        }
        let source = text.as_bytes();
        let mut cursor = 0;
        let mut redacted = Zeroizing::new(Vec::with_capacity(source.len()));
        let mut changed = false;
        while cursor < source.len() {
            let candidate_end = cursor.saturating_add(self.secret_length);
            let matches = if candidate_end <= source.len() && text.is_char_boundary(candidate_end) {
                let candidate_digest: [u8; 32] =
                    Sha256::digest(&source[cursor..candidate_end]).into();
                let mut candidate = Zeroizing::new(candidate_digest);
                let matches: bool = candidate.as_slice().ct_eq(self.digest.as_slice()).into();
                candidate.zeroize();
                matches
            } else {
                false
            };
            if matches {
                redacted.extend_from_slice(b"[REDACTED]");
                cursor = candidate_end;
                changed = true;
            } else {
                let character_length = text[cursor..]
                    .chars()
                    .next()
                    .expect("cursor must remain on a character boundary")
                    .len_utf8();
                redacted.extend_from_slice(&source[cursor..cursor + character_length]);
                cursor += character_length;
            }
        }
        if changed {
            let replacement = String::from_utf8(redacted.to_vec())
                .expect("redacting UTF-8 text must preserve UTF-8");
            text.zeroize();
            *text = replacement;
        }
    }
}

fn append_bounded(
    destination: &mut Vec<u8>,
    data: &[u8],
    other_length: usize,
    output_limit: usize,
) -> Result<(), ExecutionErrorCode> {
    if destination
        .len()
        .saturating_add(other_length)
        .saturating_add(data.len())
        > output_limit
    {
        return Err(ExecutionErrorCode::OutputLimitExceeded);
    }
    destination.extend_from_slice(data);
    Ok(())
}

async fn await_phase<F, T, E>(
    future: F,
    limit: Duration,
    cancellation: &CancellationToken,
    timeout_error: ExecutionErrorCode,
) -> Result<T, ExecutionErrorCode>
where
    F: Future<Output = Result<T, E>>,
{
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ExecutionErrorCode::Cancelled),
        result = tokio::time::timeout(limit, future) => {
            match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(_)) | Err(_) => Err(timeout_error),
            }
        }
    }
}

async fn await_execution_phase<F, T>(
    future: F,
    limit: Duration,
    cancellation: &CancellationToken,
) -> Result<T, ExecutionErrorCode>
where
    F: Future<Output = Result<T, ExecutionErrorCode>>,
{
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ExecutionErrorCode::Cancelled),
        result = tokio::time::timeout(limit, future) => {
            match result {
                Ok(result) => result,
                Err(_) => Err(ExecutionErrorCode::ExecutionTimeout),
            }
        }
    }
}

async fn disconnect(session: &mut client::Handle<PinnedHostKeyHandler>) {
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
}

#[derive(Clone, Debug)]
struct HostKeyVerification {
    pins: Arc<BTreeSet<String>>,
    saw_key: Arc<AtomicBool>,
    matched_key: Arc<AtomicBool>,
}

impl HostKeyVerification {
    fn new(pins: &[String]) -> Self {
        Self {
            pins: Arc::new(pins.iter().cloned().collect()),
            saw_key: Arc::new(AtomicBool::new(false)),
            matched_key: Arc::new(AtomicBool::new(false)),
        }
    }

    fn saw_key(&self) -> bool {
        self.saw_key.load(Ordering::Acquire)
    }

    fn matched_key(&self) -> bool {
        self.matched_key.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
struct PinnedHostKeyHandler {
    verification: HostKeyVerification,
}

impl client::Handler for PinnedHostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        self.verification.saw_key.store(true, Ordering::Release);
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let matched = self.verification.pins.contains(&fingerprint);
        self.verification
            .matched_key
            .store(matched, Ordering::Release);
        Ok(matched)
    }
}

fn timestamp_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("UTC timestamps must format as RFC 3339")
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use russh::client::Handler;
    use zeroize::Zeroizing;

    use super::*;
    use crate::core::authorization::{RemoteExecutionActor, RemoteExecutionActorKind};
    use crate::core::credential::{CredentialMutationProcessor, MemoryCredentialProvider};
    use crate::core::target_config::{RemoteEnvironment, RemoteTargetConfig};

    struct SuccessfulTransport;

    impl SshTransport for SuccessfulTransport {
        async fn execute(
            &self,
            _execution: &AuthorizedExecution,
            _credentials: &CredentialMutationProcessor,
            _cancellation: &CancellationToken,
        ) -> Result<SshCommandOutput, ExecutionErrorCode> {
            Ok(SshCommandOutput {
                exit_code: Some(0),
                stdout: "ready\n".to_owned(),
                stderr: String::new(),
            })
        }
    }

    struct CancelledTransport;

    impl SshTransport for CancelledTransport {
        async fn execute(
            &self,
            _execution: &AuthorizedExecution,
            _credentials: &CredentialMutationProcessor,
            cancellation: &CancellationToken,
        ) -> Result<SshCommandOutput, ExecutionErrorCode> {
            cancellation.cancelled().await;
            Err(ExecutionErrorCode::Cancelled)
        }
    }

    fn execution() -> AuthorizedExecution {
        AuthorizedExecution {
            request_id: "request-1".to_owned(),
            request_digest: "digest".to_owned(),
            actor: RemoteExecutionActor {
                user_id: "user-1".to_owned(),
                kind: RemoteExecutionActorKind::Human,
            },
            project_id: "project-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            target: RemoteTargetConfig {
                protocol_version: 1,
                target_id: "target-1".to_owned(),
                config_version: 1,
                runner_id: "runner-1".to_owned(),
                connector_id: "connector-1".to_owned(),
                name: "Target".to_owned(),
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
                operations: vec![],
            },
            operation_id: "status".to_owned(),
            executable: "/usr/bin/printf".to_owned(),
            argv: vec![],
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            approval_id: None,
        }
    }

    fn credentials() -> CredentialMutationProcessor {
        let processor = CredentialMutationProcessor::new(MemoryCredentialProvider::default());
        processor
            .store("target-1", 1, &Zeroizing::new("secret".to_owned()))
            .expect("store credential");
        processor
    }

    #[test]
    fn quotes_every_posix_token_without_interpolating_shell_syntax() {
        let argv = vec![
            String::new(),
            "plain text".to_owned(),
            "$(touch /tmp/pwned); `id`".to_owned(),
            "it's\nliteral".to_owned(),
        ];
        assert_eq!(
            serialize_posix_command("/bin/echo", &argv),
            "'/bin/echo' '' 'plain text' '$(touch /tmp/pwned); `id`' 'it'\\''s\nliteral'"
        );
    }

    #[test]
    fn output_limit_is_combined_across_stdout_and_stderr() {
        let mut stdout = b"1234".to_vec();
        assert_eq!(append_bounded(&mut stdout, b"56", 2, 8), Ok(()));
        let mut stderr = b"12".to_vec();
        assert_eq!(
            append_bounded(&mut stderr, b"3", stdout.len(), 8),
            Err(ExecutionErrorCode::OutputLimitExceeded)
        );
    }

    #[test]
    fn redacts_credentials_from_output_before_serialization_or_logging() {
        let secret = "correct horse battery staple";
        let mut output = SshCommandOutput {
            exit_code: Some(1),
            stdout: format!("prefix {secret} suffix"),
            stderr: format!("{secret}\n{secret}"),
        };
        SecretRedactor::new(secret).redact_output(&mut output);
        assert_eq!(output.stdout, "prefix [REDACTED] suffix");
        assert_eq!(output.stderr, "[REDACTED]\n[REDACTED]");

        let result = RemoteExecutionResult {
            kind: "result",
            protocol_version: 1,
            request_id: "request-1".to_owned(),
            status: ExecutionStatus::Failed,
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            truncated: false,
            error_code: None,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
            completed_at: "2026-01-01T00:00:01Z".to_owned(),
        };
        let wire = serde_json::to_string(&result).expect("serialize result");
        assert!(!wire.contains(secret));
        assert_eq!(wire.matches("[REDACTED]").count(), 3);
    }

    #[test]
    fn audit_logging_contains_only_allowlisted_metadata() {
        #[derive(Clone)]
        struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

        struct CapturedWriterGuard(Arc<Mutex<Vec<u8>>>);

        impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for CapturedWriter {
            type Writer = CapturedWriterGuard;

            fn make_writer(&'writer self) -> Self::Writer {
                CapturedWriterGuard(Arc::clone(&self.0))
            }
        }

        impl Write for CapturedWriterGuard {
            fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
                self.0
                    .lock()
                    .expect("capture lock")
                    .extend_from_slice(buffer);
                Ok(buffer.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let password = "audit-password-must-not-appear";
        let mut execution = execution();
        execution.target.host = "sensitive-host.internal".to_owned();
        execution.target.credential_ref = "sensitive-credential-reference".to_owned();
        execution.executable = "/sensitive/executable".to_owned();
        execution.argv = vec!["sensitive-raw-argument".to_owned()];
        let result = RemoteExecutionResult {
            kind: "result",
            protocol_version: 1,
            request_id: execution.request_id.clone(),
            status: ExecutionStatus::Succeeded,
            exit_code: Some(0),
            stdout: format!("sensitive-output {password}"),
            stderr: String::new(),
            truncated: false,
            error_code: None,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
            completed_at: "2026-01-01T00:00:01Z".to_owned(),
        };
        let captured = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(CapturedWriter(Arc::clone(&captured)))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            record_execution_audit(&execution, &result);
        });
        let log =
            String::from_utf8(captured.lock().expect("capture lock").to_vec()).expect("UTF-8 log");

        assert!(log.contains("request-1"));
        assert!(log.contains("target-1"));
        for forbidden in [
            password,
            "sensitive-host.internal",
            "sensitive-credential-reference",
            "/sensitive/executable",
            "sensitive-raw-argument",
            "sensitive-output",
        ] {
            assert!(!log.contains(forbidden), "audit leaked {forbidden}");
        }
    }

    #[tokio::test]
    async fn returns_a_bounded_wire_result_for_success() {
        let result = execute_remote(
            &SuccessfulTransport,
            &execution(),
            &credentials(),
            &CancellationToken::default(),
        )
        .await;
        assert_eq!(result.status, ExecutionStatus::Succeeded);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "ready\n");
        assert_eq!(result.error_code, None);
    }

    #[tokio::test]
    async fn cancellation_returns_the_generic_category() {
        let token = CancellationToken::default();
        let triggered = token.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            triggered.cancel();
        });
        let result =
            execute_remote(&CancelledTransport, &execution(), &credentials(), &token).await;
        assert_eq!(result.status, ExecutionStatus::Cancelled);
        assert_eq!(result.error_code, Some(ExecutionErrorCode::Cancelled));
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
    }

    #[tokio::test]
    async fn phase_timeout_and_cancellation_are_distinct() {
        let token = CancellationToken::default();
        let timeout = await_phase(
            pending::<Result<(), ()>>(),
            Duration::from_millis(1),
            &token,
            ExecutionErrorCode::ExecutionTimeout,
        )
        .await;
        assert_eq!(timeout, Err(ExecutionErrorCode::ExecutionTimeout));

        token.cancel();
        let cancelled = await_phase(
            pending::<Result<(), ()>>(),
            Duration::from_secs(1),
            &token,
            ExecutionErrorCode::ExecutionTimeout,
        )
        .await;
        assert_eq!(cancelled, Err(ExecutionErrorCode::Cancelled));

        let output_limit = await_execution_phase(
            async { Err::<(), _>(ExecutionErrorCode::OutputLimitExceeded) },
            Duration::from_secs(1),
            &CancellationToken::default(),
        )
        .await;
        assert_eq!(output_limit, Err(ExecutionErrorCode::OutputLimitExceeded));
    }

    #[test]
    fn host_key_verification_accepts_only_an_exact_sha256_pin() {
        let key = ssh_key::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEgMsjPrEx75ay7BqJutmiz87hY2wPYQBq1hyu+CV6qW",
        )
        .expect("test key");
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let accepted = HostKeyVerification::new(std::slice::from_ref(&fingerprint));
        let mut handler = PinnedHostKeyHandler {
            verification: accepted.clone(),
        };
        assert!(tokio_test_check_key(&mut handler, &key));
        assert!(accepted.saw_key());
        assert!(accepted.matched_key());

        let rejected = HostKeyVerification::new(&["SHA256:not-the-key".to_owned()]);
        let mut handler = PinnedHostKeyHandler {
            verification: rejected.clone(),
        };
        assert!(!tokio_test_check_key(&mut handler, &key));
        assert!(rejected.saw_key());
        assert!(!rejected.matched_key());
    }

    fn tokio_test_check_key(handler: &mut PinnedHostKeyHandler, key: &ssh_key::PublicKey) -> bool {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        runtime
            .block_on(handler.check_server_key(key))
            .expect("key check")
    }
}
