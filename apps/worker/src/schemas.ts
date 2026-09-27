import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import type { AppendTrace, CreateAsk } from "./protocol.gen.ts";

/** Content limits. The API enforces them; the CLI and inbox rely on its errors. */
export const LIMITS = {
  createBytes: 64 * 1024,
  traceBytes: 8 * 1024,
  answerBytes: 16 * 1024,
  adminBytes: 4 * 1024,
  titleChars: 120,
  bodyBytes: 16 * 1024,
  links: 16,
  options: 8,
  inputBytes: 4 * 1024,
  noteBytes: 1024,
  refs: 16,
  traceEvents: 50,
  expiresInMinutes: 30 * 24 * 60,
  page: 100,
} as const;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;

// Printable text on one line: no control characters, including newlines.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/;

const line = (max: number) =>
  z.string().min(1).max(max).regex(ONE_LINE, "must be one line");
const bytes = (max: number) =>
  z.string().refine((s) => utf8Bytes(s) <= max, `must be at most ${max} bytes`);
const https = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((u) => URL.canParse(u), "must be an https URL");

export const askId = z.string().regex(ULID_PATTERN, "must be an Ask id");
export const githubLogin = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
    "must be a GitHub login",
  );
export const repo = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "must be owner/name",
  );

const kind = z.enum(["approval", "question", "fyi"]);
const urgency = z.enum(["now", "soon", "later", "fyi"]);
const risk = z.enum(["routine", "sensitive", "irreversible"]);
const decision = z.enum(["approve", "reject", "other"]);

const action = z.strictObject({
  verb: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "must be a lowercase word"),
  target: line(200),
  rev: z
    .string()
    .regex(
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
      "must be a full lowercase hex revision",
    ),
  limits: line(500).nullable().exactOptional(),
});

const option = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "must be a short lowercase id"),
  label: line(80),
  decision,
  inputRequired: z.boolean().exactOptional(),
});

const link = z.strictObject({ label: line(40), url: https });

const resumeField = line(200).nullable().exactOptional();
const resume = z.strictObject({
  run: resumeField,
  task: resumeField,
  branch: resumeField,
  rev: resumeField,
});

export const createAsk = z
  .strictObject({
    idemKey: line(200),
    decisionKey: line(200),
    to: githubLogin.nullable().exactOptional(),
    repo: repo.nullable().exactOptional(),
    supersedes: askId.nullable().exactOptional(),
    kind,
    urgency,
    risk,
    title: line(LIMITS.titleChars),
    body: bytes(LIMITS.bodyBytes).nullable().exactOptional(),
    links: z.array(link).max(LIMITS.links).exactOptional(),
    action: action.nullable().exactOptional(),
    options: z.array(option).min(1).max(LIMITS.options),
    resume: resume.nullable().exactOptional(),
    expiresInMinutes: z
      .int()
      .min(1)
      .max(LIMITS.expiresInMinutes)
      .nullable()
      .exactOptional(),
  })
  .superRefine((ask, ctx) => {
    const issue = (message: string, path: PropertyKey[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const ids = new Set<string>();
    for (const [i, o] of ask.options.entries()) {
      if (ids.has(o.id))
        issue(`duplicate option id "${o.id}"`, ["options", i, "id"]);
      ids.add(o.id);
    }
    const count = (d: z.infer<typeof decision>) =>
      ask.options.filter((o) => o.decision === d).length;
    switch (ask.kind) {
      case "approval":
        if (!ask.action) issue("an approval needs an action", ["action"]);
        if (count("approve") !== 1 || count("reject") !== 1)
          issue("an approval needs exactly one approve and one reject option", [
            "options",
          ]);
        break;
      case "question":
        if (count("other") !== ask.options.length)
          issue("a question offers only options with the decision other", [
            "options",
          ]);
        break;
      case "fyi":
        if (ask.options.length !== 1 || count("other") !== 1)
          issue("an fyi offers exactly one option with the decision other", [
            "options",
          ]);
        break;
      default: {
        const unreachable: never = ask.kind;
        throw new Error(`unknown kind ${String(unreachable)}`);
      }
    }
  });

const reportedEvent = z.enum([
  "dispatched",
  "progress",
  "applied",
  "failed",
  "not_applicable",
  "corrected",
]);

export const appendTrace = z
  .strictObject({
    event: reportedEvent,
    refs: z
      .record(
        z
          .string()
          .regex(/^[a-z][a-z0-9_.-]{0,63}$/, "must be a short lowercase key"),
        line(256),
      )
      .refine(
        (r) => Object.keys(r).length <= LIMITS.refs,
        `at most ${LIMITS.refs} refs`,
      )
      .exactOptional(),
    url: https.nullable().exactOptional(),
    note: bytes(LIMITS.noteBytes).nullable().exactOptional(),
  })
  .superRefine((t, ctx) => {
    if (
      (t.event === "applied" ||
        t.event === "failed" ||
        t.event === "corrected") &&
      !t.url
    )
      ctx.addIssue({
        code: "custom",
        message: `${t.event} needs an evidence url`,
        path: ["url"],
      });
    if (t.event === "failed" && !t.note)
      ctx.addIssue({
        code: "custom",
        message: "failed needs a note with the reason",
        path: ["note"],
      });
    if (t.event === "corrected" && !t.note)
      ctx.addIssue({
        code: "custom",
        message: "corrected needs a note saying what was wrong",
        path: ["note"],
      });
  });

/** Filters for `GET /v1/asks`. */
export const listFilter = z.strictObject({
  state: z.enum(["open", "answered"]).default("open"),
  terminal: z.literal("none").optional(),
  after: askId.optional(),
  prefix: z.string().min(1).max(200).optional(),
  repo: repo.optional(),
});

/** Body of the inbox's answer request. `assertion` is required for approvals. */
export const answer = z.strictObject({
  option: z.string().min(1).max(32),
  input: bytes(LIMITS.inputBytes).nullable().exactOptional(),
  rev: z.string().max(64).nullable().exactOptional(),
  assertion: z.unknown().optional(),
});
export type AnswerRequest = z.infer<typeof answer>;

export const answerChallenge = answer.omit({ assertion: true });

/** A requester name made in Settings, or an automation name from `--as`. */
export const requesterName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._@-]{0,79}$/, "must be a short lowercase name");

/** A machine name chosen at `roger login`, such as `studio`. */
export const machineName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,39}$/,
    "must be a short lowercase name of letters, digits, and dashes",
  );

/** A user code as the person types it; normalized before lookup. */
const userCode = z.string().min(1).max(20);

export const deviceLookup = z.strictObject({ userCode });
export const deviceApproval = z.strictObject({
  userCode,
  machine: machineName,
});
export const adoption = z.strictObject({ name: requesterName });

export const newRequester = z.strictObject({
  name: requesterName,
  pickupMinutes: z.int().min(1).max(LIMITS.expiresInMinutes).exactOptional(),
  completionMinutes: z
    .int()
    .min(1)
    .max(LIMITS.expiresInMinutes)
    .exactOptional(),
});

export const notificationSettings = z.strictObject({
  ntfyTopic: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be an ntfy topic name")
    .nullable(),
});

/** Formats the first few issues as one message for an `invalid_request` error. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    )
    .join("; ");
}

// The schemas must accept exactly the shapes generated from roger-protocol.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const createAskMatchesProtocol: Equals<
  z.output<typeof createAsk>,
  CreateAsk
> = true;
const appendTraceMatchesProtocol: Equals<
  z.output<typeof appendTrace>,
  AppendTrace
> = true;
void createAskMatchesProtocol;
void appendTraceMatchesProtocol;
