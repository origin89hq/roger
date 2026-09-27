//! Polling an Ask until it leaves `open` or a deadline passes.

use std::time::{Duration, Instant};

use roger_protocol::{Ask, Outcome};

use crate::error::Result;

const FIRST_DELAY: Duration = Duration::from_secs(2);
const MAX_DELAY: Duration = Duration::from_secs(30);

/// Time source for [`wait`], replaceable in tests.
pub trait Clock {
    fn now(&self) -> Instant;
    fn sleep(&mut self, duration: Duration);
}

/// The real clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// Fetches the Ask until it has an outcome other than [`Outcome::Open`] or
/// `timeout` passes, and returns the last Ask read.
///
/// Sleeps 2 s, doubling to 30 s, and never past the deadline. The Ask is read
/// once more at the deadline. A fetch error ends the wait.
pub fn wait(
    mut fetch: impl FnMut() -> Result<Ask>,
    clock: &mut impl Clock,
    timeout: Duration,
) -> Result<Ask> {
    let start = clock.now();
    let mut delay = FIRST_DELAY;
    loop {
        let ask = fetch()?;
        if ask.outcome() != Outcome::Open {
            return Ok(ask);
        }
        let elapsed = clock.now().saturating_duration_since(start);
        let remaining = timeout.saturating_sub(elapsed);
        if remaining.is_zero() {
            return Ok(ask);
        }
        clock.sleep(delay.min(remaining));
        delay = delay.saturating_mul(2).min(MAX_DELAY);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use roger_protocol::{AskState, Decision};

    use super::*;
    use crate::error::Error;
    use crate::test_support::ask;

    struct FakeClock {
        start: Instant,
        elapsed: Duration,
        sleeps: Vec<Duration>,
    }

    impl FakeClock {
        fn new() -> Self {
            Self {
                start: Instant::now(),
                elapsed: Duration::ZERO,
                sleeps: Vec::new(),
            }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.start + self.elapsed
        }

        fn sleep(&mut self, duration: Duration) {
            self.elapsed += duration;
            self.sleeps.push(duration);
        }
    }

    fn secs(values: &[u64]) -> Vec<Duration> {
        values.iter().copied().map(Duration::from_secs).collect()
    }

    #[test]
    fn returns_when_answered_after_backing_off() -> Result<()> {
        let mut replies = VecDeque::from([
            ask(AskState::Open, None),
            ask(AskState::Open, None),
            ask(AskState::Answered, Some(Decision::Reject)),
        ]);
        let mut clock = FakeClock::new();
        let got = wait(
            || {
                Ok(replies
                    .pop_front()
                    .unwrap_or_else(|| ask(AskState::Open, None)))
            },
            &mut clock,
            Duration::from_secs(540),
        )?;
        assert_eq!(got.outcome(), Outcome::Rejected);
        assert_eq!(clock.sleeps, secs(&[2, 4]));
        assert!(replies.is_empty());
        Ok(())
    }

    #[test]
    fn already_closed_ask_returns_without_sleeping() -> Result<()> {
        let mut clock = FakeClock::new();
        let got = wait(
            || Ok(ask(AskState::Withdrawn, None)),
            &mut clock,
            Duration::from_secs(60),
        )?;
        assert_eq!(got.outcome(), Outcome::Closed);
        assert!(clock.sleeps.is_empty());
        Ok(())
    }

    #[test]
    fn backoff_caps_at_30s_and_stops_exactly_at_the_deadline() -> Result<()> {
        let mut clock = FakeClock::new();
        let mut fetches = 0_u32;
        let got = wait(
            || {
                fetches += 1;
                Ok(ask(AskState::Open, None))
            },
            &mut clock,
            Duration::from_secs(540),
        )?;
        assert_eq!(got.outcome(), Outcome::Open);
        // 2+4+8+16 = 30, then 30 s steps; 510 s leaves exactly 17 × 30.
        let mut expected = secs(&[2, 4, 8, 16]);
        expected.extend(std::iter::repeat_n(Duration::from_secs(30), 17));
        assert_eq!(clock.sleeps, expected);
        assert_eq!(clock.elapsed, Duration::from_secs(540));
        assert_eq!(fetches, 22);
        Ok(())
    }

    #[test]
    fn short_timeout_truncates_the_last_sleep_and_reads_once_more() -> Result<()> {
        let mut clock = FakeClock::new();
        let mut fetches = 0_u32;
        wait(
            || {
                fetches += 1;
                Ok(ask(AskState::Open, None))
            },
            &mut clock,
            Duration::from_secs(5),
        )?;
        assert_eq!(clock.sleeps, secs(&[2, 3]));
        assert_eq!(fetches, 3);
        Ok(())
    }

    #[test]
    fn fetch_error_ends_the_wait() {
        let mut clock = FakeClock::new();
        let mut replies = VecDeque::from([Ok(ask(AskState::Open, None)), Err(Error::Status(503))]);
        let got = wait(
            || replies.pop_front().unwrap_or(Err(Error::Status(500))),
            &mut clock,
            Duration::from_secs(60),
        );
        assert!(matches!(got, Err(Error::Status(503))));
        assert_eq!(clock.sleeps, secs(&[2]));
    }
}
