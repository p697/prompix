import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";

const amount = z.number().int().nonnegative().max(20_000_000);
const entrySchema = z.object({
  id: z.string().uuid(), at: z.iso.datetime(), provider: z.enum(["official", "twitterapi"]),
  operation: z.enum(["search", "lookup", "users"]), request: z.string().regex(/^[a-f0-9]{64}$/),
  reserved: amount, accounted: amount, state: z.enum(["reserved", "completed", "uncertain"]),
}).strict().refine(entry => entry.state === "completed" ? entry.accounted <= entry.reserved : entry.accounted === entry.reserved,
  "Invalid X reservation accounting");
const ledgerSchema = z.object({ version: z.literal(1), month: z.string().regex(/^\d{4}-\d{2}$/),
  opening: amount, entries: z.array(entrySchema).max(100_000) }).strict()
  .refine(ledger => new Set(ledger.entries.map(e => e.id)).size === ledger.entries.length &&
    ledger.entries.every(e => e.at.startsWith(`${ledger.month}-`)), "Invalid X ledger entries");
export class XBudgetExceeded extends Error {}
export const xUnitMicroUSD = { official: { post: 5000, user: 10000 }, twitterapi: { post: 150, user: 180 } } as const;

/** Shared account ledger primitive. Only the pilot is wired today. Never stores credentials or source text. */
export class XSpendBudget {
  constructor(readonly root: string, readonly monthlyUSD = 20, readonly dailyUSD = 1,
    readonly now: () => Date = () => new Date()) {
    if (!Number.isFinite(monthlyUSD) || monthlyUSD <= 0 || monthlyUSD > 20 ||
        !Number.isFinite(dailyUSD) || dailyUSD <= 0 || dailyUSD > monthlyUSD) throw new Error("Invalid X dollar budget");
  }
  private async transaction<T>(operation: () => Promise<T>) {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, "spend.lock");
    try { await mkdir(lock); }
    catch { throw new Error("X spend ledger is busy; no request sent"); }
    try { return await operation(); } finally { await rm(lock, { recursive: true }); }
  }
  async reserve(provider: "official" | "twitterapi", operation: "search" | "lookup" | "users", request: string, units: number) {
    if (!Number.isSafeInteger(units) || units < 1 || units > 1000) throw new Error("Invalid X billable units");
    const at = this.now().toISOString(), month = at.slice(0, 7), day = at.slice(0, 10);
    const reserved = units * xUnitMicroUSD[provider][operation === "users" ? "user" : "post"];
    const path = join(this.root, `${month}.json`), id = randomUUID();
    await this.transaction(async () => {
      const ledger = ledgerSchema.parse(await json(path, { version: 1, month, opening: 0, entries: [] }));
      if (ledger.month !== month) throw new Error("X spend ledger month mismatch");
      const monthly = ledger.opening + ledger.entries.reduce((sum, e) => sum + e.accounted, 0);
      const daily = ledger.entries.filter(e => e.at.startsWith(day)).reduce((sum, e) => sum + e.accounted, 0);
      if (monthly + reserved > Math.round(this.monthlyUSD * 1e6) || daily + reserved > Math.round(this.dailyUSD * 1e6))
        throw new XBudgetExceeded("X dollar budget reached; no request sent");
      ledger.entries.push({ id, at, provider, operation, request: createHash("sha256").update(request).digest("hex"),
        reserved, accounted: reserved, state: "reserved" });
      await atomic(path, ledger);
    });
    let finished = false;
    return { finish: async (returnedUnits?: number) => {
      if (finished) throw new Error("X reservation already settled");
      if (returnedUnits !== undefined && (!Number.isSafeInteger(returnedUnits) || returnedUnits < 0 || returnedUnits > units))
        throw new Error("X provider exceeded reserved result bound");
      await this.transaction(async () => {
        const ledger = ledgerSchema.parse(await json(path, null));
        const entry = ledger.entries.find(e => e.id === id);
        if (!entry || entry.state !== "reserved") throw new Error("Missing or settled X reservation");
        // Unknown outcomes keep their entire reservation. Even empty third-party reads have a minimum charge.
        entry.accounted = returnedUnits === undefined ? reserved : Math.max(provider === "twitterapi" ? 1 : 0, returnedUnits)
          * xUnitMicroUSD[provider][operation === "users" ? "user" : "post"];
        entry.state = returnedUnits === undefined ? "uncertain" : "completed";
        await atomic(path, ledger);
      });
      finished = true;
    } };
  }
}
