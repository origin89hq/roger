import { describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import type { Ask } from "../src/protocol.gen.ts";
import { SEND_LEASE_MS } from "../src/store.ts";
import {
  agent,
  approval,
  auditOf,
  count,
  createAsk,
  MONDAY_10AM,
  minutes,
  newTopic,
  ORIGIN,
  person,
  question,
  reject,
  requester,
  services,
  type TestServices,
} from "./helpers.ts";

const DAY = 24 * 60 * 60_000;

/** An instant given as Toronto wall-clock time during daylight saving (UTC-4). */
const toronto = (local: string) => Date.parse(`${local}-04:00`);

/** What was pushed to one topic, so other tests' pushes in the shared database do not interfere. */
const sentTo = (svc: TestServices, topic: string) =>
  svc.notifier.sent.filter((s) => s.topic === topic).map((s) => s.push);

/** Pushes for single Asks, as opposed to digests. */
const askPushes = (svc: TestServices, topic: string) =>
  sentTo(svc, topic).filter((p) => p.click.startsWith(`${ORIGIN}/#ask=`));

async function getAsk(svc: TestServices, id: string): Promise<Ask> {
  const stored = await svc.store.getAsk(id);
  if (!stored) throw new Error(`no Ask ${id}`);
  return stored.ask;
}

describe("expiry", () => {
  it("expires due Asks with an audit record and leaves the rest open", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const due = await createAsk(
      svc,
      bot.token,
      approval({ expiresInMinutes: 30 }),
    );
    const later = await createAsk(
      svc,
      bot.token,
      approval({ expiresInMinutes: 120 }),
    );
    const never = await createAsk(svc, bot.token);
    svc.clock.now = MONDAY_10AM + minutes(60);
    await runCron(svc);
    expect(await getAsk(svc, due.id)).toMatchObject({
      state: "expired",
      closedAt: svc.clock.now,
      answer: null,
    });
    expect((await auditOf(due.id)).at(-1)).toEqual({
      state: "expired",
      actor: "roger",
      at: svc.clock.now,
    });
    expect((await getAsk(svc, later.id)).state).toBe("open");
    expect((await getAsk(svc, never.id)).state).toBe("open");
    // A second run changes nothing.
    await runCron(svc);
    expect(
      await count("ask_events", "ask_id = ? AND state = 'expired'", due.id),
    ).toBe(1);
    expect(await count("ask_events", "ask_id = ?", later.id)).toBe(1);
  });
});

describe("pushes", () => {
  it("pushes a `soon` Ask after 30 working minutes, once", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token, question({ urgency: "soon" }));
    await svc.settle();
    svc.clock.now = MONDAY_10AM + minutes(30) - 1;
    await runCron(svc);
    expect(askPushes(svc, topic)).toEqual([]);
    svc.clock.now = MONDAY_10AM + minutes(30);
    await runCron(svc);
    svc.clock.now += minutes(5);
    await runCron(svc);
    expect(askPushes(svc, topic)).toEqual([
      {
        title: ask.title,
        message: `soon · routine · ${bot.name}`,
        priority: 4,
        tags: [],
        click: `${ORIGIN}/#ask=${ask.id}`,
      },
    ]);
  });

  it("sends again after the lease when a sender claimed a push and never confirmed it", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token, question({ urgency: "soon" }));
    svc.clock.now = MONDAY_10AM + minutes(30);
    // A sender that died between claiming and sending.
    expect(await svc.store.claimPush(ask.id, svc.clock.now)).toBe(true);
    await runCron(svc);
    expect(askPushes(svc, topic)).toEqual([]);
    svc.clock.now += SEND_LEASE_MS;
    await runCron(svc);
    svc.clock.now += minutes(5);
    await runCron(svc);
    expect(askPushes(svc, topic).map((p) => p.click)).toEqual([
      `${ORIGIN}/#ask=${ask.id}`,
    ]);
  });

  it("waits for working hours before pushing a `soon` Ask made on Friday evening", async () => {
    const svc = services(toronto("2026-09-25T17:50:00"));
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    await createAsk(svc, bot.token, question({ urgency: "soon" }));
    svc.clock.now = toronto("2026-09-26T10:00:00");
    await runCron(svc);
    svc.clock.now = toronto("2026-09-28T08:19:00");
    await runCron(svc);
    expect(askPushes(svc, topic)).toEqual([]);
    svc.clock.now = toronto("2026-09-28T08:20:00");
    await runCron(svc);
    expect(askPushes(svc, topic)).toHaveLength(1);
  });

  it("never pushes an Ask closed before its push was due", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token, question({ urgency: "soon" }));
    await agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/withdraw`);
    svc.clock.now += minutes(60);
    await runCron(svc);
    expect(askPushes(svc, topic)).toEqual([]);
  });

  it("retries a failed push on the next run and sends it once", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    svc.notifier.failing = true;
    const response = await agent(
      svc,
      bot.token,
      "POST",
      "/v1/asks",
      approval({ urgency: "now" }),
    );
    // A failed push never rolls back the Ask.
    expect(response.status).toBe(201);
    const ask = await response.json<Ask>();
    await svc.settle();
    await runCron(svc);
    expect(askPushes(svc, topic)).toEqual([]);
    expect((await getAsk(svc, ask.id)).state).toBe("open");

    svc.notifier.failing = false;
    svc.clock.now += minutes(5);
    await runCron(svc);
    await runCron(svc);
    expect(askPushes(svc, topic).map((p) => p.click)).toEqual([
      `${ORIGIN}/#ask=${ask.id}`,
    ]);
  });

  it("does not push to a person without a topic", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const before = svc.notifier.sent.length;
    const ask = await createAsk(svc, bot.token, approval({ urgency: "now" }));
    await svc.settle();
    await runCron(svc);
    expect(
      svc.notifier.sent.slice(before).map((s) => s.push.click),
    ).not.toContain(`${ORIGIN}/#ask=${ask.id}`);
  });
});

describe("digest", () => {
  async function withOpenAsk(now: number) {
    const svc = services(now);
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    const ask = await createAsk(
      svc,
      bot.token,
      approval({ urgency: "later", title: "Merge: docs" }),
    );
    return { svc, topic, me, bot, ask };
  }

  const digests = (svc: TestServices, topic: string) =>
    sentTo(svc, topic).filter((p) => p.click === `${ORIGIN}/`);

  it("sends one digest per local day during working hours", async () => {
    const { svc, topic, bot } = await withOpenAsk(MONDAY_10AM);
    await runCron(svc);
    svc.clock.now = MONDAY_10AM + minutes(300);
    await runCron(svc);
    expect(digests(svc, topic)).toEqual([
      {
        title: "1 open Ask",
        message: `${bot.name} (1)\n• Merge: docs`,
        priority: 3,
        tags: [],
        click: `${ORIGIN}/`,
      },
    ]);
    svc.clock.now = MONDAY_10AM + DAY;
    await runCron(svc);
    expect(digests(svc, topic)).toHaveLength(2);
  });

  it("waits for working hours to send the digest", async () => {
    const { svc, topic } = await withOpenAsk(toronto("2026-09-26T10:00:00"));
    await runCron(svc);
    svc.clock.now = toronto("2026-09-28T07:59:00");
    await runCron(svc);
    expect(digests(svc, topic)).toEqual([]);
    svc.clock.now = toronto("2026-09-28T08:00:00");
    await runCron(svc);
    expect(digests(svc, topic)).toHaveLength(1);
  });

  it("sends no digest to a person without open Asks", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, ask.id);
    await runCron(svc);
    expect(sentTo(svc, topic)).toEqual([]);
  });

  it("sends the digest later that day when the first Ask arrives after the first run", async () => {
    const svc = services(MONDAY_10AM);
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    await runCron(svc);
    expect(await count("digests", "github_id = ?", me.githubId)).toBe(0);
    svc.clock.now += minutes(60);
    await createAsk(
      svc,
      bot.token,
      approval({ urgency: "later", title: "Merge: late" }),
    );
    await runCron(svc);
    expect(digests(svc, topic).map((p) => p.title)).toEqual(["1 open Ask"]);
  });

  it("leaves fyi Asks out of the digest", async () => {
    const svc = services(MONDAY_10AM);
    const topic = newTopic();
    const me = await person(svc, topic);
    const bot = await requester(svc, me);
    await createAsk(svc, bot.token, {
      ...approval(),
      kind: "fyi",
      urgency: "fyi",
      action: null,
      options: [{ id: "ack", label: "OK", decision: "other" }],
    });
    await runCron(svc);
    expect(digests(svc, topic)).toEqual([]);
    await createAsk(
      svc,
      bot.token,
      approval({ urgency: "later", title: "Merge: counted" }),
    );
    await runCron(svc);
    expect(digests(svc, topic).map((p) => p.message)).toEqual([
      `${bot.name} (1)\n• Merge: counted`,
    ]);
  });

  it("sends the digest after the lease when a sender claimed it and never confirmed", async () => {
    const { svc, topic, me } = await withOpenAsk(MONDAY_10AM);
    const day = "2026-09-28";
    expect(await svc.store.claimDigest(me.githubId, day, svc.clock.now)).toBe(
      true,
    );
    await runCron(svc);
    expect(digests(svc, topic)).toEqual([]);
    svc.clock.now += SEND_LEASE_MS;
    await runCron(svc);
    svc.clock.now += minutes(5);
    await runCron(svc);
    expect(digests(svc, topic)).toHaveLength(1);
  });

  it("retries a failed digest on the next run", async () => {
    const { svc, topic, me } = await withOpenAsk(MONDAY_10AM);
    svc.notifier.failing = true;
    await runCron(svc);
    expect(await count("digests", "github_id = ?", me.githubId)).toBe(0);
    svc.notifier.failing = false;
    svc.clock.now += minutes(5);
    await runCron(svc);
    await runCron(svc);
    expect(digests(svc, topic)).toHaveLength(1);
    expect(await count("digests", "github_id = ?", me.githubId)).toBe(1);
  });
});

describe("retention", () => {
  it("purges bodies and links of Asks closed over 90 days ago and keeps the record", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const withdrawn = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${withdrawn.id}/withdraw`);
    const answered = await createAsk(svc, bot.token);
    await reject(svc, me.cookie, answered.id);
    const traced = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${answered.id}/trace`,
      {
        event: "not_applicable",
        note: "closed by hand",
      },
    );
    expect(traced.status).toBe(200);
    const open = await createAsk(svc, bot.token);
    svc.clock.now = MONDAY_10AM + 1;
    const recent = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${recent.id}/withdraw`);
    const before = await getAsk(svc, answered.id);

    // Exactly 90 days after `recent` closed: older closures go, `recent` stays.
    svc.clock.now = MONDAY_10AM + 1 + 90 * DAY;
    await runCron(svc);

    expect(await getAsk(svc, withdrawn.id)).toMatchObject({
      body: null,
      links: [],
      state: "withdrawn",
    });
    const purged = await getAsk(svc, answered.id);
    expect(purged).toEqual({ ...before, body: null, links: [] });
    expect(purged.action).toEqual(answered.action);
    expect(purged.options).toEqual(answered.options);
    expect(purged.answer).toMatchObject({
      decision: "reject",
      action: answered.action,
    });
    expect(purged.trace.map((t) => t.event)).toEqual([
      "delivered",
      "not_applicable",
    ]);
    expect(await getAsk(svc, open.id)).toMatchObject({
      body: open.body,
      links: open.links,
    });
    expect(await getAsk(svc, recent.id)).toMatchObject({
      body: recent.body,
      links: recent.links,
    });
  });
});
