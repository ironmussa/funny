use funny_runner_protocol::runner::v2::{
    EventsRequest, OperationsRequest, RequestMetadata, RunnerHeartbeat, SessionContext,
    TerminalRequest, TerminalStreamReady, TunnelData, TunnelRequest, TunnelStreamReady,
    control_request, events_request, operations_request,
    runner_transport_service_client::RunnerTransportServiceClient, terminal_request,
    tunnel_request,
};
use std::{env, error::Error, time::{Duration, Instant}};
use tokio::{sync::mpsc, time::sleep};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{
    Code, Request,
    metadata::MetadataValue,
    transport::{Certificate, ClientTlsConfig, Endpoint},
};

type TestResult<T = ()> = Result<T, Box<dyn Error>>;

fn request<T>(stream: T, authorization: &MetadataValue<tonic::metadata::Ascii>) -> Request<T> {
    let mut request = Request::new(stream);
    request
        .metadata_mut()
        .insert("authorization", authorization.clone());
    request
}

fn session() -> Option<SessionContext> {
    Some(SessionContext { session_epoch: 1 })
}

#[tokio::main]
async fn main() -> TestResult {
    let mut arguments = env::args().skip(1);
    let endpoint = arguments.next().ok_or("missing endpoint")?;
    let certificate_path = arguments.next().ok_or("missing CA certificate path")?;
    let token = arguments.next().ok_or("missing runner token")?;
    let duration_seconds = arguments
        .next()
        .as_deref()
        .unwrap_or("0")
        .parse::<u64>()?;
    let certificate = std::fs::read(certificate_path)?;
    let channel = Endpoint::from_shared(endpoint)?
        .tls_config(
            ClientTlsConfig::new()
                .ca_certificate(Certificate::from_pem(certificate))
                .domain_name("localhost"),
        )?
        .http2_keep_alive_interval(Duration::from_millis(200))
        .keep_alive_timeout(Duration::from_secs(1))
        .keep_alive_while_idle(true)
        .connect()
        .await?;
    let authorization: MetadataValue<_> = format!("Bearer {token}").parse()?;
    let client = RunnerTransportServiceClient::new(channel);

    let started = Instant::now();
    let mut iterations = 0_u64;
    loop {
        eprintln!("iteration {}: concurrent classes", iterations + 1);
        test_concurrent_classes(client.clone(), &authorization).await?;
        test_status_and_trailers(client.clone(), &authorization).await?;
        test_deadline(client.clone(), &authorization).await?;
        test_cancellation(client.clone(), &authorization).await?;
        test_payload_limit(client.clone(), &authorization).await?;
        test_keepalive_and_reconnect(client.clone(), &authorization).await?;
        iterations += 1;
        if duration_seconds == 0 || started.elapsed() >= Duration::from_secs(duration_seconds) {
            break;
        }
    }

    println!(
        "{{\"statusTrailers\":true,\"deadline\":true,\"cancellation\":true,\"keepalive\":true,\"slowReader\":true,\"payloadLimit\":true,\"reconnect\":true,\"concurrentClasses\":5,\"iterations\":{iterations}}}"
    );
    Ok(())
}

async fn test_concurrent_classes(
    client: RunnerTransportServiceClient<tonic::transport::Channel>,
    authorization: &MetadataValue<tonic::metadata::Ascii>,
) -> TestResult {
    let (control_tx, control_rx) = mpsc::channel(2);
    let (operations_tx, operations_rx) = mpsc::channel(2);
    let (events_tx, events_rx) = mpsc::channel(2);
    let (tunnel_tx, tunnel_rx) = mpsc::channel(2);
    let (terminal_tx, terminal_rx) = mpsc::channel(2);

    control_tx
        .send(funny_runner_protocol::runner::v2::ControlRequest {
            message: Some(control_request::Message::Heartbeat(RunnerHeartbeat {
                ordinal: 1,
                sent_at: None,
                active_thread_ids: Vec::new(),
            })),
        })
        .await?;
    operations_tx
        .send(OperationsRequest {
            session: session(),
            metadata: Some(RequestMetadata {
                correlation_id: "concurrent-operation".into(),
                deadline: None,
                idempotency_key: None,
            }),
            operation: Some(operations_request::Operation::GetThread(
                funny_runner_protocol::runner::v2::GetThread {
                    thread_id: "thread-harness".into(),
                },
            )),
        })
        .await?;
    events_tx
        .send(EventsRequest {
            session: session(),
            scope: None,
            sequence: 1,
            payload: Some(events_request::Payload::Gap(Default::default())),
        })
        .await?;
    tunnel_tx
        .send(TunnelRequest {
            session: session(),
            tunnel_id: "slow-reader".into(),
            metadata: None,
            frame: Some(tunnel_request::Frame::Ready(TunnelStreamReady {})),
        })
        .await?;
    terminal_tx
        .send(TerminalRequest {
            session: session(),
            terminal_id: "concurrent-terminal".into(),
            metadata: None,
            frame: Some(terminal_request::Frame::Ready(TerminalStreamReady {})),
        })
        .await?;

    // grpc-js sends response headers with the first response. Queue one request
    // per call before awaiting those headers so stream startup cannot deadlock.
    let mut control_client = client.clone();
    let mut operations_client = client.clone();
    let mut events_client = client.clone();
    let mut tunnel_client = client.clone();
    let mut terminal_client = client;
    let (control, operations, events, tunnel, terminal) = tokio::join!(
        control_client.control(request(ReceiverStream::new(control_rx), authorization)),
        operations_client.operations(request(ReceiverStream::new(operations_rx), authorization)),
        events_client.events(request(ReceiverStream::new(events_rx), authorization)),
        tunnel_client.tunnel(request(ReceiverStream::new(tunnel_rx), authorization)),
        terminal_client.terminal(request(ReceiverStream::new(terminal_rx), authorization)),
    );
    let mut control = control?.into_inner();
    let mut operations = operations?.into_inner();
    let mut events = events?.into_inner();
    let mut tunnel = tunnel?.into_inner();
    let mut terminal = terminal?.into_inner();

    sleep(Duration::from_millis(350)).await;
    let (control_message, operation_message, event_message, tunnel_message, terminal_message) = tokio::join!(
        control.message(),
        operations.message(),
        events.message(),
        tunnel.message(),
        terminal.message(),
    );
    if control_message?.is_none()
        || operation_message?.is_none()
        || event_message?.is_none()
        || tunnel_message?.is_none()
        || terminal_message?.is_none()
    {
        return Err("a concurrent communication class made no progress".into());
    }
    Ok(())
}

async fn test_status_and_trailers(
    mut client: RunnerTransportServiceClient<tonic::transport::Channel>,
    authorization: &MetadataValue<tonic::metadata::Ascii>,
) -> TestResult {
    let (sender, receiver) = mpsc::channel(1);
    sender
        .send(EventsRequest {
            session: session(),
            scope: None,
            sequence: 999,
            payload: Some(events_request::Payload::Gap(Default::default())),
        })
        .await?;
    drop(sender);
    let mut stream = client
        .events(request(ReceiverStream::new(receiver), authorization))
        .await?
        .into_inner();
    if stream.message().await?.is_none() {
        return Err("events stream ended before status test response".into());
    }
    let trailers = stream.trailers().await?.ok_or("missing status trailers")?;
    if trailers
        .get("x-harness-trailer")
        .and_then(|value| value.to_str().ok())
        != Some("events-complete")
    {
        return Err("unexpected events status trailers".into());
    }
    Ok(())
}

async fn test_deadline(
    mut client: RunnerTransportServiceClient<tonic::transport::Channel>,
    authorization: &MetadataValue<tonic::metadata::Ascii>,
) -> TestResult {
    let (sender, receiver) = mpsc::channel(1);
    sender
        .send(OperationsRequest {
            session: session(),
            metadata: Some(RequestMetadata {
                correlation_id: "deadline".into(),
                deadline: None,
                idempotency_key: None,
            }),
            operation: Some(operations_request::Operation::GetThread(
                funny_runner_protocol::runner::v2::GetThread {
                    thread_id: "deadline".into(),
                },
            )),
        })
        .await?;
    let mut call = request(ReceiverStream::new(receiver), authorization);
    call.set_timeout(Duration::from_millis(150));
    let mut stream = client.operations(call).await?.into_inner();
    let status = stream
        .message()
        .await
        .expect_err("deadline call unexpectedly succeeded");
    if status.code() != Code::DeadlineExceeded {
        return Err(format!("expected deadline exceeded, got {}", status.code()).into());
    }
    drop(sender);
    sleep(Duration::from_millis(50)).await;
    Ok(())
}

async fn test_cancellation(
    mut client: RunnerTransportServiceClient<tonic::transport::Channel>,
    authorization: &MetadataValue<tonic::metadata::Ascii>,
) -> TestResult {
    let (sender, receiver) = mpsc::channel(1);
    sender
        .send(TerminalRequest {
            session: session(),
            terminal_id: "cancel-me".into(),
            metadata: None,
            frame: Some(terminal_request::Frame::Ready(TerminalStreamReady {})),
        })
        .await?;
    let mut stream = client
        .terminal(request(ReceiverStream::new(receiver), authorization))
        .await?
        .into_inner();
    if stream.message().await?.is_none() {
        return Err("terminal cancellation stream did not start".into());
    }
    drop(stream);
    drop(sender);
    sleep(Duration::from_millis(100)).await;
    Ok(())
}

async fn test_payload_limit(
    mut client: RunnerTransportServiceClient<tonic::transport::Channel>,
    authorization: &MetadataValue<tonic::metadata::Ascii>,
) -> TestResult {
    let (sender, receiver) = mpsc::channel(1);
    sender
        .send(TunnelRequest {
            session: session(),
            tunnel_id: "oversized".into(),
            metadata: None,
            frame: Some(tunnel_request::Frame::Data(TunnelData {
                sequence: 1,
                data: vec![0; 65_537],
            })),
        })
        .await?;
    drop(sender);
    let mut stream = client
        .tunnel(request(ReceiverStream::new(receiver), authorization))
        .await?
        .into_inner();
    let status = stream
        .message()
        .await
        .expect_err("oversized frame unexpectedly succeeded");
    if status.code() != Code::ResourceExhausted {
        return Err(format!("expected resource exhausted, got {}", status.code()).into());
    }
    Ok(())
}

async fn test_keepalive_and_reconnect(
    mut client: RunnerTransportServiceClient<tonic::transport::Channel>,
    authorization: &MetadataValue<tonic::metadata::Ascii>,
) -> TestResult {
    sleep(Duration::from_millis(500)).await;
    let (sender, receiver) = mpsc::channel(2);
    sender
        .send(funny_runner_protocol::runner::v2::ControlRequest {
            message: Some(control_request::Message::Heartbeat(RunnerHeartbeat {
                ordinal: 99,
                sent_at: None,
                active_thread_ids: Vec::new(),
            })),
        })
        .await?;
    let status = match client
        .control(request(ReceiverStream::new(receiver), authorization))
        .await
    {
        Ok(response) => response
            .into_inner()
            .message()
            .await
            .expect_err("forced disconnect unexpectedly succeeded"),
        Err(status) => status,
    };
    if status.code() != Code::Unavailable {
        return Err(format!("expected unavailable, got {}", status.code()).into());
    }
    drop(sender);

    let (sender, receiver) = mpsc::channel(1);
    sender
        .send(funny_runner_protocol::runner::v2::ControlRequest {
            message: Some(control_request::Message::Heartbeat(RunnerHeartbeat {
                ordinal: 100,
                sent_at: None,
                active_thread_ids: Vec::new(),
            })),
        })
        .await?;
    drop(sender);
    let mut stream = client
        .control(request(ReceiverStream::new(receiver), authorization))
        .await?
        .into_inner();
    if stream.message().await?.is_none() {
        return Err("reconnected control stream made no progress".into());
    }
    Ok(())
}
