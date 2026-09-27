import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { z } from "zod";
import {
  type Accounts,
  DEFAULT_COMPLETION_MINUTES,
  DEFAULT_PICKUP_MINUTES,
  SESSION_MS,
} from "./accounts.ts";
import type { Config } from "./config.ts";
import { evidenceProblem } from "./evidence.ts";
import type { GitHub } from "./github.ts";
import { failure, isJson, json, jsonBody } from "./http.ts";
import { canonicalJson, secret, sha256 } from "./ids.ts";
import { DEFAULT_AUTOMATION, type Machine, type Machines } from "./machines.ts";
import {
  askPush,
  machineLoginPush,
  type Notifier,
  passkeyAddedPush,
} from "./notify.ts";
import type { Passkeys } from "./passkeys.ts";
import type {
  Ask,
  AskList,
  AskOption,
  EventList,
  LoginConfig,
  MachineToken,
} from "./protocol.gen.ts";
import {
  type AnswerRequest,
  answer,
  answerChallenge,
  appendTrace,
  askId,
  createAsk,
  describeIssues,
  LIMITS,
  listFilter,
  machineCursor,
  machineLogin,
  machineRef,
  newRequester,
  notificationSettings,
  requesterCursor,
  requesterName,
} from "./schemas.ts";
import type { Requester, Responder, Store, TransitionResult } from "./store.ts";

export interface Services {
  store: Store;
  accounts: Accounts;
  machines: Machines;
  /**
   * Admits one `roger login` from `ip`, such as a Workers Rate Limiting
   * binding. `null` when not configured, which refuses every login.
   */
  loginLimit: ((ip: string) => Promise<boolean>) | null;
  passkeys: Passkeys;
  github: GitHub;
  /** `null` when pushes are disabled. */
  notifier: Notifier | null;
  config: Config;
  now: () => number;
  /** Runs work after the response is sent, such as `ctx.waitUntil`. */
  defer: (work: Promise<unknown>) => void;
}

type Env = {
  Variables: { requester: Requester; responder: Responder; machine: Machine };
};

const SESSION_COOKIE = "__Host-roger";
const OAUTH_COOKIE = "__Host-roger-oauth";
const INBOX_LIMIT = 200;
const HISTORY_LIMIT = 50;
const REQUESTER_PAGE = 100;
/** What sign-in and `roger login` ask GitHub for: enough to check team membership. */
const LOGIN_SCOPE = "read:org";
/** Attempts to revoke a GitHub token before giving up on a login. */
const REVOKE_ATTEMPTS = 3;

/** Where a request came from, as Settings and the login push show it. */
function describeSource(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const country = (request as { cf?: { country?: unknown } }).cf?.country;
  return {
    source: typeof country === "string" ? `${ip} (${country})` : ip,
    userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
  };
}
/** Names the automation a machine credential acts for. */
const REQUESTER_HEADER = "roger-requester";
const CREDENTIAL = /^Bearer ((?:roger|rogm)_[A-Za-z0-9_-]{43})$/;

/**
 * An answer every Ask accepts: the responder's own message instead of one of
 * the requester's options. It is never an approval. Requester option ids
 * cannot start with `_`, so it cannot collide with one.
 */
const CUSTOM_REPLY: AskOption = {
  id: "_custom",
  label: "Custom reply",
  decision: "other",
  inputRequired: true,
};

async function parse<S extends z.ZodType>(
  request: Request,
  limit: number,
  schema: S,
): Promise<
  { ok: true; value: z.output<S> } | { ok: false; response: Response }
> {
  const body = await jsonBody(request, limit);
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  if (!parsed.success)
    return {
      ok: false,
      response: failure(400, "invalid_request", describeIssues(parsed.error)),
    };
  return { ok: true, value: parsed.data };
}

function transitionResponse(result: TransitionResult): Response {
  switch (result.kind) {
    case "done":
      return json(result.ask);
    case "conflict":
      return failure(409, "conflict", result.message, result.state);
    default: {
      const unreachable: never = result;
      throw new Error(`unknown result ${String(unreachable)}`);
    }
  }
}

/** Sends the push for one Ask now if it is due and not yet claimed. */
export async function pushAsk(
  svc: Services,
  askId: string | null,
  now: number,
): Promise<void> {
  if (!svc.notifier) return;
  for (const job of await svc.store.duePushes(now, 50, askId)) {
    if (!(await svc.store.claimPush(job.askId, now))) continue;
    // A sender that dies before confirming loses its lease and the push is
    // sent again: pushes are at least once, never silently dropped.
    try {
      await svc.notifier.send(job.topic, askPush(job, svc.config.origin));
      await svc.store.confirmPush(job.askId, now);
    } catch (error) {
      // The next cron run retries it.
      await svc.store.releasePush(job.askId);
      console.warn({
        event: "push_failed",
        askId: job.askId,
        error: String(error),
      });
    }
  }
}

export function createApp(svc: Services): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((error) => {
    // Never log the request: it carries tokens and cookies.
    console.error({
      event: "request_failed",
      error: error instanceof Error ? error.name : "unknown",
    });
    return failure(500, "internal", "Something went wrong.");
  });
  app.notFound(() => failure(404, "not_found", "No such route."));

  // ---- Agent API: bearer tokens only --------------------------------------

  const agent = new Hono<Env>();
  agent.use("/asks", bearer);
  agent.use("/asks/*", bearer);
  agent.use("/events", bearer);
  agent.use("/machine/*", machineOnly);

  /**
   * Resolves the requester. A static token (`roger_`) is one requester. A
   * machine credential (`rogm_`) acts as `<machine>/<name>` for the name in
   * the Roger-Requester header, `default` when absent, created on first use.
   */
  async function bearer(c: Context<Env>, next: () => Promise<void>) {
    const credential = CREDENTIAL.exec(
      c.req.header("authorization") ?? "",
    )?.[1];
    const named = c.req.header(REQUESTER_HEADER);
    if (credential?.startsWith("rogm_")) {
      const machine = await svc.machines.byCredential(credential, svc.now());
      if (!machine)
        return failure(
          401,
          "unauthorized",
          "This machine's login is unknown or revoked. Run roger login.",
        );
      const name = requesterName.safeParse(named ?? DEFAULT_AUTOMATION);
      if (!name.success)
        return failure(
          400,
          "invalid_request",
          `${REQUESTER_HEADER}: ${describeIssues(name.error)}`,
        );
      const resolved = await svc.machines.requester(
        machine,
        name.data,
        svc.now(),
      );
      switch (resolved.kind) {
        case "ok":
          c.set("requester", resolved.requester);
          break;
        case "disabled":
          return failure(
            403,
            "forbidden",
            `The requester ${resolved.name} is disabled.`,
          );
        case "refused":
          return failure(403, "forbidden", resolved.message);
        default: {
          const unreachable: never = resolved;
          throw new Error(`unknown resolution ${String(unreachable)}`);
        }
      }
      return next();
    }
    const requester = credential
      ? await svc.accounts.requesterByToken(credential)
      : null;
    if (!requester)
      return failure(401, "unauthorized", "A valid agent token is required.");
    if (named !== undefined)
      return failure(
        400,
        "invalid_request",
        "A token is already one requester; naming another needs roger login.",
      );
    c.set("requester", requester);
    await next();
  }

  /** Machine credentials only, for managing the login itself. */
  async function machineOnly(c: Context<Env>, next: () => Promise<void>) {
    const credential = CREDENTIAL.exec(
      c.req.header("authorization") ?? "",
    )?.[1];
    const machine = credential?.startsWith("rogm_")
      ? await svc.machines.byCredential(credential, svc.now())
      : null;
    if (!machine)
      return failure(
        401,
        "unauthorized",
        "A machine login is required. Run roger login.",
      );
    c.set("machine", machine);
    await next();
  }

  // Revokes the calling machine: `roger logout`.
  agent.post("/machine/logout", async (c) => {
    const machine = c.get("machine");
    await svc.machines.revoke(machine.id, machine.owner, svc.now());
    return c.body(null, 204);
  });

  // ---- Machine login: `roger login` -----------------------------------------

  // What the CLI needs for GitHub's device flow.
  agent.get("/login", () =>
    json({
      githubClientId: svc.config.github.clientId,
      scope: LOGIN_SCOPE,
    } satisfies LoginConfig),
  );

  /**
   * Exchanges a GitHub token from the device flow for a machine credential.
   * The token must have been issued to this app; then the same membership
   * check as inbox sign-in; then the token is revoked, and only once GitHub
   * confirms that is a credential issued. Team membership is checked here
   * only: removing someone from the team does not revoke their machines.
   *
   * Once the token is read, every refusal revokes it, except two: a refusal
   * by the rate limiter, so a limited address cannot make Roger call GitHub,
   * and a token GitHub says is not this app's. A body too large to read
   * cannot be revoked. The GitHub token is never stored or logged.
   */
  agent.post("/login", async (c) => {
    const read = await jsonBody(c.req.raw, LIMITS.adminBytes, true);
    const value = read.ok ? read.value : null;
    let githubToken =
      typeof value === "object" &&
      value !== null &&
      "githubToken" in value &&
      typeof value.githubToken === "string" &&
      value.githubToken.length > 0 &&
      value.githubToken.length <= 512
        ? value.githubToken
        : null;
    let revoked = false;
    /** Revokes the token at most once per request. */
    const revoke = async (): Promise<boolean> => {
      if (!githubToken || revoked) return true;
      revoked = true;
      const token = githubToken;
      for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
        const result = await svc.github.revoke(token);
        if (result === "revoked" || result === "gone") return true;
      }
      console.warn({ event: "github_revoke_failed" });
      return false;
    };
    let allowed: boolean;
    try {
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      allowed = svc.loginLimit ? await svc.loginLimit(ip) : false;
    } catch (error) {
      await revoke();
      throw error;
    }
    // A deployment without the limiter refuses logins rather than running
    // unlimited. Deliberately not revoked: see above.
    if (!allowed)
      return failure(
        429,
        "too_many_requests",
        svc.loginLimit
          ? "Too many logins from this address. Wait a minute and try again."
          : "Logins are not configured on this deployment.",
      );
    try {
      if (!read.ok) return read.response;
      if (!isJson(c.req.raw))
        return failure(
          415,
          "invalid_request",
          "Send the body as application/json.",
        );
      const body = machineLogin.safeParse(read.value);
      if (!body.success)
        return failure(400, "invalid_request", describeIssues(body.error));
      const { machine } = body.data;
      const token = body.data.githubToken;
      // Only a token issued to this app through the device flow: a leaked
      // personal access token or another app's token mints nothing.
      const user = await svc.github.appUser(token);
      if (user === "unavailable")
        return failure(503, "internal", "GitHub did not answer. Try again.");
      if (user === "foreign") {
        githubToken = null;
        return failure(
          401,
          "unauthorized",
          "The GitHub token was not issued to Roger. Run roger login.",
        );
      }
      const { org, team } = svc.config.github;
      const membership = await svc.github.teamMembership(
        token,
        org,
        team,
        user.login,
      );
      switch (membership) {
        case "active":
          break;
        case "none":
          return failure(
            403,
            "forbidden",
            `Roger is limited to members of ${org}/${team}.`,
          );
        case "unavailable":
          return failure(503, "internal", "GitHub did not answer. Try again.");
        default: {
          const unreachable: never = membership;
          throw new Error(`unknown membership ${String(unreachable)}`);
        }
      }
      // The handover completes only when GitHub confirms the token is gone.
      if (!(await revoke()))
        return failure(
          503,
          "internal",
          "GitHub did not confirm revoking the login token, so no credential was issued. Try again.",
        );
      const now = svc.now();
      const source = describeSource(c.req.raw);
      await svc.accounts.upsertResponder(user, now);
      const issued = await svc.machines.issue(
        user.githubId,
        machine,
        source,
        now,
      );
      switch (issued.kind) {
        case "issued": {
          const topic = await svc.accounts.ntfyTopic(user.githubId);
          if (svc.notifier && topic)
            svc.defer(
              svc.notifier
                .send(
                  topic,
                  machineLoginPush(
                    user.login,
                    machine,
                    source.source,
                    svc.config.origin,
                  ),
                )
                .catch((error) => {
                  console.warn({ event: "push_failed", error: String(error) });
                }),
            );
          return json({
            credential: issued.credential,
            machine,
            owner: user.login,
          } satisfies MachineToken);
        }
        case "name_taken":
          return failure(409, "conflict", issued.message);
        default: {
          const unreachable: never = issued;
          throw new Error(`unknown issue result ${String(unreachable)}`);
        }
      }
    } finally {
      await revoke();
    }
  });

  /** Loads an Ask of this requester; other requesters' Asks do not exist. */
  async function ownAsk(c: Context<Env>): Promise<Ask | Response> {
    const id = c.req.param("id") ?? "";
    const stored = askId.safeParse(id).success
      ? await svc.store.getAsk(id)
      : null;
    if (!stored || stored.requesterId !== c.get("requester").id)
      return failure(404, "not_found", "No such Ask.");
    return stored.ask;
  }

  agent.post("/asks", async (c) => {
    const body = await parse(c.req.raw, LIMITS.createBytes, createAsk);
    if (!body.ok) return body.response;
    const now = svc.now();
    const result = await svc.store.createAsk(
      c.get("requester"),
      body.value,
      now,
      svc.config.schedule,
    );
    switch (result.kind) {
      case "created":
        if (result.ask.urgency === "now")
          svc.defer(pushAsk(svc, result.ask.id, now));
        return json(result.ask, 201);
      case "existing":
        return json(result.ask, 200);
      case "invalid":
        return failure(400, "invalid_request", result.message);
      case "conflict":
        return failure(409, "conflict", result.message, result.state);
      default: {
        const unreachable: never = result;
        throw new Error(`unknown result ${String(unreachable)}`);
      }
    }
  });

  agent.get("/asks", async (c) => {
    const query = listFilter.safeParse(c.req.query());
    if (!query.success)
      return failure(400, "invalid_request", describeIssues(query.error));
    const { state, terminal, after, prefix, repo } = query.data;
    const now = svc.now();
    const page = await svc.store.listForRequester(
      c.get("requester").id,
      {
        state,
        unfinished: terminal === "none",
        after: after ?? null,
        prefix: prefix ?? null,
        repo: repo ?? null,
      },
      LIMITS.page,
    );
    await svc.store.markDelivered(page.asks, now);
    return json(page satisfies AskList);
  });

  agent.get("/asks/:id", async (c) => {
    const ask = await ownAsk(c);
    if (ask instanceof Response) return ask;
    const now = svc.now();
    if (
      ask.state === "open" &&
      ask.expiresAt !== null &&
      ask.expiresAt <= now
    ) {
      await svc.store.expireIfDue(ask.id, now);
      return json((await svc.store.getAsk(ask.id))?.ask ?? ask);
    }
    await svc.store.markDelivered([ask], now);
    return json(ask);
  });

  agent.post("/asks/:id/withdraw", async (c) => {
    const ask = await ownAsk(c);
    if (ask instanceof Response) return ask;
    return transitionResponse(
      await svc.store.withdraw(c.get("requester").id, ask.id, svc.now()),
    );
  });

  agent.post("/asks/:id/trace", async (c) => {
    const ask = await ownAsk(c);
    if (ask instanceof Response) return ask;
    const body = await parse(c.req.raw, LIMITS.traceBytes, appendTrace);
    if (!body.ok) return body.response;
    const problem = body.value.url
      ? evidenceProblem(ask, body.value.event, body.value.url)
      : null;
    if (problem) return failure(400, "invalid_request", problem);
    return transitionResponse(
      await svc.store.appendTrace(ask.id, body.value, svc.now()),
    );
  });

  agent.get("/events", async (c) => {
    const after = Number(c.req.query("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0)
      return failure(
        400,
        "invalid_request",
        "after must be a cursor from a previous response.",
      );
    const page = await svc.store.events(
      c.get("requester").id,
      after,
      LIMITS.page,
    );
    await svc.store.markDeliveredById(page.askIds, svc.now());
    return json({
      events: page.events,
      next: page.events.at(-1)?.cursor ?? after,
    } satisfies EventList);
  });

  // ---- Inbox API: session cookie only --------------------------------------

  const inbox = new Hono<Env>();
  inbox.use(async (c, next) => {
    // A cross-site request never reaches a handler with a session, whatever
    // the browser does with SameSite.
    if (c.req.method !== "GET" && c.req.header("origin") !== svc.config.origin)
      return failure(
        403,
        "forbidden",
        "Cross-origin requests are not accepted.",
      );
    const cookie = getCookie(c, SESSION_COOKIE);
    const responder = cookie
      ? await svc.accounts.session(cookie, svc.now())
      : null;
    if (!responder) return failure(401, "unauthorized", "Sign in with GitHub.");
    c.set("responder", responder);
    await next();
  });

  /** Loads an Ask addressed to the signed-in person. */
  async function addressedAsk(c: Context<Env>): Promise<Ask | Response> {
    const id = c.req.param("id") ?? "";
    const stored = askId.safeParse(id).success
      ? await svc.store.getAsk(id)
      : null;
    if (!stored || stored.responderId !== c.get("responder").githubId)
      return failure(404, "not_found", "No such Ask in your inbox.");
    return stored.ask;
  }

  inbox.get("/me", async (c) => {
    const me = c.get("responder");
    const [keys, ntfyTopic] = await Promise.all([
      svc.accounts.passkeys(me.githubId),
      svc.accounts.ntfyTopic(me.githubId),
    ]);
    return json({
      login: me.login,
      githubId: me.githubId,
      ntfyTopic,
      pushes: svc.notifier !== null,
      passkeys: keys.map((k) => ({
        id: k.id,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    });
  });

  inbox.put("/me/notifications", async (c) => {
    const body = await parse(
      c.req.raw,
      LIMITS.adminBytes,
      notificationSettings,
    );
    if (!body.ok) return body.response;
    await svc.accounts.setNtfyTopic(
      c.get("responder").githubId,
      body.value.ntfyTopic,
    );
    return new Response(null, { status: 204 });
  });

  inbox.get("/", async (c) => {
    const me = c.get("responder");
    const now = svc.now();
    const [open, stalled] = await Promise.all([
      svc.store.openFor(me.githubId, INBOX_LIMIT),
      svc.store.stalledFor(me.githubId, now, INBOX_LIMIT),
    ]);
    // The list is bounded; the total tells the page when more are waiting.
    const openTotal = await svc.store.openCount(me.githubId);
    return json({ open, stalled, openTotal, now });
  });

  inbox.get("/history", async (c) => {
    const before = c.req.query("before");
    const match =
      before === undefined ? null : /^(\d{1,16})\.([0-9A-Z]{26})$/.exec(before);
    if (before !== undefined && !match)
      return failure(
        400,
        "invalid_request",
        "before must be a cursor from a previous page.",
      );
    const cursor = match
      ? { closedAt: Number(match[1]), id: match[2] ?? "" }
      : null;
    return json(
      await svc.store.historyFor(
        c.get("responder").githubId,
        cursor,
        HISTORY_LIMIT,
      ),
    );
  });

  inbox.get("/asks/:id", async (c) => {
    const ask = await addressedAsk(c);
    return ask instanceof Response ? ask : json(ask);
  });

  /**
   * Checks an answer against the Ask without writing anything. Returns the
   * chosen option and the normalized input, or the error response.
   */
  function checkAnswer(ask: Ask, request: Omit<AnswerRequest, "assertion">) {
    if (ask.state !== "open")
      return {
        error: failure(
          409,
          "conflict",
          "This Ask is no longer open.",
          ask.state,
        ),
      };
    const option =
      request.option === CUSTOM_REPLY.id
        ? CUSTOM_REPLY
        : ask.options.find((o) => o.id === request.option);
    if (!option)
      return { error: failure(400, "invalid_request", "No such option.") };
    const input = request.input?.trim() || null;
    if (option.inputRequired && !input)
      return {
        error: failure(
          400,
          "invalid_request",
          `"${option.label}" needs instructions.`,
        ),
      };
    if (ask.action && request.rev !== ask.action.rev)
      return {
        error: failure(
          409,
          "conflict",
          "The revision you saw is not the one this Ask approves. Reload it.",
          ask.state,
        ),
      };
    return { option, input };
  }

  async function answerBinding(
    ask: Ask,
    optionId: string,
    input: string | null,
  ) {
    return {
      askId: ask.id,
      optionId,
      rev: ask.action?.rev ?? null,
      input: await sha256(input ?? ""),
    };
  }

  inbox.post("/asks/:id/challenge", async (c) => {
    const ask = await addressedAsk(c);
    if (ask instanceof Response) return ask;
    const body = await parse(c.req.raw, LIMITS.answerBytes, answerChallenge);
    if (!body.ok) return body.response;
    const checked = checkAnswer(ask, body.value);
    if (checked.error) return checked.error;
    if (checked.option.decision !== "approve")
      return failure(400, "invalid_request", "Only approvals need a passkey.");
    const options = await svc.passkeys.assertionOptions(
      c.get("responder"),
      "answer",
      await answerBinding(ask, checked.option.id, checked.input),
      svc.now(),
    );
    if (!options)
      return failure(403, "forbidden", "Register a passkey before approving.");
    return json(options);
  });

  inbox.post("/asks/:id/answer", async (c) => {
    const ask = await addressedAsk(c);
    if (ask instanceof Response) return ask;
    const body = await parse(c.req.raw, LIMITS.answerBytes, answer);
    if (!body.ok) return body.response;
    const checked = checkAnswer(ask, body.value);
    if (checked.error) return checked.error;
    const me = c.get("responder");
    const now = svc.now();
    let passkeyId: string | null = null;
    // Only an approval grants permission, so only an approval needs the person present.
    if (checked.option.decision === "approve") {
      if (body.value.assertion === undefined)
        return failure(
          403,
          "forbidden",
          "Approving needs a passkey assertion.",
        );
      const verified = await svc.passkeys.verifyAssertion(
        me,
        "answer",
        body.value.assertion,
        now,
      );
      if (!verified.ok) return failure(403, "forbidden", verified.message);
      const expected = await answerBinding(
        ask,
        checked.option.id,
        checked.input,
      );
      if (canonicalJson(verified.binding) !== canonicalJson(expected))
        return failure(
          403,
          "forbidden",
          "The passkey assertion was made for a different answer.",
        );
      passkeyId = verified.passkeyId;
    }
    return transitionResponse(
      await svc.store.answer(
        ask.id,
        {
          option: checked.option,
          input: checked.input,
          responder: me,
          passkeyId,
        },
        now,
      ),
    );
  });

  inbox.post("/passkeys/options", async (c) =>
    json(await svc.passkeys.registrationOptions(c.get("responder"), svc.now())),
  );

  inbox.post("/passkeys", async (c) => {
    const body = await jsonBody(c.req.raw, LIMITS.answerBytes);
    if (!body.ok) return body.response;
    const value = body.value;
    if (
      typeof value !== "object" ||
      value === null ||
      !("registration" in value)
    )
      return failure(400, "invalid_request", "registration is required.");
    const me = c.get("responder");
    const now = svc.now();
    const stepUp = "stepUp" in value ? value.stepUp : undefined;
    const result = await svc.passkeys.register(
      me,
      value.registration,
      stepUp,
      now,
    );
    if (!result.ok) return failure(403, "forbidden", result.message);
    const topic = await svc.accounts.ntfyTopic(me.githubId);
    if (svc.notifier && topic)
      svc.defer(
        svc.notifier
          .send(topic, passkeyAddedPush(me.login, svc.config.origin))
          .catch((error) => {
            console.warn({ event: "push_failed", error: String(error) });
          }),
      );
    return new Response(null, { status: 201 });
  });

  inbox.get("/requesters", async (c) => {
    const query = requesterCursor.safeParse(c.req.query());
    if (!query.success)
      return failure(400, "invalid_request", describeIssues(query.error));
    return json(
      await svc.accounts.requesters(
        c.get("responder").githubId,
        REQUESTER_PAGE,
        query.data.after || null,
      ),
    );
  });

  inbox.post("/requesters", async (c) => {
    const body = await parse(c.req.raw, LIMITS.adminBytes, newRequester);
    if (!body.ok) return body.response;
    const id = await svc.accounts.createRequester(
      body.value.name,
      body.value.pickupMinutes ?? DEFAULT_PICKUP_MINUTES,
      body.value.completionMinutes ?? DEFAULT_COMPLETION_MINUTES,
      c.get("responder").githubId,
      svc.now(),
    );
    return id
      ? json({ id }, 201)
      : failure(409, "conflict", "That name is taken.");
  });

  inbox.post("/requesters/:id/disable", async (c) =>
    (await svc.accounts.disableRequester(
      c.req.param("id"),
      c.get("responder").githubId,
      svc.now(),
    ))
      ? new Response(null, { status: 204 })
      : failure(404, "not_found", "No enabled requester of yours has that id."),
  );

  inbox.post("/requesters/:id/tokens", async (c) => {
    const issued = await svc.accounts.issueToken(
      c.req.param("id"),
      c.get("responder").githubId,
      svc.now(),
    );
    return issued
      ? json(issued, 201)
      : failure(404, "not_found", "No enabled requester of yours has that id.");
  });

  inbox.post("/tokens/:id/revoke", async (c) =>
    (await svc.accounts.revokeToken(
      c.req.param("id"),
      c.get("responder").githubId,
      svc.now(),
    ))
      ? new Response(null, { status: 204 })
      : failure(404, "not_found", "No active token of yours has that id."),
  );

  inbox.get("/machines", async (c) => {
    const query = machineCursor.safeParse(c.req.query());
    if (!query.success)
      return failure(400, "invalid_request", describeIssues(query.error));
    return json(
      await svc.machines.list(
        c.get("responder").githubId,
        query.data.after || null,
      ),
    );
  });

  inbox.post("/requesters/:id/adopt", async (c) => {
    const body = await parse(c.req.raw, LIMITS.adminBytes, machineRef);
    if (!body.ok) return body.response;
    const result = await svc.machines.adopt(
      c.req.param("id"),
      body.value.machineId,
      c.get("responder").githubId,
    );
    switch (result.kind) {
      case "adopted":
        return json({ machine: result.machine });
      case "not_found":
        return failure(
          404,
          "not_found",
          "No enabled, unbound requester and active machine of yours match.",
        );
      case "conflict":
      case "full":
        return failure(409, "conflict", result.message);
      default: {
        const unreachable: never = result;
        throw new Error(`unknown adoption ${String(unreachable)}`);
      }
    }
  });

  inbox.post("/requesters/:id/release", async (c) =>
    (await svc.machines.release(c.req.param("id"), c.get("responder").githubId))
      ? c.body(null, 204)
      : failure(404, "not_found", "No adopted requester of yours has that id."),
  );

  inbox.post("/machines/:id/revoke", async (c) =>
    (await svc.machines.revoke(
      c.req.param("id"),
      c.get("responder").githubId,
      svc.now(),
    ))
      ? c.body(null, 204)
      : failure(404, "not_found", "No active machine of yours has that id."),
  );

  // ---- Sign-in -------------------------------------------------------------

  const auth = new Hono<Env>();
  const callbackUrl = `${svc.config.origin}/auth/callback`;
  const cookieBase = { httpOnly: true, secure: true, path: "/" } as const;

  auth.get("/login", (c) => {
    const state = secret("");
    // Lax, because GitHub's redirect back is a cross-site navigation.
    setCookie(c, OAUTH_COOKIE, state, {
      ...cookieBase,
      sameSite: "Lax",
      maxAge: 600,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", svc.config.github.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("scope", LOGIN_SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return c.redirect(url.toString(), 302);
  });

  auth.get("/callback", async (c) => {
    const expected = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, cookieBase);
    const code = c.req.query("code");
    if (!expected || !code || c.req.query("state") !== expected)
      return c.text(
        "Sign-in expired or was not started here. Try again from the inbox.",
        400,
      );
    const token = await svc.github.exchange(code, callbackUrl);
    const user = token ? await svc.github.user(token) : null;
    if (!token || !user)
      return c.text("GitHub did not confirm who you are.", 403);
    const { org, team } = svc.config.github;
    const membership = await svc.github.teamMembership(
      token,
      org,
      team,
      user.login,
    );
    switch (membership) {
      case "active":
        break;
      case "none":
        return c.text(`Roger is limited to members of ${org}/${team}.`, 403);
      case "unavailable":
        return c.text("GitHub did not answer. Try signing in again.", 503);
      default: {
        const unreachable: never = membership;
        throw new Error(`unknown membership ${String(unreachable)}`);
      }
    }
    const now = svc.now();
    await svc.accounts.upsertResponder(user, now);
    const session = await svc.accounts.createSession(user.githubId, now);
    setCookie(c, SESSION_COOKIE, session, {
      ...cookieBase,
      sameSite: "Strict",
      maxAge: SESSION_MS / 1000,
    });
    return c.redirect("/", 302);
  });

  auth.post("/logout", async (c) => {
    if (c.req.header("origin") !== svc.config.origin)
      return failure(
        403,
        "forbidden",
        "Cross-origin requests are not accepted.",
      );
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) await svc.accounts.endSession(cookie);
    deleteCookie(c, SESSION_COOKIE, cookieBase);
    // c.body keeps the Set-Cookie header that clears the cookie; a bare Response drops it.
    return c.body(null, 204);
  });

  app.route("/v1/inbox", inbox);
  app.route("/v1", agent);
  app.route("/auth", auth);
  return app;
}
