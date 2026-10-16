import { createHmac, timingSafeEqual } from "node:crypto";
import { creatorFiltersSchema, type CreatorFilters } from "./creator-filters.ts";
import { z } from "zod";
import { contentID, feedFiltersSchema, type FeedFilters } from "../../packages/schema/feed.ts";

const cursorSchema = z.object({
  v: z.literal(2), release: contentID, position: z.number().int().min(-1).max(1_000_000),
  rank: z.number().int().min(0).max(4),
  filters: feedFiltersSchema, expires: z.number().int().positive(),
}).strict();
export type FeedCursor = z.infer<typeof cursorSchema>;
export const cursorLifetimeSeconds = 24 * 60 * 60;
function signature(body: string, secret: string): Buffer {
  if (Buffer.byteLength(secret) < 32) throw new Error("Cursor signing key is not configured");
  return createHmac("sha256", secret).update(body).digest();
}
export function encodeCursor(cursor: FeedCursor, secret: string): string {
  return signPayload(cursorSchema.parse(cursor), secret);
}
function signPayload(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(body, secret).toString("base64url")}`;
}
function verifyPayload(token: string, secret: string): unknown {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid cursor");
  const [body, encoded] = token.split(".");
  const received = Buffer.from(encoded, "base64url"), expected = signature(body, secret);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Invalid cursor");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}
function validExpiry(expires: number, now: number): boolean {
  return expires > Math.floor(now / 1000) && expires <= Math.floor(now / 1000) + cursorLifetimeSeconds + 60;
}
export function decodeCursor(token: string, filters: FeedFilters, secret: string, now = Date.now()): FeedCursor {
  const cursor = cursorSchema.parse(verifyPayload(token, secret));
  if (!validExpiry(cursor.expires, now) ||
      JSON.stringify(cursor.filters) !== JSON.stringify(feedFiltersSchema.parse(filters))) throw new Error("Expired or mismatched cursor");
  return cursor;
}

const creatorCursorSchema = z.object({
  v: z.literal(1), scope: z.literal("creators"), release: contentID,
  count: z.number().int().min(1).max(100000), after: z.string().min(1).max(200),
  q: z.string().max(120), expires: z.number().int().positive(),
}).strict();
export type CreatorCursor = z.infer<typeof creatorCursorSchema>;
export function encodeCreatorCursor(cursor: CreatorCursor, secret: string): string {
  return signPayload(creatorCursorSchema.parse(cursor), secret);
}
export function decodeCreatorCursor(token: string, q: string, secret: string, now = Date.now()): CreatorCursor {
  const cursor = creatorCursorSchema.parse(verifyPayload(token, secret));
  if (cursor.q !== q || !validExpiry(cursor.expires, now)) throw new Error("Expired or mismatched cursor");
  return cursor;
}

const discoveryCursorSchema = z.object({
  v: z.literal(2), scope: z.literal("creator-discovery"), release: contentID,
  key: z.string().min(1).max(512), after: z.string().min(1).max(200), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  filters: creatorFiltersSchema, expires: z.number().int().positive(),
}).strict();
export function encodeDiscoveryCursor(cursor: z.infer<typeof discoveryCursorSchema>, secret: string): string {
  return signPayload(discoveryCursorSchema.parse(cursor), secret);
}
export function decodeDiscoveryCursor(token: string, filters: CreatorFilters, secret: string, now = Date.now()) {
  const cursor = discoveryCursorSchema.parse(verifyPayload(token, secret));
  if (!validExpiry(cursor.expires, now) || JSON.stringify(cursor.filters) !== JSON.stringify(creatorFiltersSchema.parse(filters)))
    throw new Error("Expired or mismatched cursor");
  return cursor;
}

// Separate lane positions keep the 4:1 blend stable across page sizes, new
// releases and removals, without recomputing live row-number ordinals.
const visualFeedCursorSchema = z.object({
  v: z.literal(1), scope: z.literal("visual-feed"), release: contentID,
  visual: z.number().int().min(-1).max(1_000_000), text: z.number().int().min(-1).max(1_000_000),
  slot: z.number().int().min(0).max(4),
  visualRemaining: z.number().int().min(0).max(1_000_000).optional(),
  textRemaining: z.number().int().min(0).max(1_000_000).optional(),
  plainRun: z.number().int().min(0).max(2).default(0),
  filters: feedFiltersSchema, expires: z.number().int().positive(),
}).strict();
export type VisualFeedCursor = z.infer<typeof visualFeedCursorSchema>;
export function encodeVisualFeedCursor(cursor: VisualFeedCursor, secret: string): string {
  return signPayload(visualFeedCursorSchema.parse(cursor), secret);
}
export function decodeVisualFeedCursor(token: string, filters: FeedFilters, secret: string, now = Date.now()): VisualFeedCursor {
  const cursor = visualFeedCursorSchema.parse(verifyPayload(token, secret));
  if (!validExpiry(cursor.expires, now) || JSON.stringify(cursor.filters) !== JSON.stringify(feedFiltersSchema.parse(filters)))
    throw new Error("Expired or mismatched cursor");
  return cursor;
}
