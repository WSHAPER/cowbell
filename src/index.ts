import { AGENT_KINDS, AGENT_STATUSES } from "./herdr/spec-agent.js";
import { SUPPORTED_HERDR_VERSION } from "./herdr/spec.js";

const command = process.argv[2];

switch (command) {
  case "version":
    console.log(`cowbell 0.1.0 (herdr ${SUPPORTED_HERDR_VERSION} surface)`);
    break;
  case "kinds":
    console.log(AGENT_KINDS.join("\n"));
    break;
  case "statuses":
    console.log(AGENT_STATUSES.join("\n"));
    break;
  default:
    console.log(`cowbell — MCP server for herdr fleets

Usage:
  cowbell version   Print versions
  cowbell kinds     List supported agent kinds
  cowbell statuses  List agent status vocabulary
  npm run mcp:stdio Start the MCP server on stdio
`);
    break;
}
