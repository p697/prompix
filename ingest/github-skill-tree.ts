import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

export type SkillTreeExecutor = (command: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;
const treeResponseLimit = 7_000_000;

export async function requestSkillTree(repo: string, revision: string, run: SkillTreeExecutor): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run("gh", ["api", "--hostname", "github.com", `repos/${repo}/git/trees/${revision}?recursive=1`,
      "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2026-03-10"], {
      encoding: "utf8", timeout: 60_000, maxBuffer: treeResponseLimit, killSignal: "SIGKILL", shell: false,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: "", GH_FORCE_TTY: "",
        GH_PAGER: "cat", PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1" },
    }));
  } catch {
    // Child-process errors contain stdout/stderr; never expose CLI diagnostics or credentials.
    throw new Error("Skill repository tree request failed");
  }
  if (Buffer.byteLength(stdout, "utf8") > treeResponseLimit) throw new Error("Skill repository tree exceeds size limit");
  try { return JSON.parse(stdout); }
  catch { throw new Error("Skill repository tree response is not valid JSON"); }
}

