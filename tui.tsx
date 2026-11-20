import { Plugin } from "@opencode/plugin/tui"
import { mountWorkflows } from "./tui-board.tsx"

function currentDirectory(context) {
  const location = context.location ?? context.data.location.default()
  return location?.directory || ""
}

export default Plugin.define({
  id: "opencode-security.workflows",
  setup(context) {
    const open = () => {
      const directory = currentDirectory(context)
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
  },
})
