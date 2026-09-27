//! `roger`: agents ask a person for a decision and read the answer back.

mod cli;
mod client;
mod commands;
mod credentials;
mod error;
mod login;
mod parse;
mod wait;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

use crate::cli::{Cli, Command};
use crate::client::{Auth, Client, DEFAULT_URL, resolve_auth};
use crate::credentials::config_file;
use crate::error::{Error, Result};
use crate::parse::RequesterName;

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
    let base = std::env::var("ROGER_URL")
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_owned());
    let command = match cli.command {
        // Needs no token, so an agent can read it before setup.
        Command::Skill { name } => return commands::print_skill(name.as_deref()),
        Command::Login { machine } => {
            let path = config_file("credentials").ok_or(Error::NoConfigDir)?;
            return commands::login(&base, &path, machine);
        }
        Command::Logout => {
            let path = config_file("credentials").ok_or(Error::NoConfigDir)?;
            return commands::logout(&path);
        }
        Command::Api(command) => command,
    };
    let requester = match cli.requester {
        Some(name) => Some(name),
        None => std::env::var("ROGER_REQUESTER")
            .ok()
            .filter(|name| !name.trim().is_empty())
            .map(|name| name.trim().parse::<RequesterName>())
            .transpose()?,
    };
    let token = std::env::var("ROGER_TOKEN").ok();
    let token_file = std::env::var_os("ROGER_TOKEN_FILE").map(PathBuf::from);
    let credentials_file = config_file("credentials");
    let auth = resolve_auth(
        token.as_deref(),
        token_file.as_deref(),
        || match &credentials_file {
            Some(path) => credentials::load(path),
            None => Ok(None),
        },
        config_file("token").as_deref(),
    )?;
    let client = match auth {
        Auth::Token(token) => {
            if requester.is_some() {
                return Err(Error::AsNeedsLogin);
            }
            Client::new(&base, &token, None)
        }
        Auth::Machine(saved) => {
            if saved.url != base {
                return Err(Error::CredentialsForOtherServer {
                    path: credentials_file.unwrap_or_default(),
                    saved: saved.url,
                    url: base,
                });
            }
            Client::new(&base, &saved.credential, requester.as_ref())
        }
    };
    commands::run(&client, command)
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
