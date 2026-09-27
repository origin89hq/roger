use std::path::PathBuf;

use roger_protocol::{ErrorCode, UnknownVariant};

/// Everything that makes `roger` exit 1.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "not logged in: run `roger login`, or set ROGER_TOKEN or ROGER_TOKEN_FILE to a requester token"
    )]
    MissingToken,
    #[error("--as and ROGER_REQUESTER need `roger login`; a token is already one requester")]
    AsNeedsLogin,
    #[error("this machine is not logged in; run `roger login`")]
    NotLoggedIn,
    #[error("{} holds a login for {saved}, not {url}; run `roger login`", path.display())]
    CredentialsForOtherServer {
        path: PathBuf,
        saved: String,
        url: String,
    },
    #[error("{action} credentials file {}: {source}", path.display())]
    CredentialsFile {
        action: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("no config directory: set HOME or XDG_CONFIG_HOME")]
    NoConfigDir,
    #[error("the login was denied on GitHub")]
    LoginDenied,
    #[error("could not tell this host's name; pass --machine <name>")]
    NoMachineName,
    #[error(
        "refusing to send a GitHub login to {0}; ROGER_URL must use https, or http to this \
         computer, and carry no user name or password"
    )]
    InsecureLoginUrl(String),
    #[error("the login code expired before it was approved; run `roger login` again")]
    LoginExpired,
    #[error("login failed: {0}")]
    Login(String),
    #[error("invalid requester name `{0}`: use lowercase letters, digits, and ._@-")]
    InvalidRequesterName(String),
    #[error("invalid machine name `{0}`: use lowercase letters, digits, and -, at most 40")]
    InvalidMachineName(String),
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
