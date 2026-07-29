use clap::{Parser, Subcommand};
use funny_remote_connector::core::product::{PRODUCT_NAME, PRODUCT_VERSION};
use funny_remote_connector::service::config::ServiceOptions;
use funny_remote_connector::service::host::ConnectorService;

#[derive(Debug, Parser)]
#[command(name = PRODUCT_NAME, version = PRODUCT_VERSION)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run(ServiceOptions),
    Describe(ServiceOptions),
    PairingCode(ServiceOptions),
    RotateKey(ServiceOptions),
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .compact()
        .init();

    let result = match Cli::parse().command {
        Command::Run(options) => match options.resolve() {
            Ok(config) => ConnectorService::new(config).run().await,
            Err(error) => {
                tracing::error!(error = %error, "Connector configuration rejected");
                std::process::exit(2);
            }
        },
        Command::Describe(options) => match options.resolve() {
            Ok(config) => match ConnectorService::new(config).describe() {
                Ok(description) => {
                    println!(
                        "{}",
                        serde_json::to_string(&description)
                            .expect("service description must serialize")
                    );
                    if !description.isolation.verified {
                        std::process::exit(2);
                    }
                    Ok(())
                }
                Err(error) => Err(error),
            },
            Err(error) => {
                tracing::error!(error = %error, "Connector configuration rejected");
                std::process::exit(2);
            }
        },
        Command::PairingCode(options) => pairing_code(options, false),
        Command::RotateKey(options) => pairing_code(options, true),
    };

    if let Err(error) = result {
        tracing::error!(error = %error, "Connector stopped");
        std::process::exit(2);
    }
}

fn pairing_code(
    options: ServiceOptions,
    rotate_key: bool,
) -> Result<(), funny_remote_connector::service::host::ServiceError> {
    let config = match options.resolve() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(error = %error, "Connector configuration rejected");
            std::process::exit(2);
        }
    };
    let pairing = ConnectorService::new(config).local_pairing_code(rotate_key)?;
    println!(
        "{}",
        serde_json::to_string(&pairing).expect("local pairing output must serialize")
    );
    Ok(())
}
