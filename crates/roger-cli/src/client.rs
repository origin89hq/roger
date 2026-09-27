//! Blocking HTTP client for the Roger agent API.

use std::path::Path;
use std::time::Duration;

use roger_protocol::{
    AppendTrace, Ask, AskList, AskState, CreateAsk, ErrorBody, LoginConfig, MachineLogin,
    MachineToken, REQUESTER_HEADER,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use ureq::http::Response;
use ureq::{Agent, Body};

use crate::credentials::Credentials;
use crate::error::{Error, Result};
use crate::parse::{AskId, RequesterName};

/// Used when `ROGER_URL` is not set.
pub const DEFAULT_URL: &str = "https://roger.origin89.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Picks the token from `ROGER_TOKEN`, else from the file `ROGER_TOKEN_FILE`
/// names, else from `default_file` when it exists. Surrounding whitespace is
/// ignored; an empty token counts as missing.
pub fn resolve_token(
    token: Option<&str>,
    token_file: Option<&Path>,
    default_file: Option<&Path>,
) -> Result<String> {
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        return Ok(token.to_owned());
    }
    let path = match (token_file, default_file) {
        (Some(path), _) => path,
        (None, Some(path)) if path.is_file() => path,
        (None, _) => return Err(Error::MissingToken),
    };
    let contents = read_token_file(path)?;
    let token = contents.trim();
    if token.is_empty() {
        return Err(Error::MissingToken);
    }
    Ok(token.to_owned())
}

fn read_token_file(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(|source| Error::TokenFile {
        path: path.to_owned(),
        source,
    })
}

/// The credential a command authenticates with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    /// A requester token from Settings; always that one requester.
    Token(String),
    /// A machine login from `roger login`.
    Machine(Credentials),
}

/// Picks the credential: `ROGER_TOKEN`, then the file `ROGER_TOKEN_FILE`
/// names, then `default_file` when it exists, then the saved login. Any
/// token wins, so jobs set up before `roger login` keep their requester.
///
/// `saved` is read only when no token is configured, so a damaged login file
/// does not break a job that names its own token. A `default_file` holding
/// only whitespace does not count; `skipped` names it when the login is used
/// instead, so the switch is visible.
pub fn resolve_auth(
    token: Option<&str>,
    token_file: Option<&Path>,
    saved: impl FnOnce() -> Result<Option<Credentials>>,
    default_file: Option<&Path>,
    skipped: impl FnOnce(&Path),
) -> Result<Auth> {
    // An explicit token wins without looking at the default file, so a
    // damaged leftover file cannot break a job that names its own token.
    if token.is_some_and(|t| !t.trim().is_empty()) || token_file.is_some() {
        return resolve_token(token, token_file, None).map(Auth::Token);
    }
    let default_file = default_file.filter(|path| path.is_file());
    if let Some(path) = default_file
        && holds_token(path)?
    {
        return resolve_token(None, None, Some(path)).map(Auth::Token);
    }
    if let Some(credentials) = saved()? {
        if let Some(path) = default_file {
            skipped(path);
        }
        return Ok(Auth::Machine(credentials));
    }
    resolve_token(None, None, default_file).map(Auth::Token)
}

/// Whether a token file exists and holds more than whitespace.
pub fn holds_token(path: &Path) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    Ok(!read_token_file(path)?.trim().is_empty())
}

/// Which Asks `GET /v1/asks` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListFilter {
    pub state: AskState,
    /// Only Asks without a terminal trace event.
    pub unfinished: bool,
    /// Only decision keys starting with this.
    pub prefix: Option<String>,
    /// Only Asks about this `owner/name`.
    pub repo: Option<String>,
}

pub struct Client {
    agent: Agent,
    base: String,
    /// `None` for the login endpoints, which take no credential.
    authorization: Option<String>,
    /// Sent with a machine credential to name the automation.
    requester: Option<String>,
}

impl Client {
    /// A client for `token`, a requester token or a machine credential. With
    /// a machine credential, `requester` names the automation it acts for.
    pub fn new(base: &str, token: &str, requester: Option<&RequesterName>) -> Self {
        let mut client = Self::anonymous(base);
        client.authorization = Some(format!("Bearer {token}"));
        client.requester = requester.map(|name| name.as_str().to_owned());
        client
    }

    /// A client for `roger login`, which sends no credential.
    pub fn anonymous(base: &str) -> Self {
        let agent: Agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .user_agent(concat!("roger/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self {
            agent,
            base: base.trim_end_matches('/').to_owned(),
            authorization: None,
            requester: None,
        }
    }

    /// How this deployment signs in with GitHub.
    pub fn login_config(&self) -> Result<LoginConfig> {
        decode(self.get_request("/v1/login").call()?)
    }

    /// Exchanges a GitHub token for a machine credential.
    pub fn exchange(&self, login: &MachineLogin) -> Result<MachineToken> {
        self.post("/v1/login", login)
    }

    /// Revokes this machine credential.
    pub fn logout(&self) -> Result<()> {
        let mut request = self.agent.post(format!("{}/v1/machine/logout", self.base));
        if let Some(authorization) = &self.authorization {
            request = request.header("authorization", authorization);
        }
        let mut response = request.send_empty()?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = response.body_mut().read_to_string()?;
        Err(api_error(status.as_u16(), &text))
    }

    fn get_request(&self, path: &str) -> ureq::RequestBuilder<ureq::typestate::WithoutBody> {
        let mut request = self.agent.get(format!("{}{path}", self.base));
        if let Some(authorization) = &self.authorization {
            request = request.header("authorization", authorization);
        }
        if let Some(name) = &self.requester {
            request = request.header(REQUESTER_HEADER, name);
        }
        request
    }

    pub fn create(&self, ask: &CreateAsk) -> Result<Ask> {
        self.post("/v1/asks", ask)
    }

    pub fn get(&self, id: &AskId) -> Result<Ask> {
        let response = self.get_request(&format!("/v1/asks/{id}")).call()?;
        decode(response)
    }

    pub fn list_page(&self, filter: &ListFilter, after: Option<&str>) -> Result<AskList> {
        let mut request = self
            .get_request("/v1/asks")
            .query("state", filter.state.as_str());
        if filter.unfinished {
            request = request.query("terminal", "none");
        }
        if let Some(prefix) = &filter.prefix {
            request = request.query("prefix", prefix);
        }
        if let Some(repo) = &filter.repo {
            request = request.query("repo", repo);
        }
        if let Some(after) = after {
            request = request.query("after", after);
        }
        decode(request.call()?)
    }

    pub fn withdraw(&self, id: &AskId) -> Result<Ask> {
        self.post(&format!("/v1/asks/{id}/withdraw"), &serde_json::json!({}))
    }

    pub fn trace(&self, id: &AskId, entry: &AppendTrace) -> Result<Ask> {
        self.post(&format!("/v1/asks/{id}/trace"), entry)
    }

    fn post<B: Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        let body = serde_json::to_string(body)?;
        let mut request = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("content-type", "application/json");
        if let Some(authorization) = &self.authorization {
            request = request.header("authorization", authorization);
        }
        if let Some(name) = &self.requester {
            request = request.header(REQUESTER_HEADER, name);
        }
        decode(request.send(body)?)
    }
}

/// Parses a 2xx body as `T`, or turns an error response into [`Error::Api`]
/// when it carries an [`ErrorBody`] and [`Error::Status`] otherwise.
fn decode<T: DeserializeOwned>(mut response: Response<Body>) -> Result<T> {
    let status = response.status();
    let text = response.body_mut().read_to_string()?;
    if status.is_success() {
        return Ok(serde_json::from_str(&text)?);
    }
    Err(api_error(status.as_u16(), &text))
}

fn api_error(status: u16, text: &str) -> Error {
    match serde_json::from_str::<ErrorBody>(text) {
        Ok(body) => Error::Api {
            status,
            code: body.error.code,
            message: body.error.message,
        },
        Err(_) => Error::Status(status),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    use roger_protocol::{Decision, ErrorCode, Kind, ReportedEvent, Risk, Urgency};

    use super::*;
    use crate::test_support::ask;

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    /// A request the stub server received.
    struct Received {
        request_line: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Received {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
    }

    /// Serves one canned response per connection, in order, then stops.
    fn stub(
        responses: Vec<(u16, String)>,
    ) -> std::io::Result<(String, JoinHandle<std::io::Result<Vec<Received>>>)> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let base = format!("http://{}", listener.local_addr()?);
        let handle = std::thread::spawn(move || {
            let mut received = Vec::new();
            for (status, body) in responses {
                let (stream, _) = listener.accept()?;
                let mut reader = BufReader::new(stream.try_clone()?);
                let mut request_line = String::new();
                reader.read_line(&mut request_line)?;
                let mut headers = Vec::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line)?;
                    let line = line.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        headers.push((key.trim().to_owned(), value.trim().to_owned()));
                    }
                }
                let length = headers
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let mut request_body = vec![0; length];
                reader.read_exact(&mut request_body)?;
                let mut writer = stream;
                write!(
                    writer,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )?;
                writer.flush()?;
                received.push(Received {
                    request_line: request_line.trim_end().to_owned(),
                    headers,
                    body: String::from_utf8_lossy(&request_body).into_owned(),
                });
            }
            Ok(received)
        });
        Ok((base, handle))
    }

    fn join(
        handle: JoinHandle<std::io::Result<Vec<Received>>>,
    ) -> std::result::Result<Vec<Received>, Box<dyn std::error::Error>> {
        Ok(handle.join().map_err(|_| "stub server panicked")??)
    }

    fn create_ask() -> CreateAsk {
        CreateAsk {
            idem_key: "k".to_owned(),
            decision_key: "d".to_owned(),
            to: None,
            repo: Some("origin89hq/roger".to_owned()),
            supersedes: None,
            kind: Kind::Fyi,
            urgency: Urgency::Fyi,
            risk: Risk::Routine,
            title: "t".to_owned(),
            body: None,
            links: Vec::new(),
            action: None,
            options: Vec::new(),
            resume: None,
            expires_in_minutes: Some(5),
        }
    }

    #[test]
    fn create_sends_bearer_token_and_json_body() -> TestResult {
        let created = ask(AskState::Open, None);
        let (base, handle) = stub(vec![(201, serde_json::to_string(&created)?)])?;
        let request = create_ask();
        let got = Client::new(&format!("{base}/"), "secret", None).create(&request)?;
        assert_eq!(got, created);

        let received = join(handle)?;
        let [first] = received.as_slice() else {
            return Err("expected one request".into());
        };
        assert_eq!(first.request_line, "POST /v1/asks HTTP/1.1");
        assert_eq!(first.header("authorization"), Some("Bearer secret"));
        assert_eq!(first.header("content-type"), Some("application/json"));
        assert_eq!(
            first.header("user-agent"),
            Some(concat!("roger/", env!("CARGO_PKG_VERSION")))
        );
        assert_eq!(serde_json::from_str::<CreateAsk>(&first.body)?, request);
        Ok(())
    }

    #[test]
    fn error_body_becomes_its_message() -> TestResult {
        let body =
            r#"{"error":{"code":"conflict","message":"Ask is answered","state":"answered"}}"#;
        let (base, handle) = stub(vec![(409, body.to_owned())])?;
        let id: AskId = "01K6A0000000000000000000AA".parse()?;
        let got = Client::new(&base, "t", None).withdraw(&id);
        match got {
            Err(
                err @ Error::Api {
                    status: 409,
                    code: ErrorCode::Conflict,
                    ..
                },
            ) => {
                assert_eq!(err.to_string(), "Ask is answered");
            }
            other => return Err(format!("unexpected {other:?}").into()),
        }
        let received = join(handle)?;
        let first = received.first().ok_or("no request")?;
        assert_eq!(
            first.request_line,
            "POST /v1/asks/01K6A0000000000000000000AA/withdraw HTTP/1.1"
        );
        assert_eq!(first.body, "{}");
        Ok(())
    }

    #[test]
    fn non_json_error_reports_the_status() -> TestResult {
        let (base, handle) = stub(vec![(502, "<html>bad gateway</html>".to_owned())])?;
        let id: AskId = "abc".parse()?;
        let got = Client::new(&base, "t", None).get(&id);
        assert!(matches!(got, Err(Error::Status(502))), "{got:?}");
        let received = join(handle)?;
        assert_eq!(
            received.first().map(|r| r.request_line.as_str()),
            Some("GET /v1/asks/abc HTTP/1.1")
        );
        Ok(())
    }

    #[test]
    fn malformed_success_body_is_a_decode_error() -> TestResult {
        let (base, handle) = stub(vec![(200, r#"{"id":"x"}"#.to_owned())])?;
        let id: AskId = "x".parse()?;
        assert!(matches!(
            Client::new(&base, "t", None).get(&id),
            Err(Error::Decode(_))
        ));
        join(handle)?;
        Ok(())
    }

    #[test]
    fn list_and_trace_send_filters_and_entries() -> TestResult {
        let page = AskList {
            asks: vec![ask(AskState::Answered, Some(Decision::Approve))],
            next: Some("01K6A0000000000000000000AA".to_owned()),
        };
        let traced = ask(AskState::Answered, Some(Decision::Approve));
        let (base, handle) = stub(vec![
            (200, serde_json::to_string(&page)?),
            (200, serde_json::to_string(&traced)?),
        ])?;
        let client = Client::new(&base, "t", None);
        let filter = ListFilter {
            state: AskState::Answered,
            unfinished: true,
            prefix: Some("spec:".to_owned()),
            repo: Some("origin89hq/km43".to_owned()),
        };
        assert_eq!(client.list_page(&filter, Some("01K6"))?, page);
        let entry = AppendTrace {
            event: ReportedEvent::Applied,
            refs: std::collections::BTreeMap::from([("branch".to_owned(), "feat/x".to_owned())]),
            url: Some("https://github.com/o/r/commit/5d6e7f8".to_owned()),
            note: None,
        };
        let id: AskId = "abc".parse()?;
        assert_eq!(client.trace(&id, &entry)?, traced);

        let received = join(handle)?;
        let [list, trace] = received.as_slice() else {
            return Err("expected two requests".into());
        };
        assert_eq!(
            list.request_line,
            "GET /v1/asks?state=answered&terminal=none&prefix=spec%3A&repo=origin89hq%2Fkm43&after=01K6 HTTP/1.1"
        );
        assert_eq!(trace.request_line, "POST /v1/asks/abc/trace HTTP/1.1");
        assert_eq!(serde_json::from_str::<AppendTrace>(&trace.body)?, entry);
        Ok(())
    }

    #[test]
    fn token_comes_from_env_then_file() -> TestResult {
        assert_eq!(resolve_token(Some(" tok\n"), None, None)?, "tok");

        let dir = std::env::temp_dir().join(format!("roger-cli-token-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let file = dir.join("token");
        std::fs::write(&file, "from-file\n")?;
        assert_eq!(resolve_token(Some("  "), Some(&file), None)?, "from-file");
        assert_eq!(resolve_token(Some("env"), Some(&file), None)?, "env");
        // The default file is used only when nothing else names a token.
        assert_eq!(resolve_token(None, None, Some(&file))?, "from-file");
        let other = dir.join("other");
        std::fs::write(&other, "named\n")?;
        assert_eq!(resolve_token(None, Some(&other), Some(&file))?, "named");
        assert!(matches!(
            resolve_token(None, None, Some(&dir.join("absent"))),
            Err(Error::MissingToken)
        ));

        std::fs::write(&file, "\n")?;
        assert!(matches!(
            resolve_token(None, Some(&file), None),
            Err(Error::MissingToken)
        ));
        assert!(matches!(
            resolve_token(None, Some(&dir.join("absent")), None),
            Err(Error::TokenFile { .. })
        ));
        assert!(matches!(
            resolve_token(None, None, None),
            Err(Error::MissingToken)
        ));
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    fn saved() -> Credentials {
        Credentials {
            url: "https://roger.test".to_owned(),
            machine: "studio".to_owned(),
            owner: "someone".to_owned(),
            credential: "rogm_x".to_owned(),
        }
    }

    #[test]
    fn any_token_wins_over_the_login() -> TestResult {
        let dir = std::env::temp_dir().join(format!("roger-cli-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let default = dir.join("token");
        std::fs::write(&default, "default-token\n")?;
        let absent = dir.join("absent");
        let login = || Ok(Some(saved()));
        let unread = || -> Result<Option<Credentials>> { Err(Error::NotLoggedIn) };

        assert_eq!(
            resolve_auth(Some("env"), None, unread, Some(&default), |_| {})?,
            Auth::Token("env".to_owned())
        );
        assert_eq!(
            resolve_auth(None, Some(&default), unread, None, |_| {})?,
            Auth::Token("default-token".to_owned())
        );
        // A job set up with ~/.config/roger/token keeps its requester after a login.
        assert_eq!(
            resolve_auth(None, None, unread, Some(&default), |_| {})?,
            Auth::Token("default-token".to_owned())
        );
        assert_eq!(
            resolve_auth(Some(" "), None, login, Some(&absent), |_| {})?,
            Auth::Machine(saved())
        );
        // A damaged login file is an error, not a silent fallback.
        assert!(matches!(
            resolve_auth(None, None, unread, Some(&absent), |_| {}),
            Err(Error::NotLoggedIn)
        ));
        assert!(matches!(
            resolve_auth(None, None, || Ok(None), Some(&absent), |_| {}),
            Err(Error::MissingToken)
        ));
        // An empty token file does not hide the login, and says so.
        let blank = dir.join("blank");
        std::fs::write(&blank, " \n")?;
        let mut skipped = None;
        assert_eq!(
            resolve_auth(None, None, login, Some(&blank), |path| skipped =
                Some(path.to_owned()))?,
            Auth::Machine(saved())
        );
        assert_eq!(skipped.as_deref(), Some(blank.as_path()));
        // Without a login it is still reported as missing.
        assert!(matches!(
            resolve_auth(None, None, || Ok(None), Some(&blank), |_| {}),
            Err(Error::MissingToken)
        ));
        // A named file is explicit: an empty one is an error, not a fallback.
        assert!(matches!(
            resolve_auth(None, Some(&blank), login, None, |_| {}),
            Err(Error::MissingToken)
        ));
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn an_explicit_token_never_reads_the_default_file() -> TestResult {
        let dir = std::env::temp_dir().join(format!("roger-cli-explicit-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let named = dir.join("named");
        std::fs::write(&named, "named-token\n")?;
        let invalid = dir.join("invalid-utf8");
        std::fs::write(&invalid, [0xff, 0xfe, 0x00])?;
        let unreadable = dir.join("unreadable");
        std::fs::write(&unreadable, "secret\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000))?;
        }
        let unread = || -> Result<Option<Credentials>> { Err(Error::NotLoggedIn) };
        for default in [&invalid, &unreadable] {
            assert_eq!(
                resolve_auth(Some("env"), None, unread, Some(default), |_| {})?,
                Auth::Token("env".to_owned())
            );
            assert_eq!(
                resolve_auth(None, Some(&named), unread, Some(default), |_| {})?,
                Auth::Token("named-token".to_owned())
            );
        }
        // As the chosen fallback, a damaged default file is still an error.
        assert!(matches!(
            resolve_auth(None, None, unread, Some(&invalid), |_| {}),
            Err(Error::TokenFile { .. })
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn a_machine_client_names_its_automation_on_every_call() -> TestResult {
        let page = AskList {
            asks: Vec::new(),
            next: None,
        };
        let created = ask(AskState::Open, None);
        let (base, handle) = stub(vec![
            (200, serde_json::to_string(&page)?),
            (201, serde_json::to_string(&created)?),
        ])?;
        let name: RequesterName = "merge-gate".parse()?;
        let client = Client::new(&base, "rogm_x", Some(&name));
        let filter = ListFilter {
            state: AskState::Open,
            unfinished: false,
            prefix: None,
            repo: None,
        };
        client.list_page(&filter, None)?;
        client.create(&create_ask())?;
        let received = join(handle)?;
        assert_eq!(received.len(), 2);
        for request in &received {
            assert_eq!(request.header("roger-requester"), Some("merge-gate"));
            assert_eq!(request.header("authorization"), Some("Bearer rogm_x"));
        }

        // A token client sends no name.
        let (base, handle) = stub(vec![(200, serde_json::to_string(&page)?)])?;
        Client::new(&base, "roger_x", None).list_page(&filter, None)?;
        assert_eq!(
            join(handle)?
                .first()
                .and_then(|r| r.header("roger-requester")),
            None
        );
        Ok(())
    }

    #[test]
    fn login_calls_send_no_credential() -> TestResult {
        let config = LoginConfig {
            github_client_id: "Ov23client".to_owned(),
            scope: "read:org".to_owned(),
        };
        let token = MachineToken {
            credential: "rogm_x".to_owned(),
            machine: "studio".to_owned(),
            owner: "someone".to_owned(),
        };
        let (base, handle) = stub(vec![
            (200, serde_json::to_string(&config)?),
            (200, serde_json::to_string(&token)?),
            (
                403,
                r#"{"error":{"code":"forbidden","message":"not a member","state":null}}"#
                    .to_owned(),
            ),
        ])?;
        let client = Client::anonymous(&base);
        assert_eq!(client.login_config()?, config);
        let login = MachineLogin {
            github_token: "gho_x".to_owned(),
            machine: "studio".to_owned(),
        };
        assert_eq!(client.exchange(&login)?, token);
        match client.exchange(&login) {
            Err(err @ Error::Api { status: 403, .. }) => {
                assert_eq!(err.to_string(), "not a member");
            }
            other => return Err(format!("unexpected {other:?}").into()),
        }
        let received = join(handle)?;
        let [get, post, _] = received.as_slice() else {
            return Err("expected three requests".into());
        };
        assert_eq!(get.request_line, "GET /v1/login HTTP/1.1");
        assert_eq!(post.request_line, "POST /v1/login HTTP/1.1");
        assert_eq!(serde_json::from_str::<MachineLogin>(&post.body)?, login);
        for request in &received {
            assert_eq!(request.header("authorization"), None);
        }
        Ok(())
    }

    #[test]
    fn logout_treats_an_unknown_login_as_an_api_error() -> TestResult {
        let (base, handle) = stub(vec![
            (204, String::new()),
            (
                401,
                r#"{"error":{"code":"unauthorized","message":"revoked","state":null}}"#.to_owned(),
            ),
        ])?;
        let client = Client::new(&base, "rogm_x", None);
        client.logout()?;
        assert!(matches!(
            client.logout(),
            Err(Error::Api { status: 401, .. })
        ));
        let received = join(handle)?;
        assert_eq!(
            received.first().map(|r| r.request_line.as_str()),
            Some("POST /v1/machine/logout HTTP/1.1")
        );
        Ok(())
    }
}
