//! `roger login`: GitHub's device flow (RFC 8628), then one exchange of the
//! GitHub token for a Roger machine credential. The GitHub token is never
//! saved, and Roger revokes it after checking it.

use std::io::Write;
use std::time::Duration;

use serde::Deserialize;
use ureq::Agent;

use crate::error::{Error, Result};
use crate::wait::Clock;

/// Where GitHub's device flow runs.
pub const GITHUB_URL: &str = "https://github.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// RFC 8628 section 3.5: a `slow_down` adds 5 seconds to the interval.
const SLOW_DOWN: Duration = Duration::from_secs(5);

/// GitHub's answer to starting the device flow.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DeviceFlow {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until the codes expire.
    pub expires_in: u64,
    /// Seconds to wait between polls.
    pub interval: u64,
}

/// One poll of GitHub's token endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    /// The person approved; the GitHub access token.
    Token(String),
    Pending,
    /// Polled too fast; GitHub may name the new interval in seconds.
    SlowDown(Option<u64>),
    Denied,
    Expired,
    /// Any other refusal, with GitHub's explanation.
    Refused(String),
}

/// GitHub's token response: an error or a token, both with status 200. The
/// refresh token GitHub may add is not read.
#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

impl From<TokenResponse> for Poll {
    fn from(response: TokenResponse) -> Self {
        if let Some(token) = response.access_token.filter(|t| !t.is_empty()) {
            return Self::Token(token);
        }
        match response.error.as_deref() {
            Some("authorization_pending") => Self::Pending,
            Some("slow_down") => Self::SlowDown(response.interval),
            Some("access_denied") => Self::Denied,
            Some("expired_token") => Self::Expired,
            other => Self::Refused(
                response
                    .error_description
                    .or_else(|| other.map(str::to_owned))
                    .unwrap_or_else(|| "GitHub returned no token".to_owned()),
            ),
        }
    }
}

/// GitHub's device flow endpoints.
pub struct GitHub {
    agent: Agent,
    base: String,
}

impl GitHub {
    pub fn new(base: &str) -> Self {
        let agent: Agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .user_agent(concat!("roger/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self {
            agent,
            base: base.trim_end_matches('/').to_owned(),
        }
    }

    /// Starts the device flow for the deployment's OAuth app.
    pub fn device_code(&self, client_id: &str, scope: &str) -> Result<DeviceFlow> {
        let mut response = self
            .agent
            .post(format!("{}/login/device/code", self.base))
            .header("accept", "application/json")
            .send_form([("client_id", client_id), ("scope", scope)])?;
        let status = response.status();
        let text = response.body_mut().read_to_string()?;
        if !status.is_success() {
            return Err(Error::Status(status.as_u16()));
        }
        match serde_json::from_str::<DeviceFlow>(&text) {
            Ok(code) => Ok(code),
            // GitHub reports refusals, such as device flow being off, as 200.
            Err(_) => Err(Error::Login(
                serde_json::from_str::<TokenResponse>(&text)
                    .ok()
                    .and_then(|r| r.error_description.or(r.error))
                    .unwrap_or_else(|| "GitHub did not start the device flow".to_owned()),
            )),
        }
    }

    /// Polls once for the access token.
    pub fn poll(&self, client_id: &str, device_code: &str) -> Result<Poll> {
        let mut response = self
            .agent
            .post(format!("{}/login/oauth/access_token", self.base))
            .header("accept", "application/json")
            .send_form([
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])?;
        let status = response.status();
        let text = response.body_mut().read_to_string()?;
        if !status.is_success() {
            return Err(Error::Status(status.as_u16()));
        }
        Ok(serde_json::from_str::<TokenResponse>(&text)?.into())
    }
}

/// Tells the person where to approve, then polls until GitHub returns a
/// token, the person denies it, or the code expires. Never polls past
/// `expires_in`.
pub fn wait_for_token(
    started: &DeviceFlow,
    mut poll: impl FnMut(&str) -> Result<Poll>,
    clock: &mut impl Clock,
    out: &mut impl Write,
) -> Result<String> {
    writeln!(
        out,
        "To log in this machine, open\n  {}\nand enter the code {}. Waiting for GitHub.",
        started.verification_uri, started.user_code
    )
    .map_err(Error::Output)?;
    let start = clock.now();
    let deadline = Duration::from_secs(started.expires_in);
    let mut interval = Duration::from_secs(started.interval.max(1));
    loop {
        let elapsed = clock.now().saturating_duration_since(start);
        if elapsed.saturating_add(interval) > deadline {
            return Err(Error::LoginExpired);
        }
        clock.sleep(interval);
        match poll(&started.device_code)? {
            Poll::Token(token) => return Ok(token),
            Poll::Pending => {}
            Poll::SlowDown(Some(seconds)) => {
                interval = Duration::from_secs(seconds).max(interval.saturating_add(SLOW_DOWN));
            }
            Poll::SlowDown(None) => interval = interval.saturating_add(SLOW_DOWN),
            Poll::Denied => return Err(Error::LoginDenied),
            Poll::Expired => return Err(Error::LoginExpired),
            Poll::Refused(message) => return Err(Error::Login(message)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;
    use std::time::Instant;

    use super::*;

    struct FakeClock {
        start: Instant,
        elapsed: Duration,
        sleeps: Vec<u64>,
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.start + self.elapsed
        }

        fn sleep(&mut self, duration: Duration) {
            self.elapsed += duration;
            self.sleeps.push(duration.as_secs());
        }
    }

    fn clock() -> FakeClock {
        FakeClock {
            start: Instant::now(),
            elapsed: Duration::ZERO,
            sleeps: Vec::new(),
        }
    }

    fn started(expires_in: u64) -> DeviceFlow {
        DeviceFlow {
            device_code: "device".to_owned(),
            user_code: "BCDF-GHJK".to_owned(),
            verification_uri: "https://github.com/login/device".to_owned(),
            expires_in,
            interval: 5,
        }
    }

    fn run(expires_in: u64, polls: Vec<Poll>) -> (Result<String>, Vec<u64>, usize, String) {
        let mut polls = VecDeque::from(polls);
        let mut calls = 0;
        let mut clock = clock();
        let mut out = Vec::new();
        let result = wait_for_token(
            &started(expires_in),
            |code| {
                assert_eq!(code, "device");
                calls += 1;
                Ok(polls
                    .pop_front()
                    .unwrap_or(Poll::Refused("no more".to_owned())))
            },
            &mut clock,
            &mut out,
        );
        (
            result,
            clock.sleeps,
            calls,
            String::from_utf8_lossy(&out).into_owned(),
        )
    }

    #[test]
    fn waits_for_approval_and_slows_down_when_told() {
        let (result, sleeps, calls, out) = run(
            900,
            vec![
                Poll::Pending,
                Poll::SlowDown(None),
                Poll::SlowDown(Some(20)),
                Poll::Token("gho_x".to_owned()),
            ],
        );
        assert_eq!(result.ok().as_deref(), Some("gho_x"));
        assert_eq!(sleeps, [5, 5, 10, 20]);
        assert_eq!(calls, 4);
        assert!(out.contains("https://github.com/login/device"), "{out}");
        assert!(out.contains("BCDF-GHJK"), "{out}");
        assert!(!out.contains("gho_x"), "{out}");
    }

    #[test]
    fn stops_when_denied_or_refused() {
        let (result, _, calls, _) = run(900, vec![Poll::Denied]);
        assert!(matches!(result, Err(Error::LoginDenied)), "{result:?}");
        assert_eq!(calls, 1);
        let (result, _, _, _) = run(
            900,
            vec![Poll::Refused("device flow is disabled".to_owned())],
        );
        match result {
            Err(Error::Login(message)) => assert_eq!(message, "device flow is disabled"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn never_polls_past_the_expiry() {
        let (result, sleeps, calls, _) = run(12, vec![Poll::Pending, Poll::Pending, Poll::Pending]);
        assert!(matches!(result, Err(Error::LoginExpired)), "{result:?}");
        assert_eq!(sleeps, [5, 5]);
        assert_eq!(calls, 2);
        let (result, _, _, _) = run(900, vec![Poll::Expired]);
        assert!(matches!(result, Err(Error::LoginExpired)), "{result:?}");
    }

    #[test]
    fn stops_on_a_transport_error() {
        let mut clock = clock();
        let result = wait_for_token(
            &started(900),
            |_| Err(Error::Status(502)),
            &mut clock,
            &mut Vec::new(),
        );
        assert!(matches!(result, Err(Error::Status(502))), "{result:?}");
    }

    #[test]
    fn reads_github_token_responses() -> std::result::Result<(), serde_json::Error> {
        let parse = |json: &str| serde_json::from_str::<TokenResponse>(json).map(Poll::from);
        assert_eq!(
            parse(
                r#"{"access_token":"gho_x","token_type":"bearer","refresh_token":"ghr_y","expires_in":28800}"#
            )?,
            Poll::Token("gho_x".to_owned())
        );
        assert_eq!(
            parse(r#"{"error":"authorization_pending"}"#)?,
            Poll::Pending
        );
        assert_eq!(
            parse(r#"{"error":"slow_down","interval":10}"#)?,
            Poll::SlowDown(Some(10))
        );
        assert_eq!(parse(r#"{"error":"access_denied"}"#)?, Poll::Denied);
        assert_eq!(parse(r#"{"error":"expired_token"}"#)?, Poll::Expired);
        assert_eq!(
            parse(
                r#"{"error":"device_flow_disabled","error_description":"Device flow must be enabled"}"#
            )?,
            Poll::Refused("Device flow must be enabled".to_owned())
        );
        assert_eq!(
            parse(r#"{"access_token":""}"#)?,
            Poll::Refused("GitHub returned no token".to_owned())
        );
        Ok(())
    }

    /// Each request's first line and body.
    type Seen = std::thread::JoinHandle<Vec<(String, String)>>;

    /// Serves canned bodies in order and records the requests.
    fn stub(bodies: Vec<&'static str>) -> std::io::Result<(String, Seen)> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let base = format!("http://{}", listener.local_addr()?);
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for body in bodies {
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                let Ok(clone) = stream.try_clone() else { break };
                let mut reader = BufReader::new(clone);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = header.split_once(':')
                        && k.eq_ignore_ascii_case("content-length")
                    {
                        length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut request = vec![0; length];
                let _ = reader.read_exact(&mut request);
                let mut writer = stream;
                let _ = write!(
                    writer,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                seen.push((
                    line.trim_end().to_owned(),
                    String::from_utf8_lossy(&request).into_owned(),
                ));
            }
            seen
        });
        Ok((base, handle))
    }

    #[test]
    fn talks_to_github_with_forms_and_reads_refusals()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let (base, handle) = stub(vec![
            r#"{"device_code":"dc","user_code":"BCDF-GHJK","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
            r#"{"error":"authorization_pending"}"#,
            r#"{"error":"device_flow_disabled","error_description":"Device flow is disabled"}"#,
        ])?;
        let github = GitHub::new(&base);
        let code = github.device_code("Ov23client", "read:org")?;
        assert_eq!(code.device_code, "dc");
        assert_eq!(github.poll("Ov23client", "dc")?, Poll::Pending);
        match github.device_code("Ov23client", "read:org") {
            Err(Error::Login(message)) => assert_eq!(message, "Device flow is disabled"),
            other => return Err(format!("unexpected {other:?}").into()),
        }
        let seen = handle.join().map_err(|_| "stub panicked")?;
        assert_eq!(
            seen.iter()
                .map(|(line, _)| line.as_str())
                .collect::<Vec<_>>(),
            [
                "POST /login/device/code HTTP/1.1",
                "POST /login/oauth/access_token HTTP/1.1",
                "POST /login/device/code HTTP/1.1"
            ]
        );
        assert_eq!(
            seen.first().map(|(_, b)| b.as_str()),
            Some("client_id=Ov23client&scope=read%3Aorg")
        );
        assert_eq!(
            seen.get(1).map(|(_, b)| b.as_str()),
            Some(
                "client_id=Ov23client&device_code=dc&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
            )
        );
        Ok(())
    }
}
