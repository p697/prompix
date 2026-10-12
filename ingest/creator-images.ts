import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { download } from "./network.ts";
import { prepareJPEG } from "./images.ts";

const ownAvatar = /^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.jpg$/;

/** Try the same X photo's larger rendition, then the API-returned thumbnail. */
export function avatarDownloadURLs(value: string): string[] {
  const url = new URL(value);
  if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/profile_images/") && /_normal\.(jpg|jpeg|png|webp)$/.test(url.pathname)) {
    const larger = new URL(value);
    larger.pathname = larger.pathname.replace(/_normal(\.[^.]+)$/, "_400x400$1");
    return [larger.toString(), value];
  }
  return [value];
}

/** Only immutable, verified JPEGs are returned to the public creator contract. */
export async function publishAvatar(
  url: string, root: string, cache: Record<string, string>,
  upload: (key: string, path: string, type: string) => Promise<void>,
): Promise<string> {
  if (ownAvatar.test(url)) return url;
  if (cache[url] && ownAvatar.test(cache[url])) return cache[url];
  let data: Awaited<ReturnType<typeof download>> | undefined;
  let failure: unknown;
  for (const candidate of avatarDownloadURLs(url)) {
    try {
      data = await download(candidate, ["pbs.twimg.com", "github.com", "avatars.githubusercontent.com"], 4_000_000);
      if (!["image/jpeg", "image/png", "image/webp"].includes(data.type)) throw new Error("Unexpected avatar media type");
      break;
    } catch (error) { failure = error; data = undefined; }
  }
  if (!data) throw failure ?? new Error("Avatar unavailable");
  await mkdir(join(root, "tmp"), { recursive: true });
  const identity = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const input = join(root, "tmp", `avatar-${process.pid}-${identity}.image`);
  const output = join(root, "tmp", `avatar-${process.pid}-${identity}.jpg`);
  try {
    await writeFile(input, data.bytes);
    await prepareJPEG(input, output, 400);
    const hash = createHash("sha256").update(await readFile(output)).digest("hex");
    const key = `media/${hash}.jpg`;
    await upload(key, output, "image/jpeg");
    cache[url] = `https://api.prompix.dev/${key}`;
    return cache[url];
  } finally { await rm(input, { force: true }); await rm(output, { force: true }); }
}
