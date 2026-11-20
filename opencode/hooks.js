import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

// The scan recipes' start confirmation, word for word: the one question that is
// timed. The TUI part cancels it when it goes unanswered.
export const SCAN_START_CONFIRMATION =
  "This scan may take a while and may use a significant number of tokens. " +
  "You will need to leave OpenCode open while the scan completes. " +
  "Are you sure you want to continue?"
export const UNANSWERED_AFTER_MS = 60_000

const TIP =
  "OpenCode Security: this branch changes {size} against {base}. For a security review," +
  ' ask: "scan this branch\'s changes against {base} with OpenCode Security".'
// Past this many tips no branch is owed another one.
const MAX_TIPS = 5
const STATE_KEY = "scan-tip"
const BASES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"]
// No repository hook and no fsmonitor runs; "core.fsmonitor=" (empty, not false) is off on any git.
const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="]
const GIT_TIMEOUT_MS = 2_000
// The whole tip gets this long; a branch slow to measure is noted and not measured again.
const TIP_BUDGET_MS = 3_000
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"]
// Past this many files a change review no longer reads the change closely: nothing to suggest.
const MAX_FILES = 300

async function git(directory, args, deadline) {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error("the tip's git budget is spent")
  try {
    const { stdout } = await exec("git", [...GIT, "-C", directory, ...args], {
      timeout: Math.min(GIT_TIMEOUT_MS, left),
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
    })
    return stdout.replace(/\r?\n$/, "")
  } catch (error) {
    // A slow git still spends the budget; a failing one just answers "".
    if (error?.killed || error?.signal) throw error
    return ""
  }
}

export async function branchAt(directory, deadline) {
  const place = await git(directory, ["rev-parse", "--show-toplevel", "--git-common-dir", "HEAD"], deadline)
  const [top, common, head] = place.split("\n")
  if (!top || !common || !head) return undefined
  const name = await git(directory, ["symbolic-ref", "-q", "--short", "HEAD"], deadline)
  if (!name) return undefined
  // The common git directory, so every worktree of one repository is that repository.
  return { top, repo: resolve(directory, common), name, head }
}

export async function branchChange(branch, deadline) {
  const run = (args) => git(branch.top, args, deadline)
  const upstream = await run(["rev-parse", "--abbrev-ref", "@{upstream}"])
  // The branch's own pushed copy (<remote>/<same name>, which `git push -u` sets) is no base.
  const pushedCopy = upstream.split("/").slice(1).join("/") === branch.name
  const refs = upstream && !pushedCopy ? [upstream, ...BASES] : BASES
  let base = ""
  for (const ref of refs) {
    const found = await run(["rev-parse", "--verify", "-q", "--abbrev-ref", ref])
    if (found) {
      base = found
      break
    }
  }
  if (!base) return undefined
  const fork = await run(["merge-base", base, "HEAD"])
  if (!fork) return undefined
  const files = ((await run([...DIFF, fork, "HEAD"])).match(/\0/g) || []).length
  return files > 0 && files <= MAX_FILES ? { files, base } : undefined
}

export function tipText(files, base) {
  return TIP.replaceAll("{size}", files === 1 ? "1 file" : `${files} files`).replaceAll("{base}", base)
}

function branchKey(branch, perCommit) {
  const parts = [branch.repo, branch.name, perCommit ? branch.head : ""]
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)
}

async function readState(ctx) {
  const raw = await ctx.storage.get(STATE_KEY).catch(() => undefined)
  const shown = Array.isArray(raw?.shown) ? raw.shown.filter((key) => typeof key === "string") : []
  return {
    opened: raw?.opened === true,
    shown,
    last: typeof raw?.last === "string" ? raw.last : "",
  }
}

async function writeState(ctx, state) {
  await ctx.storage
    .set(STATE_KEY, { opened: state.opened, shown: state.shown, last: state.last })
    .catch(() => {})
}

// Opening the menu once is enough: no branch is owed a tip after that.
export async function markMenuOpened(ctx) {
  const state = await readState(ctx)
  if (state.opened) return
  await writeState(ctx, { ...state, opened: true })
}

// The hint after `git push` or `gh pr create`, when the branch has changes against
// its base and this branch has not been tipped yet.
export async function maybeTip(ctx, event) {
  if (event.status !== "completed") return ""
  if (event.tool !== "shell" && event.tool !== "bash") return ""
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") return ""
  const mode = String(process.env.OPENCODE_SECURITY_SCAN_TIP || "").toLowerCase()
  if (mode === "off") return ""
  const always = mode === "always"
  const command = String(event.input?.command || "")
  const pushed = /^\s*git\s+push\b/.test(command)
  const prOpened = !pushed && /^\s*gh\s+pr\s+create\b/.test(command)
  if (!pushed && !prOpened) return ""

  const info = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
  // A specialist's own shell call is not the user publishing a branch.
  if (info?.parentID) return ""
  const directory = info?.location?.directory || ctx.location?.directory
  if (!directory) return ""

  const state = await readState(ctx)
  if (!always && (state.opened || state.shown.length >= MAX_TIPS)) return ""

  const started = Date.now()
  const deadline = started + TIP_BUDGET_MS
  let branch
  try {
    branch = await branchAt(directory, deadline)
  } catch {
    return ""
  }
  if (!branch) return ""
  const key = branchKey(branch, always)
  if (state.last === key || state.shown.includes(key)) return ""

  let change
  try {
    change = await branchChange(branch, deadline)
  } catch {
    change = undefined
  }
  if (!change && Date.now() - started < GIT_TIMEOUT_MS) return ""

  state.last = key
  if (!always) state.shown.push(key)
  await writeState(ctx, state)
  return change ? tipText(change.files, change.base) : ""
}
