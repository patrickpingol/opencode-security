export const LEAD_AGENT = "opencode-security"

// Specialist names the scan workflow asks for, keyed by the names it uses.
export const AGENT_TYPE_MAP = {
  "opencode-security:scan-researcher": "security-researcher",
  "opencode-security:scan-verifier": "security-verifier",
  "opencode-security:scan-inventory": "security-inventory",
  "opencode-security:scan-loader": "security-loader",
  "opencode-security:scan-redactor": "security-redactor",
  "opencode-security:patch-generator": "security-patch-generator",
  "opencode-security:patch-verifier": "security-patch-verifier",
  "opencode-security:explore": "security-explore",
}

export const SECURITY_AGENTS = [
  LEAD_AGENT,
  "security-explore",
  "security-researcher",
  "security-verifier",
  "security-inventory",
  "security-loader",
  "security-redactor",
  "security-patch-generator",
  "security-patch-verifier",
]

export function missingAgents(available) {
  const ids = new Set((Array.isArray(available) ? available : []).map((agent) => String(agent?.id || agent || "")))
  return SECURITY_AGENTS.filter((id) => !ids.has(id))
}
