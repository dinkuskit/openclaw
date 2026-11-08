import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { openclawAdmin, openclawEditorPanel, openclawPairRoute } from "./admin.js";
import { openclawChatRoute } from "./chat-engine.js";
import { installNodeGatewayBridge } from "./gateway-bridge.js";

installNodeGatewayBridge();

export interface OpenClawNativePluginOptions {
  entrypoint?: string;
  adminEntry?: string;
}

function adaptNativeHandler<T>(
  fn: (route: SandboxedRouteContext, ctx: PluginContext) => Promise<T>,
) {
  return async (routeCtx: unknown): Promise<T> =>
    fn(routeCtx as SandboxedRouteContext, routeCtx as PluginContext);
}

/**
 * Trusted in-process EmDash plugin factory for the interactive OpenClaw
 * Control-UI × Antigravity 2.0 native harness.
 */
export function createPlugin(): ResolvedPlugin {
  return {
    id: "dinkus-openclaw",
    version: "0.0.0",
    capabilities: [
      "network:request:unrestricted",
      "network:request",
      "schema:read",
      "content:read",
      "content:revisions:read",
    ],
    allowedHosts: [],
    storage: {},
    hooks: {},
    mcp: { tools: {} },
    admin: {},
    routes: {
      admin: {
        public: false,
        permission: "content:edit_any",
        methods: ["POST"],
        handler: adaptNativeHandler(openclawAdmin),
      },
      "editor/assistant": {
        public: false,
        permission: "content:edit_any",
        methods: ["POST"],
        handler: adaptNativeHandler(openclawEditorPanel),
      },
      chat: {
        public: false,
        permission: "content:edit_any",
        methods: ["POST"],
        handler: adaptNativeHandler(openclawChatRoute),
      },
      pair: {
        public: true,
        methods: ["POST"],
        handler: adaptNativeHandler(openclawPairRoute),
      },
    },
  };
}

/**
 * Returns an EmDash `PluginDescriptor` mounting the native React + SolidJS
 * OpenClaw harness at `/_emdash/admin/plugins/dinkus-openclaw/openclaw` and in
 * every saved-entry Content Editor panel.
 */
export function openclawNativePlugin(
  options: OpenClawNativePluginOptions = {},
): PluginDescriptor {
  return {
    id: "dinkus-openclaw",
    version: "0.0.0",
    format: "native",
    entrypoint: options.entrypoint ?? "@dinkuskit/openclaw/native",
    adminEntry: options.adminEntry ?? "@dinkuskit/openclaw/admin",
    adminPages: [
      {
        path: "/openclaw",
        label: "OpenClaw",
        icon: "bot",
      },
    ],
    settingsSchema: {
      connection: {
        type: "secret",
        label: "OpenClaw gateway connection",
        description:
          "Encrypted OpenClaw gateway endpoint, agent ID, bearer token, and enabled content collections. Managed on the OpenClaw page.",
      },
    },
  };
}

export default createPlugin;
