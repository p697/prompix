import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atomic, json, lockContent, repo } from "../ingest/publication.ts";
import { buildXSearchPlan, runXSearchPlan, searchPlanSchema } from "../ingest/x-search-plan.ts";
import { selectXSearchLeads } from "../ingest/x-search-admission.ts";
import { TwitterAPIClient } from "../ingest/twitterapi.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";

process.umask(0o077);
const args = process.argv.slice(2);
const value = (name: string, fallback?: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const output = value("--directory");
if (!output) throw new Error("Usage: tsx scripts/collect-x-search-plan.ts --directory /external/path --start ISO --end ISO [--fetch --max-requests 10] [--replay]");
const directory = resolve(output);
await mkdir(directory, { recursive: true, mode: 0o700 });
const rel = relative(await realpath(repo), await realpath(directory));
if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Search source data must stay outside Git");
const unlock = await lockContent(directory);
try {
  let plan: unknown = await json(join(directory, "plan.json"), null);
  if (plan && ["--start", "--end", "--window-hours", "--max-pages"].some(flag => args.includes(flag)))
    throw new Error("Existing plans are immutable; resume without date/plan flags or choose a new directory");
  if (!plan) {
    if (!value("--start") || !value("--end")) throw new Error("New plans require explicit start and end");
    plan = buildXSearchPlan(value("--start")!, value("--end")!, { windowHours: Number(value("--window-hours", "6")),
      maxPagesPerQuery: Number(value("--max-pages", "10")) });
  }
  const parsed = searchPlanSchema.parse(plan);
  if (!args.includes("--fetch") && !args.includes("--replay")) {
    await atomic(join(directory, "plan.json"), parsed);
    console.log(JSON.stringify({ status: "dry-run", queries: parsed.queries.length, maxPagesPerQuery: parsed.maxPagesPerQuery, directory }));
  } else {
    if (args.includes("--fetch") && args.includes("--replay")) throw new Error("Choose fetch or offline replay");
    const enabled = args.includes("--fetch");
    const budget = configuredXSpendBudget({ ...process.env, PROMPIX_X_MONTHLY_USD: process.env.PROMPIX_X_MONTHLY_USD ?? "20",
      PROMPIX_X_DAILY_USD: process.env.PROMPIX_X_DAILY_USD ?? "1" })!;
    const client = enabled ? new TwitterAPIClient(process.env.TWITTERAPI_IO_KEY ?? "", budget) : undefined;
    const result = await runXSearchPlan(directory, parsed, { maxRequests: enabled ? Number(value("--max-requests", "10")) : 0,
      search: client ? client.search.bind(client) : async () => { throw new Error("Offline replay cannot send requests"); } });
    const leads = await selectXSearchLeads(directory, parsed);
    await atomic(join(directory, "leads.json"), { ...leads, at: new Date().toISOString() });
    console.log(JSON.stringify({ status: result.status, requestsThisRun: result.requestsThisRun, returned: result.returned,
      unique: result.unique, candidateLeads: leads.leads.length, visualLeads: leads.report.visualLeads,
      incompleteQueries: result.queries.filter(q => q.status !== "complete").length, published: false, directory }));
  }
} finally { await unlock(); }
