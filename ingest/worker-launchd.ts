import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const workerLabel = "dev.prompix.worker";
export const workerPlistPath = () => join(homedir(), "Library/LaunchAgents", `${workerLabel}.plist`);
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** launchd restarts the worker whenever it exits, and starts it at login. */
export function workerPlist(options: { node: string; repo: string; root: string }): string {
  const path = [dirname(options.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const strings = (values: string[]) => values.map(value => `    <string>${escape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${workerLabel}</string>
  <key>ProgramArguments</key>
  <array>
${strings([options.node, "--import", "tsx", "ingest/worker.ts"])}
  </array>
  <key>WorkingDirectory</key>
  <string>${escape(options.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escape(join(options.root, "worker.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(join(options.root, "worker.log"))}</string>
</dict>
</plist>
`;
}

const launchctl = (...args: string[]) => promisify(execFile)("launchctl", args);
const domain = () => `gui/${userInfo().uid}`;

export async function installWorker(options: { node: string; repo: string; root: string }) {
  await mkdir(dirname(workerPlistPath()), { recursive: true });
  await mkdir(options.root, { recursive: true });
  await writeFile(workerPlistPath(), workerPlist(options), { mode: 0o644 });
  await launchctl("bootout", `${domain()}/${workerLabel}`).catch(() => undefined);
  await launchctl("bootstrap", domain(), workerPlistPath());
}

export async function uninstallWorker() {
  await launchctl("bootout", `${domain()}/${workerLabel}`).catch(() => undefined);
  await rm(workerPlistPath(), { force: true });
}

/** Picks up new code after the main checkout is updated. */
export const restartWorker = () => launchctl("kickstart", "-k", `${domain()}/${workerLabel}`);
