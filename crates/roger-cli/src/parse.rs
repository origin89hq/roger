//! Parsers for command-line values.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use roger_protocol::{AskOption, Decision, Link};

use crate::error::{Error, Result};

/// An Ask id as the user typed it. Only characters that are safe in a URL path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskId(String);

impl AskId {
    const MAX_LEN: usize = 64;

    pub fn into_string(self) -> String {
        self.0
    }
}

impl FromStr for AskId {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        let valid = !s.is_empty()
            && s.len() <= Self::MAX_LEN
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if valid {
            Ok(Self(s.to_owned()))
        } else {
            Err(Error::InvalidAskId(s.to_owned()))
        }
    }
}

impl fmt::Display for AskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The automation a machine credential acts for, from `--as` or
/// `ROGER_REQUESTER`, such as `merge-gate`. The Worker makes it the requester
/// `<machine>/<name>`. Same rule as the Worker: lowercase letters, digits, and
/// `._@-`, starting with a letter or digit, at most 80 characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequesterName(String);

impl RequesterName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for RequesterName {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        if lowercase_name(s, 80, b"._@-") {
            Ok(Self(s.to_owned()))
        } else {
            Err(Error::InvalidRequesterName(s.to_owned()))
        }
    }
}

impl fmt::Display for RequesterName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A machine name for `roger login`, such as `studio`: lowercase letters,
/// digits, and `-`, starting with a letter or digit, at most 40 characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineName(String);

impl MachineName {
    const MAX_LEN: usize = 40;

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A suggestion from a host name such as `Studio.local`: the first label,
    /// lowercased, with other characters turned into `-`. `None` if nothing
    /// usable is left.
    pub fn from_host(host: &str) -> Option<Self> {
        let label = host.trim().split('.').next().unwrap_or_default();
        let cleaned: String = label
            .chars()
            .map(|c| {
                let c = c.to_ascii_lowercase();
                if c.is_ascii_lowercase() || c.is_ascii_digit() {
                    c
                } else {
                    '-'
                }
            })
            .take(Self::MAX_LEN)
            .collect();
        cleaned.trim_start_matches('-').parse().ok()
    }
}

impl FromStr for MachineName {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        if lowercase_name(s, Self::MAX_LEN, b"-") {
            Ok(Self(s.to_owned()))
        } else {
            Err(Error::InvalidMachineName(s.to_owned()))
        }
    }
}

impl fmt::Display for MachineName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// `[a-z0-9]` followed by `[a-z0-9]` or any of `extra`, at most `max` bytes.
fn lowercase_name(s: &str, max: usize, extra: &[u8]) -> bool {
    let plain = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let mut bytes = s.bytes();
    s.len() <= max
        && bytes.next().is_some_and(plain)
        && bytes.all(|b| plain(b) || extra.contains(&b))
}

/// Parses `id:decision:label`. The label may contain `:`.
pub fn parse_option(value: &str) -> Result<AskOption> {
    let invalid = |reason| Error::InvalidOption {
        value: value.to_owned(),
        reason,
    };
    let mut parts = value.splitn(3, ':');
    let (Some(id), Some(decision), Some(label)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid("missing a part"));
    };
    if id.is_empty() {
        return Err(invalid("empty id"));
    }
    if label.is_empty() {
        return Err(invalid("empty label"));
    }
    Ok(AskOption {
        id: id.to_owned(),
        label: label.to_owned(),
        decision: decision.parse::<Decision>()?,
        input_required: false,
    })
}

/// Parses `label=url`, splitting at the first `=`.
pub fn parse_link(value: &str) -> Result<Link> {
    match value.split_once('=') {
        Some((label, url)) if !label.is_empty() && !url.is_empty() => Ok(Link {
            label: label.to_owned(),
            url: url.to_owned(),
        }),
        Some(_) | None => Err(Error::InvalidLink(value.to_owned())),
    }
}

/// Parses `key=value`, splitting at the first `=`.
pub fn parse_ref(value: &str) -> Result<(String, String)> {
    match value.split_once('=') {
        Some((key, val)) if !key.is_empty() && !val.is_empty() => {
            Ok((key.to_owned(), val.to_owned()))
        }
        Some(_) | None => Err(Error::InvalidRef(value.to_owned())),
    }
}

/// Collects refs into a map, rejecting a key given twice.
pub fn refs_to_map(refs: Vec<(String, String)>) -> Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    for (key, value) in refs {
        if map.contains_key(&key) {
            return Err(Error::DuplicateRef(key));
        }
        map.insert(key, value);
    }
    Ok(map)
}

/// Parses durations such as `30s`, `9m`, `4h`, `2d`, and `1h30m`.
pub fn parse_duration(value: &str) -> Result<Duration> {
    let invalid = |reason| Error::InvalidDuration {
        value: value.to_owned(),
        reason,
    };
    if value.is_empty() {
        return Err(invalid("empty"));
    }
    let mut total: u64 = 0;
    let mut number: Option<u64> = None;
    for c in value.chars() {
        if let Some(digit) = c.to_digit(10) {
            let next = number
                .unwrap_or(0)
                .checked_mul(10)
                .and_then(|n| n.checked_add(u64::from(digit)))
                .ok_or_else(|| invalid("too long"))?;
            number = Some(next);
            continue;
        }
        let unit: u64 = match c {
            's' => 1,
            'm' => 60,
            'h' => 3_600,
            'd' => 86_400,
            _ => return Err(invalid("unknown unit")),
        };
        let count = number
            .take()
            .ok_or_else(|| invalid("unit without a number"))?;
        total = count
            .checked_mul(unit)
            .and_then(|secs| total.checked_add(secs))
            .ok_or_else(|| invalid("too long"))?;
    }
    if number.is_some() {
        return Err(invalid("number without a unit"));
    }
    if total == 0 {
        return Err(invalid("zero"));
    }
    Ok(Duration::from_secs(total))
}

/// Whole minutes, rounding up, for `expiresInMinutes`.
pub fn whole_minutes(duration: Duration) -> Result<u32> {
    u32::try_from(duration.as_secs().div_ceil(60)).map_err(|_| Error::ExpiryTooLong)
}

/// Extracts `owner/name` from a GitHub remote URL.
///
/// Accepts `git@github.com:owner/name`, `https://github.com/owner/name`, and
/// `ssh://git@github.com/owner/name`, each with an optional `.git` suffix.
/// Returns `None` for any other host or shape.
pub fn github_repo_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let path = if let Some(rest) = remote.strip_prefix("git@github.com:") {
        rest
    } else {
        let rest = ["https://", "ssh://"]
            .iter()
            .find_map(|scheme| remote.strip_prefix(scheme))?;
        let (authority, path) = rest.split_once('/')?;
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        if host != "github.com" {
            return None;
        }
        path
    };
    let path = path.strip_suffix('/').unwrap_or(path);
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let valid = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    };
    (valid(owner) && valid(name)).then(|| format!("{owner}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_label_keeps_colons_after_the_first_two() -> Result<()> {
        let option = parse_option("fix:other:Fix: describe it")?;
        assert_eq!(
            option,
            AskOption {
                id: "fix".to_owned(),
                label: "Fix: describe it".to_owned(),
                decision: Decision::Other,
                input_required: false,
            }
        );
        Ok(())
    }

    #[test]
    fn option_rejects_missing_parts_and_unknown_decisions() {
        assert!(matches!(
            parse_option("approve:approve"),
            Err(Error::InvalidOption {
                reason: "missing a part",
                ..
            })
        ));
        assert!(matches!(
            parse_option(":approve:Merge"),
            Err(Error::InvalidOption {
                reason: "empty id",
                ..
            })
        ));
        assert!(matches!(
            parse_option("ok:approve:"),
            Err(Error::InvalidOption {
                reason: "empty label",
                ..
            })
        ));
        assert!(matches!(
            parse_option("ok:maybe:Merge"),
            Err(Error::UnknownVariant(_))
        ));
    }

    #[test]
    fn link_splits_at_the_first_equals() -> Result<()> {
        let link = parse_link("PR=https://example.com/?a=b")?;
        assert_eq!(link.label, "PR");
        assert_eq!(link.url, "https://example.com/?a=b");
        for bad in ["PR", "=https://x", "PR="] {
            assert!(
                matches!(parse_link(bad), Err(Error::InvalidLink(_))),
                "{bad}"
            );
        }
        Ok(())
    }

    #[test]
    fn refs_reject_missing_equals_and_duplicate_keys() -> Result<()> {
        assert_eq!(
            parse_ref("orca.run=r_81")?,
            ("orca.run".to_owned(), "r_81".to_owned())
        );
        assert!(matches!(parse_ref("orca.run"), Err(Error::InvalidRef(_))));
        assert!(matches!(parse_ref("=x"), Err(Error::InvalidRef(_))));
        let map = refs_to_map(vec![parse_ref("a=1")?, parse_ref("b=2")?])?;
        assert_eq!(map.get("b").map(String::as_str), Some("2"));
        assert!(refs_to_map(Vec::new())?.is_empty());
        assert!(matches!(
            refs_to_map(vec![parse_ref("a=1")?, parse_ref("a=2")?]),
            Err(Error::DuplicateRef(key)) if key == "a"
        ));
        Ok(())
    }

    #[test]
    fn durations_accept_single_and_combined_units() -> Result<()> {
        assert_eq!(parse_duration("30s")?, Duration::from_secs(30));
        assert_eq!(parse_duration("9m")?, Duration::from_mins(9));
        assert_eq!(parse_duration("4h")?, Duration::from_hours(4));
        assert_eq!(parse_duration("2d")?, Duration::from_hours(48));
        assert_eq!(parse_duration("1h30m")?, Duration::from_mins(90));
        assert_eq!(parse_duration("1s")?, Duration::from_secs(1));
        Ok(())
    }

    #[test]
    fn durations_reject_empty_zero_overflow_and_bad_units() {
        for (input, reason) in [
            ("", "empty"),
            ("0s", "zero"),
            ("0h0m", "zero"),
            ("30", "number without a unit"),
            ("1h30", "number without a unit"),
            ("m", "unit without a number"),
            ("5w", "unknown unit"),
            ("-5m", "unknown unit"),
            ("99999999999999999999s", "too long"),
            ("999999999999999999d", "too long"),
        ] {
            assert!(
                matches!(parse_duration(input), Err(Error::InvalidDuration { reason: r, .. }) if r == reason),
                "{input}"
            );
        }
    }

    #[test]
    fn whole_minutes_round_up_and_reject_overflow() -> Result<()> {
        assert_eq!(whole_minutes(Duration::from_secs(1))?, 1);
        assert_eq!(whole_minutes(Duration::from_secs(60))?, 1);
        assert_eq!(whole_minutes(Duration::from_secs(61))?, 2);
        assert_eq!(
            whole_minutes(Duration::from_secs(u64::from(u32::MAX) * 60))?,
            u32::MAX
        );
        assert!(matches!(
            whole_minutes(Duration::from_secs(u64::from(u32::MAX) * 60 + 1)),
            Err(Error::ExpiryTooLong)
        ));
        Ok(())
    }

    #[test]
    fn github_remotes_in_every_supported_form() {
        let expected = Some("origin89hq/roger".to_owned());
        for remote in [
            "git@github.com:origin89hq/roger.git",
            "git@github.com:origin89hq/roger",
            "https://github.com/origin89hq/roger.git",
            "https://github.com/origin89hq/roger\n",
            "https://token@github.com/origin89hq/roger/",
            "ssh://git@github.com/origin89hq/roger.git",
        ] {
            assert_eq!(github_repo_from_remote(remote), expected, "{remote}");
        }
    }

    #[test]
    fn non_github_or_malformed_remotes_give_nothing() {
        for remote in [
            "",
            "git@gitlab.com:origin89hq/roger.git",
            "https://github.com.evil.com/origin89hq/roger",
            "https://github.com/origin89hq",
            "https://github.com/origin89hq/roger/tree/main",
            "http://github.com/origin89hq/roger",
            "/srv/git/roger.git",
            "git@github.com:/roger",
        ] {
            assert_eq!(github_repo_from_remote(remote), None, "{remote}");
        }
    }

    #[test]
    fn ask_ids_allow_only_path_safe_characters() {
        assert_eq!(
            "01K6A0000000000000000000AA"
                .parse::<AskId>()
                .ok()
                .map(AskId::into_string),
            Some("01K6A0000000000000000000AA".to_owned())
        );
        for bad in ["", "../x", "a b", "a/b", "a?b", &"a".repeat(65)] {
            assert!(
                matches!(bad.parse::<AskId>(), Err(Error::InvalidAskId(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn requester_names_follow_the_worker_rule() {
        for ok in ["default", "merge-gate", "orca@studio", "a.b_c", "x"] {
            assert_eq!(
                ok.parse::<RequesterName>().ok().map(|n| n.to_string()),
                Some(ok.to_owned())
            );
        }
        for bad in ["", "Merge", "a/b", "-lead", "a b", &"a".repeat(81)] {
            assert!(bad.parse::<RequesterName>().is_err(), "{bad}");
        }
        assert!("a".repeat(80).parse::<RequesterName>().is_ok());
    }

    #[test]
    fn machine_names_come_from_host_names() {
        let suggest = |host: &str| MachineName::from_host(host).map(|n| n.to_string());
        assert_eq!(suggest("Studio.local"), Some("studio".to_owned()));
        assert_eq!(
            suggest("Davids-MacBook_Pro"),
            Some("davids-macbook-pro".to_owned())
        );
        assert_eq!(suggest("--build01"), Some("build01".to_owned()));
        assert_eq!(suggest(""), None);
        assert_eq!(suggest("..."), None);
        assert_eq!(suggest(&"x".repeat(60)).map(|n| n.len()), Some(40));
        assert!("a_b".parse::<MachineName>().is_err());
        assert!("studio".parse::<MachineName>().is_ok());
    }
}
