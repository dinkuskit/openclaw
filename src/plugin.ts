import type { SandboxedPlugin } from "emdash/plugin";
import { openclawAdmin, openclawEditorPanel } from "./admin.js";

/**
 * Standalone OpenClaw Registry plugin for any EmDash CMS site: connects a
 * user's custom OpenClaw gateway to a sidebar admin page and a configurable
 * saved-entry editor panel across the site's content collections.
 */
const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      public: false,
      permission: "content:edit_any",
      methods: ["POST"],
      handler: openclawAdmin,
    },
    "editor/assistant": {
      public: false,
      permission: "content:edit_any",
      methods: ["POST"],
      handler: openclawEditorPanel,
    },
  },
};

export default plugin;
