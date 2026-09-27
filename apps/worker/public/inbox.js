// @ts-check
// The Roger inbox. Plain DOM, no build step; every string from the API is
// inserted as text, never as HTML.

import { deviceApproval, formatCode } from "./device.js";

/** @typedef {import("../src/protocol.gen.ts").Ask} Ask */
/** @typedef {import("../src/protocol.gen.ts").AskOption} AskOption */
/** @typedef {{ ask: Ask, reason: "not_delivered" | "not_finished" }} Stalled */
/** @typedef {{ login: string, githubId: number, ntfyTopic: string | null, pushes: boolean, passkeys: { id: string, createdAt: number, lastUsedAt: number | null }[] }} Me */
/** @typedef {{ id: string, name: string, pickupMinutes: number, completionMinutes: number, createdBy: string | null, createdAt: number, disabledAt: number | null, machine: string | null, tokens: { id: string, createdAt: number, revokedAt: number | null }[] }} RequesterView */
/** @typedef {{ id: string, name: string, createdAt: number, requesters: { id: string, name: string, disabledAt: number | null }[] }} MachineView */
/** @typedef {{ suggested: string | null, source: string | null, userAgent: string | null, createdAt: number, expiresAt: number }} PendingLogin */
/** @typedef {"inbox" | "history" | "settings" | "device"} View */

const state = {
  /** @type {Me | null} */ me: null,
  /** @type {Ask[]} */ open: [],
  /** @type {number} */ openTotal: 0,
  /** @type {Stalled[]} */ stalled: [],
  /** @type {Ask[]} */ history: [],
  /** @type {string | null} */ historyNext: null,
  /** @type {string | null} */ selected: null,
  /** @type {View} */ view: "inbox",
  /** @type {number} */ serverNow: Date.now(),
};

class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function api(method, path, body) {
  /** @type {RequestInit} */
  const init = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(
      response.status,
      `Unexpected response (${response.status}).`,
    );
  }
  if (!response.ok) {
    if (response.status === 401) showSignedOut();
    throw new ApiError(
      response.status,
      data?.error?.message ?? `Request failed (${response.status}).`,
    );
  }
  return data;
}

/**
 * Builds an element. Children that are strings become text nodes.
 * @param {string} tag
 * @param {Record<string, string | boolean | ((e: Event) => void)>} [attrs]
 * @param {(Node | string | null | false)[]} children
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false) node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** @param {string} id */
function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

let statusTimer = 0;
/** @param {string} message @param {boolean} [error] */
function notify(message, error = false) {
  const node = $("status");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 5000);
}

// ---- Formatting ----------------------------------------------------------------

/** @param {number} ms */
function ago(ms) {
  const minutes = Math.max(0, Math.round((state.serverNow - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** @param {number | null} ms */
function when(ms) {
  return ms === null
    ? "—"
    : new Date(ms).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/** @param {number} ms */
function clock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" });
}

const URGENCY_TEXT = { now: "Now", soon: "Soon", later: "Later", fyi: "FYI" };
const RISK_TEXT = {
  routine: "Routine",
  sensitive: "Sensitive",
  irreversible: "Irreversible",
};
const STATE_TEXT = {
  open: "Waiting for you",
  answered: "Answered",
  expired: "Expired without an answer",
  withdrawn: "Withdrawn by the requester",
  superseded: "Replaced by a newer Ask",
};
const DECISION_TEXT = {
  approve: "Approved",
  reject: "Rejected",
  other: "Answered",
};

/** @param {Ask} ask */
function badges(ask) {
  return [
    el(
      "span",
      { class: `badge urgency-${ask.urgency}`, title: "Urgency" },
      URGENCY_TEXT[ask.urgency],
    ),
    ask.risk === "routine"
      ? null
      : el(
          "span",
          { class: `badge risk-${ask.risk}`, title: "Risk" },
          RISK_TEXT[ask.risk],
        ),
  ].filter((n) => n !== null);
}

/** @param {string} repo */
function repoLink(repo) {
  return el(
    "a",
    { href: `https://github.com/${repo}`, rel: "noreferrer", target: "_blank" },
    repo,
  );
}

// ---- Lists -----------------------------------------------------------------------

/**
 * Where the requester is with an answer, from its trace: the last event wins.
 * @param {Ask} ask
 * @returns {{ text: string, tone: string } | null}
 */
function progress(ask) {
  if (!ask.answer) return null;
  const events = ask.trace.map((t) => t.event);
  if (events.includes("applied")) return { text: "Done", tone: "done" };
  if (events.includes("failed")) return { text: "Failed", tone: "failed" };
  if (events.includes("not_applicable"))
    return { text: "No longer applies", tone: "quiet" };
  if (events.includes("dispatched") || events.includes("progress"))
    return { text: "Working", tone: "working" };
  if (events.includes("delivered")) return { text: "Read", tone: "working" };
  return { text: "Not read yet", tone: "waiting" };
}

/** @param {Ask} ask @param {(Node | null)[]} status */
function row(ask, ...status) {
  return el(
    "button",
    {
      class: `row urgency-${ask.urgency}`,
      role: "option",
      "aria-selected": String(state.selected === ask.id),
      "data-id": ask.id,
      onclick: () => select(ask.id),
    },
    el(
      "span",
      { class: "row-top" },
      el("span", { class: "title" }, ask.title),
      el("span", { class: "age" }, ago(ask.createdAt)),
    ),
    el(
      "span",
      { class: "meta" },
      ...badges(ask),
      ...status,
      el("span", { class: "source" }, ask.repo ?? ask.requester),
    ),
  );
}

/** @param {string} heading @param {string} hint */
function emptyList(heading, hint) {
  return el(
    "div",
    { class: "empty-list" },
    el("p", { class: "empty-heading" }, heading),
    el("p", {}, hint),
  );
}

function renderInboxList() {
  const list = $("list");
  const heading =
    state.openTotal > state.open.length
      ? `${state.open.length} of ${state.openTotal} waiting, most urgent first`
      : `${state.open.length} waiting`;
  list.replaceChildren(
    el("h2", {}, heading),
    ...(state.open.length
      ? state.open.map((a) => row(a))
      : [
          emptyList(
            "Nothing is waiting for you.",
            "Agents ask with roger ask. New Asks appear here and, if you set a topic, on your phone.",
          ),
        ]),
  );
  if (state.stalled.length) {
    list.append(
      el("h2", {}, `${state.stalled.length} answered but not finished`),
      ...state.stalled.map((s) =>
        row(
          s.ask,
          el(
            "span",
            { class: "badge stalled" },
            s.reason === "not_delivered" ? "Not picked up" : "Not finished",
          ),
        ),
      ),
    );
  }
}

function renderHistoryList() {
  const list = $("history-list");
  list.replaceChildren(
    ...(state.history.length
      ? state.history.map((a) =>
          row(
            a,
            el(
              "span",
              { class: `badge outcome-${a.answer?.decision ?? a.state}` },
              a.answer ? DECISION_TEXT[a.answer.decision] : STATE_TEXT[a.state],
            ),
            ((p) =>
              p
                ? el("span", { class: `progress progress-${p.tone}` }, p.text)
                : null)(progress(a)),
          ),
        )
      : [
          emptyList(
            "No closed Asks yet.",
            "Asks you answer, and ones that expire or are withdrawn, are kept here.",
          ),
        ]),
  );
  if (state.historyNext)
    list.append(
      el(
        "button",
        { class: "quiet more", onclick: () => loadHistory(true) },
        "Load older",
      ),
    );
}

/** Every Ask currently listed in the active view. */
function listed() {
  return state.view === "history"
    ? state.history
    : [...state.open, ...state.stalled.map((s) => s.ask)];
}

// ---- Detail ----------------------------------------------------------------------

function detailPane() {
  return state.view === "history" ? $("history-detail") : $("detail");
}

function renderEmptyDetail() {
  const pane = detailPane();
  pane.replaceChildren(
    el(
      "div",
      { class: "detail-empty" },
      el(
        "p",
        {},
        state.view === "history"
          ? "Pick a closed Ask to see its decision and what happened next."
          : "Pick an Ask to answer it. Press j and k to move, ? for shortcuts.",
      ),
    ),
  );
}

/**
 * Answered, read, and finished times for the Details list.
 * @param {Ask} ask
 * @returns {HTMLElement[]}
 */
function lifecycle(ask) {
  if (!ask.answer) return [];
  const at = (/** @type {string[]} */ events) =>
    ask.trace.find((t) => events.includes(t.event))?.at ?? null;
  const read = at(["delivered"]);
  const finished = at(["applied", "failed", "not_applicable"]);
  return [
    el("dt", {}, "Answered"),
    el("dd", {}, when(ask.answer.answeredAt)),
    el("dt", {}, `Read by ${ask.requester}`),
    el("dd", {}, read === null ? "Not yet" : when(read)),
    el("dt", {}, "Finished"),
    el("dd", {}, finished === null ? "Not yet" : when(finished)),
  ];
}

/** @param {Ask} ask */
function renderDetail(ask) {
  const facts = el(
    "dl",
    { class: "facts" },
    el("dt", {}, "From"),
    el("dd", {}, ask.requester),
    el("dt", {}, "To"),
    el("dd", {}, `@${ask.to}`),
    ...(ask.repo
      ? [el("dt", {}, "Repository"), el("dd", {}, repoLink(ask.repo))]
      : []),
    el("dt", {}, "Decision key"),
    el("dd", { class: "mono" }, ask.decisionKey),
    el("dt", {}, "Asked"),
    el("dd", {}, when(ask.createdAt)),
    ...(ask.expiresAt
      ? [el("dt", {}, "Expires"), el("dd", {}, when(ask.expiresAt))]
      : []),
    ...lifecycle(ask),
  );
  const action = ask.action
    ? el(
        "section",
        { class: "action" },
        el(
          "p",
          { class: "action-lead" },
          ask.kind === "approval"
            ? "Approving permits exactly this:"
            : "The requester intends to:",
        ),
        el(
          "p",
          { class: "action-line" },
          el("span", { class: "verb" }, ask.action.verb),
          " ",
          el("span", { class: "mono" }, ask.action.target),
        ),
        el(
          "p",
          { class: "rev" },
          "at ",
          el("span", { class: "mono" }, ask.action.rev),
        ),
        ask.action.limits
          ? el("p", { class: "limits" }, ask.action.limits)
          : null,
      )
    : null;
  const parts = [
    el(
      "button",
      {
        class: "quiet back",
        onclick: (e) => {
          const target = /** @type {HTMLElement} */ (e.currentTarget);
          target.closest(".split")?.classList.remove("showing");
        },
      },
      "← All Asks",
    ),
    el(
      "header",
      { class: "detail-head" },
      el("div", { class: "badges" }, ...badges(ask)),
      el("h1", {}, ask.title),
      el(
        "p",
        { class: "byline" },
        `${ask.requester} asked ${ago(ask.createdAt)}`,
        ask.repo ? " in " : "",
        ask.repo ? repoLink(ask.repo) : "",
      ),
    ),
    ask.state === "open" ? null : decided(ask),
    action,
    ask.body ? el("div", { class: "body" }, ask.body) : null,
    ask.links.length
      ? el(
          "ul",
          { class: "links" },
          ...ask.links.map((l) =>
            el(
              "li",
              {},
              el(
                "a",
                { href: l.url, rel: "noreferrer", target: "_blank" },
                l.label,
              ),
            ),
          ),
        )
      : null,
    ask.state === "open" ? answerForm(ask) : null,
    el("details", { class: "more-facts" }, el("summary", {}, "Details"), facts),
  ];
  const pane = detailPane();
  pane.replaceChildren(...parts.filter((p) => p !== null));
  pane.closest(".split")?.classList.add("showing");
}

/**
 * The answer every Ask accepts: the responder's own message instead of an
 * option. The Worker records it as an `other` decision, never an approval.
 * @type {AskOption}
 */
const CUSTOM_REPLY = {
  id: "_custom",
  label: "Custom reply",
  decision: "other",
  inputRequired: true,
};

/** @param {Ask} ask */
function answerForm(ask) {
  const needsInput = ask.options.some((o) => o.inputRequired);
  const input = /** @type {HTMLTextAreaElement} */ (
    el("textarea", {
      id: "answer-input",
      "aria-label": "Instructions",
      placeholder: needsInput
        ? "Instructions, required for the options marked with …"
        : "Instructions for the requester (optional)",
      maxlength: "4000",
      rows: "3",
    })
  );
  let key = 0;
  const buttons = ask.options.map((option) => {
    const approve = option.decision === "approve";
    const shortcut = approve ? null : String(++key);
    return el(
      "button",
      {
        class: `option decision-${option.decision}`,
        "data-option": option.id,
        "data-key": shortcut ?? "",
        onclick: (e) => {
          const target = /** @type {HTMLButtonElement} */ (e.currentTarget);
          void submitAnswer(ask, option, input.value, target);
        },
      },
      shortcut ? el("kbd", {}, shortcut) : null,
      option.label,
      option.inputRequired ? " …" : "",
    );
  });
  buttons.push(
    el(
      "button",
      {
        class: "option custom-reply",
        "data-key": "r",
        title: "Answer with only the message above; never an approval",
        onclick: (e) => {
          const target = /** @type {HTMLButtonElement} */ (e.currentTarget);
          void submitAnswer(ask, CUSTOM_REPLY, input.value, target);
        },
      },
      el("kbd", {}, "r"),
      "Send my message instead",
    ),
  );
  const hasApprove = ask.options.some((o) => o.decision === "approve");
  return el(
    "section",
    { class: "answer-form" },
    el("h2", {}, "Your answer"),
    input,
    el("div", { class: "options" }, ...buttons),
    hasApprove
      ? el(
          "p",
          { class: "hint" },
          "Approving asks for your passkey. Other answers do not.",
        )
      : null,
  );
}

/** @param {Ask} ask @param {import("../src/protocol.gen.ts").TraceEntry} t */
function traceText(ask, t) {
  switch (t.event) {
    case "delivered":
      return `${ask.requester} read the answer`;
    case "dispatched":
      return "Work started";
    case "progress":
      return "Progress";
    case "applied":
      return "Done";
    case "failed":
      return "Failed";
    case "not_applicable":
      return "No longer applies";
    case "corrected":
      return "Link corrected";
    default:
      return t.event;
  }
}

/** @param {Ask} ask */
function decided(ask) {
  const a = ask.answer;
  if (!a)
    return el(
      "section",
      { class: `verdict verdict-${ask.state}` },
      el("p", { class: "verdict-label" }, STATE_TEXT[ask.state]),
      ask.closedAt
        ? el("p", { class: "verdict-by" }, when(ask.closedAt))
        : null,
      ask.supersededBy
        ? el(
            "p",
            { class: "verdict-by" },
            "Replaced by ",
            el(
              "a",
              {
                href: `#${state.view === "history" ? "history" : "ask"}=${ask.supersededBy}`,
              },
              "the newer Ask",
            ),
          )
        : null,
    );
  const terminal = ask.trace.some(
    (t) =>
      t.event === "applied" ||
      t.event === "failed" ||
      t.event === "not_applicable",
  );
  return el(
    "section",
    { class: `verdict verdict-${a.decision}` },
    el("p", { class: "verdict-kind" }, DECISION_TEXT[a.decision]),
    el("p", { class: "verdict-label" }, a.optionLabel),
    el(
      "p",
      { class: "verdict-by" },
      `by @${a.responder}${a.passkey ? " with a passkey" : ""}, ${when(a.answeredAt)}`,
    ),
    a.input ? el("blockquote", { class: "verdict-input" }, a.input) : null,
    el(
      "ol",
      { class: "rail", "aria-label": "What happened next" },
      ...ask.trace.map((t) =>
        el(
          "li",
          {
            class: `step step-${t.event}${t.event === "failed" ? " bad" : ""}`,
          },
          el("time", { datetime: new Date(t.at).toISOString() }, clock(t.at)),
          el(
            "div",
            {},
            el("span", { class: "step-name" }, traceText(ask, t)),
            t.note ? el("span", { class: "step-note" }, t.note) : null,
            ...Object.entries(t.refs).map(([k, v]) =>
              el("code", { class: "ref" }, `${k}=${v}`),
            ),
            t.url
              ? el(
                  "a",
                  { href: t.url, rel: "noreferrer", target: "_blank" },
                  "Evidence",
                )
              : null,
          ),
        ),
      ),
      terminal
        ? null
        : el(
            "li",
            { class: "step pending" },
            el("time", {}, ""),
            el(
              "div",
              {},
              el(
                "span",
                { class: "step-name" },
                ask.trace.length === 0
                  ? `Waiting for ${ask.requester} to read the answer`
                  : `Waiting for ${ask.requester} to finish`,
              ),
            ),
          ),
    ),
  );
}

/** @param {string} id */
async function select(id) {
  state.selected = id;
  history.replaceState(
    null,
    "",
    `#${state.view === "history" ? "history" : "ask"}=${id}`,
  );
  for (const node of document.querySelectorAll(".row"))
    node.setAttribute(
      "aria-selected",
      String(node.getAttribute("data-id") === id),
    );
  try {
    renderDetail(await api("GET", `/v1/inbox/asks/${id}`));
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

// ---- Answering ---------------------------------------------------------------------

/**
 * @param {Ask} ask
 * @param {AskOption} option
 * @param {string} text
 * @param {HTMLButtonElement} button
 */
async function submitAnswer(ask, option, text, button) {
  const input = text.trim() || null;
  if (option.inputRequired && !input) {
    notify(
      option.id === CUSTOM_REPLY.id
        ? "Write your message first."
        : `"${option.label}" needs instructions.`,
      true,
    );
    $("answer-input").focus();
    return;
  }
  const request = { option: option.id, input, rev: ask.action?.rev ?? null };
  button.disabled = true;
  try {
    /** @type {Record<string, unknown>} */
    const body = { ...request };
    if (option.decision === "approve") {
      const options = await api(
        "POST",
        `/v1/inbox/asks/${ask.id}/challenge`,
        request,
      );
      body.assertion = await getAssertion(options);
    }
    const answered = await api("POST", `/v1/inbox/asks/${ask.id}/answer`, body);
    notify(`Answered: ${option.label}`);
    await loadInbox();
    renderDetail(answered);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
    button.disabled = false;
  }
}

// ---- WebAuthn --------------------------------------------------------------------

/** @param {string} s */
function fromB64url(s) {
  const binary = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** @param {ArrayBuffer | null} buffer */
function toB64url(buffer) {
  if (!buffer) return null;
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** @param {any} options */
async function getAssertion(options) {
  const credential = /** @type {PublicKeyCredential | null} */ (
    await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: fromB64url(options.challenge),
        allowCredentials: (options.allowCredentials ?? []).map(
          (
            /** @type {{ id: string, type: "public-key", transports?: AuthenticatorTransport[] }} */ c,
          ) => ({
            ...c,
            id: fromB64url(c.id),
          }),
        ),
      },
    })
  );
  if (!credential) throw new Error("No passkey was used.");
  const response = /** @type {AuthenticatorAssertionResponse} */ (
    credential.response
  );
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      authenticatorData: toB64url(response.authenticatorData),
      signature: toB64url(response.signature),
      userHandle: toB64url(response.userHandle),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
  };
}

async function addPasskey() {
  try {
    const { registration, stepUp } = await api(
      "POST",
      "/v1/inbox/passkeys/options",
    );
    /** @type {Record<string, unknown>} */
    const body = {};
    if (stepUp) {
      notify("First confirm with a passkey you already have.");
      body.stepUp = await getAssertion(stepUp);
    }
    const credential = /** @type {PublicKeyCredential | null} */ (
      await navigator.credentials.create({
        publicKey: {
          ...registration,
          challenge: fromB64url(registration.challenge),
          user: { ...registration.user, id: fromB64url(registration.user.id) },
          excludeCredentials: (registration.excludeCredentials ?? []).map(
            (/** @type {{ id: string, type: "public-key" }} */ c) => ({
              ...c,
              id: fromB64url(c.id),
            }),
          ),
        },
      })
    );
    if (!credential) throw new Error("No passkey was created.");
    const response = /** @type {AuthenticatorAttestationResponse} */ (
      credential.response
    );
    body.registration = {
      id: credential.id,
      rawId: toB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toB64url(response.clientDataJSON),
        attestationObject: toB64url(response.attestationObject),
        transports: response.getTransports?.() ?? [],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment,
    };
    await api("POST", "/v1/inbox/passkeys", body);
    notify("Passkey added.");
    await loadMe();
    renderSettings();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

// ---- Settings --------------------------------------------------------------------

/** Pages of machines and requesters loaded so far in Settings. */
const settingsPages = {
  /** @type {MachineView[]} */ machines: [],
  /** @type {string | null} */ machinesNext: null,
  /** @type {RequesterView[]} */ requesters: [],
  /** @type {string | null} */ requestersNext: null,
};

/** @param {string} path @param {string | null} after */
function paged(path, after) {
  return api(
    "GET",
    after ? `${path}?after=${encodeURIComponent(after)}` : path,
  );
}

/**
 * Renders Settings from the first pages, or after loading one more page of
 * machines or requesters.
 * @param {"first" | "machines" | "requesters"} [load]
 */
async function renderSettings(load = "first") {
  const me = state.me;
  if (!me) return;
  const pages = settingsPages;
  if (load === "first") {
    const [r, m] = await Promise.all([
      paged("/v1/inbox/requesters", null),
      paged("/v1/inbox/machines", null),
    ]);
    pages.requesters = r.requesters;
    pages.requestersNext = r.next;
    pages.machines = m.machines;
    pages.machinesNext = m.next;
  } else if (load === "machines") {
    const m = await paged("/v1/inbox/machines", pages.machinesNext);
    pages.machines = [...pages.machines, ...m.machines];
    pages.machinesNext = m.next;
  } else {
    const r = await paged("/v1/inbox/requesters", pages.requestersNext);
    pages.requesters = [...pages.requesters, ...r.requesters];
    pages.requestersNext = r.next;
  }
  const { machines, requesters } = pages;
  const topic = /** @type {HTMLInputElement} */ (
    el("input", {
      value: me.ntfyTopic ?? "",
      placeholder: "ntfy topic",
      "aria-label": "ntfy topic",
    })
  );
  const name = /** @type {HTMLInputElement} */ (
    el("input", {
      placeholder: "orca-merge-gate@laptop",
      "aria-label": "Requester name",
    })
  );
  const secret = el("div");
  $("settings-view").replaceChildren(
    el(
      "section",
      {},
      el("h2", {}, "Passkeys"),
      el(
        "p",
        {},
        "Approvals need a passkey. Adding a second one needs a passkey you already have.",
      ),
      me.passkeys.length
        ? el(
            "table",
            {},
            el("tr", {}, el("th", {}, "Added"), el("th", {}, "Last used")),
            ...me.passkeys.map((p) =>
              el(
                "tr",
                {},
                el("td", {}, when(p.createdAt)),
                el("td", {}, when(p.lastUsedAt)),
              ),
            ),
          )
        : el("p", { class: "none" }, "No passkey yet: you cannot approve."),
      el("button", { onclick: () => void addPasskey() }, "Add a passkey"),
    ),
    el(
      "section",
      {},
      el("h2", {}, "Notifications"),
      el(
        "p",
        {},
        me.pushes
          ? "Asks addressed to you are pushed to this ntfy topic. Pushes carry the title, urgency, risk, and source only."
          : "Pushes are disabled on this deployment.",
      ),
      el(
        "div",
        { class: "inline-form" },
        topic,
        el(
          "button",
          {
            onclick: async () => {
              try {
                await api("PUT", "/v1/inbox/me/notifications", {
                  ntfyTopic: topic.value.trim() || null,
                });
                notify("Saved.");
                await loadMe();
              } catch (error) {
                notify(
                  error instanceof Error ? error.message : String(error),
                  true,
                );
              }
            },
          },
          "Save",
        ),
      ),
    ),
    el(
      "section",
      {},
      el("h2", {}, "Machines"),
      el(
        "p",
        {},
        "Each machine logs in once with roger login. Its automations name themselves with --as and become requesters under the machine's name, created on first use. Any process on a machine can act as any of its requesters. Disable a requester to stop one automation; revoke the machine to stop all of them.",
      ),
      machines.length
        ? el(
            "table",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Machine"),
              el("th", {}, "Requesters"),
              el("th", {}),
            ),
            ...machines.map((m) =>
              el(
                "tr",
                {},
                el(
                  "td",
                  {},
                  m.name,
                  el(
                    "div",
                    { class: "none" },
                    `Logged in ${when(m.createdAt)}`,
                  ),
                ),
                el(
                  "td",
                  {},
                  ...m.requesters.map((r) =>
                    el(
                      "div",
                      {},
                      `${r.name} `,
                      r.disabledAt
                        ? "(disabled)"
                        : el(
                            "button",
                            {
                              class: "quiet",
                              onclick: () => void disable(r.id),
                            },
                            "Disable",
                          ),
                    ),
                  ),
                ),
                el(
                  "td",
                  {},
                  el(
                    "button",
                    { class: "quiet", onclick: () => void revokeMachine(m.id) },
                    "Revoke",
                  ),
                ),
              ),
            ),
          )
        : el(
            "p",
            { class: "none" },
            "No machine is logged in. Run roger login on one.",
          ),
      pages.machinesNext
        ? el(
            "button",
            { class: "quiet", onclick: () => void renderSettings("machines") },
            "More machines",
          )
        : null,
    ),
    el(
      "section",
      {},
      el("h2", {}, "Your requesters"),
      el(
        "p",
        {},
        "Requesters with their own token, for automations that do not use roger login. Its Asks come to you unless they name someone with --to. Only you can issue or revoke its tokens. Adopt one to a logged-in machine to keep it there under --as <name>; its tokens keep working.",
      ),
      el(
        "table",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Name"),
          el("th", {}, "Tokens"),
          el("th", {}),
        ),
        ...requesters.map((r) =>
          el(
            "tr",
            {},
            el(
              "td",
              {},
              r.name,
              r.disabledAt ? " (disabled)" : "",
              r.machine
                ? el(
                    "div",
                    { class: "none" },
                    `Adopted by ${r.machine} `,
                    el(
                      "button",
                      { class: "quiet", onclick: () => void release(r.id) },
                      "Release",
                    ),
                  )
                : !r.disabledAt && !r.name.includes("/") && machines.length
                  ? adoptForm(r.id, machines)
                  : null,
            ),
            el(
              "td",
              {},
              ...r.tokens.map((t) =>
                el(
                  "div",
                  {},
                  `${when(t.createdAt)} `,
                  t.revokedAt
                    ? "(revoked)"
                    : el(
                        "button",
                        { class: "quiet", onclick: () => void revoke(t.id) },
                        "Revoke",
                      ),
                ),
              ),
            ),
            el(
              "td",
              {},
              r.disabledAt
                ? ""
                : el(
                    "button",
                    { onclick: () => void issue(r.id, r.name, secret) },
                    "New token",
                  ),
              r.disabledAt
                ? ""
                : el(
                    "button",
                    { class: "quiet", onclick: () => void disable(r.id) },
                    "Disable",
                  ),
            ),
          ),
        ),
      ),
      pages.requestersNext
        ? el(
            "button",
            {
              class: "quiet",
              onclick: () => void renderSettings("requesters"),
            },
            "More requesters",
          )
        : null,
      el(
        "div",
        { class: "inline-form" },
        name,
        el(
          "button",
          {
            onclick: async () => {
              try {
                await api("POST", "/v1/inbox/requesters", {
                  name: name.value.trim(),
                });
                await renderSettings();
              } catch (error) {
                notify(
                  error instanceof Error ? error.message : String(error),
                  true,
                );
              }
            },
          },
          "Create requester",
        ),
      ),
      secret,
    ),
  );
}

/** @param {string} id @param {string} name @param {HTMLElement} into */
async function issue(id, name, into) {
  try {
    const { token } = await api("POST", `/v1/inbox/requesters/${id}/tokens`);
    await renderSettings();
    into.replaceChildren(
      el(
        "p",
        {},
        `Token for ${name}. It is shown once; store it where the agent reads ROGER_TOKEN_FILE.`,
      ),
      el("p", { class: "secret mono" }, token),
    );
    $("settings-view").append(into);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

/** @param {string} id */
async function revoke(id) {
  try {
    await api("POST", `/v1/inbox/tokens/${id}/revoke`);
    await renderSettings();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

/**
 * @param {string} requesterId
 * @param {MachineView[]} machines
 */
function adoptForm(requesterId, machines) {
  const select = /** @type {HTMLSelectElement} */ (
    el(
      "select",
      { "aria-label": "Machine to adopt it" },
      ...machines.map((m) => el("option", { value: m.id }, m.name)),
    )
  );
  return el(
    "div",
    {},
    select,
    el(
      "button",
      {
        class: "quiet",
        onclick: async () => {
          try {
            await api("POST", `/v1/inbox/requesters/${requesterId}/adopt`, {
              machineId: select.value,
            });
            await renderSettings();
          } catch (error) {
            notify(
              error instanceof Error ? error.message : String(error),
              true,
            );
          }
        },
      },
      "Adopt",
    ),
  );
}

/** @param {string} id */
async function release(id) {
  try {
    await api("POST", `/v1/inbox/requesters/${id}/release`);
    await renderSettings();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

/** @param {string} id */
async function revokeMachine(id) {
  try {
    await api("POST", `/v1/inbox/machines/${id}/revoke`);
    await renderSettings();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

// ---- Machine login ---------------------------------------------------------------

/**
 * Approves or denies a `roger login`. The person types the code from their
 * own terminal: a link can carry someone else's code, so a code in the URL
 * is never used (RFC 8628 sections 3.3.1 and 5.4). Codes go to the API only
 * in request bodies.
 * @param {boolean} fromLink
 */
function renderDevice(fromLink) {
  const flow = deviceApproval(
    (code) =>
      /** @type {Promise<PendingLogin>} */ (
        api("POST", "/v1/inbox/device", { userCode: code })
      ),
  );
  const code = /** @type {HTMLInputElement} */ (
    el("input", {
      placeholder: "BCDF-GHJK",
      autocomplete: "off",
      "aria-label": "Code from roger login",
    })
  );
  const result = el("div");
  // Any edit forgets the looked-up login and its buttons.
  code.addEventListener("input", () => {
    flow.edit();
    result.replaceChildren();
  });
  const lookup = async () => {
    result.replaceChildren(el("p", { class: "none" }, "Looking up…"));
    const found = await flow.lookup(code.value);
    if (found.kind === "stale") return;
    if (found.kind === "failed") {
      result.replaceChildren();
      notify(
        found.error instanceof Error
          ? found.error.message
          : String(found.error),
        true,
      );
      return;
    }
    const { pending } = found;
    const shown = formatCode(found.code);
    const machine = /** @type {HTMLInputElement} */ (
      el("input", {
        value: pending.suggested ?? "",
        placeholder: "studio",
        "aria-label": "Machine name",
      })
    );
    /** @param {"approve" | "deny"} verb */
    const decide = async (verb) => {
      // Only the login whose code is still in the input.
      const target = flow.target(code.value);
      if (!target) {
        notify(
          "The code changed. Continue with the code from your terminal.",
          true,
        );
        return;
      }
      try {
        await api(
          "POST",
          `/v1/inbox/device/${verb}`,
          verb === "approve"
            ? { userCode: target.code, machine: machine.value.trim() }
            : { userCode: target.code },
        );
        flow.edit();
        result.replaceChildren(
          el(
            "p",
            {},
            verb === "approve"
              ? `Approved ${shown}. ${machine.value.trim()} is logged in once roger login finishes.`
              : `Denied ${shown}. roger login stops on that machine.`,
          ),
        );
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), true);
      }
    };
    result.replaceChildren(
      el(
        "dl",
        {},
        el("dt", {}, "Code"),
        el("dd", { class: "mono" }, shown),
        el("dt", {}, "Started"),
        el("dd", {}, ago(pending.createdAt)),
        el("dt", {}, "From"),
        el("dd", {}, pending.source ?? "unknown"),
        el("dt", {}, "Client"),
        el("dd", {}, pending.userAgent ?? "unknown"),
      ),
      el(
        "p",
        {},
        `Approve only if ${shown} is the code in your terminal and you started this login. Its automations become requesters named after the machine, such as ${pending.suggested ?? "studio"}/default. A machine of yours with the same name is logged out once this one is used, and this one takes over its requesters.`,
      ),
      el(
        "div",
        { class: "inline-form" },
        machine,
        el(
          "button",
          { onclick: () => void decide("approve") },
          `Approve ${shown}`,
        ),
        el(
          "button",
          { class: "quiet", onclick: () => void decide("deny") },
          `Deny ${shown}`,
        ),
      ),
    );
  };
  $("device-view").replaceChildren(
    el(
      "section",
      {},
      el("h2", {}, "Log in a machine"),
      el(
        "p",
        {},
        "Type the code that roger login printed in your own terminal. The machine can then ask you for decisions and read your answers as any of its requesters, until you revoke it in Settings.",
      ),
      fromLink
        ? el(
            "p",
            { class: "none" },
            "This page was opened from a link. Links can carry someone else's code, so type the one from your terminal.",
          )
        : null,
      el(
        "div",
        { class: "inline-form" },
        code,
        el("button", { onclick: () => void lookup() }, "Continue"),
      ),
      result,
    ),
  );
}

/** @param {string} id */
async function disable(id) {
  try {
    await api("POST", `/v1/inbox/requesters/${id}/disable`);
    await renderSettings();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
}

// ---- Loading and navigation ----------------------------------------------------------

function showSignedOut() {
  state.me = null;
  $("nav").hidden = true;
  for (const id of [
    "inbox-view",
    "history-view",
    "settings-view",
    "device-view",
  ])
    $(id).hidden = true;
  $("signed-out").hidden = false;
}

async function loadMe() {
  state.me = await api("GET", "/v1/inbox/me");
  $("who").textContent = state.me ? `@${state.me.login}` : "";
}

async function loadInbox() {
  const data = await api("GET", "/v1/inbox");
  state.open = data.open;
  state.openTotal = data.openTotal;
  state.stalled = data.stalled;
  state.serverNow = data.now;
  renderInboxList();
}

/** @param {boolean} more */
async function loadHistory(more) {
  const before = more ? state.historyNext : null;
  const data = await api(
    "GET",
    `/v1/inbox/history${before ? `?before=${encodeURIComponent(before)}` : ""}`,
  );
  state.history = more ? [...state.history, ...data.asks] : data.asks;
  state.historyNext = data.next;
  renderHistoryList();
}

/** @param {View} view */
async function show(view) {
  state.view = view;
  for (const link of document.querySelectorAll("nav a")) {
    if (link.getAttribute("data-view") === view)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("inbox-view").hidden = view !== "inbox";
  $("history-view").hidden = view !== "history";
  $("settings-view").hidden = view !== "settings";
  $("device-view").hidden = view !== "device";
  try {
    if (view === "inbox") await loadInbox();
    if (view === "history") await loadHistory(false);
    if (view === "settings") await renderSettings();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      notify(error instanceof Error ? error.message : String(error), true);
  }
}

async function route() {
  const hash = location.hash.slice(1);
  const [name, id] = hash.split("=");
  if (name === "settings") return show("settings");
  if (name === "device") {
    await show("device");
    // A code in the link is never used; drop it from the address bar.
    if (id) history.replaceState(null, "", "#device");
    renderDevice(id !== undefined);
    return;
  }
  if (name === "history") {
    await show("history");
    if (id) await select(id);
    else renderEmptyDetail();
    return;
  }
  await show("inbox");
  const first = id ?? state.open[0]?.id;
  if (first) await select(first);
  else renderEmptyDetail();
}

// ---- Keyboard --------------------------------------------------------------------------

let pendingG = false;
document.addEventListener("keydown", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (
    target.matches("input, textarea") ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    if (event.key === "Escape") target.blur();
    return;
  }
  if (pendingG) {
    pendingG = false;
    if (event.key === "i") location.hash = "inbox";
    if (event.key === "h") location.hash = "history";
    if (event.key === "s") location.hash = "settings";
    return;
  }
  const items = listed();
  const index = items.findIndex((a) => a.id === state.selected);
  switch (event.key) {
    case "j":
    case "k": {
      const next =
        items[
          Math.min(
            items.length - 1,
            Math.max(0, index + (event.key === "j" ? 1 : -1)),
          )
        ];
      if (next) void select(next.id);
      break;
    }
    case "i":
      document.getElementById("answer-input")?.focus();
      event.preventDefault();
      break;
    case "r":
      /** @type {HTMLButtonElement | null} */ (
        document.querySelector('.options button[data-key="r"]')
      )?.click();
      break;
    case "g":
      pendingG = true;
      break;
    case "?":
      /** @type {HTMLDialogElement} */ ($("help")).showModal();
      break;
    default:
      if (/^[1-8]$/.test(event.key)) {
        // Only options that do not approve have number keys.
        /** @type {HTMLButtonElement | null} */ (
          document.querySelector(`.options button[data-key="${event.key}"]`)
        )?.click();
      }
  }
});

$("logout").addEventListener("click", async () => {
  await api("POST", "/auth/logout").catch(() => null);
  showSignedOut();
});
window.addEventListener("hashchange", () => void route());

(async () => {
  try {
    await loadMe();
  } catch {
    showSignedOut();
    return;
  }
  $("nav").hidden = false;
  $("signed-out").hidden = true;
  await route();
  // Refresh the open list while the tab is visible.
  setInterval(() => {
    if (document.visibilityState === "visible" && state.view === "inbox")
      void loadInbox().catch(() => null);
  }, 30_000);
})();
