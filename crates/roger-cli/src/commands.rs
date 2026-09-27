//! What each subcommand does.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command as Process, Stdio};

use roger_protocol::{
    Action, AppendTrace, Ask, AskList, AskOption, AskState, CreateAsk, Decision, Kind, Outcome,
    Resume, TraceEvent,
};
use serde::Serialize;

use crate::cli::{ApiCommand, AskArgs, ListArgs, ListFormat, TraceArgs};
use crate::client::{Client, ListFilter};
use crate::credentials::{self, Credentials};
use crate::error::{Error, Result};
use crate::parse::{MachineName, github_repo_from_remote, refs_to_map, whole_minutes};
use crate::wait::{SystemClock, wait};

/// Largest `--body-file` accepted.
const MAX_BODY_BYTES: u64 = 1024 * 1024;
/// Stops `list` if the server keeps returning a `next` cursor.
const MAX_PAGES: usize = 50;

/// Runs a command and returns the process exit code.
pub fn run(client: &Client, command: ApiCommand) -> Result<u8> {
    match command {
        ApiCommand::Ask(args) => {
            let body = match &args.body_file {
                Some(path) => Some(read_body(path)?),
                None => args.body.clone(),
            };
            let repo = match (&args.repo, args.no_repo) {
                (Some(repo), _) => Some(repo.clone()),
                (None, true) => None,
                (None, false) => detect_repo(),
            };
            let request = build_create_ask(&args, body, repo)?;
            let created = client.create(&request)?;
            if !args.wait {
                print_json(&created)?;
                return Ok(0);
            }
            eprintln!("roger: created {}; waiting", created.id);
            let id = created.id.parse()?;
            let ask = wait(|| client.get(&id), &mut SystemClock, args.timeout)?;
            print_json(&ask)?;
            Ok(exit_code(ask.outcome()))
        }
        ApiCommand::Get { id } => {
            let ask = client.get(&id)?;
            print_json(&ask)?;
            Ok(exit_code(ask.outcome()))
        }
        ApiCommand::Wait { id, timeout } => {
            let ask = wait(|| client.get(&id), &mut SystemClock, timeout)?;
            print_json(&ask)?;
            Ok(exit_code(ask.outcome()))
        }
        ApiCommand::List(args) => {
            let filter = list_filter(&args);
            let asks = collect_pages(|after| client.list_page(&filter, after))?;
            match args.format {
                ListFormat::Brief => print_brief(&asks)?,
                ListFormat::Json => print_json(&Listing { asks: &asks })?,
            }
            Ok(0)
        }
        ApiCommand::Withdraw { id } => {
            print_json(&client.withdraw(&id)?)?;
            Ok(0)
        }
        ApiCommand::Adopt { name } => {
            print_json(&client.adopt(&name)?)?;
            eprintln!("roger: `--as {name}` now acts as the requester {name} on this machine");
            Ok(0)
        }
        ApiCommand::Trace(args) => {
            let TraceArgs {
                id,
                event,
                refs,
                url,
                note,
            } = args;
            let entry = AppendTrace {
                event,
                refs: refs_to_map(refs)?,
                url,
                note,
            };
            let ask = client.trace(&id, &entry)?;
            // Name the Ask back, so a caller sees which decision it recorded.
            eprintln!(
                "roger: recorded {} on {} ({}): {}",
                entry.event, ask.id, ask.decision_key, ask.title
            );
            print_json(&ask)?;
            Ok(0)
        }
    }
}

/// `roger login`: runs device authorization, saves the new credential, and
/// only then revokes the login it replaces, so a denied or expired login
/// leaves the old one working.
pub fn login(base: &str, path: &Path, machine: Option<MachineName>) -> Result<u8> {
    let old = credentials::load(path)?;
    // The device endpoints take no credential.
    let client = Client::new(base, "", None);
    let suggested = machine.or_else(host_machine_name);
    let started = client.device_code(suggested.as_ref())?;
    let token = crate::login::login(
        &started,
        |code| client.device_token(code),
        &mut SystemClock,
        &mut std::io::stderr(),
    )?;
    credentials::save(
        path,
        &Credentials {
            url: base.to_owned(),
            machine: token.machine.clone(),
            owner: token.owner.clone(),
            credential: token.access_token,
        },
    )?;
    // Under the same name the Worker already revoked it; this covers a new name.
    if let Some(old) = old.filter(|old| old.url == base)
        && let Err(err) = revoke(&old)
    {
        eprintln!(
            "roger: could not revoke the previous login of {}: {err}; revoke it in Settings",
            old.machine
        );
    }
    eprintln!(
        "roger: logged in as machine {machine} for @{owner}. Name each automation with --as <name> \
         or ROGER_REQUESTER; without a name, calls act as {machine}/default.",
        machine = token.machine,
        owner = token.owner,
    );
    Ok(0)
}

/// `roger logout`: revokes the saved login where it was issued, then deletes it.
pub fn logout(path: &Path) -> Result<u8> {
    let saved = credentials::load(path)?.ok_or(Error::NotLoggedIn)?;
    revoke(&saved)?;
    credentials::remove(path)?;
    eprintln!("roger: logged out {}", saved.machine);
    Ok(0)
}

/// Revokes a saved login. One the server no longer accepts is already revoked.
fn revoke(saved: &Credentials) -> Result<()> {
    match Client::new(&saved.url, &saved.credential, None).logout() {
        Ok(()) | Err(Error::Api { status: 401, .. }) => Ok(()),
        Err(err) => Err(err),
    }
}

/// This host's name as a machine name, if `hostname` answers with a usable one.
fn host_machine_name() -> Option<MachineName> {
    let output = Process::new("hostname")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    MachineName::from_host(&String::from_utf8_lossy(&output.stdout))
}

/// Agent skills for this version of the CLI, by the name `roger skill` takes.
/// The core skill comes first; each integration adds one entry.
pub const SKILLS: &[(&str, &str)] = &[
    ("roger", include_str!("../skills/roger/SKILL.md")),
    ("orca", include_str!("../skills/roger-orca/SKILL.md")),
];

/// Prints the named skill, or the core skill when `name` is `None`.
pub fn print_skill(name: Option<&str>) -> Result<u8> {
    let name = name.unwrap_or("roger");
    let (_, text) = SKILLS
        .iter()
        .find(|(n, _)| *n == name)
        .ok_or_else(|| Error::UnknownSkill {
            name: name.to_owned(),
            known: SKILLS
                .iter()
                .map(|(n, _)| *n)
                .collect::<Vec<_>>()
                .join(", "),
        })?;
    std::io::stdout()
        .write_all(text.as_bytes())
        .map_err(Error::Output)?;
    Ok(0)
}

/// The exit code scripts branch on.
pub const fn exit_code(outcome: Outcome) -> u8 {
    match outcome {
        Outcome::Approved => 0,
        Outcome::Rejected => 10,
        Outcome::Other => 11,
        Outcome::Expired => 20,
        Outcome::Closed => 21,
        Outcome::Open => 22,
    }
}

/// Builds the request body from the arguments, the resolved body, and repository.
pub fn build_create_ask(
    args: &AskArgs,
    body: Option<String>,
    repo: Option<String>,
) -> Result<CreateAsk> {
    let action = match (
        &args.action_verb,
        &args.action_target,
        &args.action_rev,
        &args.action_limits,
    ) {
        (Some(verb), Some(target), Some(rev), limits) => Some(Action {
            verb: verb.clone(),
            target: target.clone(),
            rev: rev.clone(),
            limits: limits.clone(),
        }),
        (None, None, None, None) => None,
        _ => return Err(Error::PartialAction),
    };

    let mut options = args.options.clone();
    if options.is_empty() && args.kind == Kind::Fyi {
        options.push(AskOption {
            id: "ack".to_owned(),
            label: "Acknowledge".to_owned(),
            decision: Decision::Other,
            input_required: false,
        });
    }
    for id in &args.input_required {
        let option = options
            .iter_mut()
            .find(|option| option.id == *id)
            .ok_or_else(|| Error::UnknownInputRequired(id.clone()))?;
        option.input_required = true;
    }

    let resume = Resume {
        run: args.resume_run.clone(),
        task: args.resume_task.clone(),
        branch: args.resume_branch.clone(),
        rev: args.resume_rev.clone(),
    };

    Ok(CreateAsk {
        idem_key: args.idem.clone(),
        decision_key: args.decision_key.clone(),
        to: args.to.clone(),
        repo,
        supersedes: args
            .supersedes
            .clone()
            .map(crate::parse::AskId::into_string),
        kind: args.kind,
        urgency: args.urgency,
        risk: args.risk,
        title: args.title.clone(),
        body,
        links: args.links.clone(),
        action,
        options,
        resume: (resume != Resume::default()).then_some(resume),
        expires_in_minutes: args.expires_in.map(whole_minutes).transpose()?,
    })
}

fn list_filter(args: &ListArgs) -> ListFilter {
    ListFilter {
        state: if args.open {
            AskState::Open
        } else {
            AskState::Answered
        },
        unfinished: args.unfinished,
        prefix: args.prefix.clone(),
        repo: args.repo.clone(),
    }
}

/// Reads pages until `next` is null, at most [`MAX_PAGES`].
pub fn collect_pages(mut fetch: impl FnMut(Option<&str>) -> Result<AskList>) -> Result<Vec<Ask>> {
    let mut asks = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = fetch(after.as_deref())?;
        asks.extend(page.asks);
        match page.next {
            Some(next) => after = Some(next),
            None => return Ok(asks),
        }
    }
    Err(Error::TooManyPages(MAX_PAGES))
}

/// Reads `--body-file`; `-` means stdin. Refuses more than [`MAX_BODY_BYTES`].
fn read_body(path: &Path) -> Result<String> {
    let io_error = |source| Error::BodyFile {
        path: path.to_owned(),
        source,
    };
    let reader: Box<dyn Read> = if path == Path::new("-") {
        Box::new(std::io::stdin().lock())
    } else {
        Box::new(std::fs::File::open(path).map_err(io_error)?)
    };
    read_bounded(reader, MAX_BODY_BYTES).map_err(|err| match err {
        ReadError::Io(source) => io_error(source),
        ReadError::TooLarge => Error::BodyTooLarge {
            limit: MAX_BODY_BYTES,
        },
    })
}

enum ReadError {
    Io(std::io::Error),
    TooLarge,
}

fn read_bounded(reader: impl Read, limit: u64) -> Result<String, ReadError> {
    let mut text = String::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_string(&mut text)
        .map_err(ReadError::Io)?;
    if u64::try_from(text.len()).map_or(true, |len| len > limit) {
        return Err(ReadError::TooLarge);
    }
    Ok(text)
}

/// `owner/name` of the current checkout's GitHub `origin`, if there is one.
fn detect_repo() -> Option<String> {
    let output = Process::new("git")
        .args(["remote", "get-url", "origin"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    github_repo_from_remote(&String::from_utf8_lossy(&output.stdout))
}

#[derive(Serialize)]
struct Listing<'a> {
    asks: &'a [Ask],
}

/// One line of `roger list --brief`: what an agent needs to pick an Ask.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief<'a> {
    pub id: &'a str,
    pub decision_key: &'a str,
    pub title: &'a str,
    pub repo: Option<&'a str>,
    pub links: Vec<&'a str>,
    pub state: AskState,
    pub decision: Option<Decision>,
    pub option_id: Option<&'a str>,
    pub input: Option<&'a str>,
    pub progress: Option<TraceEvent>,
}

impl<'a> Brief<'a> {
    /// The latest trace event stands for the requester's progress.
    pub fn of(ask: &'a Ask) -> Self {
        let answer = ask.answer.as_ref();
        Self {
            id: &ask.id,
            decision_key: &ask.decision_key,
            title: &ask.title,
            repo: ask.repo.as_deref(),
            links: ask.links.iter().map(|l| l.url.as_str()).collect(),
            state: ask.state,
            decision: answer.map(|a| a.decision),
            option_id: answer.map(|a| a.option_id.as_str()),
            input: answer.and_then(|a| a.input.as_deref()),
            progress: ask.trace.last().map(|t| t.event),
        }
    }
}

fn print_brief(asks: &[Ask]) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    for ask in asks {
        serde_json::to_writer(&mut stdout, &Brief::of(ask))?;
        stdout.write_all(b"\n").map_err(Error::Output)?;
    }
    Ok(())
}

fn print_json(value: &impl Serialize) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, value)?;
    writeln!(stdout).map_err(Error::Output)
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    use roger_protocol::{Risk, Urgency};

    use super::*;

    /// The copies under `skills/` at the repository root, read by skill
    /// installers, must match what the binary prints.
    #[test]
    fn repository_skills_match_the_embedded_ones() -> std::io::Result<()> {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../skills");
        for (name, text) in SKILLS {
            let folder = if *name == "roger" {
                "roger".to_owned()
            } else {
                format!("roger-{name}")
            };
            let copy = std::fs::read_to_string(format!("{root}/{folder}/SKILL.md"))?;
            assert!(
                copy == *text,
                "skills/{folder}/SKILL.md differs from crates/roger-cli/skills/{folder}/SKILL.md"
            );
        }
        Ok(())
    }

    #[test]
    fn brief_lines_carry_the_answer_and_the_latest_trace_event()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut answered = crate::test_support::ask(AskState::Answered, Some(Decision::Other));
        answered.links = vec![roger_protocol::Link {
            label: "Issue".to_owned(),
            url: "https://github.com/origin89hq/km43/issues/92".to_owned(),
        }];
        answered.trace = vec![roger_protocol::TraceEntry {
            id: "t1".to_owned(),
            event: TraceEvent::Delivered,
            refs: std::collections::BTreeMap::new(),
            url: None,
            note: None,
            at: 3,
        }];
        let line = serde_json::to_value(Brief::of(&answered))?;
        assert_eq!(
            line,
            serde_json::json!({
                "id": answered.id, "decisionKey": answered.decision_key, "title": "Merge",
                "repo": "origin89hq/roger", "links": ["https://github.com/origin89hq/km43/issues/92"],
                "state": "answered", "decision": "other", "optionId": "x", "input": null,
                "progress": "delivered"
            })
        );

        let open = crate::test_support::ask(AskState::Open, None);
        let line = serde_json::to_value(Brief::of(&open))?;
        assert_eq!(line["decision"], serde_json::Value::Null);
        assert_eq!(line["progress"], serde_json::Value::Null);
        assert_eq!(line["links"], serde_json::json!([]));
        Ok(())
    }

    #[test]
    fn unknown_skill_names_the_known_ones() {
        let err = print_skill(Some("opencode")).err().map(|e| e.to_string());
        assert_eq!(
            err.as_deref(),
            Some("unknown skill `opencode`; known skills: roger, orca")
        );
    }
    use crate::cli::{Cli, Command};
    use crate::test_support::ask;

    fn ask_args(extra: &[&str]) -> AskArgs {
        let mut command_line = vec![
            "roger",
            "ask",
            "--kind",
            "approval",
            "--urgency",
            "later",
            "--risk",
            "routine",
            "--title",
            "Merge",
            "--decision-key",
            "merge:o/r#25",
            "--idem",
            "i1",
        ];
        command_line.extend_from_slice(extra);
        match Cli::try_parse_from(command_line).map(|cli| cli.command) {
            Ok(Command::Api(ApiCommand::Ask(args))) => *args,
            other => panic!("unexpected {other:?}"),
        }
    }

    const REV: &str = "99052e8d50ab39ba6e38d1fc68e3442afcfd5892";

    #[test]
    fn full_approval_ask_maps_every_flag() -> Result<()> {
        let args = ask_args(&[
            "--to",
            "lemarier",
            "--action-verb",
            "merge",
            "--action-target",
            "pr:o/r#25",
            "--action-rev",
            REV,
            "--action-limits",
            "squash merge into main",
            "--link",
            "PR=https://github.com/o/r/pull/25",
            "--option",
            "approve:approve:Merge",
            "--option",
            "reject:reject:Leave",
            "--option",
            "fix:other:Fix (describe)",
            "--input-required",
            "fix",
            "--supersedes",
            "01K6A0000000000000000000AA",
            "--expires-in",
            "90s",
            "--resume-branch",
            "feat/x",
        ]);
        let request = build_create_ask(&args, Some("body".to_owned()), Some("o/r".to_owned()))?;
        assert_eq!(request.kind, Kind::Approval);
        assert_eq!(request.urgency, Urgency::Later);
        assert_eq!(request.risk, Risk::Routine);
        assert_eq!(request.to.as_deref(), Some("lemarier"));
        assert_eq!(request.repo.as_deref(), Some("o/r"));
        assert_eq!(request.body.as_deref(), Some("body"));
        assert_eq!(
            request.action,
            Some(Action {
                verb: "merge".to_owned(),
                target: "pr:o/r#25".to_owned(),
                rev: REV.to_owned(),
                limits: Some("squash merge into main".to_owned()),
            })
        );
        let flags: Vec<_> = request
            .options
            .iter()
            .map(|o| (o.id.as_str(), o.decision, o.input_required))
            .collect();
        assert_eq!(
            flags,
            [
                ("approve", Decision::Approve, false),
                ("reject", Decision::Reject, false),
                ("fix", Decision::Other, true)
            ]
        );
        assert_eq!(request.links.len(), 1);
        assert_eq!(
            request.supersedes.as_deref(),
            Some("01K6A0000000000000000000AA")
        );
        assert_eq!(request.expires_in_minutes, Some(2));
        assert_eq!(
            request.resume,
            Some(Resume {
                branch: Some("feat/x".to_owned()),
                ..Resume::default()
            })
        );
        Ok(())
    }

    #[test]
    fn fyi_without_options_gets_an_acknowledge_option() -> Result<()> {
        let mut args = ask_args(&[]);
        args.kind = Kind::Fyi;
        let request = build_create_ask(&args, None, None)?;
        assert_eq!(
            request.options,
            [AskOption {
                id: "ack".to_owned(),
                label: "Acknowledge".to_owned(),
                decision: Decision::Other,
                input_required: false,
            }]
        );
        assert_eq!(request.action, None);
        assert_eq!(request.resume, None);
        assert_eq!(request.expires_in_minutes, None);

        let mut args = ask_args(&["--option", "seen:other:Seen"]);
        args.kind = Kind::Fyi;
        let ids: Vec<_> = build_create_ask(&args, None, None)?
            .options
            .into_iter()
            .map(|o| o.id)
            .collect();
        assert_eq!(ids, ["seen"]);

        let request = build_create_ask(&ask_args(&[]), None, None)?;
        assert!(request.options.is_empty(), "only fyi gets a default");
        Ok(())
    }

    #[test]
    fn partial_action_is_rejected() {
        for extra in [
            &["--action-verb", "merge"][..],
            &["--action-verb", "merge", "--action-target", "pr:o/r#1"][..],
            &["--action-limits", "squash"][..],
            &["--action-target", "t", "--action-rev", REV][..],
        ] {
            assert!(
                matches!(
                    build_create_ask(&ask_args(extra), None, None),
                    Err(Error::PartialAction)
                ),
                "{extra:?}"
            );
        }
    }

    #[test]
    fn input_required_must_name_an_option() {
        let args = ask_args(&["--option", "ok:approve:OK", "--input-required", "fix"]);
        assert!(matches!(
            build_create_ask(&args, None, None),
            Err(Error::UnknownInputRequired(id)) if id == "fix"
        ));
    }

    #[test]
    fn exit_codes_match_the_rfc_table() {
        let codes: Vec<_> = [
            Outcome::Approved,
            Outcome::Rejected,
            Outcome::Other,
            Outcome::Expired,
            Outcome::Closed,
            Outcome::Open,
        ]
        .into_iter()
        .map(exit_code)
        .collect();
        assert_eq!(codes, [0, 10, 11, 20, 21, 22]);
    }

    #[test]
    fn pages_are_combined_until_next_is_null() -> Result<()> {
        let mut seen = Vec::new();
        let asks = collect_pages(|after| {
            seen.push(after.map(str::to_owned));
            let next = match after {
                None => Some("p2".to_owned()),
                Some(_) => None,
            };
            Ok(AskList {
                asks: vec![ask(AskState::Answered, Some(Decision::Approve))],
                next,
            })
        })?;
        assert_eq!(asks.len(), 2);
        assert_eq!(seen, [None, Some("p2".to_owned())]);
        Ok(())
    }

    #[test]
    fn empty_listing_and_errors_and_endless_cursors() {
        let empty = collect_pages(|_| {
            Ok(AskList {
                asks: Vec::new(),
                next: None,
            })
        });
        assert!(matches!(empty.as_deref(), Ok([])));

        let failed = collect_pages(|_| Err(Error::Status(500)));
        assert!(matches!(failed, Err(Error::Status(500))));

        let mut calls = 0_usize;
        let endless = collect_pages(|_| {
            calls += 1;
            Ok(AskList {
                asks: Vec::new(),
                next: Some("same".to_owned()),
            })
        });
        assert!(matches!(endless, Err(Error::TooManyPages(MAX_PAGES))));
        assert_eq!(calls, MAX_PAGES);
    }

    #[test]
    fn bounded_read_accepts_the_limit_and_rejects_more() {
        assert!(matches!(
            read_bounded(&b"abcd"[..], 4).as_deref(),
            Ok("abcd")
        ));
        assert!(matches!(read_bounded(&b""[..], 4).as_deref(), Ok("")));
        assert!(matches!(
            read_bounded(&b"abcde"[..], 4),
            Err(ReadError::TooLarge)
        ));
        assert!(matches!(
            read_bounded(&[0xff_u8][..], 4),
            Err(ReadError::Io(_))
        ));
    }

    #[test]
    fn missing_body_file_is_an_error() {
        let got = read_body(Path::new("/nonexistent/roger-body.md"));
        assert!(matches!(got, Err(Error::BodyFile { .. })));
    }
}
