/** @jsxImportSource solid-js */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { render } from "solid-js/web";
import type {
  BoundEntryRef,
  CatalogEntrySummary,
  ChatTurnMessage,
  ConversationThread,
  GatewayApprovalDecision,
  GatewayExecApproval,
  OpenClawWorkspaceSnapshot,
  RevisionProposal,
  ToolCallTrace,
} from "../protocol.js";
import {
  applyRevisionProposal,
  callOpenClawChat,
  connectOpenClawEventStream,
  ensureProposalBaseRevs,
  rebaseConflictedProposal,
  reconcileUnknownProposal,
} from "./emdash-client.js";
import { OPENCLAW_HARNESS_CSS } from "./styles.js";

export interface OpenClawChatElementProps {
  surface: "admin-page" | "editor-panel";
  collection?: string;
  entryId?: string;
  locale?: string;
  entryTitle?: string;
  emdashNavOpen?: boolean;
  onToggleEmdashNav?: () => void;
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 45) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function shortenRev(rev?: string): string {
  if (!rev || rev === "pending-browser-rev") return "live _rev";
  return rev.length > 16 ? `${rev.slice(0, 14)}…` : rev;
}

/** Safe inline text parser for **bold** and `code` without innerHTML. */
function InlineFormatted(props: { text: string }) {
  const tokens = createMemo(() => {
    const parts: Array<{ kind: "text" | "bold" | "code"; value: string }> = [];
    const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(props.text)) !== null) {
      if (match.index > last) {
        parts.push({ kind: "text", value: props.text.slice(last, match.index) });
      }
      const raw = match[0];
      if (raw.startsWith("**")) {
        parts.push({ kind: "bold", value: raw.slice(2, -2) });
      } else {
        parts.push({ kind: "code", value: raw.slice(1, -1) });
      }
      last = match.index + raw.length;
    }
    if (last < props.text.length) {
      parts.push({ kind: "text", value: props.text.slice(last) });
    }
    return parts;
  });

  return (
    <>
      <For each={tokens()}>
        {tok =>
          tok.kind === "bold" ? (
            <strong>{tok.value}</strong>
          ) : tok.kind === "code" ? (
            <code>{tok.value}</code>
          ) : (
            tok.value
          )
        }
      </For>
    </>
  );
}

/** Safe structured Markdown block renderer (untrusted content boundary). */
function SafeMarkdownProse(props: { content: string }) {
  const blocks = createMemo(() => {
    const lines = props.content.split("\n");
    const out: Array<
      | { type: "h3"; text: string }
      | { type: "ul"; items: string[] }
      | { type: "p"; text: string }
    > = [];
    let currentList: string[] | null = null;

    const flushList = () => {
      if (currentList && currentList.length > 0) {
        out.push({ type: "ul", items: currentList });
        currentList = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        flushList();
        continue;
      }
      if (line.startsWith("### ")) {
        flushList();
        out.push({ type: "h3", text: line.slice(4).trim() });
      } else if (/^\s*-\s+/.test(line)) {
        if (!currentList) currentList = [];
        currentList.push(line.replace(/^\s*-\s+/, ""));
      } else if (currentList && /^\s{2,}\S/.test(line)) {
        currentList[currentList.length - 1] += ` — ${line.trim()}`;
      } else {
        flushList();
        out.push({ type: "p", text: line.trim() });
      }
    }
    flushList();
    return out;
  });

  return (
    <div class="oc-prose">
      <For each={blocks()}>
        {block =>
          block.type === "h3" ? (
            <h3>
              <InlineFormatted text={block.text} />
            </h3>
          ) : block.type === "ul" ? (
            <ul>
              <For each={block.items}>
                {item => (
                  <li>
                    <InlineFormatted text={item} />
                  </li>
                )}
              </For>
            </ul>
          ) : (
            <p>
              <InlineFormatted text={block.text} />
            </p>
          )
        }
      </For>
    </div>
  );
}

const SLASH_COMMANDS = [
  { cmd: "/products", hint: "Inspect all live EmDash products & pricing", fill: "Can you inspect my products collection and summarize current items?" },
  { cmd: "/pages", hint: "Audit storefront CMS pages & status", fill: "Show me all storefront pages and their draft/published status." },
  { cmd: "/propose ", hint: "Stage a revision-fenced EmDash draft card", fill: "/propose Refine the copy and excerpt for " },
  { cmd: "/pair", hint: "Open Gateway & 1-click Agent Pairing sheet", fill: "__OPEN_PAIR__" },
];

interface ConversationStreamBuffer {
  text: string;
  tools: ToolCallTrace[];
  phase: string | null;
}

const EMPTY_STREAM_BUFFER: ConversationStreamBuffer = {
  text: "",
  tools: [],
  phase: null,
};

function OpenClawHarnessApp(props: { getHostProps: () => OpenClawChatElementProps; rootNode: ShadowRoot }) {
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");
  const [snapshot, setSnapshot] = createSignal<OpenClawWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [activeTurnRequestsByConv, setActiveTurnRequestsByConv] = createSignal<Record<string, number>>({});
  const [steeringByConv, setSteeringByConv] = createSignal<Record<string, boolean>>({});
  const [streamByConv, setStreamByConv] = createSignal<Record<string, ConversationStreamBuffer>>({});
  const [streamState, setStreamState] = createSignal<"live" | "reconnecting" | "buffered">("live");
  const [errorBanner, setErrorBanner] = createSignal<string | null>(null);

  const [leftOpen, setLeftOpen] = createSignal(true);
  const [rightOpen, setRightOpen] = createSignal(true);
  const [activeSheet, setActiveSheet] = createSignal<
    null | "automations" | "customizations" | "pairing" | "attach"
  >(null);

  const [composerByConv, setComposerByConv] = createSignal<Record<string, string>>({});
  const [attachedEntryByConv, setAttachedEntryByConv] = createSignal<
    Record<string, BoundEntryRef | undefined>
  >({});
  const [openToolIds, setOpenToolIds] = createSignal<Record<string, boolean>>({});
  const [turnIdxByConv, setTurnIdxByConv] = createSignal<Record<string, number>>({});

  // Proposal review & drill-down state (`overview-proposal-drilldown-003`)
  const [selectedProposalId, setSelectedProposalId] = createSignal<string | null>(null);
  const [highlightedProposalId, setHighlightedProposalId] = createSignal<string | null>(null);
  const [applyingProposalId, setApplyingProposalId] = createSignal<string | null>(null);
  const [editingProposalId, setEditingProposalId] = createSignal<string | null>(null);
  const [editFieldDraftsByProp, setEditFieldDraftsByProp] = createSignal<
    Record<string, Record<string, string>>
  >({});
  const [copiedPairing, setCopiedPairing] = createSignal(false);

  // Manual Gateway config fields in Pairing sheet
  const [gwUrlInput, setGwUrlInput] = createSignal("");
  const [gwAgentInput, setGwAgentInput] = createSignal("openclaw");
  const [gwTokenInput, setGwTokenInput] = createSignal("");
  const [allowExecApprovalsInput, setAllowExecApprovalsInput] = createSignal(false);
  const [probingGateway, setProbingGateway] = createSignal(false);
  const [resolvingApprovalId, setResolvingApprovalId] = createSignal<string | null>(null);

  let transcriptRef: HTMLDivElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let stickToBottom = true;

  const isEditorPanel = createMemo(() => props.getHostProps().surface === "editor-panel");

  const activeThread = createMemo<ConversationThread | undefined>(() => {
    const snap = snapshot();
    if (!snap) return undefined;
    return (
      snap.threads.find(t => t.conversationId === snap.activeConversationId) ?? snap.threads[0]
    );
  });

  const activeConvKey = createMemo(
    () => activeThread()?.conversationId ?? snapshot()?.activeConversationId ?? "__default__",
  );

  const composerText = createMemo(() => composerByConv()[activeConvKey()] ?? "");
  const setComposerText = (val: string, convId = activeConvKey()) => {
    setComposerByConv(prev => ({ ...prev, [convId]: val }));
  };

  const attachedEntry = createMemo(() => attachedEntryByConv()[activeConvKey()]);
  const setAttachedEntry = (val: BoundEntryRef | undefined, convId = activeConvKey()) => {
    setAttachedEntryByConv(prev => ({ ...prev, [convId]: val }));
  };

  const activeStream = createMemo<ConversationStreamBuffer>(
    () => streamByConv()[activeConvKey()] ?? EMPTY_STREAM_BUFFER,
  );
  const streamingText = createMemo(() => activeStream().text);
  const streamingTools = createMemo(() => activeStream().tools);
  const runStartupPhase = createMemo(() => activeStream().phase);

  const activeTurnRequests = createMemo(() => activeTurnRequestsByConv()[activeConvKey()] ?? 0);
  const steeringInFlight = createMemo(() => Boolean(steeringByConv()[activeConvKey()]));
  const activeTurnIdx = createMemo(() => turnIdxByConv()[activeConvKey()] ?? 0);
  const setActiveTurnIdx = (idx: number, convId = activeConvKey()) => {
    setTurnIdxByConv(prev => ({ ...prev, [convId]: idx }));
  };

  const clearConversationStream = (convId: string) => {
    setStreamByConv(prev => {
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  };

  const updateConversationStream = (
    convId: string,
    updater: (prev: ConversationStreamBuffer) => ConversationStreamBuffer,
  ) => {
    setStreamByConv(prev => ({
      ...prev,
      [convId]: updater(prev[convId] ?? EMPTY_STREAM_BUFFER),
    }));
  };

  const editDraftForProposal = (proposalId: string): Record<string, string> =>
    editFieldDraftsByProp()[proposalId] ?? {};
  const setEditDraftField = (proposalId: string, field: string, value: string) => {
    setEditFieldDraftsByProp(prev => ({
      ...prev,
      [proposalId]: {
        ...(prev[proposalId] ?? {}),
        [field]: value,
      },
    }));
  };

  const effectiveBoundEntry = createMemo<BoundEntryRef | undefined>(() => {
    const host = props.getHostProps();
    if (host.collection && host.entryId) {
      return {
        collection: host.collection,
        entryId: host.entryId,
        locale: host.locale,
        title: host.entryTitle,
      };
    }
    return attachedEntry();
  });

  const isConversationRunning = (convId: string, threadStatus?: ConversationThread["status"]) =>
    (activeTurnRequestsByConv()[convId] ?? 0) > 0 || threadStatus === "running";

  const sending = createMemo(() =>
    isConversationRunning(activeConvKey(), activeThread()?.status),
  );

  const anyConversationRunning = createMemo(() => {
    for (const count of Object.values(activeTurnRequestsByConv())) {
      if (count > 0) return true;
    }
    return (snapshot()?.threads ?? []).some(t => t.status === "running");
  });

  const renderedMessages = createMemo(() =>
    (activeThread()?.messages ?? []).filter(
      m => !(m.role === "assistant" && m.status === "streaming" && !m.content),
    ),
  );

  const hasConcretePatch = (p: RevisionProposal) =>
    Object.keys(p.proposedFields ?? {}).length > 0 && p.entryId !== "current";

  const canProposalStageDraft = (p: RevisionProposal): boolean => {
    const snap = snapshot();
    if (!snap) return true;
    const col = snap.collections.find(c => c.slug === p.collection);
    if (!col || !Array.isArray(col.supports)) return true;
    if (col.supports.includes("revisions")) return true;
    const entry = snap.entriesPreview.find(
      e => e.collection === p.collection && e.id === p.entryId,
    );
    return entry?.status === "draft" && col.supports.includes("drafts");
  };

  const needsProposalReconcile = (p: RevisionProposal): boolean =>
    p.status === "outcome_unknown" ||
    (p.status === "applying" && applyingProposalId() !== p.proposalId);

  const groupedThreads = createMemo(() => {
    const snap = snapshot();
    if (!snap) return [];
    const groups = new Map<string, ConversationThread[]>();
    for (const thread of snap.threads) {
      const key = thread.scopeGroup || "store";
      const list = groups.get(key) ?? [];
      list.push(thread);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  });

  const pendingProposals = createMemo(() =>
    (snapshot()?.proposals ?? []).filter(
      p =>
        p.status === "pending" ||
        p.status === "failed" ||
        p.status === "conflict" ||
        p.status === "applying" ||
        p.status === "outcome_unknown",
    ),
  );

  const execApprovalById = (id: string): GatewayExecApproval | undefined =>
    snapshot()?.execApprovals.find(a => a.approvalId === id);

  const pendingExecApprovals = createMemo(() =>
    (snapshot()?.execApprovals ?? []).filter(
      a => a.status === "pending" || a.status === "resolving",
    ),
  );

  const unboundConversationExecApprovals = createMemo(() => {
    const snap = snapshot();
    const thread = activeThread();
    if (!snap || !thread) return [];
    const referenced = new Set<string>();
    for (const msg of thread.messages) {
      for (const id of msg.execApprovalIds ?? []) referenced.add(id);
    }
    return snap.execApprovals.filter(
      a =>
        !referenced.has(a.approvalId) &&
        (a.conversationId === thread.conversationId || a.conversationId === "conv_catalog_overview"),
    );
  });

  const diffTotals = createMemo(() => {
    let added = 0;
    let removed = 0;
    for (const p of pendingProposals()) {
      for (const d of p.diffs) {
        added += d.addedLines;
        removed += d.removedLines;
      }
    }
    return { added, removed };
  });

  const selectedOverviewProposal = createMemo<RevisionProposal | undefined>(() => {
    const id = selectedProposalId();
    const list = snapshot()?.proposals ?? [];
    if (!id) return undefined;
    return list.find(p => p.proposalId === id);
  });

  const proposalById = (id: string): RevisionProposal | undefined =>
    snapshot()?.proposals.find(p => p.proposalId === id);

  const showSlashMenu = createMemo(() => {
    const txt = composerText();
    return txt.startsWith("/") && !txt.includes("\n") && txt.length < 18;
  });

  const filteredSlashCommands = createMemo(() => {
    const q = composerText().trim().toLowerCase();
    return SLASH_COMMANDS.filter(item => item.cmd.startsWith(q) || q === "/");
  });

  const scrollTranscriptToBottom = (force = false) => {
    if (!transcriptRef) return;
    if (force || stickToBottom) {
      requestAnimationFrame(() => {
        if (transcriptRef) {
          transcriptRef.scrollTop = transcriptRef.scrollHeight;
        }
      });
    }
  };

  const applyIncomingSnapshotPreservingFocus = (
    incoming: OpenClawWorkspaceSnapshot,
    preserveFocusedConvId?: string,
  ): OpenClawWorkspaceSnapshot => {
    if (
      preserveFocusedConvId &&
      preserveFocusedConvId !== incoming.activeConversationId &&
      incoming.threads.some(t => t.conversationId === preserveFocusedConvId)
    ) {
      return { ...incoming, activeConversationId: preserveFocusedConvId };
    }
    return incoming;
  };

  const refreshWorkspace = async (preferredConvId?: string) => {
    try {
      const snap = await callOpenClawChat({
        action: "get_workspace",
        ...(preferredConvId ? { conversationId: preferredConvId } : {}),
        ...(effectiveBoundEntry() ? { boundEntry: effectiveBoundEntry() } : {}),
      });
      setSnapshot(snap);
      if (snap.connection) {
        setAllowExecApprovalsInput(Boolean(snap.connection.allowGatewayExecApprovals));
        if (!gwUrlInput() && snap.connection.gatewayUrl !== "https://agent-session.openclaw.local") {
          setGwUrlInput(snap.connection.gatewayUrl);
        }
        if (snap.connection.agentId) {
          setGwAgentInput(snap.connection.agentId);
        }
      }
      setErrorBanner(null);
      const stamped = await ensureProposalBaseRevs(snap.proposals, snap.activeConversationId);
      if (stamped) {
        setSnapshot(applyIncomingSnapshotPreservingFocus(stamped, snapshot()?.activeConversationId));
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Failed to load OpenClaw workspace");
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    // Auto-collapse sidebars on narrow initial viewports so the chat stage stays usable
    const hostEl = props.rootNode.host as HTMLElement | undefined;
    const initialWidth =
      hostEl?.getBoundingClientRect().width ||
      (typeof window !== "undefined" ? window.innerWidth : 1280);
    if (initialWidth > 0 && initialWidth < 1080) {
      setRightOpen(false);
    }
    if (initialWidth > 0 && initialWidth < 820) {
      setLeftOpen(false);
    }

    // Sync theme with EmDash Admin's root `data-mode="dark" | "light"`
    const syncTheme = () => {
      const mode = document.documentElement.getAttribute("data-mode");
      setTheme(mode === "light" ? "light" : "dark");
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode"],
    });

    void refreshWorkspace();

    const disconnectStream = connectOpenClawEventStream({
      endpoint: "/_emdash/api/openclaw/stream",
      onStatus: status => setStreamState(status),
      onReconnect: () => {
        void refreshWorkspace(snapshot()?.activeConversationId);
      },
      onEvent: event => {
        const markSnapshotThreadStatus = (
          convId: string,
          nextStatus: ConversationThread["status"],
        ): boolean => {
          let found = false;
          setSnapshot(prev => {
            if (!prev) return prev;
            const idx = prev.threads.findIndex(t => t.conversationId === convId);
            if (idx < 0) return prev;
            found = true;
            if (prev.threads[idx]!.status === nextStatus) return prev;
            const threads = [...prev.threads];
            threads[idx] = { ...threads[idx]!, status: nextStatus };
            return { ...prev, threads };
          });
          return found;
        };

        if (event.type === "turn_started") {
          updateConversationStream(event.conversationId, () => ({
            text: "",
            tools: [],
            phase: null,
          }));
          const found = markSnapshotThreadStatus(event.conversationId, "running");
          if (!found) {
            void refreshWorkspace(snapshot()?.activeConversationId);
          } else if (event.conversationId === activeConvKey()) {
            scrollTranscriptToBottom();
          }
        } else if (event.type === "assistant_delta") {
          markSnapshotThreadStatus(event.conversationId, "running");
          updateConversationStream(event.conversationId, prev => ({
            ...prev,
            text: event.content,
            phase: null,
          }));
          if (event.conversationId === activeConvKey()) {
            scrollTranscriptToBottom();
          }
        } else if (event.type === "run_status") {
          markSnapshotThreadStatus(event.conversationId, "running");
          updateConversationStream(event.conversationId, prev => ({
            ...prev,
            phase: event.phase,
          }));
        } else if (event.type === "tool_call") {
          markSnapshotThreadStatus(event.conversationId, "running");
          updateConversationStream(event.conversationId, prev => {
            const idx = prev.tools.findIndex(t => t.callId === event.toolCall.callId);
            if (idx >= 0) {
              const copy = [...prev.tools];
              copy[idx] = event.toolCall;
              return { ...prev, tools: copy };
            }
            return { ...prev, tools: [...prev.tools, event.toolCall] };
          });
          if (event.conversationId === activeConvKey()) {
            scrollTranscriptToBottom();
          }
        } else if (event.type === "gateway_status") {
          setSnapshot(prev => (prev ? { ...prev, gatewayBridge: event.gatewayBridge } : prev));
        } else if (
          event.type === "proposal_updated" ||
          event.type === "exec_approval_updated" ||
          event.type === "workspace_sync"
        ) {
          if (
            event.type === "workspace_sync" &&
            (event.reason === "turn_completed" || event.reason === "turn_stopped")
          ) {
            if ((activeTurnRequestsByConv()[event.conversationId] ?? 0) === 0) {
              clearConversationStream(event.conversationId);
              markSnapshotThreadStatus(
                event.conversationId,
                event.reason === "turn_stopped" ? "stopped" : "idle",
              );
            }
          }
          void refreshWorkspace(snapshot()?.activeConversationId);
        }
      },
    });

    onCleanup(() => {
      observer.disconnect();
      disconnectStream();
    });
  });

  // Re-sync only when the bound entry key actually changes after initial mount
  let lastBoundEntryKey: string | null = null;
  createEffect(() => {
    const bound = effectiveBoundEntry();
    const key = bound ? `${bound.collection}:${bound.entryId}:${bound.locale ?? ""}` : "";
    if (lastBoundEntryKey === null) {
      lastBoundEntryKey = key;
      return;
    }
    if (key !== lastBoundEntryKey) {
      lastBoundEntryKey = key;
      void refreshWorkspace();
    }
  });

  const handleTranscriptScroll = () => {
    if (!transcriptRef) return;
    const distanceFromBottom =
      transcriptRef.scrollHeight - transcriptRef.scrollTop - transcriptRef.clientHeight;
    stickToBottom = distanceFromBottom < 72;

    // Update active turn dot based on scroll viewport center
    const nodes = Array.from(
      props.rootNode.querySelectorAll<HTMLElement>("[data-turn-idx]"),
    );
    if (nodes.length === 0) return;
    const containerTop = transcriptRef.getBoundingClientRect().top;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (const el of nodes) {
      const idx = Number(el.dataset.turnIdx ?? 0);
      const dist = Math.abs(el.getBoundingClientRect().top - (containerTop + 110));
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    setActiveTurnIdx(bestIdx);
  };

  const jumpToTurn = (idx: number) => {
    setActiveTurnIdx(idx);
    const target = props.rootNode.querySelector<HTMLElement>(`[data-turn-idx="${idx}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const focusProposalBothSurfaces = (proposalId: string) => {
    setSelectedProposalId(prev => (prev === proposalId ? null : proposalId));
    setHighlightedProposalId(proposalId);
    const card = props.rootNode.querySelector<HTMLElement>(
      `[data-proposal-card="${proposalId}"]`,
    );
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      setHighlightedProposalId(curr => (curr === proposalId ? null : curr));
    }, 1800);
  };

  const sendPrompt = async (overridePrompt?: string, isSteer = false) => {
    const convKey = activeConvKey();
    const text = (overridePrompt ?? composerText()).trim();
    if (!text) return;
    if (text === "/pair") {
      setComposerText("", convKey);
      setActiveSheet("pairing");
      return;
    }

    const targetConversationId = snapshot()?.activeConversationId;
    const targetBoundEntry = effectiveBoundEntry();
    setComposerText("", convKey);
    if (textareaRef) textareaRef.style.height = "38px";
    stickToBottom = true;

    if (isSteer) {
      setSteeringByConv(prev => ({ ...prev, [convKey]: true }));
    } else {
      setActiveTurnRequestsByConv(prev => ({
        ...prev,
        [convKey]: (prev[convKey] ?? 0) + 1,
      }));
      clearConversationStream(convKey);
    }

    try {
      const snap = await callOpenClawChat({
        action: isSteer ? "steer_turn" : "send_message",
        prompt: text,
        conversationId: targetConversationId,
        ...(targetBoundEntry ? { boundEntry: targetBoundEntry } : {}),
      });
      const currentFocus = snapshot()?.activeConversationId;
      const switchedAway =
        Boolean(targetConversationId) &&
        Boolean(currentFocus) &&
        currentFocus !== targetConversationId;
      const mergedSnap = switchedAway
        ? applyIncomingSnapshotPreservingFocus(snap, currentFocus)
        : snap;
      setSnapshot(mergedSnap);

      const resolvedConvId = snap.activeConversationId;
      const stamped = await ensureProposalBaseRevs(snap.proposals, resolvedConvId);
      if (stamped) {
        setSnapshot(
          applyIncomingSnapshotPreservingFocus(stamped, snapshot()?.activeConversationId),
        );
      }

      const latestTurnCount =
        (stamped ?? snap).threads
          .find(t => t.conversationId === resolvedConvId)
          ?.messages.filter(m => !(m.role === "assistant" && m.status === "streaming" && !m.content))
          .length ?? 1;
      setActiveTurnIdx(Math.max(0, latestTurnCount - 1), resolvedConvId);
      if (!switchedAway) {
        scrollTranscriptToBottom(true);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      if (isSteer) {
        setSteeringByConv(prev => ({ ...prev, [convKey]: false }));
      } else {
        const remaining = Math.max(0, (activeTurnRequestsByConv()[convKey] ?? 1) - 1);
        setActiveTurnRequestsByConv(prev => ({ ...prev, [convKey]: remaining }));
        if (remaining === 0) {
          clearConversationStream(convKey);
        }
      }
    }
  };

  const handleCreateNewThread = async () => {
    try {
      const snap = await callOpenClawChat({
        action: "create_thread",
        title: "New Store Conversation",
      });
      setSnapshot(snap);
      setActiveTurnIdx(0, snap.activeConversationId);
      const hostEl = props.rootNode.host as HTMLElement | undefined;
      if ((hostEl?.clientWidth ?? 1280) < 960) {
        setLeftOpen(false);
      }
      textareaRef?.focus();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not create thread");
    }
  };

  const handleSelectThread = async (conversationId: string) => {
    const hostEl = props.rootNode.host as HTMLElement | undefined;
    if ((hostEl?.clientWidth ?? 1280) < 960) {
      setLeftOpen(false);
    }
    await refreshWorkspace(conversationId);
    if (textareaRef) {
      textareaRef.style.height = "38px";
    }
    scrollTranscriptToBottom(true);
  };

  const handleToggleAuthority = async () => {
    const snap = snapshot();
    if (!snap?.isAdmin) return;
    const current = snap.connection?.authorityMode ?? "propose_with_approval";
    const nextMode = current === "read_only" ? "propose_with_approval" : "read_only";
    try {
      const updated = await callOpenClawChat({
        action: "configure_connection",
        conversationId: snap.activeConversationId,
        authorityMode: nextMode,
      });
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not update authority mode");
    }
  };

  const handleToggleCollection = async (slug: string) => {
    const snap = snapshot();
    if (!snap?.isAdmin) return;
    const current = snap.connection?.enabledCollections ?? snap.collections.map(c => c.slug);
    const next = current.includes(slug)
      ? current.filter(item => item !== slug)
      : [...current, slug];
    try {
      const updated = await callOpenClawChat({
        action: "configure_connection",
        conversationId: snap.activeConversationId,
        enabledCollections: next,
      });
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not update collection access");
    }
  };

  const handleApproveProposal = async (proposal: RevisionProposal) => {
    setApplyingProposalId(proposal.proposalId);
    try {
      const edits =
        editingProposalId() === proposal.proposalId
          ? editDraftForProposal(proposal.proposalId)
          : undefined;
      const updated = await applyRevisionProposal(proposal, edits);
      setSnapshot(updated);
      setEditingProposalId(null);
      setEditFieldDraftsByProp(prev => {
        const next = { ...prev };
        delete next[proposal.proposalId];
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to apply proposal";
      await refreshWorkspace(snapshot()?.activeConversationId);
      setErrorBanner(msg);
    } finally {
      setApplyingProposalId(null);
    }
  };

  const handleRejectProposal = async (proposal: RevisionProposal) => {
    setApplyingProposalId(proposal.proposalId);
    try {
      const updated = await callOpenClawChat({
        action: "record_proposal_receipt",
        conversationId: proposal.conversationId,
        proposalId: proposal.proposalId,
        status: "rejected",
      });
      setSnapshot(updated);
      if (selectedProposalId() === proposal.proposalId) setSelectedProposalId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not reject proposal";
      await refreshWorkspace(snapshot()?.activeConversationId);
      setErrorBanner(msg);
    } finally {
      setApplyingProposalId(null);
    }
  };

  const handleRebaseProposal = async (proposal: RevisionProposal) => {
    setApplyingProposalId(proposal.proposalId);
    try {
      const updated = await rebaseConflictedProposal(proposal);
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not rebase proposal");
    } finally {
      setApplyingProposalId(null);
    }
  };

  const handleReconcileProposal = async (proposal: RevisionProposal) => {
    setApplyingProposalId(proposal.proposalId);
    try {
      const updated = await reconcileUnknownProposal(proposal);
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not reconcile proposal");
    } finally {
      setApplyingProposalId(null);
    }
  };

  const handleResolveGatewayApproval = async (
    approval: GatewayExecApproval,
    decision: GatewayApprovalDecision,
  ) => {
    setResolvingApprovalId(approval.approvalId);
    try {
      const updated = await callOpenClawChat({
        action: "resolve_gateway_approval",
        conversationId: snapshot()?.activeConversationId,
        approvalId: approval.approvalId,
        kind: approval.kind,
        decision,
      });
      setSnapshot(updated);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to resolve Gateway execution approval";
      await refreshWorkspace(snapshot()?.activeConversationId);
      setErrorBanner(msg);
    } finally {
      setResolvingApprovalId(null);
    }
  };

  const handleToggleThreadVisibility = async () => {
    const convId = activeThread()?.conversationId;
    if (!convId) return;
    try {
      const updated = await callOpenClawChat({
        action: "toggle_thread_visibility",
        conversationId: convId,
      });
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not toggle thread visibility");
    }
  };

  const beginEditProposal = (proposal: RevisionProposal) => {
    const init: Record<string, string> = {};
    if (Object.keys(proposal.proposedFields ?? {}).length === 0) {
      init.description = proposal.summary;
    } else {
      for (const d of proposal.diffs) {
        init[d.field] = d.after;
      }
    }
    setEditFieldDraftsByProp(prev => ({ ...prev, [proposal.proposalId]: init }));
    setEditingProposalId(proposal.proposalId);
  };

  const handleSaveManualGateway = async () => {
    const snap = snapshot();
    if (!snap?.isAdmin) return;
    setProbingGateway(true);
    try {
      const updated = await callOpenClawChat({
        action: "configure_connection",
        conversationId: snap.activeConversationId,
        ...(gwUrlInput().trim() ? { gatewayUrl: gwUrlInput().trim() } : {}),
        ...(gwAgentInput().trim() ? { agentId: gwAgentInput().trim() } : {}),
        ...(gwTokenInput().trim() ? { gatewayToken: gwTokenInput().trim() } : {}),
        allowGatewayExecApprovals: allowExecApprovalsInput(),
      });
      setSnapshot(updated);
      setGwTokenInput("");
      if (updated.gatewayBridge.state === "connected" || !gwUrlInput().trim()) {
        setActiveSheet(null);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not save Gateway settings");
    } finally {
      setProbingGateway(false);
    }
  };

  const handleProbeGateway = async () => {
    const snap = snapshot();
    if (!snap?.isAdmin) return;
    setProbingGateway(true);
    try {
      const updated = await callOpenClawChat({
        action: "probe_gateway",
        conversationId: snap.activeConversationId,
      });
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Gateway probe failed");
    } finally {
      setProbingGateway(false);
    }
  };

  const handleDisconnectGateway = async () => {
    const snap = snapshot();
    if (!snap?.isAdmin) return;
    setProbingGateway(true);
    try {
      const updated = await callOpenClawChat({
        action: "disconnect",
        conversationId: snap.activeConversationId,
      });
      setSnapshot(updated);
      setGwUrlInput("");
      setGwTokenInput("");
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not disconnect Gateway");
    } finally {
      setProbingGateway(false);
    }
  };

  const handleStopTurn = async () => {
    try {
      const updated = await callOpenClawChat({
        action: "stop_turn",
        conversationId: snapshot()?.activeConversationId,
      });
      setSnapshot(updated);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Could not stop active run");
    }
  };

  const copyPairingCommand = async () => {
    const cmd = snapshot()?.pairingCommand;
    if (!cmd) return;
    await navigator.clipboard?.writeText(cmd).catch(() => {});
    setCopiedPairing(true);
    setTimeout(() => setCopiedPairing(false), 1800);
  };

  const activeEditorHref = createMemo(() => {
    const bound = effectiveBoundEntry() ?? activeThread()?.boundEntry;
    if (bound) {
      return `/_emdash/admin/content/${encodeURIComponent(bound.collection)}/${encodeURIComponent(bound.entryId)}`;
    }
    const firstEntry = snapshot()?.entriesPreview[0];
    if (firstEntry) {
      return `/_emdash/admin/content/${encodeURIComponent(firstEntry.collection)}/${encodeURIComponent(firstEntry.id)}`;
    }
    return "/_emdash/admin";
  });

  return (
    <div
      class="oc-root"
      data-theme={theme()}
      data-surface={props.getHostProps().surface}
    >
      {/* ZONE 1: COLLAPSIBLE LEFT SIDEBAR (Hidden in compact Editor Side-Panel) */}
      <Show when={!isEditorPanel()}>
        <aside class={`oc-left-sidebar ${leftOpen() ? "" : "is-collapsed"}`}>
          <button type="button" class="oc-new-conv-btn" onClick={handleCreateNewThread}>
            <span style={{ "font-size": "15px", "line-height": "1" }}>+</span>
            <span>New Conversation</span>
          </button>

          <div class="oc-nav-list">
            <button
              type="button"
              class={`oc-nav-item ${activeSheet() === "automations" ? "is-active" : ""}`}
              onClick={() =>
                setActiveSheet(prev => (prev === "automations" ? null : "automations"))
              }
            >
              <span class="oc-nav-item-left">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.35" />
                  <path d="M8 4.8V8.2L10.4 9.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                </svg>
                <span>Automations</span>
              </span>
              <span class="oc-count-pill">
                {(snapshot()?.automations ?? []).filter(a => a.enabled).length}
              </span>
            </button>

            <button
              type="button"
              class={`oc-nav-item ${activeSheet() === "customizations" ? "is-active" : ""}`}
              onClick={() =>
                setActiveSheet(prev => (prev === "customizations" ? null : "customizations"))
              }
            >
              <span class="oc-nav-item-left">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="4.5" width="12" height="9" rx="1.8" stroke="currentColor" stroke-width="1.35" />
                  <path d="M5.5 4.5V3.4C5.5 2.9 5.9 2.5 6.4 2.5H9.6C10.1 2.5 10.5 2.9 10.5 3.4V4.5" stroke="currentColor" stroke-width="1.35" />
                </svg>
                <span>Customizations</span>
              </span>
              <span class="oc-count-pill">
                {snapshot()?.connection?.enabledCollections.length ??
                  snapshot()?.collections.length ??
                  0}
              </span>
            </button>
          </div>

          <div class="oc-section-heading">
            <span>Store Scopes</span>
            <span>▾</span>
          </div>

          <div class="oc-threads-scroll">
            <For each={groupedThreads()}>
              {([groupName, groupList]) => (
                <div>
                  <div class="oc-folder-row">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                      <path d="M1.8 4.2C1.8 3.5 2.3 3 3 3H6.1L7.5 4.6H13C13.7 4.6 14.2 5.1 14.2 5.8V12C14.2 12.7 13.7 13.2 13 13.2H3C2.3 13.2 1.8 12.7 1.8 12V4.2Z" stroke="currentColor" stroke-width="1.3" />
                    </svg>
                    <span>{groupName}</span>
                  </div>
                  <For each={groupList}>
                    {thread => {
                      const isCurrent = () =>
                        snapshot()?.activeConversationId === thread.conversationId;
                      const isRunning = () =>
                        isConversationRunning(thread.conversationId, thread.status);
                      return (
                        <button
                          type="button"
                          class={`oc-thread-btn ${isCurrent() ? "is-active" : ""}`}
                          onClick={() => void handleSelectThread(thread.conversationId)}
                        >
                          <span class="oc-thread-title">{thread.title}</span>
                          <span class="oc-thread-meta">
                            <Show
                              when={isRunning()}
                              fallback={<span>{formatRelativeTime(thread.updatedAt)}</span>}
                            >
                              <span class="oc-live-dot" title="Agent turn running" />
                            </Show>
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>

          <div class="oc-left-footer">
            <button
              type="button"
              class={`oc-nav-item ${activeSheet() === "pairing" ? "is-active" : ""}`}
              onClick={() => setActiveSheet(prev => (prev === "pairing" ? null : "pairing"))}
            >
              <span class="oc-nav-item-left">
                <span>⚙</span>
                <span>Gateway & Pairing</span>
              </span>
              <span
                class="oc-status-dot"
                classList={{ "is-warn": !snapshot()?.paired }}
              />
            </button>
          </div>
        </aside>
      </Show>

      {/* ZONE 2: CENTER CHAT STAGE */}
      <section class="oc-stage">
        <header class="oc-topbar">
          <div class="oc-topbar-group">
            <Show when={!isEditorPanel() && props.getHostProps().onToggleEmdashNav}>
              <button
                type="button"
                class="oc-icon-btn"
                title="Toggle EmDash outer navigation sidebar"
                onClick={() => props.getHostProps().onToggleEmdashNav?.()}
              >
                <span>{props.getHostProps().emdashNavOpen ? "⇤ EmDash" : "☰ EmDash"}</span>
              </button>
            </Show>

            <Show when={!isEditorPanel()}>
              <button
                type="button"
                class={`oc-icon-btn ${leftOpen() ? "is-active" : ""}`}
                title="Toggle Conversations sidebar"
                aria-label="Toggle left sidebar"
                onClick={() => setLeftOpen(v => !v)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" stroke="currentColor" stroke-width="1.35" />
                  <path d="M5.8 2.5V13.5" stroke="currentColor" stroke-width="1.35" />
                </svg>
              </button>
            </Show>

            <div class="oc-breadcrumb">
              <span>{activeThread()?.scopeGroup ?? "store"}</span>
              <span>/</span>
              <strong>{activeThread()?.title ?? "OpenClaw Assistant"}</strong>
            </div>

            <Show when={activeThread()}>
              {thread => (
                <button
                  type="button"
                  class="oc-icon-btn"
                  title={
                    thread().visibility === "shared"
                      ? "Shared with store editors — click to make personal"
                      : "Personal thread (isolated to your user) — click to share with team"
                  }
                  onClick={() => void handleToggleThreadVisibility()}
                >
                  <span>{thread().visibility === "shared" ? "👥 Shared" : "🔒 Personal"}</span>
                </button>
              )}
            </Show>
          </div>

          <div class="oc-topbar-group">
            <button
              type="button"
              class="oc-status-pill"
              style={{ cursor: "pointer" }}
              title={`Gateway WS: ${snapshot()?.gatewayBridge.state ?? "disconnected"} · SSE: ${streamState()}`}
              onClick={() => setActiveSheet("pairing")}
            >
              <span
                class="oc-status-dot"
                classList={{
                  "is-warn":
                    streamState() !== "live" ||
                    (snapshot()?.connection?.transportMode === "gateway-ws" &&
                      snapshot()?.gatewayBridge.state !== "connected"),
                }}
              />
              <span>
                {snapshot()?.connection?.transportMode === "gateway-ws"
                  ? `@${snapshot()?.connection?.agentId ?? "openclaw"} · GW ${snapshot()?.gatewayBridge.state === "connected" ? `v${snapshot()?.gatewayBridge.protocolVersion ?? 4}` : snapshot()?.gatewayBridge.state}`
                  : streamState() === "live"
                    ? `@${snapshot()?.connection?.agentId ?? "openclaw"} · SSE live`
                    : `@${snapshot()?.connection?.agentId ?? "openclaw"} · ${streamState()}`}
              </span>
            </button>

            <Show when={!isEditorPanel()}>
              <a class="oc-pill-link" href={activeEditorHref()}>
                <span>Open in Editor</span>
                <span>↗</span>
              </a>

              <button
                type="button"
                class={`oc-icon-btn ${rightOpen() ? "is-active" : ""}`}
                title="Toggle Overview inspector"
                aria-label="Toggle right sidebar"
                onClick={() => setRightOpen(v => !v)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" stroke="currentColor" stroke-width="1.35" />
                  <path d="M10.2 2.5V13.5" stroke="currentColor" stroke-width="1.35" />
                </svg>
              </button>
            </Show>
          </div>
        </header>

        {/* ANTIGRAVITY LEFT-GUTTER VERTICAL TURN-NAVIGATION MINIMAP DOTS */}
        <Show when={renderedMessages().length > 0}>
          <nav class="oc-turn-minimap" aria-label="Conversation turns">
            <For each={renderedMessages()}>
              {(msg, idx) => (
                <button
                  type="button"
                  class={`oc-turn-dot ${activeTurnIdx() === idx() ? "is-active" : ""}`}
                  title={`${msg.role === "user" ? "You" : "OpenClaw"}: ${msg.content.slice(0, 64)}`}
                  onClick={() => jumpToTurn(idx())}
                />
              )}
            </For>
          </nav>
        </Show>

        {/* SCROLLING TRANSCRIPT */}
        <div
          class="oc-transcript"
          ref={el => (transcriptRef = el)}
          onScroll={handleTranscriptScroll}
        >
          <div class="oc-transcript-inner">
            <Show when={snapshot()?.settingsError}>
              <div class="oc-proposal-card" data-status="conflict">
                <div class="oc-proposal-header">
                  <span class="oc-proposal-title">Stored Credentials Warning</span>
                  <Show when={snapshot()?.isAdmin}>
                    <button type="button" class="oc-btn" onClick={() => setActiveSheet("pairing")}>
                      Gateway Settings
                    </button>
                  </Show>
                </div>
                <div style={{ "font-size": "12.5px", color: "var(--oc-text-body)" }}>
                  {snapshot()?.settingsError}
                </div>
              </div>
            </Show>

            <Show when={errorBanner()}>
              <div class="oc-proposal-card" data-status="conflict">
                <div class="oc-proposal-header">
                  <span class="oc-proposal-title">Notice</span>
                  <button type="button" class="oc-btn" onClick={() => setErrorBanner(null)}>
                    Dismiss
                  </button>
                </div>
                <div style={{ "font-size": "12.5px", color: "var(--oc-text-body)" }}>
                  {errorBanner()}
                </div>
              </div>
            </Show>

            <Show when={!loading() && renderedMessages().length === 0 && !sending()}>
              <div class="oc-empty-hero">
                <h2>
                  {isEditorPanel()
                    ? `Collaborate on ${effectiveBoundEntry()?.title ?? effectiveBoundEntry()?.entryId ?? "this entry"}`
                    : `Connected to ${snapshot()?.siteName ?? "your EmDash Store"}`}
                </h2>
                <p>
                  OpenClaw reads your live EmDash collections (<code>content:read</code>) and stages
                  revision-fenced draft proposals (<code>_rev</code>) that only save when you approve.
                </p>
                <div class="oc-starter-grid">
                  <button
                    type="button"
                    class="oc-starter-chip"
                    onClick={() => void sendPrompt("Can you see my products and pages?")}
                  >
                    Can you see my products?
                  </button>
                  <button
                    type="button"
                    class="oc-starter-chip"
                    onClick={() =>
                      void sendPrompt(
                        isEditorPanel()
                          ? "Propose a sharper storefront excerpt for this entry"
                          : "Propose a refined product excerpt for our top catalog item",
                      )
                    }
                  >
                    Stage a _rev draft proposal
                  </button>
                  <button
                    type="button"
                    class="oc-starter-chip"
                    onClick={() => setActiveSheet("pairing")}
                  >
                    Pair external OpenClaw / CLI agent
                  </button>
                </div>
              </div>
            </Show>

            <For each={renderedMessages()}>
              {(msg: ChatTurnMessage, idx) => (
                <div data-turn-idx={idx()}>
                  <Show
                    when={msg.role === "assistant"}
                    fallback={
                      <div class="oc-user-row">
                        <div class="oc-user-bubble">{msg.content}</div>
                      </div>
                    }
                  >
                    <div class="oc-assistant-turn">
                      {/* COMPACT EXPANDABLE TOOL CALL ROWS */}
                      <Show when={(msg.toolCalls?.length ?? 0) > 0}>
                        <div class="oc-tool-stack">
                          <For each={msg.toolCalls ?? []}>
                            {tool => {
                              const isOpen = () => Boolean(openToolIds()[tool.callId]);
                              return (
                                <div class={`oc-tool-row ${isOpen() ? "is-open" : ""}`}>
                                  <button
                                    type="button"
                                    class="oc-tool-summary"
                                    onClick={() =>
                                      setOpenToolIds(prev => ({
                                        ...prev,
                                        [tool.callId]: !prev[tool.callId],
                                      }))
                                    }
                                  >
                                    <span>{isOpen() ? "▾" : "▸"}</span>
                                    <span style={{ color: "var(--oc-text-main)" }}>{tool.name}</span>
                                    <span>— {tool.summary}</span>
                                    <span class="oc-tool-Summary-right">
                                      <span>{tool.durationMs}ms</span>
                                      <span style={{ color: "var(--oc-accent-green)" }}>
                                        {tool.status === "ok" ? "✓" : "!"}
                                      </span>
                                    </span>
                                  </button>
                                  <Show when={isOpen()}>
                                    <pre class="oc-tool-payload">
                                      {JSON.stringify(
                                        { args: tool.args, result: tool.payload },
                                        null,
                                        2,
                                      )}
                                    </pre>
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>

                      {/* BORDERLESS MARKDOWN TRANSCRIPT */}
                      <SafeMarkdownProse content={msg.content} />

                      {/* INLINE DUAL-AUTHORITY GATEWAY EXECUTION APPROVAL CARDS */}
                      <For each={msg.execApprovalIds ?? []}>
                        {approvalId => {
                          const appr = createMemo(() => execApprovalById(approvalId));
                          return (
                            <Show when={appr()}>
                              {a => {
                                const canResolve = () => Boolean(snapshot()?.canResolveGatewayApprovals);
                                const controlUiHref = () => {
                                  const origin = snapshot()?.gatewayBridge.gatewayControlUiOrigin;
                                  if (!origin) return null;
                                  return `${origin}${a().urlPath ?? "/chat/main"}`;
                                };
                                return (
                                  <div
                                    class="oc-exec-approval-card"
                                    data-approval-card={a().approvalId}
                                    data-status={a().status}
                                  >
                                    <div class="oc-proposal-header">
                                      <div class="oc-proposal-title">
                                        <span class="oc-badge is-purple">
                                          Gateway Approval · {a().kind}
                                        </span>
                                        <span>{a().title ?? `@${a().agentId} execution request`}</span>
                                        <Show when={a().host}>
                                          <span class="oc-badge">host:{a().host}</span>
                                        </Show>
                                      </div>
                                      <span
                                        class={`oc-badge ${a().status === "allowed" ? "is-green" : a().status === "pending" || a().status === "resolving" ? "is-amber" : ""}`}
                                      >
                                        {a().status === "allowed"
                                          ? `✓ Allowed (${a().decision ?? "once"})`
                                          : a().status === "denied"
                                            ? "✕ Denied"
                                            : a().status}
                                      </span>
                                    </div>

                                    <div class="oc-diff-box">
                                      <div class="oc-diff-field-name">Command / Action</div>
                                      <div style={{ color: "var(--oc-text-main)", "word-break": "break-word" }}>
                                        {a().commandPreview ?? a().command}
                                      </div>
                                      <Show when={a().warningText}>
                                        <div style={{ color: "var(--oc-accent-amber)" }}>
                                          ⚠ {a().warningText}
                                        </div>
                                      </Show>
                                    </div>

                                    <Show when={a().status === "pending" || a().status === "resolving"}>
                                      <Show
                                        when={canResolve()}
                                        fallback={
                                          <div class="oc-readonly-notice">
                                            <span>
                                              {!snapshot()?.isAdmin
                                                ? "Read-only: Editor CMS draft authority does not grant Gateway execution approval."
                                                : !snapshot()?.connection?.allowGatewayExecApprovals
                                                  ? "Read-only: Inline Gateway execution approvals are off by default."
                                                  : "Read-only: Gateway connection does not hold operator.approvals scope."}
                                            </span>
                                            <Show
                                              when={controlUiHref()}
                                              fallback={
                                                <Show when={snapshot()?.isAdmin}>
                                                  <button
                                                    type="button"
                                                    class="oc-btn"
                                                    onClick={() => setActiveSheet("pairing")}
                                                  >
                                                    Gateway Settings
                                                  </button>
                                                </Show>
                                              }
                                            >
                                              {href => (
                                                <a
                                                  class="oc-pill-link"
                                                  href={href()}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                >
                                                  Review in Gateway Control UI ↗
                                                </a>
                                              )}
                                            </Show>
                                          </div>
                                        }
                                      >
                                        <div class="oc-proposal-actions">
                                          <For each={a().allowedDecisions}>
                                            {dec => (
                                              <button
                                                type="button"
                                                class={`oc-btn ${dec === "allow-once" ? "oc-btn-primary" : ""}`}
                                                disabled={
                                                  a().status === "resolving" ||
                                                  resolvingApprovalId() === a().approvalId
                                                }
                                                onClick={() =>
                                                  void handleResolveGatewayApproval(a(), dec)
                                                }
                                              >
                                                {dec === "allow-once"
                                                  ? "Allow Once"
                                                  : dec === "allow-always"
                                                    ? "Allow Always"
                                                    : "Deny"}
                                              </button>
                                            )}
                                          </For>
                                          <Show when={controlUiHref()}>
                                            {href => (
                                              <a
                                                class="oc-pill-link"
                                                href={href()}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                              >
                                                Control UI ↗
                                              </a>
                                            )}
                                          </Show>
                                        </div>
                                      </Show>
                                    </Show>
                                  </div>
                                );
                              }}
                            </Show>
                          );
                        }}
                      </For>

                      {/* INLINE REVISION-GUARDED PROPOSAL CARDS */}
                      <For each={msg.proposalIds ?? []}>
                        {propId => {
                          const prop = createMemo(() => proposalById(propId));
                          return (
                            <Show when={prop()}>
                              {p => (
                                <div
                                  class={`oc-proposal-card ${highlightedProposalId() === p().proposalId ? "is-highlighted" : ""}`}
                                  data-proposal-card={p().proposalId}
                                  data-status={p().status}
                                >
                                  <div class="oc-proposal-header">
                                    <div class="oc-proposal-title">
                                      <span class="oc-badge is-coral">
                                        CMS Draft · rev #{p().revisionNumber ?? 1}
                                      </span>
                                      <span>{p().entryTitle}</span>
                                      <span class="oc-badge">
                                        {p().collection}/{p().entrySlug}
                                      </span>
                                      <Show when={p().supersedesProposalId}>
                                        <span class="oc-badge" title={`Supersedes ${p().supersedesProposalId}`}>
                                          edited
                                        </span>
                                      </Show>
                                    </div>
                                    <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                                      <span class="oc-badge" title={p().baseRev}>
                                        base {shortenRev(p().baseRev)}
                                      </span>
                                      <Show when={p().status === "applied"}>
                                        <span class="oc-badge is-green">
                                          ✓ Applied ({shortenRev(p().appliedRev)}
                                          {p().reconciledServerSide ? " · verified" : ""})
                                        </span>
                                      </Show>
                                      <Show when={p().status === "conflict"}>
                                        <span class="oc-badge is-amber">⚠ _rev Conflict</span>
                                      </Show>
                                      <Show when={p().status === "outcome_unknown"}>
                                        <span class="oc-badge is-amber">? Outcome Unknown</span>
                                      </Show>
                                      <Show when={p().status === "applying"}>
                                        <span class="oc-badge is-amber">
                                          {applyingProposalId() === p().proposalId
                                            ? "Applying…"
                                            : "? Interrupted Save"}
                                        </span>
                                      </Show>
                                      <Show when={p().status === "failed"}>
                                        <span class="oc-badge is-coral">✕ Save Failed</span>
                                      </Show>
                                      <Show when={p().status === "superseded"}>
                                        <span class="oc-badge">Superseded</span>
                                      </Show>
                                      <Show when={p().status === "rejected"}>
                                        <span class="oc-badge">Rejected</span>
                                      </Show>
                                    </div>
                                  </div>

                                  <div class="oc-diff-box">
                                    <Show
                                      when={
                                        editingProposalId() === p().proposalId &&
                                        Object.keys(p().proposedFields ?? {}).length === 0
                                      }
                                      fallback={
                                        <For each={p().diffs}>
                                          {diff => (
                                            <div>
                                              <div class="oc-diff-field-name">{diff.label}</div>
                                              <div class="oc-diff-minus">- {diff.before}</div>
                                              <Show
                                                when={editingProposalId() === p().proposalId}
                                                fallback={<div class="oc-diff-plus">+ {diff.after}</div>}
                                              >
                                                <input
                                                  type="text"
                                                  class="oc-edit-input"
                                                  value={
                                                    editDraftForProposal(p().proposalId)[diff.field] ??
                                                    diff.after
                                                  }
                                                  onInput={e =>
                                                    setEditDraftField(
                                                      p().proposalId,
                                                      diff.field,
                                                      e.currentTarget.value,
                                                    )
                                                  }
                                                />
                                              </Show>
                                            </div>
                                          )}
                                        </For>
                                      }
                                    >
                                      <For each={Object.keys(editDraftForProposal(p().proposalId))}>
                                        {field => (
                                          <div>
                                            <div class="oc-diff-field-name">{field}</div>
                                            <input
                                              type="text"
                                              class="oc-edit-input"
                                              value={
                                                editDraftForProposal(p().proposalId)[field] ?? ""
                                              }
                                              onInput={e =>
                                                setEditDraftField(
                                                  p().proposalId,
                                                  field,
                                                  e.currentTarget.value,
                                                )
                                              }
                                            />
                                          </div>
                                        )}
                                      </For>
                                    </Show>
                                  </div>

                                  <Show when={p().errorMessage}>
                                    <div style={{ "font-size": "12px", color: "var(--oc-accent-amber)" }}>
                                      {p().errorMessage}
                                    </div>
                                  </Show>

                                  <Show
                                    when={
                                      p().status === "pending" ||
                                      p().status === "failed" ||
                                      p().status === "conflict" ||
                                      needsProposalReconcile(p())
                                    }
                                  >
                                    <div class="oc-proposal-actions">
                                      <Show
                                        when={needsProposalReconcile(p())}
                                        fallback={
                                          <Show
                                            when={p().status === "conflict"}
                                            fallback={
                                              <Show
                                                when={canProposalStageDraft(p())}
                                                fallback={
                                                  <span
                                                    class="oc-badge is-amber"
                                                    title="Collection does not support staging drafts without modifying live content"
                                                  >
                                                    Collection lacks draft revisions · edit in EmDash
                                                  </span>
                                                }
                                              >
                                                <Show
                                                  when={
                                                    hasConcretePatch(p()) ||
                                                    (editingProposalId() === p().proposalId &&
                                                      p().entryId !== "current")
                                                  }
                                                  fallback={
                                                    <span class="oc-badge">
                                                      Summary-only · no concrete patch
                                                    </span>
                                                  }
                                                >
                                                  <button
                                                    type="button"
                                                    class="oc-btn oc-btn-primary"
                                                    disabled={applyingProposalId() === p().proposalId}
                                                    onClick={() => void handleApproveProposal(p())}
                                                  >
                                                    {applyingProposalId() === p().proposalId
                                                      ? "Applying to EmDash…"
                                                      : editingProposalId() === p().proposalId
                                                        ? `Save as rev #${(p().revisionNumber ?? 1) + 1}`
                                                        : p().status === "failed"
                                                          ? "Retry Save Draft"
                                                          : "Approve & Save Draft"}
                                                  </button>
                                                </Show>
                                              </Show>
                                            }
                                          >
                                            <button
                                              type="button"
                                              class="oc-btn oc-btn-primary"
                                              disabled={applyingProposalId() === p().proposalId}
                                              onClick={() => void handleRebaseProposal(p())}
                                            >
                                              Rebase on Latest _rev
                                            </button>
                                          </Show>
                                        }
                                      >
                                        <button
                                          type="button"
                                          class="oc-btn oc-btn-primary"
                                          disabled={applyingProposalId() === p().proposalId}
                                          onClick={() => void handleReconcileProposal(p())}
                                        >
                                          {applyingProposalId() === p().proposalId
                                            ? "Reconciling…"
                                            : "Reconcile with EmDash"}
                                        </button>
                                      </Show>

                                      <Show
                                        when={
                                          (p().status === "pending" || p().status === "failed") &&
                                          canProposalStageDraft(p()) &&
                                          editingProposalId() !== p().proposalId &&
                                          p().entryId !== "current"
                                        }
                                      >
                                        <button
                                          type="button"
                                          class="oc-btn"
                                          onClick={() => beginEditProposal(p())}
                                        >
                                          Edit & Approve
                                        </button>
                                      </Show>

                                      <Show when={!needsProposalReconcile(p())}>
                                        <button
                                          type="button"
                                          class="oc-btn"
                                          disabled={applyingProposalId() === p().proposalId}
                                          onClick={() => void handleRejectProposal(p())}
                                        >
                                          Reject
                                        </button>
                                      </Show>

                                      <a
                                        class="oc-pill-link"
                                        href={`/_emdash/admin/content/${encodeURIComponent(p().collection)}/${encodeURIComponent(p().entryId)}`}
                                      >
                                        Inspect Entry ↗
                                      </a>
                                    </div>
                                  </Show>
                                </div>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>

            {/* LIVE IN-FLIGHT STREAMING TURN */}
            <Show when={sending()}>
              <div class="oc-assistant-turn">
                <For each={streamingTools()}>
                  {tool => (
                    <div class="oc-tool-row">
                      <div class="oc-tool-summary">
                        <span>▸</span>
                        <span style={{ color: "var(--oc-text-main)" }}>{tool.name}</span>
                        <span>— {tool.summary}</span>
                        <span class="oc-tool-Summary-right">{tool.durationMs}ms ✓</span>
                      </div>
                    </div>
                  )}
                </For>
                <Show
                  when={streamingText()}
                  fallback={
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "13px", color: "var(--oc-text-muted)" }}>
                      <span class="oc-live-dot" />
                      <span>
                        @{snapshot()?.connection?.agentId ?? "openclaw"}{" "}
                        {runStartupPhase()
                          ? `· ${runStartupPhase()?.replace(/_/g, " ")}…`
                          : "is reading EmDash collections…"}
                      </span>
                    </div>
                  }
                >
                  <SafeMarkdownProse content={streamingText()} />
                </Show>
              </div>
            </Show>

            {/* UNBOUND LIVE GATEWAY EXECUTION APPROVALS (arriving mid-run or via subscription replay) */}
            <For each={unboundConversationExecApprovals()}>
              {a => {
                const canResolve = () => Boolean(snapshot()?.canResolveGatewayApprovals);
                const controlUiHref = () => {
                  const origin = snapshot()?.gatewayBridge.gatewayControlUiOrigin;
                  if (!origin) return null;
                  return `${origin}${a.urlPath ?? "/chat/main"}`;
                };
                return (
                  <div
                    class="oc-exec-approval-card"
                    data-approval-card={a.approvalId}
                    data-status={a.status}
                  >
                    <div class="oc-proposal-header">
                      <div class="oc-proposal-title">
                        <span class="oc-badge is-purple">Gateway Approval · {a.kind}</span>
                        <span>{a.title ?? `@${a.agentId} execution request`}</span>
                        <Show when={a.host}>
                          <span class="oc-badge">host:{a.host}</span>
                        </Show>
                      </div>
                      <span
                        class={`oc-badge ${a.status === "allowed" ? "is-green" : a.status === "pending" || a.status === "resolving" ? "is-amber" : ""}`}
                      >
                        {a.status === "allowed"
                          ? `✓ Allowed (${a.decision ?? "once"})`
                          : a.status === "denied"
                            ? "✕ Denied"
                            : a.status}
                      </span>
                    </div>

                    <div class="oc-diff-box">
                      <div class="oc-diff-field-name">Command / Action</div>
                      <div style={{ color: "var(--oc-text-main)", "word-break": "break-word" }}>
                        {a.commandPreview ?? a.command}
                      </div>
                      <Show when={a.warningText}>
                        <div style={{ color: "var(--oc-accent-amber)" }}>⚠ {a.warningText}</div>
                      </Show>
                    </div>

                    <Show when={a.status === "pending" || a.status === "resolving"}>
                      <Show
                        when={canResolve()}
                        fallback={
                          <div class="oc-readonly-notice">
                            <span>
                              {!snapshot()?.isAdmin
                                ? "Read-only: Editor CMS draft authority does not grant Gateway execution approval."
                                : !snapshot()?.connection?.allowGatewayExecApprovals
                                  ? "Read-only: Inline Gateway execution approvals are off by default."
                                  : "Read-only: Gateway connection does not hold operator.approvals scope."}
                            </span>
                            <Show when={controlUiHref()}>
                              {href => (
                                <a
                                  class="oc-pill-link"
                                  href={href()}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Review in Gateway Control UI ↗
                                </a>
                              )}
                            </Show>
                          </div>
                        }
                      >
                        <div class="oc-proposal-actions">
                          <For each={a.allowedDecisions}>
                            {dec => (
                              <button
                                type="button"
                                class={`oc-btn ${dec === "allow-once" ? "oc-btn-primary" : ""}`}
                                disabled={
                                  a.status === "resolving" || resolvingApprovalId() === a.approvalId
                                }
                                onClick={() => void handleResolveGatewayApproval(a, dec)}
                              >
                                {dec === "allow-once"
                                  ? "Allow Once"
                                  : dec === "allow-always"
                                    ? "Allow Always"
                                    : "Deny"}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        {/* ANTIGRAVITY DOUBLE-RIM FLOATING COMPOSER */}
        <div class="oc-composer-wrap">
          <div class="oc-composer-bezel">
            <Show when={showSlashMenu() && filteredSlashCommands().length > 0}>
              <div class="oc-slash-menu" role="listbox">
                <For each={filteredSlashCommands()}>
                  {item => (
                    <button
                      type="button"
                      class="oc-slash-item"
                      onClick={() => {
                        if (item.fill === "__OPEN_PAIR__") {
                          setComposerText("");
                          setActiveSheet("pairing");
                        } else {
                          setComposerText(item.fill);
                          textareaRef?.focus();
                        }
                      }}
                    >
                      <code style={{ color: "var(--oc-text-main)", "font-weight": "600" }}>
                        {item.cmd}
                      </code>
                      <span style={{ color: "var(--oc-text-muted)", "font-size": "11px" }}>
                        {item.hint}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <div class="oc-composer-core">
              {/* CONTEXT CHIP TRAY */}
              <div class="oc-chip-tray">
                <Show when={effectiveBoundEntry()}>
                  {bound => (
                    <span class="oc-context-chip">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M4 2H9.5L12.5 5V14H4V2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
                        <path d="M9.5 2V5H12.5" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
                      </svg>
                      <span>
                        {bound().collection}/{bound().title ?? bound().entryId}
                      </span>
                      <Show when={!isEditorPanel()}>
                        <button
                          type="button"
                          aria-label="Detach entry"
                          onClick={() => setAttachedEntry(undefined)}
                        >
                          ×
                        </button>
                      </Show>
                    </span>
                  )}
                </Show>

                <Show when={!isEditorPanel()}>
                  <button
                    type="button"
                    class="oc-context-chip"
                    style={{ cursor: "pointer" }}
                    onClick={() => setActiveSheet("attach")}
                  >
                    <span>+</span>
                    <span>Attach store entry</span>
                  </button>
                </Show>
              </div>

              <textarea
                ref={el => (textareaRef = el)}
                class="oc-composer-textarea"
                rows={1}
                placeholder={
                  sending()
                    ? "Type a mid-turn steer instruction…"
                    : isEditorPanel()
                      ? "Ask @openclaw about this entry or /propose…"
                      : "Ask @openclaw about products, pages, or type /propose to stage an EmDash draft…"
                }
                value={composerText()}
                onInput={e => {
                  setComposerText(e.currentTarget.value);
                  e.currentTarget.style.height = "38px";
                  e.currentTarget.style.height = `${Math.min(150, e.currentTarget.scrollHeight)}px`;
                }}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    // Desktop Enter-to-send; mobile virtual keyboards keep newline
                    const isCoarseMobile =
                      typeof window !== "undefined" &&
                      window.matchMedia?.("(pointer: coarse)").matches;
                    if (!isCoarseMobile) {
                      e.preventDefault();
                      void sendPrompt(undefined, sending());
                    }
                  }
                }}
              />

              <div class="oc-composer-toolbar">
                <div class="oc-composer-left-tools">
                  <button
                    type="button"
                    class="oc-model-selector"
                    title="Click to toggle Read-Only vs Read + Propose authority"
                    onClick={() => void handleToggleAuthority()}
                  >
                    <span style={{ color: "var(--oc-accent-coral)" }}>●</span>
                    <span>@{snapshot()?.connection?.agentId ?? "openclaw"}</span>
                    <span>·</span>
                    <span>
                      {snapshot()?.connection?.authorityMode === "read_only"
                        ? "Read-Only"
                        : "Read + Propose"}
                    </span>
                    <span>⌃</span>
                  </button>
                </div>

                <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  <Show when={sending()}>
                    <button
                      type="button"
                      class="oc-btn"
                      onClick={() => void handleStopTurn()}
                    >
                      ■ Stop
                    </button>
                  </Show>

                  <button
                    type="button"
                    class="oc-send-circle"
                    aria-label={sending() ? "Steer agent" : "Send message"}
                    disabled={!composerText().trim() || steeringInFlight()}
                    onClick={() => void sendPrompt(undefined, sending())}
                  >
                    ↑
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* MODAL SHEETS FOR PAIRING / CUSTOMIZATIONS / AUTOMATIONS / ATTACH ENTRY */}
        <Show when={activeSheet()}>
          <div class="oc-sheet-backdrop" onClick={() => setActiveSheet(null)}>
            <div class="oc-sheet" onClick={e => e.stopPropagation()}>
              <Show when={activeSheet() === "pairing"}>
                <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                  <h3>OpenClaw Gateway v4 & Agent Pairing</h3>
                  <button type="button" class="oc-btn" onClick={() => setActiveSheet(null)}>
                    Close
                  </button>
                </div>

                {/* LIVE @openclaw/gateway-client BRIDGE STATUS */}
                <div class="oc-gw-status-card">
                  <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
                    <span style={{ "font-weight": "600", color: "var(--oc-text-main)" }}>
                      Server-Owned Gateway Bridge (@openclaw/gateway-client)
                    </span>
                    <span
                      class={`oc-badge ${snapshot()?.gatewayBridge.state === "connected" ? "is-green" : snapshot()?.gatewayBridge.state === "disconnected" ? "" : "is-amber"}`}
                    >
                      {snapshot()?.gatewayBridge.state === "connected"
                        ? `● connected · protocol v${snapshot()?.gatewayBridge.protocolVersion ?? 4}`
                        : `● ${snapshot()?.gatewayBridge.state ?? "disconnected"}`}
                    </span>
                  </div>
                  <Show when={snapshot()?.gatewayBridge.deviceId}>
                    {devId => (
                      <div style={{ color: "var(--oc-text-muted)", "font-family": "ui-monospace, monospace", "font-size": "11px" }}>
                        Device Identity: ed25519:{devId().slice(0, 16)}… (encrypted in EmDash settings)
                      </div>
                    )}
                  </Show>
                  <Show when={(snapshot()?.gatewayBridge.grantedScopes.length ?? 0) > 0}>
                    <div style={{ display: "flex", gap: "5px", "flex-wrap": "wrap" }}>
                      <For each={snapshot()?.gatewayBridge.grantedScopes ?? []}>
                        {scope => <span class="oc-badge">{scope}</span>}
                      </For>
                    </div>
                  </Show>
                  <Show when={snapshot()?.gatewayBridge.lastError}>
                    <div style={{ color: "var(--oc-accent-amber)", "font-size": "11.5px" }}>
                      {snapshot()?.gatewayBridge.lastError}
                    </div>
                  </Show>
                  <Show when={snapshot()?.settingsError}>
                    <div style={{ color: "var(--oc-accent-amber)", "font-size": "11.5px" }}>
                      {snapshot()?.settingsError}
                    </div>
                  </Show>
                </div>

                <label class="oc-field-label">
                  <span>Gateway WebSocket or Control UI URL (ws://127.0.0.1:18789 or wss://…)</span>
                  <input
                    type="text"
                    class="oc-edit-input"
                    placeholder={
                      snapshot()?.connection?.gatewayUrl &&
                      snapshot()?.connection?.gatewayUrl !== "https://agent-session.openclaw.local"
                        ? snapshot()?.connection?.gatewayUrl
                        : "ws://127.0.0.1:18789  (or paste openclaw dashboard URL)"
                    }
                    value={gwUrlInput()}
                    onInput={e => setGwUrlInput(e.currentTarget.value)}
                  />
                </label>
                <div class="oc-form-grid">
                  <label class="oc-field-label">
                    <span>Agent ID</span>
                    <input
                      type="text"
                      class="oc-edit-input"
                      value={gwAgentInput()}
                      onInput={e => setGwAgentInput(e.currentTarget.value)}
                    />
                  </label>
                  <label class="oc-field-label">
                    <span>Gateway / Bootstrap Token (never exposed to browser)</span>
                    <input
                      type="password"
                      class="oc-edit-input"
                      placeholder="Leave blank to keep stored token"
                      value={gwTokenInput()}
                      onInput={e => setGwTokenInput(e.currentTarget.value)}
                    />
                  </label>
                </div>

                <Show when={snapshot()?.isAdmin}>
                  <label
                    style={{
                      display: "flex",
                      "align-items": "flex-start",
                      gap: "8px",
                      "font-size": "12px",
                      color: "var(--oc-text-body)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={allowExecApprovalsInput()}
                      onChange={e => setAllowExecApprovalsInput(e.currentTarget.checked)}
                      style={{ "margin-top": "2px" }}
                    />
                    <span>
                      <strong>Allow inline Gateway execution approvals</strong> (Site Admin only;
                      requires Gateway <code>operator.approvals</code> scope — CMS draft permission
                      never grants execution authority automatically).
                    </span>
                  </label>
                </Show>

                <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                  <button
                    type="button"
                    class="oc-btn oc-btn-primary"
                    disabled={probingGateway() || !snapshot()?.isAdmin}
                    onClick={() => void handleSaveManualGateway()}
                  >
                    {probingGateway() ? "Connecting…" : "Save & Connect Gateway"}
                  </button>
                  <Show when={snapshot()?.connection?.transportMode === "gateway-ws"}>
                    <button
                      type="button"
                      class="oc-btn"
                      disabled={probingGateway() || !snapshot()?.isAdmin}
                      onClick={() => void handleProbeGateway()}
                    >
                      Test / Reconnect
                    </button>
                  </Show>
                  <Show when={snapshot()?.paired && snapshot()?.isAdmin}>
                    <button
                      type="button"
                      class="oc-btn"
                      disabled={probingGateway()}
                      onClick={() => void handleDisconnectGateway()}
                    >
                      Disconnect
                    </button>
                  </Show>
                </div>

                <div class="oc-overview-divider" />
                <h3>1-Step External Agent / MCP Pairing (Expiring 15m Code)</h3>
                <Show
                  when={snapshot()?.isAdmin}
                  fallback={
                    <div style={{ "font-size": "12px", color: "var(--oc-text-muted)", "line-height": "1.5" }}>
                      Site Administrator role is required to view or mint external agent pairing codes.
                    </div>
                  }
                >
                  <div style={{ "font-size": "12px", color: "var(--oc-text-muted)", "line-height": "1.5" }}>
                    Paste into RoboClaw, OpenClaw CLI, Codex, or Claude Code to mint a Bearer session
                    token for authenticated EmDash MCP inspection & proposal staging:
                  </div>
                  <div class="oc-code-copy">{snapshot()?.pairingCommand}</div>
                  <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                    <button type="button" class="oc-btn" onClick={() => void copyPairingCommand()}>
                      {copiedPairing() ? "✓ Copied curl command" : "Copy Pairing Command"}
                    </button>
                    <button
                      type="button"
                      class="oc-btn"
                      onClick={() =>
                        void callOpenClawChat({ action: "rotate_pairing_code" })
                          .then(s => setSnapshot(s))
                          .catch(err =>
                            setErrorBanner(
                              err instanceof Error ? err.message : "Could not rotate pairing code",
                            ),
                          )
                      }
                    >
                      Rotate Code ({snapshot()?.pairingCode})
                    </button>
                  </div>
                </Show>
              </Show>

              <Show when={activeSheet() === "customizations"}>
                <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                  <h3>Customizations — Collections & Authority</h3>
                  <button type="button" class="oc-btn" onClick={() => setActiveSheet(null)}>
                    Done
                  </button>
                </div>
                <div style={{ "font-size": "12.5px", color: "var(--oc-text-muted)" }}>
                  Choose which EmDash collections OpenClaw may read (`content:read`) and whether it may
                  stage revision-fenced draft proposals (`_rev`).
                </div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <For each={snapshot()?.collections ?? []}>
                    {col => {
                      const enabled = () =>
                        (
                          snapshot()?.connection?.enabledCollections ??
                          snapshot()?.collections.map(c => c.slug) ??
                          []
                        ).includes(col.slug);
                      return (
                        <button
                          type="button"
                          class="oc-overview-row"
                          style={{
                            border: "1px solid var(--oc-border-subtle)",
                            "border-radius": "8px",
                          }}
                          onClick={() => void handleToggleCollection(col.slug)}
                        >
                          <span>
                            <strong>{col.label}</strong>{" "}
                            <span style={{ color: "var(--oc-text-muted)" }}>({col.slug})</span>
                          </span>
                          <span class={`oc-badge ${enabled() ? "is-green" : ""}`}>
                            {enabled() ? "✓ Enabled" : "Disabled"}
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>

              <Show when={activeSheet() === "automations"}>
                <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                  <h3>Store Automations</h3>
                  <button type="button" class="oc-btn" onClick={() => setActiveSheet(null)}>
                    Done
                  </button>
                </div>
                <For each={snapshot()?.automations ?? []}>
                  {rule => (
                    <div
                      style={{
                        padding: "11px 12px",
                        "border-radius": "10px",
                        border: "1px solid var(--oc-border-subtle)",
                        display: "flex",
                        "flex-direction": "column",
                        gap: "6px",
                      }}
                    >
                      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                        <strong style={{ "font-size": "13px" }}>{rule.name}</strong>
                        <button
                          type="button"
                          class={`oc-btn ${rule.enabled ? "oc-btn-primary" : ""}`}
                          onClick={() =>
                            void callOpenClawChat({
                              action: "toggle_automation",
                              automationId: rule.automationId,
                            })
                              .then(s => setSnapshot(s))
                              .catch(err =>
                                setErrorBanner(
                                  err instanceof Error ? err.message : "Could not toggle automation",
                                ),
                              )
                          }
                        >
                          {rule.enabled ? "Enabled" : "Paused"}
                        </button>
                      </div>
                      <div style={{ "font-size": "12px", color: "var(--oc-text-muted)" }}>
                        {rule.description}
                      </div>
                      <div style={{ "font-size": "11px", color: "var(--oc-text-faint)" }}>
                        {rule.schedule} · target `{rule.collection}`
                      </div>
                    </div>
                  )}
                </For>
              </Show>

              <Show when={activeSheet() === "attach"}>
                <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                  <h3>Attach EmDash Entry to Context</h3>
                  <button type="button" class="oc-btn" onClick={() => setActiveSheet(null)}>
                    Cancel
                  </button>
                </div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                  <For each={snapshot()?.entriesPreview ?? []}>
                    {(entry: CatalogEntrySummary) => (
                      <button
                        type="button"
                        class="oc-overview-row"
                        style={{
                          border: "1px solid var(--oc-border-subtle)",
                          "border-radius": "8px",
                        }}
                        onClick={() => {
                          setAttachedEntry({
                            collection: entry.collection,
                            entryId: entry.id,
                            locale: entry.locale,
                            title: entry.title,
                            slug: entry.slug,
                          });
                          setActiveSheet(null);
                          textareaRef?.focus();
                        }}
                      >
                        <span>
                          <strong>{entry.title}</strong>{" "}
                          <span style={{ color: "var(--oc-text-muted)" }}>
                            ({entry.collection}/{entry.slug})
                          </span>
                        </span>
                        <span class="oc-badge">{entry.priceSummary ?? entry.status}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </section>

      {/* ZONE 3: COLLAPSIBLE RIGHT SIDEBAR (Antigravity Floating Overview Card) */}
      <Show when={!isEditorPanel()}>
        <aside class={`oc-right-sidebar ${rightOpen() ? "" : "is-collapsed"}`}>
          <div class="oc-overview-card">
            <div class="oc-overview-head">
              <span>Overview</span>
              <span>⋮</span>
            </div>

            {/* Review Proposals row with +X -Y diff counters */}
            <button
              type="button"
              class={`oc-overview-row ${selectedOverviewProposal() ? "is-active" : ""}`}
              onClick={() => {
                const first = pendingProposals()[0] ?? snapshot()?.proposals[0];
                if (first) focusProposalBothSurfaces(first.proposalId);
              }}
            >
              <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="2.5" y="2" width="9" height="11" rx="1.6" stroke="currentColor" stroke-width="1.3" />
                  <path d="M5.5 6H8.5M7 4.5V7.5M5.5 9.8H8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
                <span>Review Proposals</span>
              </span>
              <span style={{ "font-family": "ui-monospace, monospace", "font-size": "11.5px" }}>
                <span style={{ color: "var(--oc-accent-green)" }}>+{diffTotals().added}</span>{" "}
                <span style={{ color: "var(--oc-accent-red)" }}>-{diffTotals().removed}</span>
              </span>
            </button>

            {/* IN-PLACE OVERVIEW _REV DIFF DRILL-DOWN SHEET (`overview-proposal-drilldown-003`) */}
            <Show when={selectedOverviewProposal()}>
              {sel => (
                <div class="oc-overview-drilldown">
                  <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                    <strong style={{ "font-size": "12px" }}>{sel().entryTitle}</strong>
                    <span class="oc-badge">{shortenRev(sel().baseRev)}</span>
                  </div>
                  <For each={sel().diffs}>
                    {d => (
                      <div style={{ "font-family": "ui-monospace, monospace", "font-size": "11px" }}>
                        <div class="oc-diff-field-name">{d.label}</div>
                        <div class="oc-diff-minus">- {d.before}</div>
                        <div class="oc-diff-plus">+ {d.after}</div>
                      </div>
                    )}
                  </For>
                  <Show
                    when={
                      sel().status === "pending" ||
                      sel().status === "failed" ||
                      sel().status === "conflict" ||
                      needsProposalReconcile(sel())
                    }
                  >
                    <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }}>
                      <Show
                        when={needsProposalReconcile(sel())}
                        fallback={
                          <Show
                            when={sel().status === "conflict"}
                            fallback={
                              <Show
                                when={canProposalStageDraft(sel())}
                                fallback={
                                  <span class="oc-badge is-amber" style={{ flex: "1" }}>
                                    Collection lacks draft revisions
                                  </span>
                                }
                              >
                                <Show
                                  when={hasConcretePatch(sel())}
                                  fallback={
                                    <span class="oc-badge" style={{ flex: "1" }}>
                                      Summary-only · no concrete patch
                                    </span>
                                  }
                                >
                                  <button
                                    type="button"
                                    class="oc-btn oc-btn-primary"
                                    style={{ flex: "1", "justify-content": "center" }}
                                    disabled={applyingProposalId() === sel().proposalId}
                                    onClick={() => void handleApproveProposal(sel())}
                                  >
                                    {sel().status === "failed" ? "Retry Save" : "Approve & Save"}
                                  </button>
                                </Show>
                              </Show>
                            }
                          >
                            <button
                              type="button"
                              class="oc-btn oc-btn-primary"
                              style={{ flex: "1", "justify-content": "center" }}
                              disabled={applyingProposalId() === sel().proposalId}
                              onClick={() => void handleRebaseProposal(sel())}
                            >
                              Rebase _rev
                            </button>
                          </Show>
                        }
                      >
                        <button
                          type="button"
                          class="oc-btn oc-btn-primary"
                          style={{ flex: "1", "justify-content": "center" }}
                          disabled={applyingProposalId() === sel().proposalId}
                          onClick={() => void handleReconcileProposal(sel())}
                        >
                          Reconcile with EmDash
                        </button>
                      </Show>
                      <Show when={!needsProposalReconcile(sel())}>
                        <button
                          type="button"
                          class="oc-btn"
                          disabled={applyingProposalId() === sel().proposalId}
                          onClick={() => void handleRejectProposal(sel())}
                        >
                          Reject
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <button
              type="button"
              class="oc-overview-row"
              onClick={() => setActiveSheet("customizations")}
            >
              <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3.5 2.2H9.8L12.8 5.2V13.2C12.8 13.7 12.4 14 11.9 14H3.5C3 14 2.6 13.7 2.6 13.2V3C2.6 2.5 3 2.2 3.5 2.2Z" stroke="currentColor" stroke-width="1.3" />
                  <path d="M9.5 2.3V5.4H12.6" stroke="currentColor" stroke-width="1.3" />
                </svg>
                <span>Collections</span>
              </span>
              <span style={{ color: "var(--oc-text-muted)", "font-size": "11.5px" }}>
                {snapshot()?.connection?.enabledCollections.length ??
                  snapshot()?.collections.length ??
                  0}{" "}
                enabled
              </span>
            </button>

            <button
              type="button"
              class="oc-overview-row"
              onClick={() => setActiveSheet("pairing")}
            >
              <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="2.8" width="12" height="10.4" rx="2" stroke="currentColor" stroke-width="1.3" />
                  <path d="M5 6.4L7.1 8L5 9.6M8.3 9.8H11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>Gateway & MCP</span>
              </span>
              <span style={{ color: "var(--oc-accent-green)", "font-size": "11.5px" }}>
                ● {streamState() === "live" ? "SSE live" : streamState()}
              </span>
            </button>

            <button
              type="button"
              class="oc-overview-row"
              onClick={() => void handleToggleAuthority()}
            >
              <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M6.2 3.2C6.2 2.4 6.9 1.8 7.7 1.8C8.5 1.8 9.2 2.4 9.2 3.2V4H12C12.6 4 13 4.4 13 5V7.8H13.8C14.5 7.8 15 8.4 15 9.1C15 9.8 14.5 10.4 13.8 10.4H13V13C13 13.6 12.6 14 12 14H3.8C3.2 14 2.8 13.6 2.8 13V5C2.8 4.4 3.2 4 3.8 4H6.2V3.2Z" stroke="currentColor" stroke-width="1.25" />
                </svg>
                <span>Skills & Permissions</span>
              </span>
              <span style={{ color: "var(--oc-text-muted)", "font-size": "11.5px" }}>
                {snapshot()?.connection?.authorityMode === "read_only"
                  ? "Read-Only ›"
                  : "Propose ›"}
              </span>
            </button>

            <div class="oc-overview-divider" />

            <div class="oc-overview-subhead">
              <span>Background Runs</span>
              <span class="oc-count-pill">{anyConversationRunning() ? 1 : 0}</span>
            </div>
            <div style={{ padding: "2px 13px 8px", "font-size": "11.5px", color: "var(--oc-text-muted)" }}>
              {anyConversationRunning()
                ? "Active store inspection turn streaming…"
                : "Idle · all turns settled"}
            </div>

            <div class="oc-overview-divider" />

            <div class="oc-overview-subhead">
              <span>Gateway Approvals</span>
              <span class="oc-count-pill">{pendingExecApprovals().length}</span>
            </div>
            <div style={{ padding: "2px 13px 8px", "font-size": "11.5px", color: "var(--oc-text-muted)" }}>
              {pendingExecApprovals().length > 0
                ? `${pendingExecApprovals().length} pending (${snapshot()?.canResolveGatewayApprovals ? "Admin inline" : "Read-only handoff"})`
                : snapshot()?.canResolveGatewayApprovals
                  ? "0 pending · Admin inline enabled"
                  : "0 pending · Read-only handoff default"}
            </div>

            <div class="oc-overview-divider" />

            <div class="oc-overview-subhead">
              <span>Draft Proposals</span>
              <span class="oc-count-pill">{snapshot()?.proposals.length ?? 0}</span>
            </div>

            <Show
              when={(snapshot()?.proposals.length ?? 0) > 0}
              fallback={
                <div style={{ padding: "4px 13px 12px", "font-size": "11.5px", color: "var(--oc-text-faint)" }}>
                  No staged proposals yet.
                </div>
              }
            >
              <For each={(snapshot()?.proposals ?? []).slice(0, 6)}>
                {prop => (
                  <button
                    type="button"
                    class={`oc-overview-row ${selectedProposalId() === prop.proposalId ? "is-active" : ""}`}
                    onClick={() => focusProposalBothSurfaces(prop.proposalId)}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                        display: "flex",
                        "align-items": "center",
                        gap: "6px",
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <rect x="3" y="2" width="10" height="12" rx="1.6" stroke="currentColor" stroke-width="1.3" />
                        <path d="M5.5 6H10.5M5.5 9H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                      </svg>
                      <span>{prop.entryTitle}</span>
                    </span>
                    <span
                      class={`oc-badge ${prop.status === "applied" ? "is-green" : prop.status === "conflict" ? "is-amber" : "is-coral"}`}
                    >
                      {prop.status}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </aside>
      </Show>
    </div>
  );
}

const ELEMENT_TAG = "openclaw-emdash-chat";

export function registerOpenClawChatElement(): void {
  if (typeof window === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(ELEMENT_TAG)) return;

  class OpenClawEmdashChatElement extends HTMLElement {
    private disposeSolid?: () => void;
    private stateSignal = createSignal<OpenClawChatElementProps>({
      surface: "admin-page",
    });

    static get observedAttributes() {
      return ["surface", "collection", "entry-id", "locale", "entry-title", "emdash-nav-open"];
    }

    public onToggleEmdashNav?: () => void;

    connectedCallback() {
      if (this.disposeSolid) return;
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      shadow.innerHTML = "";
      const styleEl = document.createElement("style");
      styleEl.textContent = OPENCLAW_HARNESS_CSS;
      shadow.appendChild(styleEl);

      const mountPoint = document.createElement("div");
      mountPoint.style.width = "100%";
      mountPoint.style.height = "100%";
      shadow.appendChild(mountPoint);

      this.syncPropsFromAttributes();
      const [getProps] = this.stateSignal;
      this.disposeSolid = render(
        () => <OpenClawHarnessApp getHostProps={getProps} rootNode={shadow} />,
        mountPoint,
      );
    }

    attributeChangedCallback() {
      this.syncPropsFromAttributes();
    }

    public updateHostProps(partial: Partial<OpenClawChatElementProps>) {
      const [, setProps] = this.stateSignal;
      setProps(prev => ({
        ...prev,
        ...partial,
        onToggleEmdashNav: partial.onToggleEmdashNav ?? this.onToggleEmdashNav,
      }));
    }

    private syncPropsFromAttributes() {
      const [, setProps] = this.stateSignal;
      const surfaceAttr = this.getAttribute("surface");
      setProps(prev => ({
        ...prev,
        surface: surfaceAttr === "editor-panel" ? "editor-panel" : "admin-page",
        collection: this.getAttribute("collection") ?? undefined,
        entryId: this.getAttribute("entry-id") ?? undefined,
        locale: this.getAttribute("locale") ?? undefined,
        entryTitle: this.getAttribute("entry-title") ?? undefined,
        emdashNavOpen: this.getAttribute("emdash-nav-open") === "true",
        onToggleEmdashNav: this.onToggleEmdashNav,
      }));
    }

    disconnectedCallback() {
      this.disposeSolid?.();
      this.disposeSolid = undefined;
    }
  }

  customElements.define(ELEMENT_TAG, OpenClawEmdashChatElement);
}
