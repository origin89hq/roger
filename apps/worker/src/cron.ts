import { pushAsk, type Services } from "./app.ts";
import { isWorkingTime, localClock } from "./config.ts";
import { digestPush } from "./notify.ts";

const BATCH = 200;

/**
 * Expires due Asks, sends due and failed pushes, sends each person's morning
 * digest once, and purges old content. Every step is a conditional write, so
 * an overlapping or repeated run changes nothing.
 */
export async function runCron(svc: Services): Promise<void> {
  const now = svc.now();
  const expired = await svc.store.expireDue(now, BATCH);
  await pushAsk(svc, null, now);
  await sendDigests(svc, now);
  const purged = await svc.store.purgeOldContent(now, BATCH);
  await svc.accounts.sweep(now, BATCH);
  console.info({ event: "cron", expired, purged });
}

async function sendDigests(svc: Services, now: number): Promise<void> {
  const { notifier, config } = svc;
  if (!notifier || !isWorkingTime(now, config.schedule)) return;
  const day = localClock(now, config.schedule.timeZone).date;
  for (const { githubId, topic } of await svc.store.digestCandidates()) {
    // `fyi` Asks are inbox only. A person with nothing to report is checked
    // again on the next run, so Asks that arrive later that day still count.
    const open = (await svc.store.openFor(githubId, BATCH)).filter(
      (a) => a.urgency !== "fyi",
    );
    if (open.length === 0) continue;
    if (!(await svc.store.claimDigest(githubId, day, now))) continue;
    try {
      await notifier.send(topic, digestPush(open, config.origin));
    } catch (error) {
      await svc.store.releaseDigest(githubId, day);
      console.warn({ event: "digest_failed", githubId, error: String(error) });
    }
  }
}
