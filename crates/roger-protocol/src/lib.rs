//! Wire types for the Roger agent API.
//!
//! The Worker validates every request with Zod schemas whose inferred types are
//! checked against the TypeScript generated from this crate, so a change here
//! that the Worker does not follow fails `just check`. Content limits live in
//! the Worker, which is the only place they are enforced.
//!
//! Timestamps are milliseconds since the Unix epoch.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use specta::Type;

/// How integer timestamps, cursors, and GitHub ids appear in TypeScript.
///
/// They are `i64` in Rust and stay below 2^53, so a plain `number` is exact.
/// Specta renders `f64` as `number | null`, so this borrows `u32`'s rendering.
type JsNumber = u32;

/// A string that did not name a known variant of a protocol enum.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown {kind} `{value}`; expected one of: {expected}")]
pub struct UnknownVariant {
    kind: &'static str,
    value: String,
    expected: String,
}

/// Declares a string enum with matching serde names, `Display`, and `FromStr`.
macro_rules! wire_enum {
    (
        $(#[$meta:meta])*
        $name:ident, $kind:literal {
            $( $(#[$vmeta:meta])* $variant:ident = $wire:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
        pub enum $name {
            $( $(#[$vmeta])* #[serde(rename = $wire)] $variant ),+
        }

        impl $name {
            /// Every variant, in declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// The name used on the wire and on the command line.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = UnknownVariant;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(UnknownVariant {
                        kind: $kind,
                        value: s.to_owned(),
                        expected: [$($wire),+].join(", "),
                    }),
                }
            }
        }
    };
}

wire_enum! {
    /// What the requester needs from a person.
    Kind, "kind" {
        /// May the requester perform this exact action?
        Approval = "approval",
        /// The requester is stuck and needs a choice or instruction.
        Question = "question",
        /// No answer needed, only acknowledgement.
        Fyi = "fyi",
    }
}

wire_enum! {
    /// How quickly a person should see the Ask. Decides delivery.
    Urgency, "urgency" {
        /// Push immediately, even in quiet hours.
        Now = "now",
        /// Push after 30 working minutes.
        Soon = "soon",
        /// Inbox and daily digest.
        Later = "later",
        /// Inbox only.
        Fyi = "fyi",
    }
}

wire_enum! {
    /// What can go wrong if the answer is wrong. Decides presentation.
    Risk, "risk" {
        /// For example, merging a green PR in a web repository.
        Routine = "routine",
        /// Secrets, spending, authorization, or data-loss changes.
        Sensitive = "sensitive",
        /// Production data, releases, anything touching equipment.
        Irreversible = "irreversible",
    }
}

wire_enum! {
    /// Lifecycle state. Every state other than `open` is terminal.
    AskState, "state" {
        /// Waiting for a person.
        Open = "open",
        /// A person chose an option.
        Answered = "answered",
        /// Nobody answered before `expiresAt`. Carries no decision.
        Expired = "expired",
        /// The requester no longer needs an answer.
        Withdrawn = "withdrawn",
        /// The requester replaced it with a newer Ask for the same decision key.
        Superseded = "superseded",
    }
}

wire_enum! {
    /// What an option means. Scripts branch on this, never on option order.
    Decision, "decision" {
        /// Permits the Ask's action. Only `approval` Asks offer it.
        Approve = "approve",
        /// Refuses the Ask's action.
        Reject = "reject",
        /// Anything else, such as "fix" with instructions.
        Other = "other",
    }
}

wire_enum! {
    /// An entry in the record of what happened after an answer.
    TraceEvent, "trace event" {
        /// The requester first read the answer. Recorded by Roger.
        Delivered = "delivered",
        /// The requester started work because of the answer.
        Dispatched = "dispatched",
        /// A step worth showing, such as a push.
        Progress = "progress",
        /// The requester acted on the answer. Terminal.
        Applied = "applied",
        /// The requester tried and failed. Terminal.
        Failed = "failed",
        /// The answer no longer applies. Terminal.
        NotApplicable = "not_applicable",
        /// Replaces the evidence link of the terminal event, which was wrong.
        /// Only after a terminal event; the original stays in the trace.
        Corrected = "corrected",
    }
}

wire_enum! {
    /// A trace event the requester may report. `delivered` is Roger's own.
    ReportedEvent, "trace event" {
        /// The requester started work because of the answer.
        Dispatched = "dispatched",
        /// A step worth showing, such as a push.
        Progress = "progress",
        /// The requester acted on the answer. Terminal; needs a `url`.
        Applied = "applied",
        /// The requester tried and failed. Terminal; needs a `url` and a `note`.
        Failed = "failed",
        /// The answer no longer applies. Terminal.
        NotApplicable = "not_applicable",
        /// Replaces a wrong evidence link on the terminal event; needs a `url`
        /// and a `note` saying what was wrong.
        Corrected = "corrected",
    }
}

impl From<ReportedEvent> for TraceEvent {
    fn from(event: ReportedEvent) -> Self {
        match event {
            ReportedEvent::Dispatched => Self::Dispatched,
            ReportedEvent::Progress => Self::Progress,
            ReportedEvent::Applied => Self::Applied,
            ReportedEvent::Failed => Self::Failed,
            ReportedEvent::NotApplicable => Self::NotApplicable,
            ReportedEvent::Corrected => Self::Corrected,
        }
    }
}

impl TraceEvent {
    /// Whether this event ends the trace. Exactly one terminal event per Ask.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        match self {
            Self::Applied | Self::Failed | Self::NotApplicable => true,
            Self::Delivered | Self::Dispatched | Self::Progress | Self::Corrected => false,
        }
    }
}

wire_enum! {
    /// Machine-readable error category.
    ErrorCode, "error code" {
        /// The request is malformed or breaks a content rule.
        InvalidRequest = "invalid_request",
        /// Missing, unknown, or revoked credentials.
        Unauthorized = "unauthorized",
        /// The credentials cannot perform this operation.
        Forbidden = "forbidden",
        /// No such Ask, or it belongs to another requester.
        NotFound = "not_found",
        /// The Ask is no longer open, or the request conflicts with existing state.
        Conflict = "conflict",
        /// The request body exceeds the size limit.
        TooLarge = "too_large",
        /// The Worker failed.
        Internal = "internal",
    }
}

/// The exact action an approval permits. Kept after retention cleanup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// What the requester will do, such as `merge`.
    pub verb: String,
    /// What it will do it to, such as `pr:origin89hq/engineering#25`.
    pub target: String,
    /// The full revision the approval is bound to: a 40- or 64-character
    /// lowercase hex git object id.
    pub rev: String,
    /// Constraints the requester commits to, such as "squash merge into main".
    #[serde(default)]
    pub limits: Option<String>,
}

/// An answer the requester offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AskOption {
    /// Stable id, unique within the Ask.
    pub id: String,
    /// Text on the button.
    pub label: String,
    /// What choosing this option means.
    pub decision: Decision,
    /// Whether the responder must write instructions with this option.
    #[serde(default)]
    pub input_required: bool,
}

/// A labelled link shown with the Ask. Purged by retention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// Short label, such as `PR`.
    pub label: String,
    /// An `https` URL.
    pub url: String,
}

/// What a fresh worker needs to continue after the answer arrives.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    /// Orca Run id.
    #[serde(default)]
    pub run: Option<String>,
    /// Orca Task id.
    #[serde(default)]
    pub task: Option<String>,
    /// Branch the work continues on.
    #[serde(default)]
    pub branch: Option<String>,
    /// Head revision when the Ask was created.
    #[serde(default)]
    pub rev: Option<String>,
}

/// Body of `POST /v1/asks`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateAsk {
    /// Unique per requester. Repeating a create with the same key and content
    /// returns the existing Ask; different content is a conflict.
    pub idem_key: String,
    /// Names the decision. At most one open Ask per requester and decision key.
    pub decision_key: String,
    /// GitHub login of the person who should answer. They must have signed in
    /// to Roger once. Absent means the person who created the requester.
    #[serde(default)]
    pub to: Option<String>,
    /// GitHub repository the Ask concerns, as `owner/name`. The CLI fills it
    /// from the checkout's `origin` remote when not given.
    #[serde(default)]
    pub repo: Option<String>,
    /// The open Ask, with the same decision key, that this one replaces.
    #[serde(default)]
    pub supersedes: Option<String>,
    /// What the requester needs.
    pub kind: Kind,
    /// How quickly a person should see it.
    pub urgency: Urgency,
    /// What a wrong answer can cost.
    pub risk: Risk,
    /// One line.
    pub title: String,
    /// Markdown.
    #[serde(default)]
    pub body: Option<String>,
    /// Links shown with the Ask.
    #[serde(default)]
    pub links: Vec<Link>,
    /// Required for `approval`.
    #[serde(default)]
    pub action: Option<Action>,
    /// The answers offered.
    pub options: Vec<AskOption>,
    /// Context for resuming work after the answer.
    #[serde(default)]
    pub resume: Option<Resume>,
    /// Working minutes until the Ask expires unanswered. Absent means never.
    #[serde(default)]
    pub expires_in_minutes: Option<u32>,
}

/// A person's answer. Immutable once recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// The chosen option's id, or `_custom` when the responder wrote their own
    /// reply in `input` instead of choosing an option.
    pub option_id: String,
    /// The chosen option's label at answer time.
    pub option_label: String,
    /// What the answer means.
    pub decision: Decision,
    /// Free-text instructions from the responder.
    pub input: Option<String>,
    /// The action the answer applies to, copied from the Ask.
    pub action: Option<Action>,
    /// GitHub login of the responder at answer time.
    pub responder: String,
    /// Numeric GitHub user id of the responder.
    #[specta(type = JsNumber)]
    pub responder_id: i64,
    /// Whether a passkey assertion was verified for this answer.
    pub passkey: bool,
    /// When the answer was recorded.
    #[specta(type = JsNumber)]
    pub answered_at: i64,
}

/// One entry in an Ask's trace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceEntry {
    /// Sortable id; trace order.
    pub id: String,
    /// What happened.
    pub event: TraceEvent,
    /// Requester-supplied references, such as `orca.run` or `branch`.
    pub refs: BTreeMap<String, String>,
    /// Evidence link.
    pub url: Option<String>,
    /// Short explanation.
    pub note: Option<String>,
    /// When Roger recorded it.
    #[specta(type = JsNumber)]
    pub at: i64,
}

/// Body of `POST /v1/asks/{id}/trace`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppendTrace {
    /// What happened.
    pub event: ReportedEvent,
    /// References such as `orca.run=r_81`. Stored and linked, never contacted.
    #[serde(default)]
    pub refs: BTreeMap<String, String>,
    /// Evidence link. Required for `applied` and `failed`.
    #[serde(default)]
    pub url: Option<String>,
    /// Short explanation. Required for `failed`.
    #[serde(default)]
    pub note: Option<String>,
}

/// An Ask as the API returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    /// ULID.
    pub id: String,
    /// Name of the requester that created it.
    pub requester: String,
    /// GitHub login of the only person who can answer it.
    pub to: String,
    /// GitHub repository the Ask concerns, as `owner/name`. Kept after retention.
    pub repo: Option<String>,
    /// The decision it asks about.
    pub decision_key: String,
    /// The Ask this one replaced.
    pub supersedes: Option<String>,
    /// The Ask that replaced this one.
    pub superseded_by: Option<String>,
    /// What the requester needs.
    pub kind: Kind,
    /// How quickly a person should see it.
    pub urgency: Urgency,
    /// What a wrong answer can cost.
    pub risk: Risk,
    /// One line.
    pub title: String,
    /// Markdown. `null` after retention cleanup.
    pub body: Option<String>,
    /// Empty after retention cleanup.
    pub links: Vec<Link>,
    /// The exact action an approval permits.
    pub action: Option<Action>,
    /// The answers offered.
    pub options: Vec<AskOption>,
    /// Context for resuming work.
    pub resume: Option<Resume>,
    /// When it expires unanswered.
    #[specta(type = Option<JsNumber>)]
    pub expires_at: Option<i64>,
    /// Lifecycle state.
    pub state: AskState,
    /// When it was created.
    #[specta(type = JsNumber)]
    pub created_at: i64,
    /// When it left `open`.
    #[specta(type = Option<JsNumber>)]
    pub closed_at: Option<i64>,
    /// Present once answered.
    pub answer: Option<Answer>,
    /// What happened after the answer, oldest first.
    pub trace: Vec<TraceEntry>,
}

/// What a script should do with an Ask, derived from its state and decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Still waiting for a person.
    Open,
    /// Answered with an `approve` decision.
    Approved,
    /// Answered with a `reject` decision.
    Rejected,
    /// Answered with an `other` decision; read the option and input.
    Other,
    /// Nobody answered in time. There is no decision.
    Expired,
    /// Withdrawn or superseded by the requester.
    Closed,
}

impl Ask {
    /// The outcome of this Ask.
    ///
    /// An `answered` Ask without an answer, which the Worker never returns, is
    /// reported as [`Outcome::Open`] so no script treats it as a decision.
    #[must_use]
    pub fn outcome(&self) -> Outcome {
        match self.state {
            AskState::Open => Outcome::Open,
            AskState::Answered => match self.answer.as_ref().map(|answer| answer.decision) {
                Some(Decision::Approve) => Outcome::Approved,
                Some(Decision::Reject) => Outcome::Rejected,
                Some(Decision::Other) => Outcome::Other,
                None => Outcome::Open,
            },
            AskState::Expired => Outcome::Expired,
            AskState::Withdrawn | AskState::Superseded => Outcome::Closed,
        }
    }
}

/// Response of `GET /v1/asks`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AskList {
    /// Oldest first.
    pub asks: Vec<Ask>,
    /// Pass as `after` to read the next page; `null` on the last page.
    pub next: Option<String>,
}

/// A transition of one of the requester's Asks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StateChange {
    /// Position in the requester's event stream.
    #[specta(type = JsNumber)]
    pub cursor: i64,
    /// The Ask that changed.
    pub ask_id: String,
    /// Its decision key.
    pub decision_key: String,
    /// The state it entered.
    pub state: AskState,
    /// When it changed.
    #[specta(type = JsNumber)]
    pub at: i64,
}

/// Response of `GET /v1/events`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventList {
    /// Oldest first.
    pub events: Vec<StateChange>,
    /// Pass as `after` to continue; equals the request's `after` when empty.
    #[specta(type = JsNumber)]
    pub next: i64,
}

/// Details of a failed request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    /// Category.
    pub code: ErrorCode,
    /// Human-readable explanation.
    pub message: String,
    /// The Ask's current state, on conflicts about an Ask.
    pub state: Option<AskState>,
}

/// Body of every error response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    /// What went wrong.
    pub error: ErrorDetail,
}

/// The `client_id` the CLI sends to the device authorization endpoints.
pub const DEVICE_CLIENT_ID: &str = "roger-cli";

/// The `grant_type` of a device access token request (RFC 8628, section 3.4).
pub const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// The header naming the automation a machine credential acts for. Absent
/// means `default`; the Worker resolves it to the requester `<machine>/<name>`.
pub const REQUESTER_HEADER: &str = "roger-requester";

/// Response of `POST /v1/device/code` (RFC 8628, section 3.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeviceAuthorization {
    /// Secret the CLI polls with. Never shown to the person.
    pub device_code: String,
    /// Code the person confirms in the inbox, such as `BCDF-GHJK`.
    pub user_code: String,
    /// Where the person enters the code.
    pub verification_uri: String,
    /// `verification_uri` with the code filled in.
    pub verification_uri_complete: String,
    /// Seconds until both codes expire.
    pub expires_in: u32,
    /// Seconds the CLI waits between polls.
    pub interval: u32,
}

/// Successful response of `POST /v1/device/token` (RFC 8628, section 3.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MachineToken {
    /// The machine credential. Shown once; the Worker stores only its hash.
    pub access_token: String,
    /// Always `Bearer`.
    pub token_type: String,
    /// The machine name the person chose when approving.
    pub machine: String,
    /// GitHub login of the person who approved, who owns the machine.
    pub owner: String,
}

wire_enum! {
    /// Error of the device token endpoint (RFC 8628, section 3.5, and RFC 6749).
    DeviceError, "device error" {
        /// The person has not approved or denied yet. Poll again.
        AuthorizationPending = "authorization_pending",
        /// Polled too fast. Add 5 seconds to the interval and poll again.
        SlowDown = "slow_down",
        /// The person denied the request.
        AccessDenied = "access_denied",
        /// The device code expired. Start over.
        ExpiredToken = "expired_token",
        /// Unknown or already used device code.
        InvalidGrant = "invalid_grant",
        /// A parameter is missing or malformed.
        InvalidRequest = "invalid_request",
        /// The client is not the Roger CLI.
        InvalidClient = "invalid_client",
        /// The grant type is not the device code grant.
        UnsupportedGrantType = "unsupported_grant_type",
    }
}

/// Error body of the device endpoints, in the OAuth form (RFC 6749, section 5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeviceErrorBody {
    /// What went wrong.
    pub error: DeviceError,
    /// Human-readable explanation.
    pub error_description: String,
}

/// Renders the TypeScript types the Worker imports.
///
/// # Errors
///
/// Returns the exporter's error if a type cannot be represented in TypeScript.
#[cfg(test)]
fn typescript() -> Result<String, specta_typescript::Error> {
    let types = specta::Types::default()
        .register::<CreateAsk>()
        .register::<AppendTrace>()
        .register::<Ask>()
        .register::<AskList>()
        .register::<EventList>()
        .register::<ErrorBody>()
        .register::<DeviceAuthorization>()
        .register::<MachineToken>()
        .register::<DeviceErrorBody>();
    specta_typescript::Typescript::default().export(&types, specta_serde::Format)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BINDINGS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/worker/src/protocol.gen.ts"
    );

    /// Fails when the checked-in TypeScript differs from these types.
    /// `ROGER_WRITE_BINDINGS=1` rewrites the file instead.
    #[test]
    fn typescript_bindings_are_current() -> Result<(), Box<dyn std::error::Error>> {
        let rendered = typescript()?;
        if std::env::var_os("ROGER_WRITE_BINDINGS").is_some() {
            std::fs::write(BINDINGS, &rendered)?;
            return Ok(());
        }
        let checked_in = std::fs::read_to_string(BINDINGS).unwrap_or_default();
        assert!(
            checked_in == rendered,
            "apps/worker/src/protocol.gen.ts is stale; run `just protocol`"
        );
        Ok(())
    }

    #[test]
    fn enums_use_the_same_names_on_the_wire_and_in_display() -> Result<(), serde_json::Error> {
        for state in AskState::ALL {
            assert_eq!(serde_json::to_string(state)?, format!("\"{state}\""));
            assert_eq!(state.as_str().parse::<AskState>().ok(), Some(*state));
        }
        for event in TraceEvent::ALL {
            assert_eq!(serde_json::to_string(event)?, format!("\"{event}\""));
        }
        for event in ReportedEvent::ALL {
            assert_eq!(serde_json::to_string(event)?, format!("\"{event}\""));
            assert_eq!(TraceEvent::from(*event).as_str(), event.as_str());
        }
        for code in ErrorCode::ALL {
            assert_eq!(serde_json::to_string(code)?, format!("\"{code}\""));
        }
        for error in DeviceError::ALL {
            assert_eq!(serde_json::to_string(error)?, format!("\"{error}\""));
        }
        Ok(())
    }

    #[test]
    fn unknown_names_are_rejected_with_the_choices() {
        let err = "maybe".parse::<Decision>().err();
        assert_eq!(
            err.map(|e| e.to_string()),
            Some("unknown decision `maybe`; expected one of: approve, reject, other".to_owned())
        );
        assert!("Approve".parse::<Decision>().is_err());
        assert!("".parse::<Kind>().is_err());
    }

    #[test]
    fn only_applied_failed_and_not_applicable_are_terminal() {
        let terminal: Vec<_> = TraceEvent::ALL
            .iter()
            .filter(|event| event.is_terminal())
            .collect();
        assert_eq!(
            terminal,
            [
                &TraceEvent::Applied,
                &TraceEvent::Failed,
                &TraceEvent::NotApplicable
            ]
        );
    }

    fn ask(state: AskState, decision: Option<Decision>) -> Ask {
        Ask {
            id: "01K6A0000000000000000000AA".to_owned(),
            requester: "orca-merge-gate@test".to_owned(),
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

    #[test]
    fn outcome_follows_the_decision_not_the_option() {
        assert_eq!(
            ask(AskState::Answered, Some(Decision::Approve)).outcome(),
            Outcome::Approved
        );
        assert_eq!(
            ask(AskState::Answered, Some(Decision::Reject)).outcome(),
            Outcome::Rejected
        );
        assert_eq!(
            ask(AskState::Answered, Some(Decision::Other)).outcome(),
            Outcome::Other
        );
    }

    #[test]
    fn closed_asks_without_an_answer_never_report_a_decision() {
        assert_eq!(ask(AskState::Open, None).outcome(), Outcome::Open);
        assert_eq!(ask(AskState::Expired, None).outcome(), Outcome::Expired);
        assert_eq!(ask(AskState::Withdrawn, None).outcome(), Outcome::Closed);
        assert_eq!(ask(AskState::Superseded, None).outcome(), Outcome::Closed);
        assert_eq!(ask(AskState::Answered, None).outcome(), Outcome::Open);
    }

    #[test]
    fn create_ask_accepts_missing_optional_fields() -> Result<(), serde_json::Error> {
        let parsed: CreateAsk = serde_json::from_str(
            r#"{"idemKey":"k","decisionKey":"d","kind":"fyi","urgency":"fyi","risk":"routine",
                "title":"t","options":[{"id":"ack","label":"OK","decision":"other"}]}"#,
        )?;
        assert!(parsed.links.is_empty());
        assert_eq!(parsed.body, None);
        assert_eq!(
            parsed.options.first().map(|o| o.input_required),
            Some(false)
        );
        Ok(())
    }
}
