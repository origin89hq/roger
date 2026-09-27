//! `roger`: agents ask a person for a decision and read the answer back.

mod cli;
mod client;
mod commands;
mod error;
mod parse;
mod wait;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

use crate::cli::Cli;
use crate::client::{Client, DEFAULT_URL, resolve_token};
use crate::error::Result;

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            // Usage errors exit 1, like every other error; help and version exit 0.
            let code = u8::from(err.use_stderr());
            // Printing can only fail if the terminal is gone.
            let _ = err.print();
            return ExitCode::from(code);
        }
    };
    match run(cli) {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            eprintln!("roger: {err}");
            ExitCode::from(1)
        }
    }
}

fn run(cli: Cli) -> Result<u8> {
    let token = std::env::var("ROGER_TOKEN").ok();
    let token_file = std::env::var_os("ROGER_TOKEN_FILE").map(PathBuf::from);
    let token = resolve_token(token.as_deref(), token_file.as_deref())?;
    let base = std::env::var("ROGER_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_owned());
    commands::run(&Client::new(base.trim(), &token), cli.command)
}

#[cfg(test)]
mod test_support {
    use roger_protocol::{Answer, Ask, AskState, Decision, Kind, Risk, Urgency};

    /// An Ask in `state`, answered with `decision` when given.
    pub fn ask(state: AskState, decision: Option<Decision>) -> Ask {
        Ask {
            id: "01K6A0000000000000000000AA".to_owned(),
            requester: "orca-merge-gate".to_owned(),
            to: "someone".to_owned(),
            repo: Some("origin89hq/roger".to_owned()),
            decision_key: "merge:origin89hq/roger#1".to_owned(),
            supersedes: None,
            superseded_by: None,
            kind: Kind::Approval,
            urgency: Urgency::Later,
            risk: Risk::Routine,
            title: "Merge".to_owned(),
            body: None,
            links: Vec::new(),
            action: None,
            options: Vec::new(),
            resume: None,
            expires_at: None,
            state,
            created_at: 1,
            closed_at: None,
            answer: decision.map(|decision| Answer {
                option_id: "x".to_owned(),
                option_label: "X".to_owned(),
                decision,
                input: None,
                action: None,
                responder: "someone".to_owned(),
                responder_id: 1,
                passkey: false,
                answered_at: 2,
            }),
            trace: Vec::new(),
        }
    }
}
