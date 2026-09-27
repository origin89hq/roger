import { describe, expect, it } from "vitest";
import type { Ask, AskList, CreateAsk } from "../src/protocol.gen.ts";
import {
  agent,
  answerAsk,
  approval,
  count,
  createAsk,
  errorOf,
  person,
  question,
  readAsk,
  reject,
  requester,
  services,
  type TestServices,
} from "./helpers.ts";

// approval() links origin89hq/roger/pull/2 and targets pr:origin89hq/roger#2.
const OWN_COMMENT =
  "https://github.com/origin89hq/roger/pull/2#issuecomment-111";
const OTHER_COMMENT =
  "https://github.com/origin89hq/engineering/issues/15#issuecomment-222";

async function answered(svc: TestServices, body: CreateAsk = approval()) {
  const me = await person(svc);
  const bot = await requester(svc, me);
  const ask = await createAsk(svc, bot.token, body);
  if (body.kind === "approval") await reject(svc, me.cookie, ask.id);
  else await answerAsk(svc, me.cookie, ask.id, { option: "a" });
  return { me, bot, ask };
}

function trace(svc: TestServices, token: string, id: string, body: unknown) {
  return agent(svc, token, "POST", `/v1/asks/${id}/trace`, body);
}

describe("evidence links", () => {
  it("accepts a comment on a thread the Ask links", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    const response = await trace(svc, bot.token, ask.id, {
      event: "applied",
      url: OWN_COMMENT,
    });
    expect(response.status).toBe(200);
  });

  it("refuses a comment on a thread the Ask is not about, naming both", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    const response = await trace(svc, bot.token, ask.id, {
      event: "applied",
      url: OTHER_COMMENT,
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("origin89hq/engineering#15");
    expect(error.message).toContain("origin89hq/roger#2");
    expect(error.message).toContain(ask.id);
    expect(
      await count("trace", "ask_id = ? AND event = 'applied'", ask.id),
    ).toBe(0);
  });

  it("accepts the action target's thread when the Ask has no links", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc, approval({ links: [] }));
    const response = await trace(svc, bot.token, ask.id, {
      event: "failed",
      url: OWN_COMMENT.replace("pull", "issues"),
      note: "checks failed",
    });
    expect(response.status).toBe(200);
  });

  it("accepts links that are not comments, such as a new PR or a commit", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    expect(
      (
        await trace(svc, bot.token, ask.id, {
          event: "progress",
          url: OTHER_COMMENT,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await trace(svc, bot.token, ask.id, {
          event: "applied",
          url: "https://github.com/origin89hq/roger/pull/99",
        })
      ).status,
    ).toBe(200);
  });

  it("accepts any link when the Ask names no thread", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc, question());
    const response = await trace(svc, bot.token, ask.id, {
      event: "applied",
      url: OTHER_COMMENT,
    });
    expect(response.status).toBe(200);
  });
});

describe("correcting the evidence link", () => {
  it("appends a correction after the terminal event and keeps the original", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    await trace(svc, bot.token, ask.id, {
      event: "applied",
      url: "https://github.com/origin89hq/roger/pull/2",
    });
    const response = await trace(svc, bot.token, ask.id, {
      event: "corrected",
      url: OWN_COMMENT,
      note: "Linked the PR instead of the decision comment.",
    });
    expect(response.status).toBe(200);
    const events = (await readAsk(svc, bot.token, ask.id)).trace.map(
      (t) => t.event,
    );
    expect(events).toEqual(["delivered", "applied", "corrected"]);
    const unfinished = await (
      await agent(
        svc,
        bot.token,
        "GET",
        "/v1/asks?state=answered&terminal=none",
      )
    ).json<AskList>();
    expect(unfinished.asks.map((a) => a.id)).not.toContain(ask.id);
  });

  it("refuses a correction before the terminal event", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    const response = await trace(svc, bot.token, ask.id, {
      event: "corrected",
      url: OWN_COMMENT,
      note: "too early",
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(
      "Only a trace with a terminal event",
    );
  });

  it("needs a url and a note, and checks the url like any evidence", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    await trace(svc, bot.token, ask.id, {
      event: "not_applicable",
      note: "head moved",
    });
    for (const body of [
      { event: "corrected", note: "no url" },
      { event: "corrected", url: OWN_COMMENT },
    ]) {
      expect((await trace(svc, bot.token, ask.id, body)).status).toBe(400);
    }
    expect(
      (
        await trace(svc, bot.token, ask.id, {
          event: "corrected",
          url: OTHER_COMMENT,
          note: "wrong again",
        })
      ).status,
    ).toBe(400);
  });

  it("tells a second terminal event to record a correction instead", async () => {
    const svc = services();
    const { bot, ask } = await answered(svc);
    await trace(svc, bot.token, ask.id, {
      event: "applied",
      url: OWN_COMMENT,
    });
    const response = await trace(svc, bot.token, ask.id, {
      event: "applied",
      url: OWN_COMMENT,
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain("corrected");
  });
});

describe("listing with filters", () => {
  it("filters by decision-key prefix and repository", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const spec = await createAsk(
      svc,
      bot.token,
      question({
        decisionKey: `spec:origin89hq/km43#1:${crypto.randomUUID()}`,
        repo: "origin89hq/km43",
      }),
    );
    const task = await createAsk(
      svc,
      bot.token,
      question({
        decisionKey: `task:run/${crypto.randomUUID()}`,
        repo: "origin89hq/firmware",
      }),
    );
    const list = async (query: string) =>
      (
        await (
          await agent(svc, bot.token, "GET", `/v1/asks?state=open&${query}`)
        ).json<AskList>()
      ).asks.map((a: Ask) => a.id);
    expect(await list("prefix=spec%3A")).toEqual([spec.id]);
    expect(await list("prefix=task%3A")).toEqual([task.id]);
    expect(await list("repo=Origin89hq%2Ffirmware")).toEqual([task.id]);
    expect(await list("prefix=spec%3A&repo=origin89hq%2Ffirmware")).toEqual([]);
    expect((await list("")).sort()).toEqual([spec.id, task.id].sort());
  });

  it("refuses a malformed filter", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    for (const query of ["repo=not-a-repo", "state=closed", "prefix="]) {
      const response = await agent(svc, bot.token, "GET", `/v1/asks?${query}`);
      expect(response.status, query).toBe(400);
    }
  });
});
