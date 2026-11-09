export interface OpenClawBridgeOptions {
  streamEntrypoint?: string;
}

function resolveSiblingPath(relativePath: string): string {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname);
  return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}

/**
 * Astro integration injecting the authenticated SSE event bridge outside
 * EmDash's buffered plugin route dispatcher (`/_emdash/api/openclaw/stream`).
 */
export function openclawBridge(options: OpenClawBridgeOptions = {}) {
  const defaultEntrypoint = resolveSiblingPath("./stream-endpoint.mjs");
  return {
    name: "@dinkuskit/openclaw-bridge",
    hooks: {
      "astro:config:setup": ({
        injectRoute,
      }: {
        injectRoute: (route: {
          pattern: string;
          entrypoint: string;
          prerender?: boolean;
        }) => void;
      }) => {
        injectRoute({
          pattern: "/_emdash/api/openclaw/stream",
          entrypoint: options.streamEntrypoint ?? defaultEntrypoint,
          prerender: false,
        });
      },
    },
  };
}

export default openclawBridge;
