//! Command-line arguments.

use std::path::PathBuf;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use roger_protocol::{AskOption, Kind, Link, ReportedEvent, Risk, Urgency};

use crate::parse::{
    AskId, MachineName, RequesterName, parse_duration, parse_link, parse_option, parse_ref,
};

const LONG_ABOUT: &str = "\
Ask a person for a decision and read the answer back.

Log in once per machine with `roger login`; the person approves it in the
inbox. Each automation then names itself with --as, and Roger resolves it to
the requester <machine>/<name>, created on first use. Without a name, calls
act as <machine>/default. Any process that can read this machine's login can
act as any of its requesters.

Configuration comes from the environment:
  ROGER_REQUESTER    automation name, used when --as is not given
  ROGER_TOKEN        requester token; used instead of the login
  ROGER_TOKEN_FILE   file holding a requester token, used when ROGER_TOKEN is
                     unset; also used instead of the login
  ROGER_URL          API base URL (default https://roger.origin89.com)

Credentials are read in this order: ROGER_TOKEN, ROGER_TOKEN_FILE, the login
in ~/.config/roger/credentials, then a token in ~/.config/roger/token. --as
works only with a login.

`get` and `wait` print the Ask as JSON and exit with:
  0   answered with an `approve` decision
  10  answered with a `reject` decision
  11  answered with an `other` decision; read the option and input
  20  expired, with no decision
  21  withdrawn or superseded
  22  still open (`wait` timed out, or `get` on an open Ask)
  1   error (network, auth, invalid Ask, conflict, bad arguments)

Other commands exit 0 on success and 1 on error.";

#[derive(Debug, Parser)]
#[command(name = "roger", version, about = "Ask a person for a decision and read the answer back.", long_about = LONG_ABOUT)]
pub struct Cli {
    /// Automation this call acts for, such as `merge-gate`; becomes the
    /// requester `<machine>/<name>`. Needs `roger login`. Default: `default`.
    #[arg(long = "as", global = true, value_name = "NAME")]
    pub requester: Option<RequesterName>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    #[command(flatten)]
    Api(ApiCommand),
    /// Log this machine in: a person approves it in the inbox, and the
    /// credential is saved to ~/.config/roger/credentials. Replaces an
    /// earlier login of this machine.
    Login {
        /// Suggested machine name; the person can change it when approving.
        /// Default: this host's name.
        #[arg(long)]
        machine: Option<MachineName>,
    },
    /// Revoke this machine's login and delete the saved credential.
    Logout,
    /// Print an agent skill for this version: `roger` (default), or an
    /// integration such as `orca`.
    Skill {
        /// Skill name; omit for the core skill.
        name: Option<String>,
    },
}

/// Commands that call the agent API with a credential.
#[derive(Debug, Subcommand)]
pub enum ApiCommand {
    /// Create an Ask and print it. Repeating the same --idem returns the existing Ask.
    Ask(Box<AskArgs>),
    /// Print an Ask; the exit code reports its outcome.
    Get { id: AskId },
    /// Poll an Ask until it is no longer open or --timeout passes.
    Wait {
        id: AskId,
        /// How long to wait, such as 30s, 9m, or 1h30m.
        #[arg(long, default_value = "9m", value_parser = parse_duration)]
        timeout: Duration,
    },
    /// Print this requester's Asks as `{"asks": [...]}`, every page combined.
    List(ListArgs),
    /// Withdraw an open Ask.
    Withdraw { id: AskId },
    /// Record what happened after an answer.
    Trace(TraceArgs),
    /// Make a requester you created in Settings answer to `--as <name>` on
    /// this machine, keeping its Asks. Its tokens keep working.
    Adopt {
        /// The requester's name, such as `orca@studio`.
        name: RequesterName,
    },
}

#[derive(Debug, Args)]
pub struct AskArgs {
    /// approval, question, or fyi.
    #[arg(long)]
    pub kind: Kind,
    /// now, soon, later, or fyi.
    #[arg(long)]
    pub urgency: Urgency,
    /// routine, sensitive, or irreversible.
    #[arg(long)]
    pub risk: Risk,
    /// One line.
    #[arg(long)]
    pub title: String,
    /// Names the decision; at most one open Ask per decision key.
    #[arg(long)]
    pub decision_key: String,
    /// Idempotency key, unique per requester.
    #[arg(long)]
    pub idem: String,
    /// GitHub login of the person who should answer. Default: the requester's owner.
    #[arg(long)]
    pub to: Option<String>,
    /// GitHub repository as owner/name. Default: the `origin` remote of the current checkout.
    #[arg(long, conflicts_with = "no_repo")]
    pub repo: Option<String>,
    /// Do not detect the repository from `origin`.
    #[arg(long)]
    pub no_repo: bool,
    /// What an approval permits, such as `merge`.
    #[arg(long)]
    pub action_verb: Option<String>,
    /// What the action applies to, such as `pr:owner/name#25`.
    #[arg(long)]
    pub action_target: Option<String>,
    /// Full git revision the approval is bound to.
    #[arg(long)]
    pub action_rev: Option<String>,
    /// Constraints the requester commits to.
    #[arg(long)]
    pub action_limits: Option<String>,
    /// label=url; repeatable.
    #[arg(long = "link", value_parser = parse_link)]
    pub links: Vec<Link>,
    /// id:decision:label; repeatable. `fyi` Asks default to ack:other:Acknowledge.
    #[arg(long = "option", value_parser = parse_option)]
    pub options: Vec<AskOption>,
    /// Option id whose answer must include instructions; repeatable.
    #[arg(long)]
    pub input_required: Vec<String>,
    /// Markdown body.
    #[arg(long, conflicts_with = "body_file")]
    pub body: Option<String>,
    /// Read the markdown body from a file; `-` reads stdin.
    #[arg(long)]
    pub body_file: Option<PathBuf>,
    /// Open Ask with the same decision key that this one replaces.
    #[arg(long)]
    pub supersedes: Option<AskId>,
    /// Working time until the Ask expires unanswered, such as 4h.
    #[arg(long, value_parser = parse_duration)]
    pub expires_in: Option<Duration>,
    /// Orca Run id for resuming work.
    #[arg(long)]
    pub resume_run: Option<String>,
    /// Orca Task id for resuming work.
    #[arg(long)]
    pub resume_task: Option<String>,
    /// Branch the work continues on.
    #[arg(long)]
    pub resume_branch: Option<String>,
    /// Head revision when the Ask was created.
    #[arg(long)]
    pub resume_rev: Option<String>,
    /// After creating, wait like `roger wait` and print only the final Ask.
    #[arg(long)]
    pub wait: bool,
    /// Timeout for --wait.
    #[arg(long, default_value = "9m", value_parser = parse_duration, requires = "wait")]
    pub timeout: Duration,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    /// Answered Asks.
    #[arg(long, conflicts_with = "open", required_unless_present = "open")]
    pub answered: bool,
    /// Only Asks with no terminal trace event (`applied`, `failed`, `not_applicable`).
    #[arg(long, conflicts_with = "open")]
    pub unfinished: bool,
    /// Open Asks.
    #[arg(long)]
    pub open: bool,
    /// Only decision keys starting with this, such as `spec:`.
    #[arg(long)]
    pub prefix: Option<String>,
    /// Only Asks about this repository, as `owner/name`.
    #[arg(long)]
    pub repo: Option<String>,
    /// `json` prints `{"asks": [...]}` with full Asks; `brief` prints one
    /// compact JSON object per line (id, key, title, repo, links, answer,
    /// progress).
    #[arg(long, value_enum, default_value_t = ListFormat::Json)]
    pub format: ListFormat,
}

/// Output of `roger list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ListFormat {
    /// Full Asks in one JSON document.
    Json,
    /// One compact line per Ask.
    Brief,
}

#[derive(Debug, Args)]
pub struct TraceArgs {
    pub id: AskId,
    /// `dispatched`, `progress`, `applied`, `failed`, `not_applicable`, or
    /// `corrected` (fixes the evidence link of an earlier terminal event).
    pub event: ReportedEvent,
    /// `key=value`, such as `orca.run=r_81`; repeatable.
    #[arg(long = "ref", value_parser = parse_ref)]
    pub refs: Vec<(String, String)>,
    /// Evidence link. Required for applied, failed, and corrected. A comment
    /// link must be on an issue or PR this Ask links or targets.
    #[arg(long)]
    pub url: Option<String>,
    /// Short explanation. Required for failed and corrected.
    #[arg(long)]
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;

    #[test]
    fn command_definition_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn list_requires_exactly_one_state() {
        assert!(Cli::try_parse_from(["roger", "list"]).is_err());
        assert!(Cli::try_parse_from(["roger", "list", "--answered", "--open"]).is_err());
        assert!(Cli::try_parse_from(["roger", "list", "--open", "--unfinished"]).is_err());
        assert!(Cli::try_parse_from(["roger", "list", "--answered", "--unfinished"]).is_ok());
    }

    #[test]
    fn trace_parses_event_and_refs() {
        let parsed = Cli::try_parse_from([
            "roger",
            "trace",
            "abc",
            "dispatched",
            "--ref",
            "orca.run=r_81",
            "--ref",
            "branch=x",
        ]);
        match parsed.map(|cli| cli.command) {
            Ok(Command::Api(ApiCommand::Trace(args))) => {
                assert_eq!(args.event, ReportedEvent::Dispatched);
                assert_eq!(args.refs.len(), 2);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(Cli::try_parse_from(["roger", "trace", "abc", "delivered"]).is_err());
        assert!(Cli::try_parse_from(["roger", "trace", "abc", "applied", "--ref", "x"]).is_err());
    }

    #[test]
    fn timeout_needs_wait_and_a_valid_duration() {
        let base = [
            "roger",
            "ask",
            "--kind",
            "fyi",
            "--urgency",
            "fyi",
            "--risk",
            "routine",
            "--title",
            "t",
            "--decision-key",
            "d",
            "--idem",
            "i",
        ];
        assert!(Cli::try_parse_from(base).is_ok());
        assert!(Cli::try_parse_from(base.iter().chain(&["--timeout", "1m"])).is_err());
        assert!(Cli::try_parse_from(base.iter().chain(&["--wait", "--timeout", "1m"])).is_ok());
        assert!(Cli::try_parse_from(base.iter().chain(&["--wait", "--timeout", "0s"])).is_err());
        assert!(Cli::try_parse_from(base.iter().chain(&["--repo", "o/r", "--no-repo"])).is_err());
        assert!(
            Cli::try_parse_from(base.iter().chain(&["--body", "x", "--body-file", "-"])).is_err()
        );
    }

    #[test]
    fn as_is_global_and_validated() {
        let parsed = Cli::try_parse_from(["roger", "list", "--open", "--as", "merge-gate"]);
        assert_eq!(
            parsed
                .ok()
                .and_then(|cli| cli.requester)
                .map(|n| n.to_string()),
            Some("merge-gate".to_owned())
        );
        let before = Cli::try_parse_from(["roger", "--as", "merge-gate", "get", "abc"]);
        assert!(before.is_ok());
        assert!(Cli::try_parse_from(["roger", "list", "--open", "--as", "Merge/Gate"]).is_err());
        assert!(Cli::try_parse_from(["roger", "login", "--machine", "studio"]).is_ok());
        assert!(Cli::try_parse_from(["roger", "login", "--machine", "Studio!"]).is_err());
    }
}
