import { afterEach, describe, expect, it, vi } from "vitest";
import { githubApi } from "../src/github.ts";
import { agent, count, person, services } from "./helpers.ts";

// The real GitHub adapter against GitHub's documented answers.

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** Answers each request with the next of `answers`; an Error is thrown as a network failure. */
function github(answers: (Response | Error)[]): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: request.body ? await request.json() : null,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected GitHub call");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return calls;
}

const USER = {
  user: { id: 42, login: "tester" },
  app: { client_id: "client" },
};
const ok = (body: unknown) => Response.json(body, { status: 200 });
const status = (code: number) =>
  new Response(code === 204 ? null : "{}", { status: code });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checking which app issued a token", () => {
  it("asks GitHub with the app's own credentials and returns the token's user", async () => {
    const calls = github([ok(USER)]);
    const user = await githubApi("client", "secret").appUser("gho_x");
    expect(user).toEqual({ githubId: 42, login: "tester" });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "https://api.github.com/applications/client/token",
        authorization: `Basic ${btoa("client:secret")}`,
        body: { access_token: "gho_x" },
      },
    ]);
  });

  it("calls a token GitHub does not know for this app foreign", async () => {
    github([status(404)]);
    expect(await githubApi("client", "secret").appUser("ghp_x")).toBe(
      "foreign",
    );
  });

  it("treats any other answer as unavailable", async () => {
    const api = githubApi("client", "secret");
    for (const answer of [
      status(422),
      status(500),
      // A well-formed user under any status but 200 is still not an answer.
      Response.json(USER, { status: 201 }),
      new Response("not json", { status: 200 }),
      ok({ user: { id: "42", login: "tester" } }),
      new Error("network down"),
    ]) {
      github([answer]);
      expect(await api.appUser("gho_x")).toBe("unavailable");
      vi.restoreAllMocks();
    }
  });
});

describe("revoking a token", () => {
  it("confirms only GitHub's 204", async () => {
    const calls = github([status(204)]);
    expect(await githubApi("client", "secret").revoke("gho_x")).toBe("revoked");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", "https://api.github.com/applications/client/token"],
    ]);
  });

  it("counts a 404 as gone only when a check agrees the token is gone", async () => {
    const api = githubApi("client", "secret");
    github([status(404), status(404)]);
    expect(await api.revoke("gho_x")).toBe("gone");
    vi.restoreAllMocks();
    // GitHub says 404 but the token still checks out: not confirmed.
    github([status(404), ok(USER)]);
    expect(await api.revoke("gho_x")).toBe("unavailable");
    vi.restoreAllMocks();
    github([status(404), status(500)]);
    expect(await api.revoke("gho_x")).toBe("unavailable");
  });

  it("treats 422, server errors, and network failures as unconfirmed", async () => {
    const api = githubApi("client", "secret");
    for (const answer of [
      status(422),
      status(500),
      new Error("network down"),
    ]) {
      github([answer]);
      expect(await api.revoke("gho_x")).toBe("unavailable");
      vi.restoreAllMocks();
    }
  });
});

describe("POST /v1/login with the real adapter", () => {
  it("answers 503 and still revokes when GitHub's token check is malformed", async () => {
    const svc = services();
    const me = await person(svc);
    svc.github = Object.assign(
      Object.create(svc.github),
      githubApi("client", "secret"),
    );
    const calls = github([
      new Response("not json", { status: 200 }),
      status(204),
    ]);
    const response = await agent(
      svc,
      null,
      "POST",
      "/v1/login",
      { githubToken: "gho_x", machine: "studio-adapter" },
      { "cf-connecting-ip": "192.0.2.9" },
    );
    expect(response.status).toBe(503);
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });

  it("issues nothing when GitHub answers the revocation with 422", async () => {
    const svc = services();
    const me = await person(svc);
    svc.github = Object.assign(
      Object.create(svc.github),
      githubApi("client", "secret"),
    );
    const membership = Response.json({ state: "active" }, { status: 200 });
    const calls = github([
      ok({ user: { id: me.githubId, login: me.login } }),
      membership,
      status(422),
      status(422),
      status(422),
    ]);
    const response = await agent(
      svc,
      null,
      "POST",
      "/v1/login",
      { githubToken: "gho_x", machine: "studio-adapter-2" },
      { "cf-connecting-ip": "192.0.2.10" },
    );
    expect(response.status).toBe(503);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(3);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });
});
