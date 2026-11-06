import { z } from "zod";

/** The pipeline's daily summary, composed by the pipeline; the monitor only delivers it. */
export const reportSchema = z.object({ date: z.iso.date(), ok: z.boolean(), text: z.string().min(1).max(12000) }).strict();
export type DailyReport = z.infer<typeof reportSchema>;

/** A plain-text UTF-8 message to the one configured recipient. */
export function encodeEmail(subject: string, body: string, id: string, at: Date, recipient: string): string {
  if (!/^[^\s<>\r\n]+@[^\s<>\r\n]+$/.test(recipient)) throw new Error("Invalid recipient configuration");
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  return [`From: Prompix <alerts@prompix.dev>`, `To: ${recipient}`, `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Message-ID: <${id}@prompix.dev>`, `Date: ${at.toUTCString()}`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64(body).match(/.{1,76}/g)!.join("\r\n")].join("\r\n");
}

export function reportMessage(report: DailyReport, recipient: string, label: string, at = new Date()): string {
  const subject = `${label === "production" ? "" : "[验收测试] "}Prompix · 管线日报 ${report.date}${report.ok ? "" : " · 有问题"}`;
  return encodeEmail(subject, `${report.text}\n\n此邮件由 Prompix 后台管线每天自动发送。\n`, `report-${report.date}-${at.getTime()}`, at, recipient);
}
