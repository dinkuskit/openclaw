import type { SandboxedPlugin } from "emdash/plugin";
import { openclawAdmin } from "./admin.js";

/**
 * DinkusKit OpenClaw for the EmDash admin: connects an OpenClaw gateway and
 * custom agents to the site's MCP tools and Block Kit approval cards, starting
 * read-only with explicit WAITING_FOR_HUMAN approval before any mutation.
 */
const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      public: false,
      permission: "content:edit_any",
      methods: ["POST"],
      handler: openclawAdmin,
    },
  },
};

export default plugin;
