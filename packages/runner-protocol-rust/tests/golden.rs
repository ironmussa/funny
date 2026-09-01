use funny_runner_protocol::runner::v2;
use prost::Message;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    name: String,
    message_type: String,
    wire_hex: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digits = std::str::from_utf8(pair).expect("fixture hex is UTF-8");
            u8::from_str_radix(digits, 16).expect("fixture contains valid hex")
        })
        .collect()
}

fn assert_round_trip<M>(wire: &[u8]) -> M
where
    M: Message + Default,
{
    let decoded = M::decode(wire).expect("Rust bindings decode the golden wire");
    assert_eq!(decoded.encode_to_vec(), wire);
    decoded
}

#[test]
fn rust_bindings_match_shared_golden_wire() {
    let fixtures: Vec<GoldenFixture> = serde_json::from_str(include_str!(
        "../../../protocol/runner/v2/fixtures/golden.json"
    ))
    .expect("golden fixture JSON is valid");

    for fixture in fixtures {
        let wire = decode_hex(&fixture.wire_hex);
        match fixture.message_type.as_str() {
            "runner.v2.RunnerHello" => {
                let value: v2::RunnerHello = assert_round_trip(&wire);
                assert_eq!(value.supported_versions[0].major, 2);
            }
            "runner.v2.Failure" => {
                let value: v2::Failure = assert_round_trip(&wire);
                assert_eq!(value.code, v2::FailureCode::Conflict as i32);
            }
            "runner.v2.TunnelRequest" => {
                let value: v2::TunnelRequest = assert_round_trip(&wire);
                assert!(matches!(
                    value.frame,
                    Some(v2::tunnel_request::Frame::Data(_))
                ));
            }
            "runner.v2.OperationsRequest" => {
                let value: v2::OperationsRequest = assert_round_trip(&wire);
                assert_eq!(
                    value.metadata.and_then(|metadata| metadata.idempotency_key),
                    Some("runner-fixture:insert-message:1".into())
                );
            }
            "runner.v2.EventsResponse" => {
                let value: v2::EventsResponse = assert_round_trip(&wire);
                match (fixture.name.as_str(), value.outcome) {
                    ("event_receipt", Some(v2::events_response::Outcome::Accepted(accepted))) => {
                        assert_eq!(accepted.highest_contiguous_sequence, 42)
                    }
                    ("event_gap", Some(v2::events_response::Outcome::Gap(gap))) => {
                        assert_eq!(gap.requested_sequence, 10);
                        assert_eq!(gap.earliest_available_sequence, 24);
                    }
                    _ => panic!("event fixture has an unexpected outcome"),
                }
            }
            "runner.v2.TerminalRequest" => {
                let value: v2::TerminalRequest = assert_round_trip(&wire);
                match value.frame {
                    Some(v2::terminal_request::Frame::Output(output)) => {
                        assert_eq!(output.sequence, 8);
                    }
                    _ => panic!("terminal fixture must contain sequenced output"),
                }
            }
            message_type => panic!("unsupported fixture type {message_type}"),
        }
    }
}
