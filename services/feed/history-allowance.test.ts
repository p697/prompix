import { test } from "node:test";
import assert from "node:assert/strict";
import { historyAllowanceIDs } from "./history-allowance.ts";
const permit = { version: 1 as const, id: "test", approvedAt: "2026-10-19T00:00:00Z", expiresAt: "2026-10-20T00:00:00Z", contentIDs: ["x-post-1"] };
test("bulk authorization is finite, unique, source-scoped and time-bounded", () => {
 const now = Date.parse("2026-10-19T12:00:00Z");
 assert.deepEqual(historyAllowanceIDs(permit, now), ["x-post-1"]);
 assert.deepEqual(historyAllowanceIDs(undefined, now), []);
 for (const p of [{...permit,contentIDs:["x-post-1","x-post-1"]},{...permit,contentIDs:["other"]},{...permit,expiresAt:"2026-10-22T00:00:00Z"}, {...permit,expiresAt:"2026-10-19T06:00:00Z"}]) assert.throws(()=>historyAllowanceIDs(p,now));
 assert.throws(()=>historyAllowanceIDs(permit,Date.parse("2026-10-18T00:00:00Z")));
});
