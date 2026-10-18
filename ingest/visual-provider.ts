import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { visualAttachmentSchema, visualCoverageSchema, visualDecisionSchema, visualInputCharacters, visualLimits,
  visualRequestText, visualReviewModel, conservativeVisualDecision, type VisualInput, type VisualProvider } from "./visual-review.ts";

export { visualInstructions } from "./visual-review.ts";

const inputSchema = z.object({
  id: z.string().min(1).max(200), identity: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["text", "image", "video"]),
  prompt: z.string().min(1), model: z.string(),
  source: z.object({ url: z.string().nullable(), repository: z.string().optional(), license: z.string() }).strict(),
  attachments: z.array(visualAttachmentSchema).min(1).max(visualLimits.attachments), coverage: visualCoverageSchema,
}).strict();

function validateInput(items: readonly VisualInput[]): VisualInput[] {
  const result = z.array(inputSchema).min(1).max(visualLimits.candidates).safeParse(items);
  if (!result.success) throw new Error("Invalid bounded visual review input");
  const values = result.data, attachments = values.flatMap(item => item.attachments);
  if (new Set(values.map(item => item.id)).size !== values.length ||
    new Set(values.map(item => item.identity)).size !== values.length || attachments.length > visualLimits.attachments ||
    attachments.reduce((sum, attachment) => sum + attachment.byteLength, 0) > visualLimits.totalBytes ||
    visualInputCharacters(values) > visualLimits.inputCharacters)
    throw new Error("Visual review input exceeds its identity or batch limits");
  for (const item of values) {
    if (new Set(item.attachments.map(attachment => attachment.id)).size !== item.attachments.length)
      throw new Error("Duplicate visual attachment identity");
    const coverage = item.coverage;
    if (item.kind !== "video") {
      if (coverage.mode !== "images" || item.attachments.some(attachment => attachment.role !== "image" || attachment.timeSeconds !== undefined))
        throw new Error("Invalid visual image coverage");
    } else {
      if (coverage.mode !== "sampled-frames") throw new Error("Video review requires actual sampled frame coverage");
      const frames = item.attachments.filter(attachment => attachment.role === "video-frame");
      if (item.attachments.filter(attachment => attachment.role === "poster").length !== 1 ||
        frames.length !== coverage.sampleTimes.length ||
        !coverage.videoSourceURL.endsWith(`/${coverage.videoSHA256}.mp4`) ||
        frames.some((frame, index) => frame.timeSeconds !== coverage.sampleTimes[index] || frame.sourceURL !== coverage.videoSourceURL ||
          coverage.sampleTimes[index] >= coverage.durationSeconds || (index > 0 && coverage.sampleTimes[index] <= coverage.sampleTimes[index - 1])))
        throw new Error("Video attachments do not match their sampled frame coverage");
    }
    if (item.attachments.some(attachment => attachment.role !== "video-frame" && !attachment.sourceURL.endsWith(`/${attachment.sha256}.jpg`)))
      throw new Error("Visual attachment does not match its mirrored source identity");
  }
  return values;
}

/** Exact permitted identity pairs, counts and attachment bindings for this request. */
export function visualResponseSchema(items: readonly VisualInput[]) {
  const values = validateInput(items);
  const variants = values.map(item => {
    const attachments = item.attachments.map(attachment => visualDecisionSchema.shape.attachments.element.extend({
      id: z.literal(attachment.id), sha256: z.literal(attachment.sha256),
    }));
    const attachment = attachments.length === 1 ? attachments[0] : z.union(attachments as [typeof attachments[0], typeof attachments[0], ...typeof attachments]);
    return visualDecisionSchema.extend({ presentation: z.enum(["general", "suggestive", "explicit", "unknown"]), id: z.literal(item.id), identity: z.literal(item.identity), attachments: z.array(attachment).length(attachments.length) });
  });
  const decision = variants.length === 1 ? variants[0] : z.union(variants as [typeof variants[0], typeof variants[0], ...typeof variants]);
  return z.object({ decisions: z.array(decision).length(values.length) }).strict();
}

/** The signature, frame dimensions and scan header must describe a JPEG, not only a renamed file. */
function hasJPEGStructure(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || !bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) return false;
  let offset = 2, hasFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) return false;
      hasFrame = true;
    }
    if (marker === 0xda) return hasFrame && length >= 6;
    offset += length;
  }
  return false;
}

/** Read at most the declared length plus one byte, even if a file grows during validation. */
async function boundedFile(path: string, maximum: number, expectedLength?: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum || (expectedLength !== undefined && info.size !== expectedLength))
      throw new Error("Bounded file size or type changed");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (length !== info.size) throw new Error("Bounded file changed while reading");
    return bytes;
  } finally { await file.close(); }
}

// Login state remains available through HOME/CODEX_HOME; unrelated service keys
// never enter the child process. Ignore user config/rules also disables configured MCP servers.
function providerEnvironment() {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "CODEX_HOME", "XDG_CONFIG_HOME"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

type ProviderLimits = { timeoutMs?: number; killGraceMs?: number };
/** Test overrides may shorten hard limits; they cannot enlarge the production budget. */
export function codexVisualProvider(executable = "codex",
  recordResponse?: (response: { model: string; receivedAt: string; text: string }) => Promise<void>, limits: ProviderLimits = {}): VisualProvider {
  const timeoutMs = limits.timeoutMs ?? 180_000, killGraceMs = limits.killGraceMs ?? 2000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000 || !Number.isInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 2000)
    throw new Error("Invalid visual provider time limit");
  return async items => {
    const values = validateInput(items), responseSchema = visualResponseSchema(values);
    const directory = await mkdtemp(join(tmpdir(), "prompix-visual-"));
    try {
      const schema = join(directory, "schema.json"), output = join(directory, "decisions.json"), paths: string[] = [];
      for (const attachment of values.flatMap(item => item.attachments)) {
        let bytes: Buffer;
        try {
          bytes = await boundedFile(attachment.path, visualLimits.attachmentBytes, attachment.byteLength);
          if (!hasJPEGStructure(bytes) || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256)
            throw new Error("Visual attachment JPEG bytes or hash changed");
        }
        catch { throw new Error("Visual attachment verification failed before provider execution"); }
        const path = join(directory, `attachment-${String(paths.length + 1).padStart(2, "0")}.jpg`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        paths.push(path);
      }
      await writeFile(schema, JSON.stringify(z.toJSONSchema(responseSchema)), { mode: 0o600 });
      let inputTokens: number | undefined, outputTokens: number | undefined;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
          "--sandbox", "read-only", "--cd", directory, "--model", visualReviewModel, "--json",
          "-c", 'model_reasoning_effort="low"', "-c", "features.shell_tool=false", "-c", 'web_search="disabled"',
          ...paths.flatMap(path => ["-i", path]), "--output-schema", schema, "--output-last-message", output, "-"],
        { stdio: ["pipe", "pipe", "pipe"], env: providerEnvironment() });
        let buffer = "", received = 0, diagnostics = 0, failure: Error | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
        const stop = (message: string) => {
          if (failure) return;
          failure = new Error(message); child.kill("SIGTERM");
          escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        };
        const timeout = setTimeout(() => stop("Visual provider timed out; daily attempt remains consumed"), timeoutMs);
        const cleanup = () => { clearTimeout(timeout); if (escalation) clearTimeout(escalation); };
        const eventLine = (line: string) => {
          let event: { type?: string; usage?: unknown; item?: { type?: string } };
          try { event = JSON.parse(line); } catch { return; }
          if (!event || typeof event !== "object") return;
          if (typeof event.type === "string" && event.type.startsWith("item.") && event.item?.type && !["agent_message", "reasoning"].includes(event.item.type))
            stop("Visual provider attempted a disallowed tool; no decision accepted");
          if (event.type === "turn.failed" || event.type === "error")
            stop("Visual provider reported a failed turn; no decision accepted");
          if (event.type === "turn.completed") {
            const usage = z.object({ input_tokens: z.number().int().nonnegative().max(1_000_000_000),
              output_tokens: z.number().int().nonnegative().max(1_000_000_000) }).safeParse(event.usage);
            if (usage.success) {
              inputTokens = (inputTokens ?? 0) + usage.data.input_tokens;
              outputTokens = (outputTokens ?? 0) + usage.data.output_tokens;
            }
          }
        };
        child.stdout.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > 2_000_000) { stop("Visual provider exceeded bounded output"); return; }
          buffer += chunk.toString();
          let end: number;
          while ((end = buffer.indexOf("\n")) !== -1) {
            eventLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          diagnostics += chunk.length;
          if (diagnostics > 2_000_000) stop("Visual provider exceeded bounded diagnostics");
        });
        child.stdin.on("error", () => {});
        child.on("error", () => { cleanup(); reject(new Error("Visual provider could not start")); });
        child.on("close", code => {
          if (buffer.trim()) eventLine(buffer);
          cleanup();
          if (failure) reject(failure);
          else if (code === 0) resolve();
          else reject(new Error(`Visual provider exited ${code ?? "without a status"}`));
        });
        child.stdin.end(visualRequestText(values));
      });
      let text: string;
      try {
        text = (await boundedFile(output, 32_000)).toString("utf8");
      } catch { throw new Error("Visual response is missing or exceeds bounded output size"); }
      await recordResponse?.({ model: visualReviewModel, receivedAt: new Date().toISOString(), text });
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error("Visual provider returned invalid JSON"); }
      const parsed = responseSchema.safeParse(value);
      if (!parsed.success) throw new Error("Visual provider returned invalid decisions or attachment identities");
      for (const [index, decision] of parsed.data.decisions.entries()) {
        const item = values[index];
        if (decision.id !== item.id || decision.identity !== item.identity || decision.attachments.some((attachment, position) =>
          attachment.id !== item.attachments[position].id || attachment.sha256 !== item.attachments[position].sha256))
          throw new Error("Visual provider returned duplicate, unordered or inconsistent decisions");
      }
      return { decisions: parsed.data.decisions.map(conservativeVisualDecision), inputTokens, outputTokens };
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
}
