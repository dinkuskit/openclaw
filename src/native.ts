import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { openclawAdmin, openclawEditorPanel, openclawPairRoute } from "./admin.js";
import { resolveAudienceScope } from "./playground-env.js";
import { runWithOpenClawAudienceScope } from "./sse-bus.js";
import {
  BLOBSTER_CATALOG_URL,
  BLOBSTER_SUBMIT_URL,
  FEATURED_AGENT_TEMPLATES,
  OPENCLAW_ENABLE_TEMPLATES_CMD,
  buildAgentTemplateInstallCommands,
  openclawChatRoute,
  resolvePlaygroundVisitorHash,
  type AgentTemplateEntry,
  type AgentTemplateInstallCommands,
} from "./chat-engine.js";

export {
  BLOBSTER_CATALOG_URL,
  BLOBSTER_SUBMIT_URL,
  FEATURED_AGENT_TEMPLATES,
  OPENCLAW_ENABLE_TEMPLATES_CMD,
  buildAgentTemplateInstallCommands,
  resolvePlaygroundVisitorHash,
  type AgentTemplateEntry,
  type AgentTemplateInstallCommands,
};

declare const __OPENCLAW_WORKERD__: boolean | undefined;

export function isNodeGatewayBridgeSupportedRuntime(): boolean {
  if (typeof __OPENCLAW_WORKERD__ !== "undefined" && __OPENCLAW_WORKERD__) {
    return false;
  }
  const g = globalThis as {
    navigator?: { userAgent?: string };
    WebSocketPair?: unknown;
    process?: { versions?: { node?: string; workerd?: string } };
  };
  if (g.navigator?.userAgent?.includes("Cloudflare-Workers")) {
    return false;
  }
  if (typeof g.WebSocketPair === "function") {
    return false;
  }
  if (!g.process?.versions?.node || g.process?.versions?.workerd) {
    return false;
  }
  return true;
}

if (isNodeGatewayBridgeSupportedRuntime()) {
  try {
    const bridgeModuleUrl = new URL("./gateway-" + "bridge.mjs", import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ bridgeModuleUrl)) as {
      installNodeGatewayBridge?: () => unknown;
    };
    mod.installNodeGatewayBridge?.();
  } catch {
    // Non-Node or edge bundler without Node ws gateway client; HTTP & paired-agent transports remain active.
  }
}

export interface OpenClawNativePluginOptions {
  entrypoint?: string;
  adminEntry?: string;
}

function adaptNativeHandler<T>(
  fn: (route: SandboxedRouteContext, ctx: PluginContext) => Promise<T>,
) {
  // Every route publishes under the playground visitor's scope (undefined on
  // ordinary sites), so the stream endpoint can tell visitors apart.
  return async (routeCtx: unknown): Promise<T> => {
    const scope = await resolveAudienceScope(routeCtx);
    return runWithOpenClawAudienceScope(scope, () =>
      fn(routeCtx as SandboxedRouteContext, routeCtx as PluginContext),
    );
  };
}

const OPENCLAW_ADMIN_PAGES = [
  {
    path: "/openclaw",
    label: "OpenClaw",
    icon: "bot",
    group: "OpenClaw",
  },
];

const OPENCLAW_SETTINGS_SCHEMA = {
  connection: {
    type: "secret" as const,
    label: "OpenClaw gateway connection",
    description:
      "Encrypted OpenClaw gateway endpoint, agent ID, bearer token, and enabled content collections. Managed on the OpenClaw page.",
  },
};

/**
 * Trusted in-process EmDash plugin factory for the interactive OpenClaw
 * Control-UI × Antigravity 2.0 native harness.
 */
export function createPlugin(options: OpenClawNativePluginOptions = {}): ResolvedPlugin {
  return {
    id: "dinkus-openclaw",
    version: "0.1.0",
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
    admin: {
      entry: options.adminEntry ?? "@dinkuskit/openclaw/admin",
      pages: OPENCLAW_ADMIN_PAGES,
      settingsSchema: OPENCLAW_SETTINGS_SCHEMA,
    },
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
): PluginDescriptor<OpenClawNativePluginOptions> {
  const adminEntry = options.adminEntry ?? "@dinkuskit/openclaw/admin";
  return {
    id: "dinkus-openclaw",
    version: "0.1.0",
    format: "native",
    entrypoint: options.entrypoint ?? "@dinkuskit/openclaw/native",
    adminEntry,
    options: { adminEntry },
    adminPages: OPENCLAW_ADMIN_PAGES,
    settingsSchema: OPENCLAW_SETTINGS_SCHEMA,
  };
}

export default createPlugin;
