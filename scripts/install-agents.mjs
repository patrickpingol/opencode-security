#!/usr/bin/env node
// OpenCode reads agent definitions from ~/.config/opencode/agents, so the
// plugin's specialists have to live there too. This links (default) or copies
// every agents/*.md file into that directory, and can undo it.
//
//   node scripts/install-agents.mjs            # symlink into the global agents dir
//   node scripts/install-agents.mjs --copy     # copy instead of symlink
//   node scripts/install-agents.mjs --remove   # remove the links/copies it made
//   node scripts/install-agents.mjs --check    # report what is installed, change nothing
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "agents")
const configDir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const target = join(configDir, "agents")

const args = new Set(process.argv.slice(2))
const copy = args.has("--copy")
const remove = args.has("--remove")
const check = args.has("--check")

async function state(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return { kind: "link", to: await readlink(path) }
    return { kind: "file" }
  } catch {
    return { kind: "missing" }
  }
}

async function files() {
  const entries = await readdir(source)
  return entries.filter((name) => name.endsWith(".md")).sort()
}

async function main() {
  const names = await files()
  if (check) {
    const rows = []
    for (const name of names) {
      const at = join(target, name)
      const found = await state(at)
      const linked = found.kind === "link" && resolve(dirname(at), found.to) === join(source, name)
      rows.push(`${linked ? "linked" : found.kind === "link" ? "other link" : found.kind === "missing" ? "missing" : "file"}  ${name}`)
    }
    console.log(`agents dir: ${target}`)
    console.log(rows.join("\n"))
    return
  }

  if (remove) {
    let removed = 0
    for (const name of names) {
      const from = join(source, name)
      const at = join(target, name)
      const found = await state(at)
      if (found.kind === "missing") continue
      if (found.kind === "link" && resolve(dirname(at), found.to) !== from) {
        console.warn(`kept ${name}: the link does not point at this checkout`)
        continue
      }
      if (found.kind === "file") {
        const [current, original] = await Promise.all([
          readFile(at, "utf8").catch(() => null),
          readFile(from, "utf8").catch(() => null),
        ])
        if (current === null || original === null || current !== original) {
          console.warn(`kept ${name}: it is a file this checkout did not copy; remove it yourself if you want`)
          continue
        }
      }
      await rm(at)
      removed += 1
    }
    console.log(`removed ${removed} of ${names.length} agent file(s) from ${target}`)
    return
  }

  await mkdir(target, { recursive: true })
  let installed = 0
  for (const name of names) {
    const from = join(source, name)
    const at = join(target, name)
    const found = await state(at)
    if (found.kind !== "missing") {
      const ours = found.kind === "link" && resolve(dirname(at), found.to) === from
      if (!ours && !copy) {
        console.warn(`kept ${name}: ${at} already exists and was not installed by this script`)
        continue
      }
      if (!ours && copy) {
        console.warn(`kept ${name}: ${at} already exists; refusing to overwrite it`)
        continue
      }
      await rm(at)
    }
    if (copy) await copyFile(from, at)
    else await symlink(from, at, "file")
    installed += 1
  }
  console.log(`${copy ? "copied" : "linked"} ${installed} of ${names.length} agent file(s) into ${target}`)
}

await main()
