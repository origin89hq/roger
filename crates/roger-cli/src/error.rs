use std::path::PathBuf;

use roger_protocol::{ErrorCode, UnknownVariant};

/// Everything that makes `roger` exit 1.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no token: set ROGER_TOKEN or ROGER_TOKEN_FILE, or save it to ~/.config/roger/token")]
    MissingToken,
    #[error("reading token file {}: {source}", path.display())]
    TokenFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("reading body from {}: {source}", path.display())]
    BodyFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("body is larger than {limit} bytes")]
    BodyTooLarge { limit: u64 },
    #[error("invalid option `{value}`: {reason}; expected id:decision:label")]
    InvalidOption { value: String, reason: &'static str },
    #[error(transparent)]
    UnknownVariant(#[from] UnknownVariant),
    #[error("--input-required `{0}` does not name an --option")]
    UnknownInputRequired(String),
    #[error("--action-verb, --action-target, and --action-rev must be given together")]
    PartialAction,
    #[error("invalid link `{0}`; expected label=url")]
    InvalidLink(String),
    #[error("invalid ref `{0}`; expected key=value")]
    InvalidRef(String),
    #[error("--ref `{0}` is given more than once")]
    DuplicateRef(String),
    #[error("invalid duration `{value}`: {reason}; expected forms like 30s, 9m, 4h, 2d, 1h30m")]
    InvalidDuration { value: String, reason: &'static str },
    #[error("--expires-in is longer than {max} minutes", max = u32::MAX)]
    ExpiryTooLong,
    #[error("invalid Ask id `{0}`")]
    InvalidAskId(String),
    #[error("{message}")]
    Api {
        status: u16,
        code: ErrorCode,
        message: String,
    },
    #[error("server returned HTTP {0}")]
    Status(u16),
    #[error("request failed: {0}")]
    Http(#[from] ureq::Error),
    #[error("unexpected response: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("more than {0} pages of Asks; stopping")]
    TooManyPages(usize),
    #[error("writing output: {0}")]
    Output(#[source] std::io::Error),
    /// `roger skill` was given a name it does not ship.
    #[error("unknown skill `{name}`; known skills: {known}")]
    UnknownSkill { name: String, known: String },
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
