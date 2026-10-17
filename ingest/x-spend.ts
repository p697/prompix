import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { rapidAPICycleSchema, rapidAPICycleTermsSchema, rapidAPICycleMonths, rapidAPICycleUsage,
  rapidAPIRequestRunway, type RapidAPICycleTerms } from "./rapidapi-quota.ts";

const amount = z.number().int().nonnegative().max(20_000_000);
const entrySchema = z.object({
  id: z.string().uuid(), at: z.iso.datetime(), provider: z.enum(["official", "twitterapi", "tweetapi", "rapidapi"]),
  operation: z.enum(["search", "lookup", "users", "subscription"]), request: z.string().regex(/^[a-f0-9]{64}$/),
  reserved: amount, accounted: amount, state: z.enum(["reserved", "completed", "uncertain"]),
}).strict().refine(entry => entry.state === "completed" ? entry.accounted <= entry.reserved : entry.accounted === entry.reserved,
  "Invalid X reservation accounting");
const ledgerSchema = z.object({ version: z.literal(1), month: z.string().regex(/^\d{4}-\d{2}$/),
  opening: amount, entries: z.array(entrySchema).max(100_000) }).strict()
  .refine(ledger => new Set(ledger.entries.map(e => e.id)).size === ledger.entries.length &&
    ledger.entries.every(e => e.at.startsWith(`${ledger.month}-`)), "Invalid X ledger entries");
export class XBudgetExceeded extends Error {}
export const xUnitMicroUSD = { official: { post: 5000, user: 10000 }, twitterapi: { post: 150, user: 180 } } as const;
// TweetAPI's bulk lookup bills one call, including empty results, at the PAYG rate.
export const tweetAPICallMicroUSD = 500;
// One explicitly approved Basic month; this is NOT a production provider tariff.
export const rapidAPIPilotFeeMicroUSD = 1_000_000;
export const rapidAPIPilotMaxCalls = 8;
export type XSpendPurpose = "growth" | "maintenance";
export const maintenanceReserveSchema = z.object({
  version: z.literal(1), checkedAt: z.iso.datetime(), complete: z.boolean(),
  standalone: z.number().int().min(0).max(100000), officialPosts: z.number().int().min(0).max(2000000),
  sourceSetSHA256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Nominal two-scan runway, not an estimate of unpredictable official fallbacks.
 * Keep the entire current day as headroom even if its first scan already ran. */
export function maintenanceRunway(plan: z.infer<typeof maintenanceReserveSchema>, now: Date) {
  const daily = 2 * (plan.standalone * xUnitMicroUSD.twitterapi.post + plan.officialPosts * xUnitMicroUSD.official.post);
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate() + 1;
  return { daily, monthly: daily * days, days };
}

/** Explicit opt-in supports importing account spend before enabling the production guard. */
export function configuredXSpendBudget(environment: NodeJS.ProcessEnv = process.env) {
  const reserve = environment.PROMPIX_X_MAINTENANCE_RESERVE;
  if (reserve !== undefined && reserve !== "1" && reserve !== "0") throw new Error("Invalid X maintenance reserve switch");
  if (environment.PROMPIX_X_MONTHLY_USD === undefined) {
    if (environment.PROMPIX_X_DAILY_USD !== undefined || reserve === "1") throw new Error("Monthly X budget is required with a daily budget or maintenance reserve");
    return undefined;
  }
  const monthly = Number(environment.PROMPIX_X_MONTHLY_USD);
  return new XSpendBudget(environment.PROMPIX_X_SPEND_DIR ?? join(homedir(), ".local/share/prompix/x-spend"), monthly,
    Number(environment.PROMPIX_X_DAILY_USD ?? monthly), () => new Date(), reserve === "1");
}

/** Shared account ledger. Never stores credentials or source text. */
export class XSpendBudget {
  constructor(readonly root: string, readonly monthlyUSD = 20, readonly dailyUSD = 1,
    readonly now: () => Date = () => new Date(), readonly protectMaintenance = false) {
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
  async reserve(provider: "official" | "twitterapi" | "tweetapi" | "rapidapi", operation: "search" | "lookup" | "users" | "subscription", request: string, units: number,
    purpose: XSpendPurpose = "growth") {
    return this.reserveEntry(provider, operation, request, units, purpose, false);
  }

  /** Preparation for the production adapter, which remains disabled separately.
   * Only an explicitly reconciled, paid cycle can use this path. */
  async reserveRapidAPICycleLookup(request: string, purpose: XSpendPurpose = "maintenance") {
    return this.reserveEntry("rapidapi", "lookup", request, 1, purpose, true);
  }

  private async reserveEntry(provider: "official" | "twitterapi" | "tweetapi" | "rapidapi",
    operation: "search" | "lookup" | "users" | "subscription", request: string, units: number,
    purpose: XSpendPurpose, cycleLookup: boolean) {
    if (!Number.isSafeInteger(units) || units < 1 || units > 1000) throw new Error("Invalid X billable units");
    if (!["growth", "maintenance"].includes(purpose) || (purpose === "maintenance" && (operation !== "lookup" || (!["official", "twitterapi"].includes(provider) && !cycleLookup))))
      throw new Error("Only verified source lookups may use X maintenance headroom");
    if (provider === "tweetapi" && (operation !== "lookup" || units !== 1)) throw new Error("TweetAPI pilot reserves one lookup call");
    if (operation === "subscription" && provider !== "rapidapi") throw new Error("Only the RapidAPI pilot has a fixed fee");
    if (provider === "rapidapi" && (units !== 1 || !["lookup", "subscription"].includes(operation)))
      throw new Error("RapidAPI pilot reserves one fixed fee or one included lookup");
    const at = this.now().toISOString(), month = at.slice(0, 7), day = at.slice(0, 10);
    const unitCost = provider === "rapidapi" ? (operation === "subscription" ? rapidAPIPilotFeeMicroUSD : 0)
      : provider === "tweetapi" ? tweetAPICallMicroUSD : xUnitMicroUSD[provider][operation === "users" ? "user" : "post"];
    const reserved = units * unitCost;
    const path = join(this.root, `${month}.json`);
    let id: string = randomUUID();
    await this.transaction(async () => {
      const ledger = ledgerSchema.parse(await json(path, { version: 1, month, opening: 0, entries: [] }));
      if (ledger.month !== month) throw new Error("X spend ledger month mismatch");
      if (provider === "rapidapi") {
        const fees = ledger.entries.filter(e => e.provider === "rapidapi" && e.operation === "subscription");
        if (operation === "subscription" && fees.length) {
          if (fees.length === 1 && fees[0].request === createHash("sha256").update(request).digest("hex")) {
            id = fees[0].id; return; // Recover the same reservation after an interrupted operator handoff.
          }
          throw new Error("RapidAPI pilot fee already reserved; inspect the existing entry");
        }
        if (operation === "lookup") {
          if (!cycleLookup) {
            const age = fees.length === 1 ? Date.parse(at) - Date.parse(fees[0].at) : Infinity;
            if (fees.length !== 1 || fees[0].state !== "completed" || fees[0].accounted !== rapidAPIPilotFeeMicroUSD || age < 0 || age >= 72 * 3600_000)
              throw new Error("RapidAPI pilot requires a confirmed fee in this UTC month within 72 hours");
            if (ledger.entries.filter(e => e.provider === "rapidapi" && e.operation === "lookup").length >= rapidAPIPilotMaxCalls)
              throw new Error("RapidAPI pilot request allowance exhausted");
          }
          const cycle = await json(join(this.root, "rapidapi-cycle.json"), null);
          if (cycleLookup || cycle !== null) await this.admitRapidAPICycle(cycle, purpose, new Date(at));
        }
      }
      const monthly = ledger.opening + ledger.entries.reduce((sum, e) => sum + e.accounted, 0);
      const daily = ledger.entries.filter(e => e.at.startsWith(day)).reduce((sum, e) => sum + e.accounted, 0);
      if (monthly + reserved > Math.round(this.monthlyUSD * 1e6) || daily + reserved > Math.round(this.dailyUSD * 1e6))
        throw new XBudgetExceeded("X dollar budget reached; no request sent");
      if (this.protectMaintenance && purpose === "growth") {
        const plan = maintenanceReserveSchema.safeParse(await json(join(this.root, "maintenance-reserve.json"), null).catch(() => null));
        const age = plan.success ? Date.parse(at) - Date.parse(plan.data.checkedAt) : Infinity;
        if (!plan.success || !plan.data.complete || age < 0 || age >= 24 * 3600_000)
          throw new XBudgetExceeded("Current complete X maintenance census is required; no request sent");
        const runway = maintenanceRunway(plan.data, new Date(at));
        if (monthly + reserved + runway.monthly > Math.round(this.monthlyUSD * 1e6) ||
          daily + reserved + runway.daily > Math.round(this.dailyUSD * 1e6))
          throw new XBudgetExceeded("X maintenance runway is protected; no request sent");
      }
      ledger.entries.push({ id, at, provider, operation, request: createHash("sha256").update(request).digest("hex"),
        reserved, accounted: reserved, state: "reserved" });
      await atomic(path, ledger);
    });
    let finished = false;
    return { id, finish: async (returnedUnits?: number) => {
      if (finished) throw new Error("X reservation already settled");
      if (returnedUnits !== undefined && (!Number.isSafeInteger(returnedUnits) || returnedUnits < 0 || returnedUnits > units))
        throw new Error("X provider exceeded reserved result bound");
      await this.transaction(async () => {
        const ledger = ledgerSchema.parse(await json(path, null));
        const entry = ledger.entries.find(e => e.id === id);
        if (!entry || entry.state !== "reserved") throw new Error("Missing or settled X reservation");
        // Unknown outcomes keep their entire reservation. Even empty third-party reads have a minimum charge.
        entry.accounted = returnedUnits === undefined ? reserved : Math.max(provider === "official" ? 0 : 1, returnedUnits) * unitCost;
        entry.state = returnedUnits === undefined ? "uncertain" : "completed";
        await atomic(path, ledger);
      });
      finished = true;
    } };
  }

  private async rapidAPICycleAttempts(terms: RapidAPICycleTerms) {
    const ledgers = await Promise.all(rapidAPICycleMonths(terms).map(async month => {
      const ledger = ledgerSchema.parse(await json(join(this.root, `${month}.json`),
        { version: 1, month, opening: 0, entries: [] }));
      if (ledger.month !== month) throw new Error("RapidAPI cycle ledger month mismatch");
      return ledger;
    }));
    const entries = ledgers.flatMap(l => l.entries);
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error("Conflicting RapidAPI cycle ledger identities");
    const fee = ledgers.find(l => l.month === terms.feeMonth)?.entries.find(e => e.id === terms.feeReservationID);
    if (!fee || fee.provider !== "rapidapi" || fee.operation !== "subscription" || fee.state !== "completed" ||
        fee.reserved !== rapidAPIPilotFeeMicroUSD || fee.accounted !== rapidAPIPilotFeeMicroUSD ||
        Math.abs(Date.parse(fee.at) - Date.parse(terms.startsAt)) > 72 * 3600_000 ||
        Date.parse(fee.at) > this.now().getTime() || Date.parse(fee.at) >= Date.parse(terms.endsAt))
      throw new Error("RapidAPI cycle requires its original confirmed fee");
    return entries.filter(e => e.provider === "rapidapi" && e.operation === "lookup" &&
      Date.parse(e.at) >= Date.parse(fee.at) && Date.parse(e.at) < Date.parse(terms.endsAt)).map(e => e.id);
  }

  private async admitRapidAPICycle(raw: unknown, purpose: XSpendPurpose, now: Date) {
    if (raw === null) throw new Error("RapidAPI production cycle is not configured");
    const cycle = rapidAPICycleSchema.parse(raw);
    if (now.getTime() < Date.parse(cycle.terms.startsAt) || now.getTime() >= Date.parse(cycle.terms.stopAt))
      throw new Error("RapidAPI authorized subscription cycle is inactive; no renewal inferred");
    const usage = rapidAPICycleUsage(cycle, await this.rapidAPICycleAttempts(cycle.terms), now);
    if (usage.remaining < 1) throw new XBudgetExceeded("RapidAPI subscription request quota exhausted; no request sent");
    if (purpose === "growth") {
      const census = maintenanceReserveSchema.safeParse(await json(join(this.root, "maintenance-reserve.json"), null));
      const age = census.success ? now.getTime() - Date.parse(census.data.checkedAt) : Infinity;
      if (!census.success || !census.data.complete || age < 0 || age >= 24 * 3600_000)
        throw new XBudgetExceeded("Current complete X maintenance census is required for RapidAPI growth");
      if (usage.remaining - 1 < rapidAPIRequestRunway(census.data.standalone, cycle.terms.stopAt, now))
        throw new XBudgetExceeded("RapidAPI maintenance request runway is protected; no request sent");
    }
  }

  /** Operator reconciliation while provider callers are idle. Dashboard usage
   * includes external calls. Lower observations never release local attempts.
   * Immutable receipt bounds prevent rollover, renewal or resetting a cycle.
   * This does not activate production routing or purchase anything. */
  async reconcileRapidAPICycle(input: RapidAPICycleTerms, observedUsed: number) {
    const terms = rapidAPICycleTermsSchema.parse(input);
    z.number().int().min(0).max(100_000).parse(observedUsed);
    return this.transaction(async () => {
      const now = this.now(), at = now.toISOString(), path = join(this.root, "rapidapi-cycle.json");
      if (now.getTime() < Date.parse(terms.startsAt) || now.getTime() >= Date.parse(terms.stopAt))
        throw new Error("RapidAPI reconciliation requires an active authorized cycle");
      const existing = await json(path, null), ids = await this.rapidAPICycleAttempts(terms);
      let previousUsed = ids.length;
      if (existing !== null) {
        const prior = rapidAPICycleSchema.parse(existing);
        if (JSON.stringify(prior.terms) !== JSON.stringify(terms)) throw new Error("RapidAPI cycle terms are immutable; no renewal or reset");
        previousUsed = rapidAPICycleUsage(prior, ids, now).used;
      }
      const cycle = rapidAPICycleSchema.parse({ version: 1, terms, observedAt: at,
        usedFloor: Math.max(observedUsed, previousUsed), anchoredAttemptIDs: ids });
      await atomic(path, cycle);
      return rapidAPICycleUsage(cycle, ids, now);
    });
  }

  /** Operator-only receipt confirmation after checking the actual paid subscription.
   * This records no payment, never refunds a charge, and cannot renew the pilot. */
  async confirmRapidAPIPilotFee(id: string) {
    z.string().uuid().parse(id);
    const month = this.now().toISOString().slice(0, 7), path = join(this.root, `${month}.json`);
    await this.transaction(async () => {
      const ledger = ledgerSchema.parse(await json(path, null));
      if (ledger.month !== month) throw new Error("X spend ledger month mismatch");
      const entry = ledger.entries.find(e => e.id === id);
      if (!entry || entry.provider !== "rapidapi" || entry.operation !== "subscription" ||
          entry.reserved !== rapidAPIPilotFeeMicroUSD || entry.accounted !== rapidAPIPilotFeeMicroUSD)
        throw new Error("Missing RapidAPI pilot fee reservation");
      entry.state = "completed";
      await atomic(path, ledger);
    });
  }
}
