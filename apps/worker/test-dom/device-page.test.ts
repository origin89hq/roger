import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../public/index.html?raw";

// The inbox page's login approval, driven through its real DOM wiring with
// the API answered by the test.

const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));

const ME = {
  login: "tester",
  githubId: 42,
  ntfyTopic: null,
  pushes: false,
  passkeys: [],
};
const LOGIN = {
  suggested: "studio",
  source: "203.0.113.7 (CA)",
  userAgent: "roger/0.1.3",
  createdAt: Date.now() - 60_000,
  expiresAt: Date.now() + 840_000,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  answer: (status: number, data?: unknown) => void;
}

let calls: Call[] = [];

function respond(status: number, data?: unknown): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Each request waits until the test answers it, except the profile. */
function fakeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  if (path === "/v1/inbox/me") return Promise.resolve(respond(200, ME));
  return new Promise((resolve) => {
    calls.push({
      method,
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      answer: (status, data) => resolve(respond(status, data)),
    });
  });
}

/** Lets pending promises and renders finish. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function open(hash: string) {
  vi.resetModules();
  document.body.innerHTML = body;
  history.replaceState(null, "", `/${hash}`);
  await import("../public/inbox.js");
  await settle();
}

function codeInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Code from roger login"]',
  );
  if (!input) throw new Error("no code input");
  return input;
}

async function type(value: string) {
  const input = codeInput();
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await settle();
}

function buttons(): string[] {
  return [...document.querySelectorAll("#device-view button")].map(
    (b) => b.textContent ?? "",
  );
}

async function click(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("#device-view button"),
  ].find((b) => b.textContent === label);
  if (!button)
    throw new Error(`no button ${label}; have ${buttons().join(", ")}`);
  button.click();
  await settle();
}

function lookups(): Call[] {
  return calls.filter((c) => c.path === "/v1/inbox/device");
}

// happy-dom fires hashchange on history.replaceState, which browsers do not;
// stop it before the page's own listener sees it.
window.addEventListener(
  "hashchange",
  (event) => event.stopImmediatePropagation(),
  {
    capture: true,
  },
);

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["setInterval"] });
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the login approval page", () => {
  it("starts empty from a link, looks nothing up, and drops the code from the address", async () => {
    await open("#device=BCDF-GHJK");
    expect(codeInput().value).toBe("");
    expect(lookups()).toEqual([]);
    expect(location.hash).toBe("#device");
    expect(document.querySelector("#device-view")?.textContent).toContain(
      "opened from a link",
    );
  });

  it("shows the code, source, and client, and forgets them on any edit", async () => {
    await open("#device");
    await type("BCDF-GHJK");
    await click("Continue");
    lookups()[0]?.answer(200, LOGIN);
    await settle();
    const text = document.querySelector("#device-view")?.textContent ?? "";
    expect(text).toContain("203.0.113.7 (CA)");
    expect(text).toContain("roger/0.1.3");
    expect(buttons()).toContain("Approve BCDF-GHJK");

    await type("BCDF-GHJX");
    expect(buttons()).toEqual(["Continue"]);
  });

  it("does not bring back an earlier login when a later lookup fails", async () => {
    await open("#device");
    await type("BCDF-GHJK");
    await click("Continue");
    lookups()[0]?.answer(200, LOGIN);
    await settle();
    await click("Continue");
    lookups()[1]?.answer(404, {
      error: { code: "not_found", message: "No login", state: null },
    });
    await settle();
    expect(buttons()).toEqual(["Continue"]);
  });

  it("ignores an earlier lookup that answers after a later one", async () => {
    await open("#device");
    await type("BCDF-GHJK");
    await click("Continue");
    await type("MNPQ-RSTV");
    await click("Continue");
    lookups()[1]?.answer(200, LOGIN);
    await settle();
    lookups()[0]?.answer(200, LOGIN);
    await settle();
    expect(buttons()).toContain("Approve MNPQ-RSTV");
    expect(buttons()).not.toContain("Approve BCDF-GHJK");
  });

  it("keeps the current login when an earlier lookup fails late", async () => {
    await open("#device");
    await type("BCDF-GHJK");
    await click("Continue");
    await type("MNPQ-RSTV");
    await click("Continue");
    lookups()[1]?.answer(200, LOGIN);
    await settle();
    lookups()[0]?.answer(404, {
      error: { code: "not_found", message: "No login", state: null },
    });
    await settle();
    expect(buttons()).toContain("Approve MNPQ-RSTV");
    expect(document.querySelector("#status")?.textContent ?? "").toBe("");
  });

  it("approves only the displayed code, normalized", async () => {
    await open("#device");
    await type("bcdf ghjk");
    await click("Continue");
    expect(lookups()[0]?.body).toEqual({ userCode: "BCDFGHJK" });
    lookups()[0]?.answer(200, LOGIN);
    await settle();
    await click("Approve BCDF-GHJK");
    const approvals = calls.filter(
      (c) => c.path === "/v1/inbox/device/approve",
    );
    expect(approvals.map((c) => c.body)).toEqual([
      { userCode: "BCDFGHJK", machine: "studio" },
    ]);
  });

  it("refuses to approve when the typed code no longer matches", async () => {
    await open("#device");
    await type("BCDF-GHJK");
    await click("Continue");
    lookups()[0]?.answer(200, LOGIN);
    await settle();
    // Changed without an input event, as autofill can.
    codeInput().value = "MNPQ-RSTV";
    await click("Approve BCDF-GHJK");
    expect(calls.filter((c) => c.path.startsWith("/v1/inbox/device/"))).toEqual(
      [],
    );
  });
});
