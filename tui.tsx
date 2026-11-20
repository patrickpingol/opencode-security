import { Plugin } from "@opencode/plugin/tui"
import { SCAN_START_CONFIRMATION, UNANSWERED_AFTER_MS } from "./opencode/hooks.js"
import { mountWorkflows } from "./tui-board.tsx"

function currentLocation(context) {
  return context.location ?? context.data.location.default()
}

function asksScanStartConfirmation(form) {
  if (form?.metadata?.kind !== "question") return false
  const fields = Array.isArray(form.fields) ? form.fields : []
  return fields.some((field) => String(field?.description || "").includes(SCAN_START_CONFIRMATION))
}

export default Plugin.define({
  id: "opencode-security.workflows",
  setup(context) {
    const timers = new Set()

    // The scan's start confirmation is always a real question, so an unattended
    // session would wait on it forever. Close it after a minute, as V1 did.
    const stopForms = context.data.on("form.created", (event) => {
      const form = event?.data?.form
      if (!asksScanStartConfirmation(form)) return
      const location = event.location ?? currentLocation(context)
      const timer = setTimeout(() => {
        timers.delete(timer)
        void context.data.session.form
          .cancel(
            {
              sessionID: form.sessionID,
              formID: form.id,
              message: `No answer after ${UNANSWERED_AFTER_MS / 1000} seconds, so nothing was run.`,
            },
            location,
          )
          .catch(() => {})
      }, UNANSWERED_AFTER_MS)
      timers.add(timer)
    })

    const open = () => {
      const directory = currentLocation(context)?.directory || ""
      if (!directory) {
        void context.ui.dialog.alert({ title: "Workflows", message: "Open a project, then run /workflows again." })
        return
      }
      mountWorkflows(context, directory)
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-security.workflows",
          title: "Workflows",
          description: "Show security scans in this project",
          group: "Security",
          palette: true,
          slash: { name: "workflows" },
          run: open,
        },
      ],
    }))

    return () => {
      stopForms()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  },
})
