import { AGENT_TYPE_MAP } from "./agents.js"
import { parseJsonObject, textFromMessage } from "./json-result.js"
import { notePanel } from "./panel-findings.js"
import { outcomeBody, outcomeSummary, promptExcerpt, summarizeSession } from "./session-activity.js"

const DEFAULT_CONCURRENCY = 6
const DEFAULT_STALL_MS = 600_000
const POLL_MS = 750

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function messagesOf(listed) {
  if (Array.isArray(listed)) return listed
  if (Array.isArray(listed?.data)) return listed.data
  return []
}

function assistantMessages(rows, before) {
  return rows.filter((row) => row?.type === "assistant" && !before.has(row.id))
}

function stillWorking(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.some(
    (part) => part?.type === "tool" && (part.state?.status === "running" || part.state?.status === "streaming"),
  )
}

// A round is over when its last assistant message has finished a turn that does
// not hand off to another tool step, or when the session itself reports idle.
function roundFinished(rows, before, info) {
  const messages = assistantMessages(rows, before)
  if (!messages.length) return false
  const last = messages[messages.length - 1]
  if (stillWorking(last)) return false
  if (last.time?.completed && last.finish && last.finish !== "tool-calls") return true
  const idle = Number(info?.time?.idle) > 0 && Number(info?.time?.idle) >= Number(info?.time?.busy ?? 0)
  return idle
}

function lastAssistantText(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = textFromMessage(rows[i])
    if (text.trim()) return text
    if (rows[i]?.type === "user") return ""
  }
  return ""
}

function snapshotTasks(tasks) {
  return tasks.map((task) => ({
    ...task,
    activity: Array.isArray(task.activity) ? task.activity.slice() : [],
  }))
}

function applySnapshot(task, snap) {
  if (!snap) return false
  let changed = false
  if (snap.model && snap.model !== task.model) {
    task.model = snap.model
    changed = true
  }
  if (snap.tokens > (Number(task.tokens) || 0)) {
    task.tokens = snap.tokens
    changed = true
  }
  if (snap.toolCount > (Number(task.toolCount) || 0)) {
    task.toolCount = snap.toolCount
    changed = true
  }
  const next = Array.isArray(snap.activity) ? snap.activity : []
  if (next.length && next.join("\n") !== (task.activity || []).join("\n")) {
    task.activity = next.slice()
    changed = true
  }
  return changed
}

export function createRuntime({ ctx, parentSessionID, signal, onProgress, concurrency, pollMs }) {
  const limit = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY)
  const watchMs = Math.max(250, Number(pollMs) || POLL_MS)
  let active = 0
  const waiting = []
  const logs = []
  const tasks = []
  const phases = []
  let phaseTitle = "starting"
  let findings = []

  function emit(kind, message) {
    onProgress?.({
      kind,
      message,
      logs,
      phase: phaseTitle,
      phases: phases.slice(),
      active,
      waiting: waiting.length,
      tasks: snapshotTasks(tasks),
      findings: findings.map((finding) => ({ ...finding, votes: finding.votes.map((vote) => ({ ...vote })) })),
    })
  }

  function note(kind, message) {
    if (kind === "phase") {
      phaseTitle = message
      phases.push(message)
    }
    logs.push(message)
    emit(kind, message)
  }

  function touch() {
    emit("activity", logs.at(-1) || "")
  }

  let modelPromise
  function parentModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        if (!parentSessionID) return undefined
        try {
          const info = await ctx.session.get({ sessionID: parentSessionID })
          const model = info?.model
          if (!model?.providerID || !model?.id) return undefined
          return model.variant ? { providerID: model.providerID, id: model.id, variant: model.variant } : { providerID: model.providerID, id: model.id }
        } catch {
          return undefined
        }
      })()
    }
    return modelPromise
  }

  async function acquire() {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise((resolve) => waiting.push(resolve))
    active += 1
  }

  function release() {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }

  async function awaitRound(sessionID, before, task, deadline, stallMs) {
    for (;;) {
      if (signal?.aborted) throw new Error(`${task.label}: the scan was aborted`)
      const rows = messagesOf(await ctx.session.context({ sessionID }).catch(() => []))
      const info = await ctx.session.get({ sessionID }).catch(() => undefined)
      if (applySnapshot(task, summarizeSession(rows))) touch()
      if (roundFinished(rows, before, info)) return rows
      if (Date.now() >= deadline) throw new Error(`${task.label}: specialist timed out after ${stallMs}ms`)
      await sleep(watchMs)
    }
  }

  async function agent(prompt, opts = {}) {
    const requested = opts.agentType || opts.agent || "security-researcher"
    const agentName = AGENT_TYPE_MAP[requested] || requested
    const label = opts.label || agentName
    const stallMs = Number(opts.stallMs) > 0 ? Number(opts.stallMs) : DEFAULT_STALL_MS
    await acquire()
    let sessionID
    const excerpt = promptExcerpt(prompt)
    const task = {
      label,
      agent: agentName,
      phase: String(opts.phase || phaseTitle || ""),
      status: "running",
      sessionID: "",
      detail: "",
      model: "",
      tokens: 0,
      toolCount: 0,
      activity: [],
      prompt: excerpt.text,
      promptLines: excerpt.lines,
      outcome: "",
      outcomeBody: "",
      startedAt: new Date().toISOString(),
      finishedAt: "",
    }
    tasks.push(task)
    try {
      if (signal?.aborted) throw new Error("the scan was aborted")
      findings = notePanel(findings, label, prompt, null)
      note("agent", `${label}: dispatching ${agentName}`)
      const model = await parentModel()
      const created = await ctx.session.create({
        title: String(label).slice(0, 120),
        agent: agentName,
        ...(model ? { model } : {}),
        metadata: { opencodeSecurity: { label, parentSessionID: parentSessionID || null } },
      })
      sessionID = created.id
      task.sessionID = sessionID
      if (model?.id) task.model = model.providerID ? `${model.providerID}/${model.id}` : model.id
      touch()
      const before = new Set(messagesOf(await ctx.session.context({ sessionID }).catch(() => [])).map((row) => row?.id))
      const schema = opts.schema
        ? `\n\nReply with one JSON object and nothing else. No markdown fence. It must match this JSON Schema:\n${JSON.stringify(opts.schema)}`
        : "\n\nReply with the result and nothing else."
      const effort = opts.effort ? `\nDispatch effort: ${opts.effort}.` : ""
      await ctx.session.prompt({ sessionID, text: `${prompt}${effort}${schema}` })
      const rows = await awaitRound(sessionID, before, task, Date.now() + stallMs, stallMs)
      const text = lastAssistantText(rows)
      const parsed = parseJsonObject(text)
      if (!parsed) throw new Error(`${label}: specialist returned no JSON object`)
      findings = notePanel(findings, label, prompt, parsed)
      task.status = "returned"
      task.finishedAt = new Date().toISOString()
      task.outcome = outcomeSummary(parsed)
      task.outcomeBody = outcomeBody(parsed)
      note("agent", `${label}: returned`)
      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      task.status = "failed"
      task.finishedAt = new Date().toISOString()
      task.detail = message.slice(0, 200)
      note("agent", `${label}: ${message}`)
      if (sessionID) {
        await ctx.session.interrupt({ sessionID }).catch(() => {})
      }
      throw error instanceof Error ? error : new Error(message)
    } finally {
      release()
    }
  }

  async function parallel(thunks) {
    return Promise.all(thunks.map((thunk) => thunk()))
  }

  async function pipeline(items, ...stages) {
    return parallel(
      items.map((item) => async () => {
        let value = item
        for (const stage of stages) value = await stage(value)
        return value
      }),
    )
  }

  function phase(title) {
    note("phase", String(title))
  }

  function log(message) {
    note("log", String(message))
  }

  return { agent, parallel, pipeline, phase, log, logs }
}
