import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { TransientXReadError } from "./x.ts";

const stateSchema = z.object({ notBefore: z.number().int().nonnegative() }).strict();
type Pacing = { intervalMS?: number; waitMS?: number };

/** All processes sharing the spend ledger share one request lane. No HTTP retry. */
export async function paceTwitterAPI<T>(root: string, operation: () => Promise<T>, options: Pacing = {}): Promise<T> {
  const interval = options.intervalMS ?? 6500, wait = options.waitMS ?? 120_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(wait) || wait < 1)
    throw new Error("Invalid TwitterAPI pacing limits");
  await mkdir(root, { recursive: true });
  const lock = join(root, "twitterapi-request.lock"), state = join(root, "twitterapi-pacing.json");
  const deadline = Date.now() + wait;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    // Do not steal a possibly active or incompletely persisted lock. Recovery
    // must inspect the original operation and its financial reservation first.
    if (Date.now() >= deadline) throw new Error("TwitterAPI request lane is busy; no request sent");
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  try {
    await atomic(join(lock, "owner.json"), { pid: process.pid });
    const previous = stateSchema.parse(await json(state, { notBefore: 0 }));
    const delay = Math.max(0, previous.notBefore - Date.now());
    if (delay > deadline - Date.now()) throw new Error("TwitterAPI cooldown exceeds this wait window; no request sent");
    while (previous.notBefore > Date.now())
      await new Promise(resolve => setTimeout(resolve, previous.notBefore - Date.now()));
    // Persist before the callback can reserve money or send HTTP. Keeping the
    // lock through response settlement prevents overlapping daily/backfill calls.
    await atomic(state, { notBefore: Date.now() + interval });
    let cooldown = interval;
    try { return await operation(); }
    catch (error) {
      if (error instanceof TransientXReadError)
        cooldown = Math.max(interval, Math.min(error.retryAfterMS, 24 * 3600_000));
      throw error;
    } finally {
      // Start the next interval after settlement. A slow filesystem write or a
      // suspended process before HTTP must not consume the network spacing.
      await atomic(state, { notBefore: Date.now() + cooldown });
    }
  } finally { await rm(lock, { recursive: true }); }
}
