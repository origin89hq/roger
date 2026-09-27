import { env } from "cloudflare:test";
import { Accounts } from "../src/accounts.ts";
import { createApp, type Services } from "../src/app.ts";
import { type Config, readSchedule } from "../src/config.ts";
import type { GitHub, Membership } from "../src/github.ts";
import { base64url } from "../src/ids.ts";
import { Machines } from "../src/machines.ts";
import type { Notifier, Push } from "../src/notify.ts";
import { Passkeys } from "../src/passkeys.ts";
import type {
  Ask,
  AskState,
  CreateAsk,
  ErrorDetail,
} from "../src/protocol.gen.ts";
import { type Responder, Store } from "../src/store.ts";

export const ORIGIN = "https://roger.test";
export const REV = "99052e8d50ab39ba6e38d1fc68e3442afcfd5892";

const schedule = readSchedule("America/Toronto", "08:00-18:00", "mon-fri");
if (typeof schedule === "string") throw new Error(schedule);

export const config: Config = {
  origin: ORIGIN,
  rpId: "roger.test",
  github: {
    clientId: "client",
    clientSecret: "secret",
    org: "origin89hq",
    team: "roger",
  },
  ntfy: { url: "https://ntfy.test", token: null },
  schedule,
};

/** Monday 2026-09-28 10:00 in Toronto: working hours. */
export const MONDAY_10AM = Date.parse("2026-09-28T14:00:00Z");

export class FakeGitHub implements GitHub {
  users = new Map<string, Responder>();
  members = new Set<string>();
  async exchange(code: string) {
    return this.users.has(code) ? code : null;
  }
  async user(token: string) {
    return this.users.get(token) ?? null;
  }
  /** Set to make the membership check fail as a GitHub outage would. */
  outage = false;
  async teamMembership(
    _token: string,
    _org: string,
    _team: string,
    login: string,
  ): Promise<Membership> {
    if (this.outage) return "unavailable";
    return this.members.has(login) ? "active" : "none";
  }
}

export class FakeNotifier implements Notifier {
  sent: { topic: string; push: Push }[] = [];
  failing = false;
  async send(topic: string, push: Push) {
    if (this.failing) throw new Error("ntfy down");
    this.sent.push({ topic, push });
  }
}

export interface TestServices extends Services {
  clock: { now: number };
  notifier: FakeNotifier;
  github: FakeGitHub;
  deferred: Promise<unknown>[];
  settle(): Promise<void>;
}

export function services(now = MONDAY_10AM): TestServices {
  const accounts = new Accounts(env.DB);
  const clock = { now };
  const deferred: Promise<unknown>[] = [];
  return {
    store: new Store(env.DB),
    accounts,
    machines: new Machines(env.DB),
    passkeys: new Passkeys(accounts, config),
    github: new FakeGitHub(),
    notifier: new FakeNotifier(),
    config,
    now: () => clock.now,
    defer: (work) => deferred.push(work),
    clock,
    deferred,
    async settle() {
      await Promise.all(deferred.splice(0));
    },
  };
}

let counter = 0;
/** A GitHub identity no other test uses, so tests sharing the database stay independent. */
export function newPerson(): Responder {
  counter += 1;
  const n = 1_000_000 + Math.floor(Math.random() * 1_000_000_000) + counter;
  return { githubId: n, login: `person-${n}` };
}

/** A signed-in person with a session cookie. */
export async function person(svc: Services, topic: string | null = null) {
  const who = newPerson();
  await svc.accounts.upsertResponder(who, svc.now());
  if (topic) await svc.accounts.setNtfyTopic(who.githubId, topic);
  const cookie = await svc.accounts.createSession(who.githubId, svc.now());
  return { ...who, cookie };
}

/** A requester owned by `owner`, with a working token. */
export async function requester(svc: Services, owner: Responder) {
  const name = `agent-${crypto.randomUUID().slice(0, 8)}`;
  const id = await svc.accounts.createRequester(
    name,
    120,
    1440,
    owner.githubId,
    svc.now(),
  );
  if (!id) throw new Error("requester name taken");
  const issued = await svc.accounts.issueToken(id, owner.githubId, svc.now());
  if (!issued) throw new Error("token not issued");
  return { id, name, token: issued.token, tokenId: issued.id };
}

export async function agent(
  svc: Services,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return createApp(svc).fetch(new Request(`${ORIGIN}${path}`, init));
}

export async function browser(
  svc: Services,
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers({ origin: ORIGIN, ...headers });
  if (cookie) h.set("cookie", `__Host-roger=${cookie}`);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return createApp(svc).fetch(new Request(`${ORIGIN}${path}`, init));
}

export function approval(overrides: Partial<CreateAsk> = {}): CreateAsk {
  const key = crypto.randomUUID();
  return {
    idemKey: `idem-${key}`,
    decisionKey: `merge:origin89hq/roger#${key}`,
    repo: "origin89hq/roger",
    kind: "approval",
    urgency: "later",
    risk: "routine",
    title: "Merge: feat: add the inbox",
    body: "All checks pass.",
    links: [{ label: "PR", url: "https://github.com/origin89hq/roger/pull/2" }],
    action: {
      verb: "merge",
      target: "pr:origin89hq/roger#2",
      rev: REV,
      limits: "squash",
    },
    options: [
      { id: "approve", label: "Merge", decision: "approve" },
      { id: "reject", label: "Leave", decision: "reject" },
      { id: "fix", label: "Fix", decision: "other", inputRequired: true },
    ],
    ...overrides,
  };
}

export async function createAsk(
  svc: Services,
  token: string,
  body: CreateAsk = approval(),
): Promise<Ask> {
  const response = await agent(svc, token, "POST", "/v1/asks", body);
  if (response.status !== 201)
    throw new Error(`create failed: ${await response.text()}`);
  return response.json<Ask>();
}

/** Sends a hand-built request, for headers the other helpers always set. */
export async function send(svc: Services, request: Request): Promise<Response> {
  return createApp(svc).fetch(request);
}

/** A ntfy topic no other test uses. */
export function newTopic(): string {
  return `topic-${crypto.randomUUID().slice(0, 12)}`;
}

/** Minutes as milliseconds. */
export const minutes = (n: number) => n * 60_000;

export function question(overrides: Partial<CreateAsk> = {}): CreateAsk {
  const key = crypto.randomUUID();
  return {
    idemKey: `idem-${key}`,
    decisionKey: `name:${key}`,
    kind: "question",
    urgency: "soon",
    risk: "routine",
    title: "Which name?",
    options: [
      { id: "a", label: "Roger", decision: "other" },
      { id: "b", label: "Wilco", decision: "other" },
    ],
    ...overrides,
  };
}

/** The error body of a failed response. */
export async function errorOf(response: Response): Promise<ErrorDetail> {
  return (await response.json<{ error: ErrorDetail }>()).error;
}

/** Reads an Ask as its requester. */
export async function readAsk(
  svc: Services,
  token: string,
  id: string,
): Promise<Ask> {
  const response = await agent(svc, token, "GET", `/v1/asks/${id}`);
  if (response.status !== 200)
    throw new Error(`read failed: ${await response.text()}`);
  return response.json<Ask>();
}

export async function answerAsk(
  svc: Services,
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return browser(svc, cookie, "POST", `/v1/inbox/asks/${id}/answer`, body);
}

/** Rejects an approval from the inbox; needs no passkey. */
export async function reject(
  svc: Services,
  cookie: string,
  id: string,
): Promise<Ask> {
  const response = await answerAsk(svc, cookie, id, {
    option: "reject",
    rev: REV,
  });
  if (response.status !== 200)
    throw new Error(`reject failed: ${await response.text()}`);
  return response.json<Ask>();
}

/** Requests an assertion challenge for an answer. */
export async function challenge(
  svc: Services,
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return browser(svc, cookie, "POST", `/v1/inbox/asks/${id}/challenge`, body);
}

/** Signs a fresh challenge for approving `id` with `input`. */
export async function approvalAssertion(
  svc: Services,
  cookie: string,
  passkey: SoftPasskey,
  id: string,
  input: string | null = null,
) {
  const response = await challenge(svc, cookie, id, {
    option: "approve",
    rev: REV,
    input,
  });
  if (response.status !== 200)
    throw new Error(`challenge failed: ${await response.text()}`);
  return passkey.assert(await response.json<{ challenge: string }>());
}

/** The audit rows of one Ask, oldest first. */
export async function auditOf(
  id: string,
): Promise<{ state: AskState; actor: string; at: number }[]> {
  const rows = await env.DB.prepare(
    "SELECT state, actor, at FROM ask_events WHERE ask_id = ? ORDER BY seq",
  )
    .bind(id)
    .all<{ state: AskState; actor: string; at: number }>();
  return rows.results;
}

export async function count(
  table: string,
  where: string,
  ...values: unknown[]
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
  )
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- A software passkey ------------------------------------------------------

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  return [(major << 5) | 25, n >> 8, n & 255];
}

function cbor(value: Cbor): number[] {
  if (typeof value === "number")
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array)
    return [...cborHead(2, value.length), ...value];
  const out = cborHead(5, value.size);
  for (const [k, v] of value) out.push(...cbor(k), ...cbor(v));
  return out;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Converts a raw P-256 signature (r || s) to the DER form WebAuthn uses. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const trimmed = b.slice(i);
    const padded = (trimmed[0] ?? 0) & 0x80 ? [0, ...trimmed] : [...trimmed];
    return [0x02, padded.length, ...padded];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

function decodeB64url(s: string): Uint8Array {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** An authenticator that signs whatever challenge it is given, like a real one would. */
export class SoftPasskey {
  private counter = 0;
  readonly id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly origin: string,
  ) {}

  static async create(origin = ORIGIN): Promise<SoftPasskey> {
    const keys = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return new SoftPasskey(keys, origin);
  }

  private async authData(attested: boolean): Promise<Uint8Array> {
    const rpIdHash = await digest(
      new TextEncoder().encode(new URL(this.origin).hostname),
    );
    this.counter += 1;
    const c = this.counter;
    const head = [
      ...rpIdHash,
      attested ? 0x45 : 0x05,
      c >>> 24,
      (c >> 16) & 255,
      (c >> 8) & 255,
      c & 255,
    ];
    if (!attested) return new Uint8Array(head);
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    if (jwk instanceof ArrayBuffer) throw new Error("expected a JWK");
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, decodeB64url(jwk.x ?? "")],
      [-3, decodeB64url(jwk.y ?? "")],
    ]);
    const credId = decodeB64url(this.id);
    return new Uint8Array([
      ...head,
      ...new Uint8Array(16),
      credId.length >> 8,
      credId.length & 255,
      ...credId,
      ...cbor(cose),
    ]);
  }

  private clientData(type: string, challenge: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        type,
        challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
  }

  async register(options: { challenge: string }) {
    const attestation = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", await this.authData(true)],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: base64url(
          this.clientData("webauthn.create", options.challenge),
        ),
        attestationObject: base64url(new Uint8Array(attestation)),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  async assert(options: { challenge: string }) {
    const authData = await this.authData(false);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signed = new Uint8Array([...authData, ...(await digest(clientData))]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        signed,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: base64url(clientData),
        authenticatorData: base64url(authData),
        signature: base64url(der(raw)),
      },
      clientExtensionResults: {},
    };
  }
}

/** Registers a new software passkey for a signed-in person through the inbox API. */
export async function registerPasskey(
  svc: Services,
  cookie: string,
  existing: SoftPasskey | null = null,
): Promise<{ passkey: SoftPasskey; response: Response }> {
  const passkey = await SoftPasskey.create();
  const options = await (
    await browser(svc, cookie, "POST", "/v1/inbox/passkeys/options")
  ).json<{
    registration: { challenge: string };
    stepUp: { challenge: string } | null;
  }>();
  const body: Record<string, unknown> = {
    registration: await passkey.register(options.registration),
  };
  if (existing && options.stepUp)
    body.stepUp = await existing.assert(options.stepUp);
  const response = await browser(
    svc,
    cookie,
    "POST",
    "/v1/inbox/passkeys",
    body,
  );
  return { passkey, response };
}
