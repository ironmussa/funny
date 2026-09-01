use funny_runner_protocol::runner::v2::{
    self, ControlRequest, ProtocolVersion, RunnerDescriptor, RunnerHello, control_request,
    control_response, runner_transport_service_client::RunnerTransportServiceClient,
};
use std::{env, error::Error};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{
    Request,
    metadata::MetadataValue,
    transport::{Certificate, ClientTlsConfig, Endpoint},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args().skip(1);
    let endpoint = arguments.next().ok_or("missing endpoint")?;
    let certificate_path = arguments.next().ok_or("missing CA certificate path")?;
    let token = arguments.next().ok_or("missing runner token")?;

    let certificate = std::fs::read(certificate_path)?;
    let channel = Endpoint::from_shared(endpoint)?
        .tls_config(
            ClientTlsConfig::new()
                .ca_certificate(Certificate::from_pem(certificate))
                .domain_name("localhost"),
        )?
        .connect()
        .await?;

    let authorization: MetadataValue<_> = format!("Bearer {token}").parse()?;
    let mut client =
        RunnerTransportServiceClient::with_interceptor(channel, move |mut request: Request<()>| {
            request
                .metadata_mut()
                .insert("authorization", authorization.clone());
            Ok(request)
        });

    let (sender, receiver) = mpsc::channel(1);
    sender
        .send(ControlRequest {
            message: Some(control_request::Message::Hello(RunnerHello {
                supported_versions: vec![ProtocolVersion { major: 2, minor: 0 }],
                runner: Some(RunnerDescriptor {
                    instance_id: "runner-harness".into(),
                    name: "Tonic compatibility client".into(),
                    hostname: "localhost".into(),
                    operating_system: env::consts::OS.into(),
                    workspace: None,
                    active_provider_ids: Vec::new(),
                }),
                capabilities: vec![v2::RunnerCapability::Operations as i32],
                requested_limits: None,
                event_cursors: Vec::new(),
                terminal_cursors: Vec::new(),
            })),
        })
        .await?;
    drop(sender);

    let request = Request::new(ReceiverStream::new(receiver));
    let response = client.control(request).await?;
    let authenticated_runner = response
        .metadata()
        .get("x-harness-authenticated-runner")
        .ok_or("missing authenticated runner metadata")?
        .to_str()?
        .to_owned();
    let mut stream = response.into_inner();
    let message = stream
        .message()
        .await?
        .ok_or("control stream ended before hello")?;
    let hello = match message.message {
        Some(control_response::Message::Hello(hello)) => hello,
        _ => return Err("server did not negotiate with ServerHello".into()),
    };
    let selected = hello
        .selected_version
        .ok_or("missing selected protocol version")?;
    if selected.major != 2 {
        return Err(format!("unexpected protocol major {}", selected.major).into());
    }

    println!(
        "{{\"authenticatedRunner\":\"{}\",\"protocolMajor\":{},\"sessionEpoch\":{}}}",
        authenticated_runner, selected.major, hello.session_epoch
    );
    Ok(())
}
