import type { Ask, ReportedEvent } from "./protocol.gen.ts";

const THREAD =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/i;
const COMMENT = /^#(?:issuecomment|discussion_r|pullrequestreview)-\d+$/;
const TARGET = /^(?:pr|issue):([^/\s]+)\/([^#\s]+)#(\d+)$/i;

/** `owner/repo#number` of a GitHub issue or pull request URL, lowercased. */
export function githubThread(url: string): string | null {
  const m = THREAD.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
}

/** The GitHub threads an Ask is about: its links and its action target. */
export function askThreads(ask: Ask): Set<string> {
  const threads = new Set<string>();
  for (const link of ask.links) {
    const thread = githubThread(link.url);
    if (thread) threads.add(thread);
  }
  const target = ask.action ? TARGET.exec(ask.action.target) : null;
  if (target)
    threads.add(`${target[1]}/${target[2]}#${target[3]}`.toLowerCase());
  return threads;
}

/**
 * Why `url` cannot be the evidence for `event` on this Ask, or `null` when it
 * can. A comment on a GitHub issue or pull request must be on a thread the Ask
 * is about: recording another Ask's comment is the mistake this catches.
 * Other links (a new PR, a commit, a CI run) are accepted, and so is any link
 * when the Ask names no thread.
 */
export function evidenceProblem(
  ask: Ask,
  event: ReportedEvent,
  url: string,
): string | null {
  if (event === "dispatched" || event === "progress") return null;
  const thread = githubThread(url);
  if (!thread || !COMMENT.test(new URL(url).hash)) return null;
  const threads = askThreads(ask);
  if (threads.size === 0 || threads.has(thread)) return null;
  return `The evidence is a comment on ${thread}, but Ask ${ask.id} ("${ask.title}", ${ask.decisionKey}) is about ${[...threads].join(", ")}. Record the comment you wrote for this Ask, and check that the Ask id is the one you meant.`;
}
