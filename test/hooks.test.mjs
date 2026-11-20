import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { markMenuOpened, maybeTip, tipText } from "../opencode/hooks.js"

const exec = promisify(execFile)
const identity = ["-c", "user.email=test@example.com", "-c", "user.name=test"]

function fakeContext(directory, session = {}) {
  const store = new Map()
  return {
    location: { directory },
    storage: {
      async get(key) {
        return store.get(key)
      },
      async set(key, value) {
        store.set(key, value)
      },
    },
    session: {
      async get() {
        return { location: { directory }, time: {}, ...session }
      },
    },
  }
}

function pushEvent(command = "git push origin feature") {
  return { tool: "shell", status: "completed", input: { command }, sessionID: "ses_test" }
}

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-security-tip-"))
  const repo = join(dir, "repo")
  await mkdir(repo)
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo })
  await exec("git", [...identity, "commit", "-q", "--allow-empty", "-m", "base"], { cwd: repo })
  await exec("git", ["checkout", "-q", "-b", "feature"], { cwd: repo })
  await writeFile(join(repo, "a.py"), "print(1)\n")
  await writeFile(join(repo, "b.py"), "print(2)\n")
  await exec("git", ["add", "."], { cwd: repo })
  await exec("git", [...identity, "commit", "-q", "-m", "change"], { cwd: repo })
  return repo
}

async function withMode(mode, body) {
  const previous = process.env.OPENCODE_SECURITY_SCAN_TIP
  if (mode === undefined) delete process.env.OPENCODE_SECURITY_SCAN_TIP
  else process.env.OPENCODE_SECURITY_SCAN_TIP = mode
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SECURITY_SCAN_TIP
    else process.env.OPENCODE_SECURITY_SCAN_TIP = previous
  }
}

test("the push tip names the base and the change, once per branch", async () => {
  await withMode(undefined, async () => {
    const repo = await repository()
    const ctx = fakeContext(repo)

    const tip = await maybeTip(ctx, pushEvent())
    assert.match(tip, /changes 2 files against main/)
    assert.match(tip, /scan this branch's changes against main/)
    assert.equal(await maybeTip(ctx, pushEvent()), "")

    await exec("git", ["checkout", "-q", "-b", "other"], { cwd: repo })
    await writeFile(join(repo, "c.py"), "print(3)\n")
    await exec("git", ["add", "."], { cwd: repo })
    await exec("git", [...identity, "commit", "-q", "-m", "more"], { cwd: repo })
    assert.match(await maybeTip(ctx, pushEvent()), /changes 3 files against main/)
  })
})

test("the tip stays quiet for anything but publishing a branch", async () => {
  await withMode(undefined, async () => {
    const repo = await repository()
    const ctx = fakeContext(repo)
    assert.equal(await maybeTip(ctx, pushEvent("git status")), "")
    assert.equal(await maybeTip(ctx, { ...pushEvent(), status: "error" }), "")
    assert.equal(await maybeTip(ctx, { ...pushEvent(), tool: "read" }), "")
    assert.equal(await maybeTip(fakeContext(repo, { parentID: "ses_parent" }), pushEvent()), "")
  })
})

test("opening the menu, or five tips, ends the hint", async () => {
  await withMode(undefined, async () => {
    const repo = await repository()
    const ctx = fakeContext(repo)
    assert.match(await maybeTip(ctx, pushEvent()), /changes 2 files/)

    await markMenuOpened(ctx)
    await exec("git", ["checkout", "-q", "-b", "after-menu"], { cwd: repo })
    await writeFile(join(repo, "d.py"), "print(4)\n")
    await exec("git", ["add", "."], { cwd: repo })
    await exec("git", [...identity, "commit", "-q", "-m", "later"], { cwd: repo })
    assert.equal(await maybeTip(ctx, pushEvent()), "")
  })

  await withMode(undefined, async () => {
    const repo = await repository()
    const ctx = fakeContext(repo)
    for (let index = 0; index < 6; index += 1) {
      await exec("git", ["checkout", "-q", "-B", `branch-${index}`, "main"], { cwd: repo })
      await writeFile(join(repo, `file-${index}.py`), "print(0)\n")
      await exec("git", ["add", "."], { cwd: repo })
      await exec("git", [...identity, "commit", "-q", "-m", `change ${index}`], { cwd: repo })
      const tip = await maybeTip(ctx, pushEvent())
      assert.equal(tip === "", index >= 5, `tip ${index}`)
    }
  })
})

test("OPENCODE_SECURITY_SCAN_TIP=always tips each new commit, and =off stays quiet", async () => {
  await withMode("always", async () => {
    const repo = await repository()
    const ctx = fakeContext(repo)
    assert.match(await maybeTip(ctx, pushEvent()), /changes 2 files against main/)
    assert.equal(await maybeTip(ctx, pushEvent()), "")
    await writeFile(join(repo, "e.py"), "print(5)\n")
    await exec("git", ["add", "."], { cwd: repo })
    await exec("git", [...identity, "commit", "-q", "-m", "again"], { cwd: repo })
    assert.match(await maybeTip(ctx, pushEvent()), /changes 3 files against main/)
  })

  await withMode("off", async () => {
    const repo = await repository()
    assert.equal(await maybeTip(fakeContext(repo), pushEvent()), "")
  })
})

test("tipText reads naturally for one file", () => {
  assert.match(tipText(1, "origin/main"), /changes 1 file against origin\/main/)
  assert.match(tipText(4, "main"), /changes 4 files against main/)
})
