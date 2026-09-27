//! `roger login`: device authorization (RFC 8628) against the Worker.

use std::io::Write;
use std::time::Duration;

use roger_protocol::{DeviceAuthorization, DeviceError, MachineToken};

use crate::client::DevicePoll;
use crate::error::{Error, Result};
use crate::wait::Clock;

/// RFC 8628 section 3.5: a `slow_down` adds 5 seconds to the interval.
const SLOW_DOWN: Duration = Duration::from_secs(5);

/// Tells the person where to approve, then polls until the login is
/// approved, denied, or expires. Never polls past `expires_in`.
pub fn login(
    started: &DeviceAuthorization,
    mut poll: impl FnMut(&str) -> Result<DevicePoll>,
    clock: &mut impl Clock,
    out: &mut impl Write,
) -> Result<MachineToken> {
    writeln!(
        out,
        "To log in this machine, open\n  {}\nand confirm the code {}. Waiting for approval.",
        started.verification_uri_complete, started.user_code
    )
    .map_err(Error::Output)?;
    let start = clock.now();
    let deadline = Duration::from_secs(started.expires_in.into());
    let mut interval = Duration::from_secs(started.interval.max(1).into());
    loop {
        let elapsed = clock.now().saturating_duration_since(start);
        if elapsed.saturating_add(interval) > deadline {
            return Err(Error::LoginExpired);
        }
        clock.sleep(interval);
        let error = match poll(&started.device_code)? {
            Ok(token) => return Ok(token),
            Err(error) => error,
        };
        match error.error {
            DeviceError::AuthorizationPending => {}
            DeviceError::SlowDown => interval = interval.saturating_add(SLOW_DOWN),
            DeviceError::AccessDenied => return Err(Error::LoginDenied),
            DeviceError::ExpiredToken => return Err(Error::LoginExpired),
            DeviceError::InvalidGrant
            | DeviceError::InvalidRequest
            | DeviceError::InvalidClient
            | DeviceError::UnsupportedGrantType => {
                return Err(Error::Login(error.error_description));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::time::Instant;

    use roger_protocol::DeviceErrorBody;

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

    fn started(expires_in: u32) -> DeviceAuthorization {
        DeviceAuthorization {
            device_code: "device".to_owned(),
            user_code: "BCDF-GHJK".to_owned(),
            verification_uri: "https://roger.test/#device".to_owned(),
            verification_uri_complete: "https://roger.test/#device=BCDF-GHJK".to_owned(),
            expires_in,
            interval: 5,
        }
    }

    fn refused(error: DeviceError) -> DevicePoll {
        Err(DeviceErrorBody {
            error,
            error_description: format!("{error} happened"),
        })
    }

    fn token() -> MachineToken {
        MachineToken {
            access_token: "rogm_x".to_owned(),
            token_type: "Bearer".to_owned(),
            machine: "studio".to_owned(),
            owner: "someone".to_owned(),
        }
    }

    fn run(
        expires_in: u32,
        polls: Vec<DevicePoll>,
    ) -> (Result<MachineToken>, Vec<u64>, usize, String) {
        let mut polls = VecDeque::from(polls);
        let mut calls = 0;
        let mut clock = clock();
        let mut out = Vec::new();
        let result = login(
            &started(expires_in),
            |code| {
                assert_eq!(code, "device");
                calls += 1;
                Ok(polls
                    .pop_front()
                    .unwrap_or_else(|| refused(DeviceError::InvalidGrant)))
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
                refused(DeviceError::AuthorizationPending),
                refused(DeviceError::SlowDown),
                Ok(token()),
            ],
        );
        assert_eq!(result.ok(), Some(token()));
        assert_eq!(sleeps, [5, 5, 10]);
        assert_eq!(calls, 3);
        assert!(
            out.contains("https://roger.test/#device=BCDF-GHJK"),
            "{out}"
        );
        assert!(out.contains("BCDF-GHJK"), "{out}");
    }

    #[test]
    fn stops_when_denied() {
        let (result, _, calls, _) = run(900, vec![refused(DeviceError::AccessDenied)]);
        assert!(matches!(result, Err(Error::LoginDenied)), "{result:?}");
        assert_eq!(calls, 1);
    }

    #[test]
    fn never_polls_past_the_expiry() {
        let pending = || refused(DeviceError::AuthorizationPending);
        let (result, sleeps, calls, _) = run(12, vec![pending(), pending(), pending()]);
        assert!(matches!(result, Err(Error::LoginExpired)), "{result:?}");
        assert_eq!(sleeps, [5, 5]);
        assert_eq!(calls, 2);

        let (result, _, _, _) = run(900, vec![refused(DeviceError::ExpiredToken)]);
        assert!(matches!(result, Err(Error::LoginExpired)), "{result:?}");
    }

    #[test]
    fn reports_other_refusals_with_the_server_description() {
        let (result, _, _, _) = run(900, vec![refused(DeviceError::InvalidGrant)]);
        match result {
            Err(Error::Login(message)) => assert_eq!(message, "invalid_grant happened"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn stops_on_a_transport_error() {
        let mut clock = clock();
        let result = login(
            &started(900),
            |_| Err(Error::Status(502)),
            &mut clock,
            &mut Vec::new(),
        );
        assert!(matches!(result, Err(Error::Status(502))), "{result:?}");
    }
}
