import { createHash } from "node:crypto";

const message = "Selected model is at capacity. Please try a different model.";
/** Recognize only the observed pre-output rejection, never partial generation or malformed events. */
export function isPreOutputCapacityRejection(raw: string): boolean {
  try {
    const events = raw.trim().split("\n").map(line => JSON.parse(line));
    return events.length === 4 && events[0].type === "thread.started" && events[1].type === "turn.started"
      && events[2].type === "error" && events[2].message === message
      && events[3].type === "turn.failed" && events[3].error?.message === message;
  } catch { return false; }
}
/** Construct only after immutable events are saved and absence of output/result is checked. */
export class VerifiedCapacityRejection extends Error {
  readonly eventsSHA256: string;
  constructor(raw: string) {
    if (!isPreOutputCapacityRejection(raw)) throw new Error("Unverified capacity rejection");
    super("Verified model capacity rejection before output");
    this.eventsSHA256 = createHash("sha256").update(raw).digest("hex");
  }
}
