import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/ids.ts";
import { MACHINE_PAGE, MACHINE_REQUESTER_LIMIT } from "../src/machines.ts";
import type {
  Ask,
  AskList,
  LoginConfig,
  MachineToken,
} from "../src/protocol.gen.ts";
import {
  agent,
  approval,
  browser,
  count,
  createAsk,
  errorOf,
  newTopic,
  ORIGIN,
  person,
  question,
  requester,
  send,
  services,
  type TestServices,
} from "./helpers.ts";

/** A machine name no other test uses. */
function machineName(): string {
  return `m-${crypto.randomUUID().slice(0, 8)}`;
}

/** A GitHub token the fake accepts for `who`, as a team member unless told otherwise. */
function githubToken(
  svc: TestServices,
  who: { githubId: number; login: string },
  member = true,
): string {
  const token = `gho_${crypto.randomUUID()}`;
  svc.github.users.set(token, { githubId: who.githubId, login: who.login });
  svc.github.appTokens.add(token);
  if (member) svc.github.members.add(who.login);
  return token;
}

/** `POST /v1/login` from a client address no other call uses. */
function exchange(
  svc: TestServices,
  body: unknown,
  ip = `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`,
): Promise<Response> {
  return agent(svc, null, "POST", "/v1/login", body, {
    "cf-connecting-ip": ip,
  });
}

/** Logs a machine in for `owner` and returns its credential. */
async function login(
  svc: TestServices,
  owner: { githubId: number; login: string },
  name = machineName(),
) {
  const response = await exchange(svc, {
    githubToken: githubToken(svc, owner),
    machine: name,
  });
  expect(response.status).toBe(200);
  const token = await response.json<MachineToken>();
  return { name, credential: token.credential };
}

/** Calls the agent API with a machine credential acting as `as`. */
function as(
  svc: TestServices,
  credential: string,
  name: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return agent(
    svc,
    credential,
    method,
    path,
    body,
    name === null ? {} : { "roger-requester": name },
  );
}

/** The id of `owner`'s active machine `name`, from Settings. */
async function machineId(
  svc: TestServices,
  owner: { cookie: string },
  name: string,
): Promise<string> {
  let after: string | null = null;
  for (;;) {
    const page: {
      machines: { id: string; name: string }[];
      next: string | null;
    } = await (
      await browser(
        svc,
        owner.cookie,
        "GET",
        `/v1/inbox/machines${after ? `?after=${after}` : ""}`,
      )
    ).json();
    const found = page.machines.find((m) => m.name === name);
    if (found) return found.id;
    if (!page.next) throw new Error(`no machine ${name}`);
    after = page.next;
  }
}

function adopt(
  svc: TestServices,
  cookie: string,
  requesterId: string,
  machine: string,
) {
  return browser(
    svc,
    cookie,
    "POST",
    `/v1/inbox/requesters/${requesterId}/adopt`,
    {
      machineId: machine,
    },
  );
}

/** Gives `owner`'s machine `name` `n` requesters directly. */
async function fillRequesters(owner: number, name: string, n: number) {
  await env.DB.batch(
    Array.from({ length: n }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO requesters (id, name, pickup_minutes, completion_minutes, created_by, created_at, machine)
         VALUES (?, ?, 1, 1, ?, 0, ?)`,
      ).bind(`${name}-${i}`, `${name}/job-${i}`, owner, name),
    ),
  );
}

describe("logging in", () => {
  it("tells the CLI which GitHub app to use", async () => {
    const svc = services();
    const response = await agent(svc, null, "GET", "/v1/login");
    expect(await response.json<LoginConfig>()).toEqual({
      githubClientId: "client",
      scope: "read:org",
    });
  });

  it("exchanges a team member's GitHub token for a machine credential, stored only as a hash", async () => {
    const svc = services();
    const me = await person(svc);
    const token = githubToken(svc, me);
    const name = machineName();
    const response = await exchange(svc, { githubToken: token, machine: name });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const issued = await response.json<MachineToken>();
    expect(issued).toMatchObject({ machine: name, owner: me.login });
    expect(issued.credential).toMatch(/^rogm_[A-Za-z0-9_-]{43}$/);
    expect(
      await count(
        "machines",
        "hash = ? AND owner = ? AND name = ?",
        await sha256(issued.credential),
        me.githubId,
        name,
      ),
    ).toBe(1);
    expect(await count("machines", "hash = ?", issued.credential)).toBe(0);
    // The GitHub token is revoked and cannot be exchanged again.
    expect(svc.github.revoked).toEqual([token]);
    expect(
      (await agent(svc, issued.credential, "GET", "/v1/asks")).status,
    ).toBe(200);
  });

  it("signs up a team member who never used the inbox", async () => {
    const svc = services();
    const newcomer = {
      githubId: 7_000_000 + Math.floor(Math.random() * 1e6),
      login: `new-${crypto.randomUUID().slice(0, 8)}`,
    };
    const studio = await login(svc, newcomer);
    const created = await createAsk(svc, studio.credential, question());
    expect(created.to).toBe(newcomer.login);
  });

  it("refuses someone outside the team, and still revokes their token", async () => {
    const svc = services();
    const outsider = await person(svc);
    const token = githubToken(svc, outsider, false);
    const response = await exchange(svc, {
      githubToken: token,
      machine: machineName(),
    });
    expect(response.status).toBe(403);
    expect(await count("machines", "owner = ?", outsider.githubId)).toBe(0);
    expect(svc.github.revoked).toEqual([token]);
  });

  it("refuses a team member's token that Roger's app did not issue", async () => {
    const svc = services();
    const me = await person(svc);
    // A personal access token of a team member: GitHub knows the user, but
    // the token is not this app's.
    const pat = `ghp_${crypto.randomUUID()}`;
    svc.github.users.set(pat, { githubId: me.githubId, login: me.login });
    svc.github.members.add(me.login);
    const response = await exchange(svc, {
      githubToken: pat,
      machine: machineName(),
    });
    expect(response.status).toBe(401);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
    // GitHub would refuse to revoke another app's token; Roger does not try.
    expect(svc.github.revoked).toEqual([]);
  });

  it("refuses a token GitHub does not accept", async () => {
    const svc = services();
    const response = await exchange(svc, {
      githubToken: "gho_unknown",
      machine: machineName(),
    });
    expect(response.status).toBe(401);
  });

  it("asks to retry when GitHub cannot confirm membership, and issues nothing", async () => {
    const svc = services();
    const me = await person(svc);
    svc.github.outage = true;
    const token = githubToken(svc, me);
    const response = await exchange(svc, {
      githubToken: token,
      machine: machineName(),
    });
    expect(response.status).toBe(503);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
    expect(svc.github.revoked).toEqual([token]);
  });

  it("revokes a received token when the rest of the request is refused", async () => {
    const svc = services();
    const me = await person(svc);
    const badName = githubToken(svc, me);
    const extraKey = githubToken(svc, me);
    for (const body of [
      { githubToken: badName, machine: "Studio/../x" },
      { githubToken: extraKey, machine: "studio", extra: 1 },
    ]) {
      const response = await exchange(svc, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // No token to revoke in these.
    for (const body of [
      { githubToken: "", machine: "studio" },
      { machine: "studio" },
    ]) {
      expect((await exchange(svc, body)).status).toBe(400);
    }
    // A JSON body sent without the JSON content type.
    const unlabelled = githubToken(svc, me);
    const wrongType = await send(
      svc,
      new Request(`${ORIGIN}/v1/login`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "cf-connecting-ip": "192.0.2.1",
        },
        body: JSON.stringify({ githubToken: unlabelled, machine: "studio" }),
      }),
    );
    expect(wrongType.status).toBe(415);
    expect(svc.github.revoked).toEqual([badName, extraKey, unlabelled]);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });

  it("issues nothing when GitHub does not confirm revoking the token", async () => {
    const svc = services();
    const me = await person(svc);
    svc.github.revokeFails = true;
    const token = githubToken(svc, me);
    const response = await exchange(svc, {
      githubToken: token,
      machine: machineName(),
    });
    expect(response.status).toBe(503);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
    // Bounded retries, once per request.
    expect(svc.github.revoked).toEqual([token, token, token]);
  });

  it("revokes when the limiter fails, but not when it refuses", async () => {
    const svc = services();
    const me = await person(svc);
    svc.limiter.limit = 0;
    const limited = githubToken(svc, me);
    expect(
      (await exchange(svc, { githubToken: limited, machine: machineName() }))
        .status,
    ).toBe(429);
    expect(svc.github.revoked).toEqual([]);
    svc.loginLimit = async () => {
      throw new Error("limiter down");
    };
    const failed = githubToken(svc, me);
    expect(
      (await exchange(svc, { githubToken: failed, machine: machineName() }))
        .status,
    ).toBe(500);
    expect(svc.github.revoked).toEqual([failed]);
  });

  it("records where the login came from and tells the owner", async () => {
    const svc = services();
    const topic = newTopic();
    const me = await person(svc, topic);
    const name = machineName();
    const response = await agent(
      svc,
      null,
      "POST",
      "/v1/login",
      { githubToken: githubToken(svc, me), machine: name },
      {
        "cf-connecting-ip": "203.0.113.7",
        "user-agent": `roger/0.1.3 ${"x".repeat(300)}`,
      },
    );
    expect(response.status).toBe(200);
    await svc.settle();
    expect(svc.notifier.sent).toHaveLength(1);
    expect(svc.notifier.sent[0]?.topic).toBe(topic);
    expect(svc.notifier.sent[0]?.push.message).toContain(
      `machine ${name} from 203.0.113.7`,
    );
    const listed = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { name: string; source: string; userAgent: string }[];
    }>();
    const machine = listed.machines.find((m) => m.name === name);
    expect(machine?.source).toBe("203.0.113.7");
    expect(machine?.userAgent).toHaveLength(200);
  });

  it("limits logins per client address, leaving other addresses alone", async () => {
    const svc = services();
    const me = await person(svc);
    const from = (ip: string) =>
      exchange(
        svc,
        { githubToken: githubToken(svc, me), machine: machineName() },
        ip,
      );
    for (let i = 0; i < svc.limiter.limit; i++)
      expect((await from("203.0.113.7")).status).toBe(200);
    const limited = await from("203.0.113.7");
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe("too_many_requests");
    expect((await from("198.51.100.9")).status).toBe(200);
  });

  it("refuses every login when the deployment has no limiter", async () => {
    const svc = services();
    const me = await person(svc);
    svc.loginLimit = null;
    const response = await exchange(svc, {
      githubToken: githubToken(svc, me),
      machine: machineName(),
    });
    expect(response.status).toBe(429);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });

  it("keeps each machine name to one person, and a new login replaces the owner's old one", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const studio = await login(svc, me);
    const created = await createAsk(svc, studio.credential, question());

    const theirs = await exchange(svc, {
      githubToken: githubToken(svc, other),
      machine: studio.name,
    });
    expect(theirs.status).toBe(409);
    expect((await errorOf(theirs)).message).toContain("Someone else");
    expect(await count("machines", "owner = ?", other.githubId)).toBe(0);

    // Until the new credential is used, the old one keeps working, so a
    // login whose credential is never saved takes nothing offline.
    const again = await login(svc, me, studio.name);
    expect(
      (await agent(svc, studio.credential, "GET", "/v1/asks")).status,
    ).toBe(200);
    const read = await agent(
      svc,
      again.credential,
      "GET",
      `/v1/asks/${created.id}`,
    );
    expect(read.status).toBe(200);
    expect(
      (await agent(svc, studio.credential, "GET", "/v1/asks")).status,
    ).toBe(401);
    expect(
      await count("machines", "owner = ? AND revoked_at IS NULL", me.githubId),
    ).toBe(1);
  });

  it("replaces by issuance order, not by id order", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const newer = await login(svc, me, studio.name);
    // Ids from different isolates can sort opposite to issuance; make them.
    await env.DB.prepare(
      "UPDATE machines SET id = '00000000000000000000000000' WHERE hash = ?",
    )
      .bind(await sha256(newer.credential))
      .run();
    expect((await agent(svc, newer.credential, "GET", "/v1/asks")).status).toBe(
      200,
    );
    expect(
      (await agent(svc, studio.credential, "GET", "/v1/asks")).status,
    ).toBe(401);
    // The old login, used first, never revokes the newer one.
    const third = await login(svc, me, studio.name);
    expect((await agent(svc, newer.credential, "GET", "/v1/asks")).status).toBe(
      200,
    );
    expect((await agent(svc, third.credential, "GET", "/v1/asks")).status).toBe(
      200,
    );
    expect((await agent(svc, newer.credential, "GET", "/v1/asks")).status).toBe(
      401,
    );
  });
});

describe("machine credentials", () => {
  it("act as <machine>/default without a name, and <machine>/<name> with one", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const plain = await as(
      svc,
      studio.credential,
      null,
      "POST",
      "/v1/asks",
      question(),
    );
    expect(plain.status).toBe(201);
    expect((await plain.json<Ask>()).requester).toBe(`${studio.name}/default`);
    const named = await as(
      svc,
      studio.credential,
      "merge-gate",
      "POST",
      "/v1/asks",
      approval(),
    );
    expect(named.status).toBe(201);
    const ask = await named.json<Ask>();
    expect(ask.requester).toBe(`${studio.name}/merge-gate`);
    // Asks go to the machine's owner by default.
    expect(ask.to).toBe(me.login);
  });

  it("keep two automations on one machine apart", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const shared = question({
      idemKey: "same-idem",
      decisionKey: "same-decision",
    });
    const a = await as(
      svc,
      studio.credential,
      "coordinator",
      "POST",
      "/v1/asks",
      shared,
    );
    const b = await as(
      svc,
      studio.credential,
      "merge-gate",
      "POST",
      "/v1/asks",
      shared,
    );
    // Idempotency keys and the one-open-Ask-per-decision rule are per requester.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const askA = await a.json<Ask>();
    const askB = await b.json<Ask>();
    expect(askA.id).not.toBe(askB.id);

    const listA = await (
      await as(svc, studio.credential, "coordinator", "GET", "/v1/asks")
    ).json<AskList>();
    expect(listA.asks.map((x) => x.id)).toEqual([askA.id]);
    for (const [method, path, body] of [
      ["GET", `/v1/asks/${askA.id}`, undefined],
      ["POST", `/v1/asks/${askA.id}/withdraw`, {}],
      ["POST", `/v1/asks/${askA.id}/trace`, { event: "progress" }],
    ] as const) {
      const response = await as(
        svc,
        studio.credential,
        "merge-gate",
        method,
        path,
        body,
      );
      expect(response.status, path).toBe(404);
    }
    const events = await (
      await as(svc, studio.credential, "merge-gate", "GET", "/v1/events")
    ).json<{
      events: { askId: string }[];
    }>();
    expect(events.events.map((e) => e.askId)).toEqual([askB.id]);
  });

  it("are refused once the machine is revoked in Settings or logs out", async () => {
    const svc = services();
    const me = await person(svc);
    const inSettings = await login(svc, me);
    const { machines } = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { id: string; name: string }[];
    }>();
    const id = machines.find((m) => m.name === inSettings.name)?.id;
    expect(
      (await browser(svc, me.cookie, "POST", `/v1/inbox/machines/${id}/revoke`))
        .status,
    ).toBe(204);
    const refused = await as(
      svc,
      inSettings.credential,
      "x",
      "GET",
      "/v1/asks",
    );
    expect(refused.status).toBe(401);

    const loggedOut = await login(svc, me);
    expect(
      (await agent(svc, loggedOut.credential, "POST", "/v1/machine/logout"))
        .status,
    ).toBe(204);
    expect(
      (await agent(svc, loggedOut.credential, "GET", "/v1/asks")).status,
    ).toBe(401);
    expect(
      (await agent(svc, loggedOut.credential, "POST", "/v1/machine/logout"))
        .status,
    ).toBe(401);
  });

  it("stop one automation when its requester is disabled, leaving the others", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const first = await createAsk(svc, studio.credential, question());
    const byName = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { name: string; requesters: { id: string; name: string }[] }[];
    }>();
    const defaultRequester = byName.machines
      .find((m) => m.name === studio.name)
      ?.requesters.find((r) => r.name === `${studio.name}/default`);
    expect(first.requester).toBe(defaultRequester?.name);
    const disabled = await browser(
      svc,
      me.cookie,
      "POST",
      `/v1/inbox/requesters/${defaultRequester?.id}/disable`,
    );
    expect(disabled.status).toBe(204);
    const refused = await as(svc, studio.credential, null, "GET", "/v1/asks");
    expect(refused.status).toBe(403);
    expect(
      (await as(svc, studio.credential, "other", "GET", "/v1/asks")).status,
    ).toBe(200);
  });

  it("reject an invalid automation name", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    for (const name of ["Upper", "a/b", "", "-lead"]) {
      const response = await as(
        svc,
        studio.credential,
        name,
        "GET",
        "/v1/asks",
      );
      expect(response.status, name).toBe(400);
    }
  });

  it("create at most a bounded number of requesters per machine", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const inserts = Array.from({ length: MACHINE_REQUESTER_LIMIT }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO requesters (id, name, pickup_minutes, completion_minutes, created_by, created_at, machine)
         VALUES (?, ?, 1, 1, ?, 0, ?)`,
      ).bind(
        `${studio.name}-${i}`,
        `${studio.name}/job-${i}`,
        me.githubId,
        studio.name,
      ),
    );
    await env.DB.batch(inserts);
    expect(
      (await as(svc, studio.credential, "job-1", "GET", "/v1/asks")).status,
    ).toBe(200);
    const full = await as(
      svc,
      studio.credential,
      "one-more",
      "GET",
      "/v1/asks",
    );
    expect(full.status).toBe(403);
  });

  it("adopt a Settings requester only through the inbox, and release it", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const legacy = await requester(svc, me);
    const theirs = await requester(svc, other);
    const studio = await login(svc, me);
    const studioId = await machineId(svc, me, studio.name);
    const before = await createAsk(svc, legacy.token, question());

    // A machine credential alone cannot adopt anything.
    const alone = await agent(
      svc,
      studio.credential,
      "POST",
      "/v1/machine/adopt",
      {
        name: legacy.name,
      },
    );
    expect(alone.status).toBe(404);
    expect(
      (
        await as(
          svc,
          studio.credential,
          legacy.name,
          "POST",
          "/v1/asks",
          question(),
        )
      ).status,
    ).toBe(201);
    // ...that call created `<machine>/<legacy>`, so adopting now would hide its Asks.
    const hidden = await adopt(svc, me.cookie, legacy.id, studioId);
    expect(hidden.status).toBe(409);
    const own = await (
      await as(svc, studio.credential, legacy.name, "GET", "/v1/asks")
    ).json<AskList>();
    expect(own.asks.map((a) => a.requester)).toEqual([
      `${studio.name}/${legacy.name}`,
    ]);

    const laptop = await login(svc, me);
    const laptopId = await machineId(svc, me, laptop.name);
    expect((await adopt(svc, other.cookie, legacy.id, laptopId)).status).toBe(
      404,
    );
    expect((await adopt(svc, me.cookie, theirs.id, laptopId)).status).toBe(404);
    const adopted = await adopt(svc, me.cookie, legacy.id, laptopId);
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toEqual({ machine: laptop.name });
    // Adoption is once: another machine cannot take it.
    expect((await adopt(svc, me.cookie, legacy.id, studioId)).status).toBe(404);

    const read = await as(
      svc,
      laptop.credential,
      legacy.name,
      "GET",
      `/v1/asks/${before.id}`,
    );
    expect(read.status).toBe(200);
    expect((await agent(svc, legacy.token, "GET", "/v1/asks")).status).toBe(
      200,
    );

    const released = await browser(
      svc,
      me.cookie,
      "POST",
      `/v1/inbox/requesters/${legacy.id}/release`,
    );
    expect(released.status).toBe(204);
    const after = await as(
      svc,
      laptop.credential,
      legacy.name,
      "GET",
      `/v1/asks/${before.id}`,
    );
    expect(after.status).toBe(404);
    expect(
      (await agent(svc, legacy.token, "GET", `/v1/asks/${before.id}`)).status,
    ).toBe(200);
  });

  it("adopt only while the machine has room under its requester cap", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const id = await machineId(svc, me, studio.name);
    await fillRequesters(me.githubId, studio.name, MACHINE_REQUESTER_LIMIT - 1);
    const first = await requester(svc, me);
    const second = await requester(svc, me);
    expect((await adopt(svc, me.cookie, first.id, id)).status).toBe(200);
    const full = await adopt(svc, me.cookie, second.id, id);
    expect(full.status).toBe(409);
    expect((await errorOf(full)).message).toContain(
      `${MACHINE_REQUESTER_LIMIT} requesters`,
    );
  });

  it("are listed in Settings only for their owner", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const studio = await login(svc, me);
    await createAsk(svc, studio.credential, question());
    const mine = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { id: string; name: string; requesters: { name: string }[] }[];
    }>();
    const listed = mine.machines.find((m) => m.name === studio.name);
    expect(listed?.requesters.map((r) => r.name)).toEqual([
      `${studio.name}/default`,
    ]);
    const theirs = await (
      await browser(svc, other.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: unknown[];
    }>();
    expect(theirs.machines).toEqual([]);
    const stolen = await browser(
      svc,
      other.cookie,
      "POST",
      `/v1/inbox/machines/${listed?.id}/revoke`,
    );
    expect(stolen.status).toBe(404);
    // Machine requesters stay out of the hand-made requester list.
    const requesters = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/requesters")
    ).json<{
      requesters: { name: string }[];
    }>();
    expect(requesters.requesters).toEqual([]);
  });
});

describe("static tokens", () => {
  it("are still accepted, and cannot name another requester", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const created = await agent(svc, bot.token, "POST", "/v1/asks", question());
    expect(created.status).toBe(201);
    expect((await created.json<Ask>()).requester).toBe(bot.name);
    const named = await agent(svc, bot.token, "GET", "/v1/asks", undefined, {
      "roger-requester": "other",
    });
    expect(named.status).toBe(400);
  });
});

describe("machine names", () => {
  it("are free again once revoked; the previous owner's requesters move aside and stay theirs", async () => {
    const svc = services();
    const first = await person(svc);
    const second = await person(svc);
    const studio = await login(svc, first);
    const created = await as(
      svc,
      studio.credential,
      "job",
      "POST",
      "/v1/asks",
      question(),
    );
    const ask = await created.json<Ask>();
    await browser(
      svc,
      first.cookie,
      "POST",
      `/v1/inbox/machines/${await machineId(svc, first, studio.name)}/revoke`,
    );

    const taken = await login(svc, second, studio.name);
    const mine = await as(
      svc,
      taken.credential,
      "job",
      "POST",
      "/v1/asks",
      question(),
    );
    expect((await mine.json<Ask>()).requester).toBe(`${studio.name}/job`);

    // The first owner's requester is renamed, listed in their Settings past
    // 100 requesters that sort before it, and reachable with a token they issue.
    await env.DB.batch(
      Array.from({ length: 100 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO requesters (id, name, pickup_minutes, completion_minutes, created_by, created_at)
           VALUES (?, ?, 1, 1, ?, 0)`,
        ).bind(
          `${studio.name}-a-${i}`,
          `a-${studio.name}-${i}`,
          first.githubId,
        ),
      ),
    );
    const everyone: { id: string; name: string; machine: string | null }[] = [];
    let after: string | null = null;
    for (;;) {
      const page: {
        requesters: { id: string; name: string; machine: string | null }[];
        next: string | null;
      } = await (
        await browser(
          svc,
          first.cookie,
          "GET",
          `/v1/inbox/requesters${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        )
      ).json();
      expect(page.requesters.length).toBeLessThanOrEqual(100);
      everyone.push(...page.requesters);
      if (!page.next) break;
      after = page.next;
    }
    expect(everyone).toHaveLength(101);
    const moved = everyone.find((r) =>
      r.name.startsWith(`${studio.name}/job#`),
    );
    expect(moved?.machine).toBeNull();
    const issued = await browser(
      svc,
      first.cookie,
      "POST",
      `/v1/inbox/requesters/${moved?.id}/tokens`,
    );
    const { token } = await issued.json<{ token: string }>();
    const read = await agent(svc, token, "GET", `/v1/asks/${ask.id}`);
    expect(read.status).toBe(200);
    expect((await read.json<Ask>()).requester).toBe(moved?.name);
    // The second owner cannot reach it.
    expect(
      (await as(svc, taken.credential, "job", "GET", `/v1/asks/${ask.id}`))
        .status,
    ).toBe(404);
  });

  it("stay discoverable and revocable past one page of Settings", async () => {
    const svc = services();
    const me = await person(svc);
    const prefix = machineName();
    await env.DB.batch(
      Array.from({ length: MACHINE_PAGE + 1 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO machines (id, name, owner, hash, generation, replacing, source, created_at) VALUES (?, ?, ?, ?, 1, 0, 'test', 0)",
        ).bind(
          `01K6A${String(i).padStart(21, "0")}`,
          `${prefix}-${i}`,
          me.githubId,
          crypto.randomUUID(),
        ),
      ),
    );
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: { machines: { id: string }[]; next: string | null } = await (
        await browser(
          svc,
          me.cookie,
          "GET",
          `/v1/inbox/machines${after ? `?after=${after}` : ""}`,
        )
      ).json();
      expect(page.machines.length).toBeLessThanOrEqual(MACHINE_PAGE);
      seen.push(...page.machines.map((m) => m.id));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(MACHINE_PAGE + 1);
    // An empty cursor is the first page.
    for (const path of [
      "/v1/inbox/machines?after=",
      "/v1/inbox/requesters?after=",
    ]) {
      const first = await browser(svc, me.cookie, "GET", path);
      expect(first.status, path).toBe(200);
    }
    const firstMachines = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines?after=")
    ).json<{ machines: { id: string }[] }>();
    expect(firstMachines.machines.map((m) => m.id)).toEqual(
      seen.slice(0, MACHINE_PAGE),
    );
    expect(
      (await browser(svc, me.cookie, "GET", "/v1/inbox/machines?after=nope"))
        .status,
    ).toBe(400);
    const firstRequesters = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/requesters?after=")
    ).json<{ requesters: { id: string }[] }>();
    const plainRequesters = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/requesters")
    ).json<{ requesters: { id: string }[] }>();
    expect(firstRequesters).toEqual(plainRequesters);
    const last = seen.at(-1);
    expect(
      (
        await browser(
          svc,
          me.cookie,
          "POST",
          `/v1/inbox/machines/${last}/revoke`,
        )
      ).status,
    ).toBe(204);
    expect(
      await count("machines", "id = ? AND revoked_at IS NOT NULL", last),
    ).toBe(1);
  });
});
