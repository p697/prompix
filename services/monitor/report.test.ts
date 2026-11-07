import { test } from "node:test";
import assert from "node:assert/strict";
import { reportMessage, reportSchema } from "./report.ts";

test("a daily report becomes one UTF-8 message to the configured recipient only", () => {
  const report = reportSchema.parse({ date: "2026-11-06", ok: false, text: "新增 0 条" });
  const message = reportMessage(report, "owner@example.com", "production", new Date("2026-11-07T00:01:00Z"));
  assert.match(message, /^From: Prompix <alerts@prompix.dev>\r\nTo: owner@example.com\r\n/);
  const subject = Buffer.from(/Subject: =\?UTF-8\?B\?(.+)\?=/.exec(message)![1], "base64").toString();
  assert.equal(subject, "Prompix · 管线日报 2026-11-06 · 有问题");
  const body = Buffer.from(message.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
  assert.match(body, /^新增 0 条/);
  assert.throws(() => reportMessage(report, "a@b.c\r\nBcc: x@y.z", "production"), /recipient/);
  assert.equal(reportSchema.safeParse({ date: "2026-11-06", ok: true, text: "x".repeat(12001) }).success, false);
});
