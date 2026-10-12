import { z } from "zod";

export const defaultReviewRequests = 4;
export const maximumReviewRequests = 20;
export type ReviewAttempt = { day: string; requests: 1; state: "reserved" | "completed" | "failed" };
export type ReviewLedger<Attempt extends ReviewAttempt> = {
  schemaVersion: 2; day: string; requests: number; attempts: Attempt[];
};

/** Request counts bound Codex usage; they do not represent a measured dollar budget. */
export function reviewRequestLimit(value: unknown = defaultReviewRequests): number {
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new Error("Invalid daily review request limit");
  const limit = typeof value === "string" ? Number(value) : value;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > maximumReviewRequests)
    throw new Error(`Daily review request limit must be an integer between 0 and ${maximumReviewRequests}`);
  return limit;
}

/** Read old one-request ledgers without resetting their spent or interrupted attempt. */
export function reviewLedgerSchema<Attempt extends ReviewAttempt>(attemptSchema: z.ZodType<Attempt>) {
  const current = z.object({
    schemaVersion: z.literal(2), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    requests: z.number().int().min(1).max(maximumReviewRequests),
    attempts: z.array(attemptSchema).min(1).max(maximumReviewRequests),
  }).strict().superRefine((ledger, context) => {
    if (ledger.requests !== ledger.attempts.length || ledger.attempts.some(attempt => attempt.day !== ledger.day)
      || ledger.attempts.slice(0, -1).some(attempt => attempt.state !== "completed"))
      context.addIssue({ code: "custom", message: "Inconsistent daily review ledger" });
  });
  return z.union([attemptSchema, current]).transform((value): ReviewLedger<Attempt> =>
    "attempts" in value ? value as ReviewLedger<Attempt>
      : { schemaVersion: 2, day: value.day, requests: 1, attempts: [value as Attempt] });
}

export function appendReviewAttempt<Attempt extends ReviewAttempt>(ledger: ReviewLedger<Attempt> | undefined, attempt: Attempt): ReviewLedger<Attempt> {
  if (attempt.state !== "reserved") throw new Error("A review attempt must be reserved before it starts");
  const previous = ledger?.day === attempt.day ? ledger.attempts : [];
  if (previous.length >= maximumReviewRequests || previous.some(value => value.state !== "completed"))
    throw new Error("An unfinished review attempt blocks further requests for its day");
  const attempts = [...structuredClone(previous), structuredClone(attempt)];
  return { schemaVersion: 2, day: attempt.day, requests: attempts.length, attempts };
}

export function replaceReviewAttempt<Attempt extends ReviewAttempt>(ledger: ReviewLedger<Attempt>, attempt: Attempt): ReviewLedger<Attempt> {
  if (ledger.day !== attempt.day || ledger.attempts.at(-1)?.state !== "reserved" || attempt.state === "reserved")
    throw new Error("Only the reserved review attempt can be completed");
  return { ...ledger, attempts: [...structuredClone(ledger.attempts.slice(0, -1)), structuredClone(attempt)] };
}
