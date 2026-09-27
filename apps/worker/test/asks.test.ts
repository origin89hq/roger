import { describe, expect, it } from "vitest";
import type { Ask, AskList, EventList } from "../src/protocol.gen.ts";
import {
  agent,
  approval,
  auditOf,
  browser,
  count,
  createAsk,
  errorOf,
  MONDAY_10AM,
  minutes,
  newTopic,
  ORIGIN,
  person,
  question,
  readAsk,
  reject,
  requester,
  send,
  services,
} from "./helpers.ts";

describe("creating an Ask", () => {
  it("opens an approval addressed to the requester's owner", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const body = approval();
    const response = await agent(svc, bot.token, "POST", "/v1/asks", body);
    expect(response.status).toBe(201);
    const ask = await response.json<Ask>();
    expect(ask).toMatchObject({
      requester: bot.name,
      to: me.login,
      repo: "origin89hq/roger",
      decisionKey: body.decisionKey,
      state: "open",
      kind: "approval",
      action: {
        verb: "merge",
        target: "pr:origin89hq/roger#2",
        rev: body.action?.rev,
        limits: "squash",
      },
      supersedes: null,
      supersededBy: null,
      expiresAt: null,
      createdAt: MONDAY_10AM,
      closedAt: null,
      answer: null,
      trace: [],
    });
    expect(ask.options.map((o) => [o.id, o.decision, o.inputRequired])).toEqual(
      [
        ["approve", "approve", false],
        ["reject", "reject", false],
        ["fix", "other", true],
      ],
    );
    expect(await auditOf(ask.id)).toEqual([
      { state: "open", actor: `requester:${bot.id}`, at: MONDAY_10AM },
    ]);
  });

  it("pushes a `now` Ask to its recipient's topic without the body, links, or action", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ urgency: "now", risk: "sensitive" }),
    );
    await svc.settle();
    expect(svc.notifier.sent).toEqual([
      {
        topic,
        push: {
          title: ask.title,
          message: `now · sensitive · ${bot.name} · origin89hq/roger`,
          priority: 5,
          tags: ["warning"],
          click: `${ORIGIN}/#ask=${ask.id}`,
        },
      },
    ]);
  });

  it("does not push a `later` Ask", async () => {
    const svc = services();
    const me = await person(svc, newTopic());
    const bot = await requester(svc, me);
    await createAsk(svc, bot.token, approval({ urgency: "later" }));
    await svc.settle();
    expect(svc.notifier.sent).toEqual([]);
  });

  it("routes an Ask to another signed-in person named in `to`", async () => {
    const svc = services();
    const owner = await person(svc);
    const other = await person(svc);
    const bot = await requester(svc, owner);
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ to: other.login.toUpperCase() }),
    );
    expect(ask.to).toBe(other.login);
    const theirs = await (
      await browser(svc, other.cookie, "GET", "/v1/inbox")
    ).json<{ open: Ask[] }>();
    const mine = await (
      await browser(svc, owner.cookie, "GET", "/v1/inbox")
    ).json<{ open: Ask[] }>();
    expect(theirs.open.map((a) => a.id)).toEqual([ask.id]);
    expect(mine.open).toEqual([]);
  });

  it("rejects a `to` who has never signed in", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const body = approval({ to: "nobody-has-this-login" });
    const response = await agent(svc, bot.token, "POST", "/v1/asks", body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_request");
    expect(await count("asks", "idem_key = ?", body.idemKey)).toBe(0);
  });

  it("returns the existing Ask for a repeated create with the same content", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const body = approval();
    const first = await createAsk(svc, bot.token, body);
    svc.clock.now += minutes(5);
    const again = await agent(svc, bot.token, "POST", "/v1/asks", body);
    expect(again.status).toBe(200);
    expect(await again.json<Ask>()).toEqual(first);
    expect(await count("asks", "requester_id = ?", bot.id)).toBe(1);
  });

  it("refuses a repeated idempotency key with different content", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const body = approval();
    const first = await createAsk(svc, bot.token, body);
    const response = await agent(svc, bot.token, "POST", "/v1/asks", {
      ...body,
      title: "Merge: something else",
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("conflict");
    expect((await readAsk(svc, bot.token, first.id)).title).toBe(body.title);
    expect(await count("asks", "requester_id = ?", bot.id)).toBe(1);
  });

  it("refuses a second open Ask for the same decision key and names the open one", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const first = await createAsk(svc, bot.token);
    const second = approval({ decisionKey: first.decisionKey });
    const response = await agent(svc, bot.token, "POST", "/v1/asks", second);
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.state).toBe("open");
    expect(error.message).toContain(first.id);
    expect(await count("asks", "idem_key = ?", second.idemKey)).toBe(0);
  });

  it("allows the same decision key once the earlier Ask is closed", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const first = await createAsk(svc, bot.token);
    expect(
      (await agent(svc, bot.token, "POST", `/v1/asks/${first.id}/withdraw`))
        .status,
    ).toBe(200);
    const next = await agent(
      svc,
      bot.token,
      "POST",
      "/v1/asks",
      approval({ decisionKey: first.decisionKey }),
    );
    expect(next.status).toBe(201);
  });
});

describe("supersession", () => {
  it("closes the named Ask and opens its replacement", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const old = await createAsk(svc, bot.token);
    svc.clock.now += minutes(1);
    const response = await agent(
      svc,
      bot.token,
      "POST",
      "/v1/asks",
      approval({ decisionKey: old.decisionKey, supersedes: old.id }),
    );
    expect(response.status).toBe(201);
    const replacement = await response.json<Ask>();
    expect(replacement).toMatchObject({
      state: "open",
      supersedes: old.id,
      supersededBy: null,
    });
    const closed = await readAsk(svc, bot.token, old.id);
    expect(closed).toMatchObject({
      state: "superseded",
      supersededBy: replacement.id,
      closedAt: svc.clock.now,
      answer: null,
    });
    expect((await auditOf(old.id)).map((e) => e.state)).toEqual([
      "open",
      "superseded",
    ]);
  });

  it("refuses to supersede a closed Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const old = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${old.id}/withdraw`);
    const body = approval({ decisionKey: old.decisionKey, supersedes: old.id });
    const response = await agent(svc, bot.token, "POST", "/v1/asks", body);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).state).toBe("withdrawn");
    expect(await count("asks", "idem_key = ?", body.idemKey)).toBe(0);
    expect((await readAsk(svc, bot.token, old.id)).supersededBy).toBeNull();
  });

  it("refuses to supersede an Ask already superseded by a newer one", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const old = await createAsk(svc, bot.token);
    const newer = await createAsk(
      svc,
      bot.token,
      approval({ decisionKey: old.decisionKey, supersedes: old.id }),
    );
    const delayed = approval({
      decisionKey: old.decisionKey,
      supersedes: old.id,
    });
    const response = await agent(svc, bot.token, "POST", "/v1/asks", delayed);
    expect(response.status).toBe(409);
    expect(await count("asks", "idem_key = ?", delayed.idemKey)).toBe(0);
    expect((await readAsk(svc, bot.token, newer.id)).state).toBe("open");
  });

  it("refuses to supersede another requester's Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const mine = await requester(svc, me);
    const theirs = await requester(svc, me);
    const target = await createAsk(svc, theirs.token);
    const body = approval({
      decisionKey: target.decisionKey,
      supersedes: target.id,
    });
    const response = await agent(svc, mine.token, "POST", "/v1/asks", body);
    expect(response.status).toBe(409);
    // Another requester's Ask must not leak its state.
    expect((await errorOf(response)).state).toBeNull();
    expect(await count("asks", "idem_key = ?", body.idemKey)).toBe(0);
    expect((await readAsk(svc, theirs.token, target.id)).state).toBe("open");
  });

  it("refuses to supersede an Ask with a different decision key", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const target = await createAsk(svc, bot.token);
    const body = approval({ supersedes: target.id });
    const response = await agent(svc, bot.token, "POST", "/v1/asks", body);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain("same decision key");
    expect(await count("asks", "idem_key = ?", body.idemKey)).toBe(0);
    expect((await readAsk(svc, bot.token, target.id)).state).toBe("open");
  });
});

describe("create validation", () => {
  const withOptions = (options: unknown) => ({ ...approval(), options });
  const cases: [string, (b: ReturnType<typeof approval>) => unknown][] = [
    ["an approval without an action", (b) => ({ ...b, action: null })],
    [
      "an approval with two approve options",
      () =>
        withOptions([
          { id: "a", label: "Yes", decision: "approve" },
          { id: "b", label: "Also yes", decision: "approve" },
          { id: "c", label: "No", decision: "reject" },
        ]),
    ],
    [
      "a question offering approve",
      () =>
        question({
          options: [
            { id: "a", label: "Yes", decision: "approve" },
            { id: "b", label: "No", decision: "other" },
          ],
        }),
    ],
    [
      "an fyi with two options",
      () =>
        question({
          kind: "fyi",
          options: [
            { id: "a", label: "Seen", decision: "other" },
            { id: "b", label: "Also seen", decision: "other" },
          ],
        }),
    ],
    [
      "duplicate option ids",
      () =>
        withOptions([
          { id: "a", label: "Yes", decision: "approve" },
          { id: "a", label: "No", decision: "reject" },
        ]),
    ],
    [
      "a short revision",
      (b) => ({
        ...b,
        action: { verb: "merge", target: "pr:x#1", rev: "abc123" },
      }),
    ],
    [
      "an uppercase revision",
      (b) => ({
        ...b,
        action: { verb: "merge", target: "pr:x#1", rev: "A".repeat(40) },
      }),
    ],
    ["a title over 120 characters", (b) => ({ ...b, title: "x".repeat(121) })],
    ["a title with a newline", (b) => ({ ...b, title: "Merge\nnow" })],
    [
      "a non-https link",
      (b) => ({ ...b, links: [{ label: "PR", url: "http://github.com/x" }] }),
    ],
    ["a body over 16 KiB", (b) => ({ ...b, body: "x".repeat(16 * 1024 + 1) })],
    ["an unknown field", (b) => ({ ...b, color: "red" })],
    ["zero expiry minutes", (b) => ({ ...b, expiresInMinutes: 0 })],
  ];

  for (const [name, build] of cases) {
    it(`rejects ${name} with 400 and creates nothing`, async () => {
      const svc = services();
      const me = await person(svc);
      const bot = await requester(svc, me);
      const response = await agent(
        svc,
        bot.token,
        "POST",
        "/v1/asks",
        build(approval()),
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_request");
      expect(await count("asks", "requester_id = ?", bot.id)).toBe(0);
    });
  }

  it("accepts a 120-character title and a 16 KiB body", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ title: "x".repeat(120), body: "é".repeat(8 * 1024) }),
    );
    expect(ask.title).toHaveLength(120);
    expect(ask.body).toHaveLength(8 * 1024);
  });

  it("rejects a request body over 64 KiB with 413", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const response = await agent(
      svc,
      bot.token,
      "POST",
      "/v1/asks",
      approval({ body: "x".repeat(70 * 1024) }),
    );
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("too_large");
    expect(await count("asks", "requester_id = ?", bot.id)).toBe(0);
  });

  it("rejects a body that is not JSON by content type with 415", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const response = await send(
      svc,
      new Request(`${ORIGIN}/v1/asks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bot.token}`,
          "content-type": "text/plain",
        },
        body: JSON.stringify(approval()),
      }),
    );
    expect(response.status).toBe(415);
    expect(await count("asks", "requester_id = ?", bot.id)).toBe(0);
  });

  it("rejects invalid JSON with 400", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const response = await agent(
      svc,
      bot.token,
      "POST",
      "/v1/asks",
      '{"kind": "approval",',
    );
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("not valid JSON");
  });
});

describe("agent authentication", () => {
  it("rejects a request without a token", async () => {
    const svc = services();
    const response = await agent(svc, null, "GET", "/v1/asks");
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthorized");
  });

  it("rejects a malformed token", async () => {
    const svc = services();
    const response = await agent(svc, "roger_short", "GET", "/v1/asks");
    expect(response.status).toBe(401);
  });

  it("rejects a well-formed token that was never issued", async () => {
    const svc = services();
    const response = await agent(
      svc,
      `roger_${"A".repeat(43)}`,
      "POST",
      "/v1/asks",
      approval(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    expect((await agent(svc, bot.token, "GET", "/v1/asks")).status).toBe(200);
    await svc.accounts.revokeToken(bot.tokenId, me.githubId, svc.now());
    expect((await agent(svc, bot.token, "GET", "/v1/asks")).status).toBe(401);
  });

  it("rejects a token of a disabled requester", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    await svc.accounts.disableRequester(bot.id, me.githubId, svc.now());
    const response = await agent(
      svc,
      bot.token,
      "POST",
      "/v1/asks",
      approval(),
    );
    expect(response.status).toBe(401);
    expect(await count("asks", "requester_id = ?", bot.id)).toBe(0);
  });

  it("rejects a session cookie on agent routes", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    for (const [method, path] of [
      ["GET", "/v1/asks"],
      ["GET", `/v1/asks/${ask.id}`],
      ["POST", `/v1/asks/${ask.id}/withdraw`],
      ["GET", "/v1/events"],
    ] as const) {
      const response = await browser(svc, me.cookie, method, path);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });

  it("hides another requester's Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const mine = await requester(svc, me);
    const theirs = await requester(svc, me);
    const ask = await createAsk(svc, theirs.token);
    expect(
      (await agent(svc, mine.token, "GET", `/v1/asks/${ask.id}`)).status,
    ).toBe(404);
    expect(
      (await agent(svc, mine.token, "POST", `/v1/asks/${ask.id}/withdraw`))
        .status,
    ).toBe(404);
    expect(
      (
        await agent(svc, mine.token, "POST", `/v1/asks/${ask.id}/trace`, {
          event: "progress",
        })
      ).status,
    ).toBe(404);
    expect((await readAsk(svc, theirs.token, ask.id)).state).toBe("open");
  });

  it("returns 404 for an id that is not an Ask id", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    expect(
      (await agent(svc, bot.token, "GET", "/v1/asks/not-an-id")).status,
    ).toBe(404);
  });
});

describe("withdrawing", () => {
  it("withdraws an open Ask with an audit record", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    svc.clock.now += minutes(3);
    const response = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${ask.id}/withdraw`,
    );
    expect(response.status).toBe(200);
    expect(await response.json<Ask>()).toMatchObject({
      state: "withdrawn",
      closedAt: svc.clock.now,
      answer: null,
    });
    expect(await auditOf(ask.id)).toEqual([
      { state: "open", actor: `requester:${bot.id}`, at: MONDAY_10AM },
      { state: "withdrawn", actor: `requester:${bot.id}`, at: svc.clock.now },
    ]);
  });

  it("refuses to withdraw twice and reports the state", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/withdraw`);
    const again = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${ask.id}/withdraw`,
    );
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toMatchObject({
      code: "conflict",
      state: "withdrawn",
    });
    expect(
      await count("ask_events", "ask_id = ? AND state <> 'open'", ask.id),
    ).toBe(1);
  });

  it("refuses to withdraw an answered Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, ask.id);
    const response = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${ask.id}/withdraw`,
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).state).toBe("answered");
  });
});

describe("expiry", () => {
  it("reads an Ask past its expiry as expired, without an answer", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ expiresInMinutes: 60 }),
    );
    expect(ask.expiresAt).toBe(MONDAY_10AM + minutes(60));
    svc.clock.now = MONDAY_10AM + minutes(60) - 1;
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
    svc.clock.now = MONDAY_10AM + minutes(60);
    const expired = await readAsk(svc, bot.token, ask.id);
    expect(expired).toMatchObject({
      state: "expired",
      answer: null,
      closedAt: svc.clock.now,
      trace: [],
    });
    expect(await auditOf(ask.id)).toEqual([
      { state: "open", actor: `requester:${bot.id}`, at: MONDAY_10AM },
      { state: "expired", actor: "roger", at: svc.clock.now },
    ]);
    expect(await count("answers", "ask_id = ?", ask.id)).toBe(0);
  });

  it("counts expiry in working time across a weekend", async () => {
    // Friday 2026-09-25 17:30 in Toronto (EDT).
    const svc = services(Date.parse("2026-09-25T21:30:00Z"));
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ expiresInMinutes: 60 }),
    );
    // Thirty minutes on Friday, thirty on Monday morning: 08:30 EDT.
    expect(ask.expiresAt).toBe(Date.parse("2026-09-28T12:30:00Z"));
  });
});

describe("listing and delivery", () => {
  it("lists open Asks by default and rejects an unknown state", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const open = await createAsk(svc, bot.token);
    const closed = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${closed.id}/withdraw`);
    const list = await (
      await agent(svc, bot.token, "GET", "/v1/asks")
    ).json<AskList>();
    expect(list).toEqual({ asks: [open], next: null });
    expect(
      (await agent(svc, bot.token, "GET", "/v1/asks?state=withdrawn")).status,
    ).toBe(400);
    expect(
      (await agent(svc, bot.token, "GET", "/v1/asks?after=nope")).status,
    ).toBe(400);
  });

  it("pages answered Asks without a terminal trace", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ids: string[] = [];
    for (let i = 0; i < 102; i++) {
      const ask = await createAsk(svc, bot.token, approval({ urgency: "fyi" }));
      await reject(svc, me.cookie, ask.id);
      ids.push(ask.id);
    }
    const finished = ids[50] ?? "";
    const trace = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${finished}/trace`,
      {
        event: "not_applicable",
      },
    );
    expect(trace.status).toBe(200);
    // An open Ask is never listed as answered.
    await createAsk(svc, bot.token);
    const unfinished = ids.filter((id) => id !== finished);

    const first = await (
      await agent(
        svc,
        bot.token,
        "GET",
        "/v1/asks?state=answered&terminal=none",
      )
    ).json<AskList>();
    expect(first.asks.map((a) => a.id)).toEqual(unfinished.slice(0, 100));
    expect(first.next).toBe(unfinished[99]);
    const second = await (
      await agent(
        svc,
        bot.token,
        "GET",
        `/v1/asks?state=answered&terminal=none&after=${first.next}`,
      )
    ).json<AskList>();
    expect(second).toMatchObject({ next: null });
    expect(second.asks.map((a) => a.id)).toEqual(unfinished.slice(100));

    const all = await (
      await agent(
        svc,
        bot.token,
        "GET",
        `/v1/asks?state=answered&after=${ids[99]}`,
      )
    ).json<AskList>();
    expect(all.asks.map((a) => a.id)).toEqual(ids.slice(100));
  });

  it("records `delivered` once however often the answer is read", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, ask.id);
    svc.clock.now += minutes(7);
    const deliveredAt = svc.clock.now;
    await readAsk(svc, bot.token, ask.id);
    svc.clock.now += minutes(1);
    await readAsk(svc, bot.token, ask.id);
    await agent(svc, bot.token, "GET", "/v1/asks?state=answered");
    const last = await readAsk(svc, bot.token, ask.id);
    expect(last.trace).toEqual([
      {
        id: expect.any(String),
        event: "delivered",
        refs: {},
        url: null,
        note: null,
        at: deliveredAt,
      },
    ]);
    expect(
      await count("trace", "ask_id = ? AND event = 'delivered'", ask.id),
    ).toBe(1);
  });

  it("does not record `delivered` when the inbox reads an answered Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, ask.id);
    expect(
      (await browser(svc, me.cookie, "GET", `/v1/inbox/asks/${ask.id}`)).status,
    ).toBe(200);
    expect(await count("trace", "ask_id = ?", ask.id)).toBe(0);
  });
});

describe("events", () => {
  it("returns this requester's transitions in order with a cursor", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const other = await requester(svc, me);
    const a = await createAsk(svc, bot.token);
    await createAsk(svc, other.token);
    svc.clock.now += 1000;
    await agent(svc, bot.token, "POST", `/v1/asks/${a.id}/withdraw`);
    const b = await createAsk(svc, bot.token, question());
    svc.clock.now += 1000;
    const answered = await browser(
      svc,
      me.cookie,
      "POST",
      `/v1/inbox/asks/${b.id}/answer`,
      { option: "b" },
    );
    expect(answered.status).toBe(200);

    const all = await (
      await agent(svc, bot.token, "GET", "/v1/events")
    ).json<EventList>();
    expect(all.events.map((e) => [e.askId, e.state, e.decisionKey])).toEqual([
      [a.id, "open", a.decisionKey],
      [a.id, "withdrawn", a.decisionKey],
      [b.id, "open", b.decisionKey],
      [b.id, "answered", b.decisionKey],
    ]);
    expect(all.events.map((e) => e.at)).toEqual([
      MONDAY_10AM,
      MONDAY_10AM + 1000,
      MONDAY_10AM + 1000,
      MONDAY_10AM + 2000,
    ]);
    const cursors = all.events.map((e) => e.cursor);
    expect([...cursors].sort((x, y) => x - y)).toEqual(cursors);
    expect(all.next).toBe(cursors.at(-1));
    // Reading an answered transition delivers the answer.
    expect(
      await count("trace", "ask_id = ? AND event = 'delivered'", b.id),
    ).toBe(1);

    const rest = await (
      await agent(svc, bot.token, "GET", `/v1/events?after=${cursors[1]}`)
    ).json<EventList>();
    expect(rest.events.map((e) => e.cursor)).toEqual(cursors.slice(2));
    const none = await (
      await agent(svc, bot.token, "GET", `/v1/events?after=${all.next}`)
    ).json<EventList>();
    expect(none).toEqual({ events: [], next: all.next });
  });

  it("rejects a cursor that is not a non-negative integer", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    for (const after of ["-1", "1.5", "abc"]) {
      expect(
        (await agent(svc, bot.token, "GET", `/v1/events?after=${after}`))
          .status,
        after,
      ).toBe(400);
    }
  });
});
