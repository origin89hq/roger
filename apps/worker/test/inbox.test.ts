import { describe, expect, it } from "vitest";
import { SESSION_MS } from "../src/accounts.ts";
import type { Ask } from "../src/protocol.gen.ts";
import {
  agent,
  answerAsk,
  approval,
  approvalAssertion,
  auditOf,
  browser,
  challenge,
  count,
  createAsk,
  errorOf,
  MONDAY_10AM,
  minutes,
  newTopic,
  ORIGIN,
  person,
  question,
  REV,
  readAsk,
  registerPasskey,
  reject,
  requester,
  send,
  services,
} from "./helpers.ts";

interface Inbox {
  open: Ask[];
  stalled: { ask: Ask; reason: "not_delivered" | "not_finished" }[];
  openTotal: number;
  now: number;
}

async function inbox(
  svc: ReturnType<typeof services>,
  cookie: string,
): Promise<Inbox> {
  const response = await browser(svc, cookie, "GET", "/v1/inbox");
  expect(response.status).toBe(200);
  return response.json<Inbox>();
}

describe("the inbox", () => {
  it("shows only Asks addressed to the signed-in person, by urgency then age", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const bot = await requester(svc, me);
    const create = async (urgency: Ask["urgency"], to: string = me.login) => {
      svc.clock.now += 1000;
      return createAsk(svc, bot.token, approval({ urgency, to }));
    };
    const later1 = await create("later");
    const fyi = await create("fyi");
    const now1 = await create("now");
    await create("now", other.login);
    const later2 = await create("later");
    const soon = await create("soon");
    const now2 = await create("now");
    const closed = await create("now");
    await agent(svc, bot.token, "POST", `/v1/asks/${closed.id}/withdraw`);

    const view = await inbox(svc, me.cookie);
    expect(view.open.map((a) => a.id)).toEqual([
      now1.id,
      now2.id,
      soon.id,
      later1.id,
      later2.id,
      fyi.id,
    ]);
    expect(view.now).toBe(svc.clock.now);
    expect(view.stalled).toEqual([]);
    expect(view.openTotal).toBe(6);
  });

  it("hides someone else's Ask and refuses to answer it", async () => {
    const svc = services();
    const me = await person(svc);
    const stranger = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    expect(
      (await browser(svc, stranger.cookie, "GET", `/v1/inbox/asks/${ask.id}`))
        .status,
    ).toBe(404);
    const response = await answerAsk(svc, stranger.cookie, ask.id, {
      option: "reject",
      rev: REV,
    });
    expect(response.status).toBe(404);
    expect(
      (
        await challenge(svc, stranger.cookie, ask.id, {
          option: "approve",
          rev: REV,
        })
      ).status,
    ).toBe(404);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });
});

describe("answering without a passkey", () => {
  it("records a rejection that the requester reads", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    svc.clock.now += minutes(4);
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "reject",
      rev: REV,
    });
    expect(response.status).toBe(200);
    const expected = {
      optionId: "reject",
      optionLabel: "Leave",
      decision: "reject",
      input: null,
      action: ask.action,
      responder: me.login,
      responderId: me.githubId,
      passkey: false,
      answeredAt: svc.clock.now,
    };
    expect(await response.json<Ask>()).toMatchObject({
      state: "answered",
      answer: expected,
    });
    expect(await readAsk(svc, bot.token, ask.id)).toMatchObject({
      state: "answered",
      closedAt: svc.clock.now,
      answer: expected,
    });
    expect((await auditOf(ask.id)).at(-1)).toEqual({
      state: "answered",
      actor: `github:${me.githubId}`,
      at: svc.clock.now,
    });
  });

  it("requires instructions for an option that needs them", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    for (const input of [undefined, null, "", "   \n "]) {
      const body =
        input === undefined
          ? { option: "fix", rev: REV }
          : { option: "fix", rev: REV, input };
      const response = await answerAsk(svc, me.cookie, ask.id, body);
      expect(response.status, JSON.stringify(input)).toBe(400);
    }
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "fix",
      rev: REV,
      input: "  rebase first ",
    });
    expect(response.status).toBe(200);
    expect((await response.json<Ask>()).answer).toMatchObject({
      optionId: "fix",
      decision: "other",
      input: "rebase first",
      passkey: false,
    });
  });

  it("refuses an unknown option and oversized instructions", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    expect(
      (await answerAsk(svc, me.cookie, ask.id, { option: "maybe", rev: REV }))
        .status,
    ).toBe(400);
    const long = await answerAsk(svc, me.cookie, ask.id, {
      option: "fix",
      rev: REV,
      input: "x".repeat(4097),
    });
    expect(long.status).toBe(400);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });

  it("answers a question, which has no revision", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token, question());
    const response = await answerAsk(svc, me.cookie, ask.id, { option: "b" });
    expect(response.status).toBe(200);
    expect((await response.json<Ask>()).answer).toMatchObject({
      optionId: "b",
      optionLabel: "Wilco",
      action: null,
    });
  });
});

describe("approving", () => {
  async function setup() {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const { passkey, response } = await registerPasskey(svc, me.cookie);
    expect(response.status).toBe(201);
    return { svc, me, bot, passkey };
  }

  it("refuses an approval without an assertion", async () => {
    const { svc, me, bot } = await setup();
    const ask = await createAsk(svc, bot.token);
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
    });
    expect(response.status).toBe(403);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
    expect(await count("answers", "ask_id = ?", ask.id)).toBe(0);
  });

  it("records an approval made with a passkey", async () => {
    const { svc, me, bot, passkey } = await setup();
    const ask = await createAsk(svc, bot.token);
    const assertion = await approvalAssertion(svc, me.cookie, passkey, ask.id);
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
      assertion,
    });
    expect(response.status).toBe(200);
    const expected = {
      optionId: "approve",
      decision: "approve",
      passkey: true,
      action: ask.action,
    };
    expect((await response.json<Ask>()).answer).toMatchObject(expected);
    expect((await readAsk(svc, bot.token, ask.id)).answer).toMatchObject(
      expected,
    );
    expect(
      await count(
        "answers",
        "ask_id = ? AND passkey_id = ?",
        ask.id,
        passkey.id,
      ),
    ).toBe(1);
  });

  it("refuses an assertion made for different instructions, and consumes it", async () => {
    const { svc, me, bot, passkey } = await setup();
    const ask = await createAsk(svc, bot.token);
    const assertion = await approvalAssertion(svc, me.cookie, passkey, ask.id);
    const changed = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
      input: "and delete the branch",
      assertion,
    });
    expect(changed.status).toBe(403);
    expect((await errorOf(changed)).message).toContain("different answer");
    // The challenge is single use: replaying the assertion for the answer it was
    // made for fails too.
    const replay = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
      assertion,
    });
    expect(replay.status).toBe(403);
    expect((await errorOf(replay)).message).toContain("already used");
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });

  it("refuses an assertion made for another Ask", async () => {
    const { svc, me, bot, passkey } = await setup();
    const first = await createAsk(svc, bot.token);
    const second = await createAsk(svc, bot.token);
    const assertion = await approvalAssertion(
      svc,
      me.cookie,
      passkey,
      first.id,
    );
    const response = await answerAsk(svc, me.cookie, second.id, {
      option: "approve",
      rev: REV,
      assertion,
    });
    expect(response.status).toBe(403);
    expect((await readAsk(svc, bot.token, second.id)).state).toBe("open");
    expect((await readAsk(svc, bot.token, first.id)).state).toBe("open");
  });

  it("refuses a replayed assertion after a successful approval", async () => {
    const { svc, me, bot, passkey } = await setup();
    const ask = await createAsk(svc, bot.token);
    const assertion = await approvalAssertion(svc, me.cookie, passkey, ask.id);
    expect(
      (
        await answerAsk(svc, me.cookie, ask.id, {
          option: "approve",
          rev: REV,
          assertion,
        })
      ).status,
    ).toBe(200);
    const again = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
      assertion,
    });
    expect(again.status).toBe(409);
    expect(await count("answers", "ask_id = ?", ask.id)).toBe(1);
  });

  it("refuses an assertion signed by another person's passkey", async () => {
    const { svc, me, bot } = await setup();
    const intruder = await person(svc);
    const { passkey: theirs } = await registerPasskey(svc, intruder.cookie);
    const ask = await createAsk(svc, bot.token);
    const options = await (
      await challenge(svc, me.cookie, ask.id, { option: "approve", rev: REV })
    ).json<{
      challenge: string;
    }>();
    const assertion = await theirs.assert(options);
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
      assertion,
    });
    expect(response.status).toBe(403);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });

  it("refuses a stale revision", async () => {
    const { svc, me, bot, passkey } = await setup();
    const ask = await createAsk(svc, bot.token);
    const stale = "0".repeat(40);
    expect(
      (
        await challenge(svc, me.cookie, ask.id, {
          option: "approve",
          rev: stale,
        })
      ).status,
    ).toBe(409);
    const assertion = await approvalAssertion(svc, me.cookie, passkey, ask.id);
    for (const rev of [stale, null, undefined]) {
      const body =
        rev === undefined
          ? { option: "approve", assertion }
          : { option: "approve", rev, assertion };
      const response = await answerAsk(svc, me.cookie, ask.id, body);
      expect(response.status, String(rev)).toBe(409);
      expect((await errorOf(response)).state).toBe("open");
    }
    // A rejection is bound to the revision too.
    expect(
      (
        await answerAsk(svc, me.cookie, ask.id, {
          option: "reject",
          rev: stale,
        })
      ).status,
    ).toBe(409);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });

  it("refuses to approve an Ask that expired, and records no answer", async () => {
    const { svc, me, bot, passkey } = await setup();
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ expiresInMinutes: 30 }),
    );
    svc.clock.now = MONDAY_10AM + minutes(30);
    const assertion = await approvalAssertion(svc, me.cookie, passkey, ask.id);
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
      assertion,
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).state).toBe("expired");
    expect(await count("answers", "ask_id = ?", ask.id)).toBe(0);
    expect((await auditOf(ask.id)).map((e) => [e.state, e.actor])).toEqual([
      ["open", `requester:${bot.id}`],
      ["expired", "roger"],
    ]);
  });

  it("refuses to answer a withdrawn Ask", async () => {
    const { svc, me, bot } = await setup();
    const ask = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/withdraw`);
    const response = await answerAsk(svc, me.cookie, ask.id, {
      option: "reject",
      rev: REV,
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).state).toBe("withdrawn");
    expect(await count("answers", "ask_id = ?", ask.id)).toBe(0);
  });

  it("offers a challenge only for an approve option", async () => {
    const { svc, me, bot } = await setup();
    const ask = await createAsk(svc, bot.token);
    expect(
      (await challenge(svc, me.cookie, ask.id, { option: "reject", rev: REV }))
        .status,
    ).toBe(400);
  });

  it("refuses a challenge to a person without a passkey", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    const response = await challenge(svc, me.cookie, ask.id, {
      option: "approve",
      rev: REV,
    });
    expect(response.status).toBe(403);
    expect(
      await count(
        "challenges",
        "github_id = ? AND purpose = 'answer'",
        me.githubId,
      ),
    ).toBe(0);
  });
});

describe("inbox authentication", () => {
  it("refuses an agent token without a session", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    const headers = { authorization: `Bearer ${bot.token}` };
    expect(
      (await browser(svc, null, "GET", "/v1/inbox", undefined, headers)).status,
    ).toBe(401);
    const answer = await browser(
      svc,
      null,
      "POST",
      `/v1/inbox/asks/${ask.id}/answer`,
      { option: "reject", rev: REV },
      headers,
    );
    expect(answer.status).toBe(401);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
  });

  it("refuses a cross-origin or origin-less POST", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    const post = (headers: Record<string, string>) =>
      send(
        svc,
        new Request(`${ORIGIN}/v1/inbox/asks/${ask.id}/answer`, {
          method: "POST",
          headers: {
            cookie: `__Host-roger=${me.cookie}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ option: "reject", rev: REV }),
        }),
      );
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({ origin: "http://roger.test" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await readAsk(svc, bot.token, ask.id)).state).toBe("open");
    // The same request from the app's origin succeeds.
    expect((await post({ origin: ORIGIN })).status).toBe(200);
  });

  it("refuses an expired session", async () => {
    const svc = services();
    const me = await person(svc);
    svc.clock.now += SESSION_MS - 1;
    expect((await browser(svc, me.cookie, "GET", "/v1/inbox")).status).toBe(
      200,
    );
    svc.clock.now += 1;
    expect((await browser(svc, me.cookie, "GET", "/v1/inbox")).status).toBe(
      401,
    );
  });

  it("refuses an unknown session cookie", async () => {
    const svc = services();
    expect(
      (await browser(svc, "not-a-session", "GET", "/v1/inbox/me")).status,
    ).toBe(401);
    expect((await browser(svc, null, "GET", "/v1/inbox/me")).status).toBe(401);
  });
});

describe("passkeys", () => {
  it("registers a first passkey without a step-up and pushes a notice", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const { passkey, response } = await registerPasskey(svc, me.cookie);
    expect(response.status).toBe(201);
    const view = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/me")
    ).json<{
      passkeys: { id: string }[];
    }>();
    expect(view.passkeys.map((p) => p.id)).toEqual([passkey.id]);
    await svc.settle();
    expect(svc.notifier.sent).toEqual([
      {
        topic,
        push: {
          title: "A passkey was added to your Roger account",
          message: expect.stringContaining(
            `${me.login} registered a new passkey`,
          ),
          priority: 4,
          tags: ["warning"],
          click: `${ORIGIN}/#settings`,
        },
      },
    ]);
  });

  it("needs a step-up from an existing passkey to add another", async () => {
    const svc = services();
    const me = await person(svc);
    const { passkey: first } = await registerPasskey(svc, me.cookie);
    const withoutStepUp = await registerPasskey(svc, me.cookie);
    expect(withoutStepUp.response.status).toBe(403);
    expect(await count("passkeys", "github_id = ?", me.githubId)).toBe(1);
    const stranger = await foreignPasskey(svc);
    const wrongKey = await registerPasskey(svc, me.cookie, stranger);
    expect(wrongKey.response.status).toBe(403);
    expect(await count("passkeys", "github_id = ?", me.githubId)).toBe(1);
    const withStepUp = await registerPasskey(svc, me.cookie, first);
    expect(withStepUp.response.status).toBe(201);
    expect(await count("passkeys", "github_id = ?", me.githubId)).toBe(2);
  });

  it("refuses a registration without a response", async () => {
    const svc = services();
    const me = await person(svc);
    expect(
      (await browser(svc, me.cookie, "POST", "/v1/inbox/passkeys", {})).status,
    ).toBe(400);
    expect(
      (
        await browser(svc, me.cookie, "POST", "/v1/inbox/passkeys", {
          registration: {},
        })
      ).status,
    ).toBe(403);
    expect(await count("passkeys", "github_id = ?", me.githubId)).toBe(0);
  });
});

/** A passkey registered to someone else, so it signs validly but is not the person's. */
async function foreignPasskey(svc: ReturnType<typeof services>) {
  const other = await person(svc);
  const { passkey } = await registerPasskey(svc, other.cookie);
  return passkey;
}

describe("requester management", () => {
  it("lists only the signed-in person's requesters", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const mine = await requester(svc, me);
    const theirs = await requester(svc, other);
    const list = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/requesters")
    ).json<{ requesters: { id: string }[]; truncated: boolean }>();
    const ids = list.requesters.map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(list.truncated).toBe(false);
  });

  it("lets only the owner issue tokens, revoke them, or disable the requester", async () => {
    const svc = services();
    const owner = await person(svc);
    const other = await person(svc);
    const bot = await requester(svc, owner);
    const post = (path: string) => browser(svc, other.cookie, "POST", path);
    expect((await post(`/v1/inbox/requesters/${bot.id}/tokens`)).status).toBe(
      404,
    );
    expect((await post(`/v1/inbox/tokens/${bot.tokenId}/revoke`)).status).toBe(
      404,
    );
    expect((await post(`/v1/inbox/requesters/${bot.id}/disable`)).status).toBe(
      404,
    );
    expect((await agent(svc, bot.token, "GET", "/v1/asks")).status).toBe(200);
    expect(await count("tokens", "requester_id = ?", bot.id)).toBe(1);
  });

  it("creates a requester, issues a token, revokes it, and disables the requester", async () => {
    const svc = services();
    const me = await person(svc);
    const name = `bot-${crypto.randomUUID().slice(0, 8)}`;
    const created = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/requesters",
      { name, pickupMinutes: 30 },
    );
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();
    const taken = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/requesters",
      { name },
    );
    expect(taken.status).toBe(409);

    const issue = async () => {
      const response = await browser(
        svc,
        me.cookie,
        "POST",
        `/v1/inbox/requesters/${id}/tokens`,
      );
      expect(response.status).toBe(201);
      return response.json<{ id: string; token: string }>();
    };
    const first = await issue();
    const second = await issue();
    const ask = await createAsk(svc, first.token);
    expect(ask).toMatchObject({ requester: name, to: me.login });

    expect(
      (
        await browser(
          svc,
          me.cookie,
          "POST",
          `/v1/inbox/tokens/${first.id}/revoke`,
        )
      ).status,
    ).toBe(204);
    expect((await agent(svc, first.token, "GET", "/v1/asks")).status).toBe(401);
    expect(
      (
        await browser(
          svc,
          me.cookie,
          "POST",
          `/v1/inbox/tokens/${first.id}/revoke`,
        )
      ).status,
    ).toBe(404);
    expect((await agent(svc, second.token, "GET", "/v1/asks")).status).toBe(
      200,
    );

    expect(
      (
        await browser(
          svc,
          me.cookie,
          "POST",
          `/v1/inbox/requesters/${id}/disable`,
        )
      ).status,
    ).toBe(204);
    expect((await agent(svc, second.token, "GET", "/v1/asks")).status).toBe(
      401,
    );
    expect(
      (
        await browser(
          svc,
          me.cookie,
          "POST",
          `/v1/inbox/requesters/${id}/tokens`,
        )
      ).status,
    ).toBe(404);

    const list = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/requesters")
    ).json<{
      requesters: {
        id: string;
        pickupMinutes: number;
        completionMinutes: number;
        createdBy: string;
        disabledAt: number | null;
        tokens: { id: string; revokedAt: number | null }[];
      }[];
    }>();
    expect(list.requesters.find((r) => r.id === id)).toMatchObject({
      pickupMinutes: 30,
      completionMinutes: 1440,
      createdBy: me.login,
      disabledAt: svc.clock.now,
      tokens: [
        { id: first.id, revokedAt: svc.clock.now },
        { id: second.id, revokedAt: null },
      ],
    });
  });

  it("refuses an invalid requester name", async () => {
    const svc = services();
    const me = await person(svc);
    for (const name of ["", "Upper", "has space", "x".repeat(81)]) {
      const response = await browser(
        svc,
        me.cookie,
        "POST",
        "/v1/inbox/requesters",
        { name },
      );
      expect(response.status, name).toBe(400);
    }
  });
});

describe("stalled answers", () => {
  it("flags an answer not delivered within the pickup time", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me); // pickup 120, completion 1440 minutes
    const ask = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, ask.id);
    const answeredAt = svc.clock.now;
    svc.clock.now = answeredAt + minutes(120);
    expect((await inbox(svc, me.cookie)).stalled).toEqual([]);
    svc.clock.now += 1;
    const stalled = (await inbox(svc, me.cookie)).stalled;
    expect(stalled.map((s) => [s.ask.id, s.reason])).toEqual([
      [ask.id, "not_delivered"],
    ]);
    // Another person never sees it.
    const other = await person(svc);
    expect((await inbox(svc, other.cookie)).stalled).toEqual([]);
  });

  it("flags a delivered answer without a terminal event within the completion time", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, ask.id);
    svc.clock.now += minutes(10);
    const deliveredAt = svc.clock.now;
    await readAsk(svc, bot.token, ask.id);
    await agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/trace`, {
      event: "dispatched",
    });
    svc.clock.now = deliveredAt + minutes(1440);
    // A day later the person signs in again.
    const cookie = await svc.accounts.createSession(me.githubId, svc.clock.now);
    expect((await inbox(svc, cookie)).stalled).toEqual([]);
    svc.clock.now += 1;
    const stalled = (await inbox(svc, cookie)).stalled;
    expect(stalled.map((s) => [s.ask.id, s.reason])).toEqual([
      [ask.id, "not_finished"],
    ]);

    const done = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${ask.id}/trace`,
      {
        event: "applied",
        url: "https://github.com/origin89hq/roger/pull/2",
      },
    );
    expect(done.status).toBe(200);
    expect((await inbox(svc, cookie)).stalled).toEqual([]);
  });
});

describe("history", () => {
  it("pages closed Asks, most recently closed first", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const open = await createAsk(svc, bot.token);
    const closed: string[] = [];
    for (let i = 0; i < 52; i++) {
      svc.clock.now += 1000;
      const ask = await createAsk(svc, bot.token, approval({ urgency: "fyi" }));
      if (i % 2 === 0)
        await agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/withdraw`);
      else await reject(svc, me.cookie, ask.id);
      closed.push(ask.id);
    }
    const newestFirst = [...closed].reverse();

    type Page = { asks: Ask[]; next: string | null };
    const first = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/history")
    ).json<Page>();
    expect(first.asks.map((a) => a.id)).toEqual(newestFirst.slice(0, 50));
    expect(first.asks.map((a) => a.id)).not.toContain(open.id);
    expect(first.next).not.toBeNull();
    const second = await (
      await browser(
        svc,
        me.cookie,
        "GET",
        `/v1/inbox/history?before=${encodeURIComponent(first.next ?? "")}`,
      )
    ).json<Page>();
    expect(second.next).toBeNull();
    expect(second.asks.map((a) => a.id)).toEqual(newestFirst.slice(50));

    const other = await person(svc);
    expect(
      (
        await (
          await browser(svc, other.cookie, "GET", "/v1/inbox/history")
        ).json<Page>()
      ).asks,
    ).toEqual([]);
    expect(
      (await browser(svc, me.cookie, "GET", "/v1/inbox/history?before=soon"))
        .status,
    ).toBe(400);
  });

  it("neither skips nor repeats Asks closed in the same millisecond", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const ask = await createAsk(svc, bot.token, approval({ urgency: "fyi" }));
      ids.push(ask.id);
    }
    svc.clock.now += 1000;
    for (const id of ids)
      await agent(svc, bot.token, "POST", `/v1/asks/${id}/withdraw`);

    type Page = { asks: Ask[]; next: string | null };
    const first = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/history")
    ).json<Page>();
    const second = await (
      await browser(
        svc,
        me.cookie,
        "GET",
        `/v1/inbox/history?before=${encodeURIComponent(first.next ?? "")}`,
      )
    ).json<Page>();
    const seen = [...first.asks, ...second.asks].map((a) => a.id);
    expect(seen).toHaveLength(51);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(second.next).toBeNull();
  });
});

describe("notification settings", () => {
  it("sets and clears the person's topic", async () => {
    const svc = services();
    const me = await person(svc);
    const topic = newTopic();
    expect(
      (
        await browser(svc, me.cookie, "PUT", "/v1/inbox/me/notifications", {
          ntfyTopic: topic,
        })
      ).status,
    ).toBe(204);
    expect(await svc.accounts.ntfyTopic(me.githubId)).toBe(topic);
    expect(
      (
        await browser(svc, me.cookie, "PUT", "/v1/inbox/me/notifications", {
          ntfyTopic: "a/b",
        })
      ).status,
    ).toBe(400);
    expect(await svc.accounts.ntfyTopic(me.githubId)).toBe(topic);
    expect(
      (
        await browser(svc, me.cookie, "PUT", "/v1/inbox/me/notifications", {
          ntfyTopic: null,
        })
      ).status,
    ).toBe(204);
    expect(await svc.accounts.ntfyTopic(me.githubId)).toBeNull();
  });
});
