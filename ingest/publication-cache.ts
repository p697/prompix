import { constants } from "node:fs";
import { open, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { preparePublication, type PublicationInput } from "../services/feed/publication.ts";

const maximumBytes = 256 * 1024 * 1024;
const pathFor = (root: string, release: string) => {
  if (!/^feed-[a-f0-9]{64}$/.test(release)) throw new Error("Invalid cached release identity");
  return join(root, "database-release-cache", `${release}.json`);
};
/** Recompute the database's complete content identity; a cache is never an authority. */
export async function readPublicationCache(root: string, release: string): Promise<PublicationInput | undefined> {
  const path = pathFor(root, release);
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximumBytes) return;
      bytes = await file.readFile();
      if (bytes.length !== info.size || bytes.length > maximumBytes) return;
    } finally { await file.close(); }
    const catalog = JSON.parse(bytes.toString("utf8"));
    if (preparePublication(catalog).id !== release) return;
    return { ...catalog, version: release };
  } catch { return; } // Missing, corrupt or unsafe cache uses the authoritative bounded export.
}
/** Optional acceleration only. Failure to store a cache cannot turn a committed stage into a failure. */
export async function storePublicationCache(root: string, release: string, catalog: PublicationInput): Promise<boolean> {
  const path = pathFor(root, release);
  if (preparePublication(catalog).id !== release) return false;
  const bytes = Buffer.from(JSON.stringify({ ...catalog, version: release }) + "\n");
  if (bytes.length > maximumBytes) return false;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(root, "database-release-cache"), { recursive: true });
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, path);
    return true;
  } catch { return false; }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
