import type {
  OpenClawStreamEvent,
  OpenClawWorkspaceSnapshot,
  RevisionProposal,
} from "../protocol.js";

const API_BASE = "/_emdash/api";

function emdashHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("X-EmDash-Request", "1");
  return headers;
}

export async function callOpenClawChat(
  payload: Record<string, unknown>,
): Promise<OpenClawWorkspaceSnapshot> {
  const res = await fetch(`${API_BASE}/plugins/dinkus-openclaw/chat`, {
    method: "POST",
    credentials: "same-origin",
    headers: emdashHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: OpenClawWorkspaceSnapshot & { ok?: boolean; message?: string };
    error?: { message?: string };
  } | null;

  if (!res.ok || !json?.success || !json.data) {
    throw new Error(json?.error?.message ?? `OpenClaw route error (HTTP ${res.status})`);
  }
  if ((json.data as { ok?: boolean }).ok === false) {
    throw new Error((json.data as { message?: string }).message ?? "OpenClaw request refused");
  }
  return json.data;
}

export interface LiveEmDashEntry {
  item: {
    id: string;
    slug?: string;
    status?: string;
    locale?: string;
    version?: number;
    data: Record<string, unknown>;
  };
  _rev: string;
}

export async function fetchLiveEntryWithRev(
  collection: string,
  entryId: string,
  locale?: string,
): Promise<LiveEmDashEntry> {
  const params = new URLSearchParams();
  if (locale) params.set("locale", locale);
  const url = `${API_BASE}/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "same-origin",
    headers: emdashHeaders(),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: LiveEmDashEntry;
    error?: { message?: string };
  } | null;
  if (!res.ok || !json?.success || !json.data) {
    throw new Error(json?.error?.message ?? `Failed to read ${collection}/${entryId}`);
  }
  return json.data;
}

/**
 * Resolves and stamps opaque EmDash `_rev` tokens on newly created proposals
 * so optimistic concurrency compares against the exact revision the reviewer saw.
 */
export async function ensureProposalBaseRevs(
  proposals: RevisionProposal[],
  conversationId: string,
): Promise<OpenClawWorkspaceSnapshot | null> {
  let latestSnapshot: OpenClawWorkspaceSnapshot | null = null;
  for (const prop of proposals) {
    if (prop.status !== "pending") continue;
    if (prop.baseRev && !prop.baseRev.startsWith("v") && prop.baseRev !== "pending-browser-rev") {
      continue;
    }
    try {
      const live = await fetchLiveEntryWithRev(prop.collection, prop.entryId, prop.locale);
      if (live._rev && live._rev !== prop.baseRev) {
        latestSnapshot = await callOpenClawChat({
          action: "stamp_proposal_rev",
          conversationId,
          proposalId: prop.proposalId,
          baseRev: live._rev,
        });
      }
    } catch {
      // Non-fatal; will check again on apply.
    }
  }
  return latestSnapshot;
}

/**
 * Revision-guarded CMS mutation (`Pending -> Applying -> Applied | Conflict | OutcomeUnknown | Failed`).
 * When `editedFields` is supplied ("Edit & Approve"), mints an immutable `revisionNumber + 1`
 * proposal first (`revise_proposal`) and marks the prior revision `superseded` before saving.
 */
export async function applyRevisionProposal(
  proposal: RevisionProposal,
  editedFields?: Record<string, string>,
): Promise<OpenClawWorkspaceSnapshot> {
  let activeProposal = proposal;

  if (editedFields && Object.keys(editedFields).length > 0) {
    const revisedSnap = (await callOpenClawChat({
      action: "revise_proposal",
      conversationId: proposal.conversationId,
      proposalId: proposal.proposalId,
      proposedFields: editedFields,
    })) as OpenClawWorkspaceSnapshot & { revisedProposalId?: string };

    const nextProp = revisedSnap.revisedProposalId
      ? revisedSnap.proposals.find(p => p.proposalId === revisedSnap.revisedProposalId)
      : revisedSnap.proposals.find(p => p.supersedesProposalId === proposal.proposalId);
    if (nextProp) {
      activeProposal = nextProp;
    }
  }

  const live = await fetchLiveEntryWithRev(
    activeProposal.collection,
    activeProposal.entryId,
    activeProposal.locale,
  );

  const expectedRev =
    activeProposal.baseRev &&
    !activeProposal.baseRev.startsWith("v") &&
    activeProposal.baseRev !== "pending-browser-rev"
      ? activeProposal.baseRev
      : live._rev;

  // Detect concurrent edit before even sending PUT if expectedRev already diverged!
  if (expectedRev !== live._rev) {
    return callOpenClawChat({
      action: "record_proposal_receipt",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      status: "conflict",
      conflictRev: live._rev,
      errorMessage: "Entry was modified by another save since this proposal was created.",
    });
  }

  const mergedData: Record<string, unknown> = {
    ...(live.item.data ?? {}),
    ...activeProposal.proposedFields,
  };

  const params = new URLSearchParams();
  if (activeProposal.locale) params.set("locale", activeProposal.locale);
  const putUrl = `${API_BASE}/content/${encodeURIComponent(activeProposal.collection)}/${encodeURIComponent(activeProposal.entryId)}${params.toString() ? `?${params}` : ""}`;

  let putRes: Response;
  try {
    putRes = await fetch(putUrl, {
      method: "PUT",
      credentials: "same-origin",
      headers: emdashHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        data: mergedData,
        _rev: expectedRev,
      }),
    });
  } catch {
    // Uncertain outcome after dispatch: never encourage blind duplicate writes; reconcile against stored CMS entry.
    return callOpenClawChat({
      action: "record_proposal_receipt",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      status: "outcome_unknown",
      errorMessage:
        "Network interrupted before EmDash acknowledged the save. Click Reconcile with EmDash to verify stored content.",
    });
  }

  const putJson = (await putRes.json().catch(() => null)) as {
    success?: boolean;
    data?: { item?: Record<string, unknown>; _rev?: string };
    error?: { code?: string; message?: string };
  } | null;

  if (putRes.status === 409 || putJson?.error?.code === "CONFLICT") {
    const fresh = await fetchLiveEntryWithRev(
      activeProposal.collection,
      activeProposal.entryId,
      activeProposal.locale,
    ).catch(() => null);
    return callOpenClawChat({
      action: "record_proposal_receipt",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      status: "conflict",
      conflictRev: fresh?._rev,
      errorMessage:
        putJson?.error?.message ?? "Revision conflict — entry changed before approval.",
    });
  }

  if (!putRes.ok || !putJson?.success || !putJson.data) {
    return callOpenClawChat({
      action: "record_proposal_receipt",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      status: "failed",
      errorMessage: putJson?.error?.message ?? `Save rejected (HTTP ${putRes.status})`,
    });
  }

  return callOpenClawChat({
    action: "record_proposal_receipt",
    conversationId: activeProposal.conversationId,
    proposalId: activeProposal.proposalId,
    status: "applied",
    appliedRev: putJson.data._rev ?? expectedRev,
  });
}

export async function reconcileUnknownProposal(
  proposal: RevisionProposal,
): Promise<OpenClawWorkspaceSnapshot> {
  return callOpenClawChat({
    action: "reconcile_proposal",
    conversationId: proposal.conversationId,
    proposalId: proposal.proposalId,
  });
}

export async function rebaseConflictedProposal(
  proposal: RevisionProposal,
): Promise<OpenClawWorkspaceSnapshot> {
  const live = await fetchLiveEntryWithRev(
    proposal.collection,
    proposal.entryId,
    proposal.locale,
  );
  return callOpenClawChat({
    action: "record_proposal_receipt",
    conversationId: proposal.conversationId,
    proposalId: proposal.proposalId,
    status: "pending",
    baseRev: live._rev,
    errorMessage: "",
  });
}

/**
 * Connects to the host SSE bridge (`/_emdash/api/openclaw/stream`) using
 * fetch-based streaming so cookies/headers stay first-party.
 */
export function connectOpenClawEventStream(options: {
  endpoint: string;
  onEvent: (event: OpenClawStreamEvent) => void;
  onStatus: (status: "live" | "reconnecting" | "buffered") => void;
}): () => void {
  let stopped = false;
  let activeController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const start = async (attempt: number) => {
    if (stopped) return;
    activeController = new AbortController();
    try {
      const res = await fetch(options.endpoint, {
        method: "GET",
        credentials: "same-origin",
        headers: emdashHeaders({ Accept: "text/event-stream" }),
        signal: activeController.signal,
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !res.body || !contentType.includes("text/event-stream")) {
        options.onStatus("buffered");
        return;
      }

      options.onStatus("live");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const dataLine = rawEvent
            .split("\n")
            .find(line => line.startsWith("data:"));
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine.slice(5).trim()) as OpenClawStreamEvent;
              options.onEvent(parsed);
            } catch {
              // ignore malformed frame
            }
          }
        }
      }
    } catch {
      if (stopped) return;
    }

    if (!stopped) {
      options.onStatus("reconnecting");
      const delay = Math.min(8_000, 800 * Math.pow(1.6, attempt));
      retryTimer = setTimeout(() => void start(attempt + 1), delay);
    }
  };

  void start(0);

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    activeController?.abort();
  };
}
