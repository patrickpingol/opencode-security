import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { LEAD_AGENT, missingAgents } from "./opencode/agents.js"
import { createRuntime } from "./opencode/runtime.js"
import { runScan } from "./opencode/scan-runner.js"
import { progressLine, writeWorkflowStatus } from "./opencode/workflow-status.js"

const exec = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const skillDir = join(root, "skills", "opencode-security")
const scripts = join(root, "scripts")
const scanPath = join(root, "workflows", "scan.js")

const PREFIX = "OPENCODE-SECURITY-"
const TIP = "OpenCode Security: this branch was just published. Run /opencode-security to scan the changes."

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")
}

async function existingReports(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function pythonVersion() {
  try {
    const { stdout } = await exec("python3", ["-c", 'import sys; print("%d.%d.%d" % sys.version_info[:3])'])
    return stdout.trim() || "unknown"
  } catch {
    return "python3 not found on PATH"
  }
}

async function leadPrompt(directory, request) {
  const reports = await existingReports(directory)
  return `Session start (UTC): ${stamp()}
Existing reports: ${reports.length ? reports.join("\n") : "(none)"}
Python: ${await pythonVersion()}

You are the OpenCode Security lead.

PLUGIN_ROOT: ${root}
SCRIPTS: ${scripts}
SKILL_DIR: ${skillDir}

Read ${skillDir}/SKILL.md and follow it. Use the three paths above wherever that file says PLUGIN_ROOT, SCRIPTS, or SKILL_DIR. Read ${skillDir}/role.md when the skill tells you to.

User request:
${String(request || "").trim()}

A scan runs only through the security_scan tool. Pass the scan settings as \`payload\`. The tool blocks until that workflow run finishes and names an output file. Dispatch specialists with the subagent tool and wait for each report. Ask the user with the question tool.`
}

function normalizePayload(args) {
  if (!args || typeof args !== "object") return {}
  const payload = args.payload
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload)
    } catch {
      return { raw: payload }
    }
  }
  if (payload && typeof payload === "object") return payload
  return args
}

function appendTip(result) {
  const text = { type: "text", text: `\n\n${TIP}` }
  const content = Array.isArray(result?.content) ? result.content : []
  return { ...result, content: [...content, text] }
}

export default Plugin.define({
  id: "opencode-security",
  async setup(ctx) {
    const directory = ctx.location.directory

    const listed = await ctx.agent.list().catch(() => undefined)
    const agents = Array.isArray(listed?.data) ? listed.data : []
    const missing = missingAgents(agents)
    if (missing.length) {
      console.warn(
        `opencode-security: agent definitions missing (${missing.join(", ")}). ` +
          `Run scripts/install-agents.mjs to add them to ~/.config/opencode/agents/.`,
      )
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "opencode-security",
        description: "Scan a repository, scan a change, or suggest patches for confirmed findings",
        async execute({ sessionID, prompt, delivery }) {
          const info = await ctx.session.get({ sessionID }).catch(() => undefined)
          const target = info?.location?.directory || directory
          const text = await leadPrompt(target, prompt?.text)
          const loaded = await ctx.agent.list().catch(() => undefined)
          const available = Array.isArray(loaded?.data) ? loaded.data : []
          if (available.some((agent) => agent.id === LEAD_AGENT)) {
            await ctx.session.switchAgent({ sessionID, agent: LEAD_AGENT })
          }
          await ctx.session.prompt({ sessionID, text, delivery })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "security_scan",
        description:
          "Run one OpenCode Security scan workflow (workflows/scan.js) inside OpenCode. Blocks until that run finishes. Pass the scan settings object as payload (scanRoot, runDir, mode, effort, and the other fields the scan job names). Writes {result} to an output file and returns that path. Do not dispatch researchers yourself.",
        input: {
          type: "object",
          properties: {
            payload: {
              description: "Scan settings object, or a JSON string of that object",
            },
          },
          required: ["payload"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const payload = normalizePayload(args)
          const logs = []
          const scanID = context.sessionID || `scan-${process.pid}-${Date.now()}`
          let latest = { phase: "starting", phases: [], active: 0, waiting: 0, tasks: [], logs: [] }
          const publish = (state) => {
            try {
              writeWorkflowStatus({
                id: scanID,
                updatedAt: new Date().toISOString(),
                directory,
                parentSessionID: context.sessionID,
                effort: typeof payload.effort === "string" ? payload.effort : undefined,
                mode: typeof payload.mode === "string" ? payload.mode : undefined,
                scope: typeof payload.scope === "string" ? payload.scope : undefined,
                state,
                phase: latest.phase,
                phases: latest.phases,
                active: latest.active,
                waiting: latest.waiting,
                tasks: latest.tasks,
                findings: latest.findings || [],
                log: latest.logs.slice(-20),
              })
            } catch {
              // The scan continues when the status file cannot be written.
            }
          }
          const runtime = createRuntime({
            ctx,
            parentSessionID: context.sessionID,
            signal: context.signal,
            concurrency: process.env.OPENCODE_SECURITY_CONCURRENCY,
            onProgress(event) {
              latest = event
              logs.splice(0, logs.length, ...event.logs)
              publish("running")
              void context
                .progress({
                  title: progressLine(event).slice(0, 80),
                  phase: event.phase,
                  lines: logs.length,
                  active: event.active,
                })
                .catch(() => {})
            },
          })
          publish("running")
          let result
          try {
            result = await runScan(scanPath, payload, runtime)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            latest = { ...latest, logs: [...latest.logs, message] }
            publish("failed")
            throw new Error(`security_scan failed before it could write a result: ${message}`)
          }
          publish(result?.started === false ? "not-started" : "finished")
          const recent = logs.slice(-40).join("\n")
          if (result?.started === false) {
            const why = result?.reason || "not started"
            const next = typeof result?.next === "string" ? `\n${result.next}` : ""
            return {
              content: [
                {
                  type: "text",
                  text: [`scan did not start: ${why}${next}`, recent ? `narrator:\n${recent}` : ""].filter(Boolean).join("\n"),
                },
              ],
              metadata: { title: "Scan did not start", findings: 0, started: false },
            }
          }
          const runDir = typeof result?.runDir === "string" ? result.runDir : directory
          await mkdir(runDir, { recursive: true })
          const outputFile = join(runDir, `workflow-output-${Date.now()}.json`)
          await writeFile(outputFile, JSON.stringify({ result }, null, 2))
          const findings = Array.isArray(result?.findings) ? result.findings.length : 0
          const text = [
            `output file: ${outputFile}`,
            `findings in this run: ${findings}`,
            recent ? `narrator:\n${recent}` : "",
            "Run save_result.py on the output file and the run directory, then do what it prints.",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            content: [{ type: "text", text }],
            metadata: {
              title: `Scan run finished (${findings} findings)`,
              outputFile,
              findings,
              started: true,
            },
          }
        },
      })
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return
      if (event.tool !== "shell" && event.tool !== "bash") return
      if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") return
      if (/^off$/i.test(process.env.OPENCODE_SECURITY_SCAN_TIP || "")) return
      const command = String(event.input?.command || "")
      if (!/^\s*git\s+push\b/.test(command) && !/^\s*gh\s+pr\s+create\b/.test(command)) return
      event.result = appendTip(event.result)
    })
  },
})
