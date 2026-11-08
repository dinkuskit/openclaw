import * as React from "react";
import type { OpenClawChatElementProps } from "./ui/openclaw-chat-element.js";
import { registerOpenClawChatElement } from "./ui/openclaw-chat-element.js";

interface HostElement extends HTMLElement {
  onToggleEmdashNav?: () => void;
  updateHostProps?: (partial: Partial<OpenClawChatElementProps>) => void;
}

export interface ContentEditorPanelContext {
  collection: string;
  entry: {
    id: string;
    slug?: string;
    data?: Record<string, unknown>;
  };
  locale?: string;
}

export interface ContentEditorPanelExtension {
  id: string;
  title: string;
  component: React.ComponentType<ContentEditorPanelContext>;
  collections?: readonly string[] | ((collection: string) => boolean);
  minRole?: number;
  order?: number;
}

export function OpenClawWorkspacePage(): React.ReactElement {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const customElRef = React.useRef<HostElement | null>(null);
  // Locked Round 1 decision (`emdash-outer-nav-002`): auto-collapse EmDash outer nav on /openclaw mount.
  const [emdashNavOpen, setEmdashNavOpen] = React.useState(false);

  React.useEffect(() => {
    registerOpenClawChatElement();
  }, []);

  // Manage full-bleed `<main>` container and EmDash outer sidebar visibility cleanly.
  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    const mainEl = wrapper?.closest("main") as HTMLElement | null;
    const contentCol = mainEl?.parentElement as HTMLElement | null;
    const outerSidebar = contentCol?.previousElementSibling as HTMLElement | null;

    const prevMainPadding = mainEl?.style.padding ?? "";
    const prevMainOverflow = mainEl?.style.overflow ?? "";
    const prevMainDisplay = mainEl?.style.display ?? "";
    const prevSidebarDisplay = outerSidebar?.style.display ?? "";

    if (mainEl) {
      mainEl.style.padding = "0";
      mainEl.style.overflow = "hidden";
      mainEl.style.display = "flex";
    }
    if (outerSidebar) {
      outerSidebar.style.display = emdashNavOpen ? "" : "none";
    }

    return () => {
      if (mainEl) {
        mainEl.style.padding = prevMainPadding;
        mainEl.style.overflow = prevMainOverflow;
        mainEl.style.display = prevMainDisplay;
      }
      if (outerSidebar) {
        outerSidebar.style.display = prevSidebarDisplay;
      }
    };
  }, [emdashNavOpen]);

  const toggleOuterNav = React.useCallback(() => {
    setEmdashNavOpen(prev => !prev);
  }, []);

  React.useEffect(() => {
    const el = customElRef.current;
    if (!el) return;
    el.onToggleEmdashNav = toggleOuterNav;
    el.updateHostProps?.({
      surface: "admin-page",
      emdashNavOpen,
      onToggleEmdashNav: toggleOuterNav,
    });
  }, [emdashNavOpen, toggleOuterNav]);

  return React.createElement(
    "div",
    {
      ref: wrapperRef,
      style: {
        width: "100%",
        height: "100%",
        minHeight: "calc(100svh - 58px)",
        flex: "1 1 auto",
        display: "flex",
        overflow: "hidden",
      },
    },
    React.createElement("openclaw-emdash-chat", {
      ref: customElRef,
      surface: "admin-page",
      "emdash-nav-open": String(emdashNavOpen),
      style: { width: "100%", height: "100%", flex: "1 1 auto" },
    }),
  );
}

export function OpenClawEditorPanel(props: ContentEditorPanelContext): React.ReactElement {
  const customElRef = React.useRef<HostElement | null>(null);
  const entryTitle = React.useMemo(() => {
    const d = props.entry?.data ?? {};
    const candidate = d.title ?? d.name ?? d.heading ?? props.entry?.slug ?? props.entry?.id;
    return typeof candidate === "string" ? candidate : String(props.entry?.id ?? "Entry");
  }, [props.entry]);

  React.useEffect(() => {
    registerOpenClawChatElement();
  }, []);

  React.useEffect(() => {
    customElRef.current?.updateHostProps?.({
      surface: "editor-panel",
      collection: props.collection,
      entryId: props.entry.id,
      locale: props.locale,
      entryTitle,
    });
  }, [props.collection, props.entry.id, props.locale, entryTitle]);

  return React.createElement(
    "div",
    { style: { width: "100%", minHeight: "480px" } },
    React.createElement("openclaw-emdash-chat", {
      ref: customElRef,
      surface: "editor-panel",
      collection: props.collection,
      "entry-id": props.entry.id,
      ...(props.locale ? { locale: props.locale } : {}),
      "entry-title": entryTitle,
    }),
  );
}

export const pages: Record<string, React.ComponentType> = {
  "/openclaw": OpenClawWorkspacePage,
};

export const contentEditorPanels: readonly ContentEditorPanelExtension[] = [
  {
    id: "openclaw-assistant",
    title: "OpenClaw Assistant",
    minRole: 40,
    order: 10,
    component: OpenClawEditorPanel,
  },
];
