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
    draftRevisionId?: string | null;
    liveRevisionId?: string | null;
    data: Record<string, unknown>;
  };
  _rev: string;
}

function doesLiveEntryMatchProposalBase(
  proposal: RevisionProposal,
  live: LiveEmDashEntry,
): boolean {
  if (proposal.baseRev.startsWith("v") && typeof live.item.version === "number") {
    const liveSynthetic = `v${live.item.version}:${live.item.draftRevisionId ?? live.item.liveRevisionId ?? "head"}`;
    if (liveSynthetic !== proposal.baseRev) {
      return false;
    }
  }
  for (const d of proposal.diffs) {
    if (d.before === "(current saved content)") continue;
    const rawVal = live.item.data?.[d.field];
    const liveVal = typeof rawVal === "string" ? rawVal : "";
    const expectedVal = d.before === "(empty)" ? "" : d.before;
    if (liveVal !== expectedVal) {
      return false;
    }
  }
  return true;
}

export async function fetchLiveEntryWithRev(
  collection: string,
  entryId: string,
  locale?: string,
): Promise<LiveEmDashEntry> {
  const params = new URLSearchParams();
  if (locale) params.set("locale", locale);
  const querySuffix = params.toString() ? `?${params}` : "";
  const url = `${API_BASE}/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}${querySuffix}`;
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

  const entry = json.data;
  const itemRecord = entry.item as Record<string, unknown>;
  if (
    typeof entry.item.draftRevisionId === "string" &&
    entry.item.draftRevisionId.length > 0 &&
    entry.item.draftRevisionId !== entry.item.liveRevisionId &&
    !("liveData" in itemRecord)
  ) {
    const compareUrl = `${API_BASE}/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}/compare${querySuffix}`;
    const compareRes = await fetch(compareUrl, {
      method: "GET",
      credentials: "same-origin",
      headers: emdashHeaders(),
    });
    const compareJson = (await compareRes.json().catch(() => null)) as {
      success?: boolean;
      data?: {
        hasChanges?: boolean;
        draft?: Record<string, unknown> | null;
      };
      error?: { message?: string };
    } | null;
    if (!compareRes.ok || !compareJson?.success || !compareJson.data) {
      throw new Error(
        compareJson?.error?.message ??
          `Failed to read staged draft revision for ${collection}/${entryId}`,
      );
    }
    if (
      compareJson.data.hasChanges &&
      compareJson.data.draft &&
      typeof compareJson.data.draft === "object"
    ) {
      const cleanDraft: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(compareJson.data.draft)) {
        if (!k.startsWith("_")) {
          cleanDraft[k] = v;
        }
      }
      return {
        ...entry,
        item: {
          ...entry.item,
          data: {
            ...(entry.item.data ?? {}),
            ...cleanDraft,
          },
        },
      };
    }
  }

  return entry;
}

export async function fetchCollectionSupports(collection: string): Promise<string[]> {
  const res = await fetch(
    `${API_BASE}/schema/collections/${encodeURIComponent(collection)}`,
    {
      method: "GET",
      credentials: "same-origin",
      headers: emdashHeaders(),
    },
  );
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: {
      item?: { supports?: unknown };
      supports?: unknown;
    };
    error?: { message?: string };
  } | null;
  const rawSupports = json?.data?.item?.supports ?? json?.data?.supports;
  if (!res.ok || !json?.success || !Array.isArray(rawSupports)) {
    throw new Error(
      json?.error?.message ??
        `Failed to verify revision capability for collection "${collection}"`,
    );
  }
  return rawSupports.filter((s): s is string => typeof s === "string");
}

/**
 * Resolves and stamps opaque EmDash `_rev` tokens on newly created proposals
 * only after verifying the live entry still matches the pre-turn revision and fields.
 */
export async function ensureProposalBaseRevs(
  proposals: RevisionProposal[],
  conversationId: string,
): Promise<OpenClawWorkspaceSnapshot | null> {
  let latestSnapshot: OpenClawWorkspaceSnapshot | null = null;
  for (const prop of proposals) {
    if (prop.status !== "pending") continue;
    if (Object.keys(prop.proposedFields ?? {}).length === 0) continue;
    if (prop.baseRev && !prop.baseRev.startsWith("v") && prop.baseRev !== "pending-browser-rev") {
      continue;
    }
    try {
      const live = await fetchLiveEntryWithRev(prop.collection, prop.entryId, prop.locale);
      if (!doesLiveEntryMatchProposalBase(prop, live)) {
        latestSnapshot = await callOpenClawChat({
          action: "record_proposal_receipt",
          conversationId: prop.conversationId || conversationId,
          proposalId: prop.proposalId,
          status: "conflict",
          conflictRev: live._rev,
          errorMessage:
            "Entry changed before revision token was bound. Rebase or regenerate before saving.",
        });
        continue;
      }
      if (live._rev && live._rev !== prop.baseRev) {
        latestSnapshot = await callOpenClawChat({
          action: "stamp_proposal_rev",
          conversationId: prop.conversationId || conversationId,
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
    if (!nextProp) {
      throw new Error("Proposal revision was not created — refresh and inspect its current status.");
    }
    activeProposal = nextProp;
  }

  if (Object.keys(activeProposal.proposedFields ?? {}).length === 0) {
    throw new Error(
      "Summary-only external proposal has no concrete field patch. Edit & Approve on a bound entry or create a concrete draft proposal first.",
    );
  }

  const [live, supports] = await Promise.all([
    fetchLiveEntryWithRev(
      activeProposal.collection,
      activeProposal.entryId,
      activeProposal.locale,
    ),
    fetchCollectionSupports(activeProposal.collection),
  ]);

  const entryStatus = live.item.status ?? "published";
  const canStageDraft =
    supports.includes("revisions") ||
    (entryStatus === "draft" && supports.includes("drafts"));
  if (!canStageDraft) {
    return callOpenClawChat({
      action: "record_proposal_receipt",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      status: "failed",
      errorMessage: `Collection "${activeProposal.collection}" does not support staging drafts for ${entryStatus} entries — saving would modify live content immediately.`,
    });
  }

  const hasOpaqueRev =
    Boolean(activeProposal.baseRev) &&
    !activeProposal.baseRev.startsWith("v") &&
    activeProposal.baseRev !== "pending-browser-rev";

  if (!hasOpaqueRev) {
    if (!doesLiveEntryMatchProposalBase(activeProposal, live)) {
      return callOpenClawChat({
        action: "record_proposal_receipt",
        conversationId: activeProposal.conversationId,
        proposalId: activeProposal.proposalId,
        status: "conflict",
        conflictRev: live._rev,
        errorMessage: "Entry was modified by another save since this proposal was created.",
      });
    }
    const stampedSnap = await callOpenClawChat({
      action: "stamp_proposal_rev",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      baseRev: live._rev,
    });
    const stampedProp = stampedSnap.proposals.find(
      p => p.proposalId === activeProposal.proposalId,
    );
    if (stampedProp?.status === "conflict") {
      return stampedSnap;
    }
  }

  const expectedRev = hasOpaqueRev ? activeProposal.baseRev : live._rev;

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

  // Server-side pre-apply fence: ensures stale tabs cannot apply rejected/superseded/applied proposals
  // and marks the proposal `applying` before dispatching the CMS write.
  const preflight = (await callOpenClawChat({
    action: "begin_apply_proposal",
    conversationId: activeProposal.conversationId,
    proposalId: activeProposal.proposalId,
    expectedRev,
  })) as OpenClawWorkspaceSnapshot & { applyReady?: boolean };
  if (preflight.applyReady === false) {
    return preflight;
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

  try {
    return await callOpenClawChat({
      action: "record_proposal_receipt",
      conversationId: activeProposal.conversationId,
      proposalId: activeProposal.proposalId,
      status: "applied",
      appliedRev: putJson.data._rev ?? expectedRev,
    });
  } catch {
    return await reconcileUnknownProposal(activeProposal);
  }
}

export async function reconcileUnknownProposal(
  proposal: RevisionProposal,
): Promise<OpenClawWorkspaceSnapshot> {
  let clientVerifiedMatch: boolean | undefined;
  let observedRev: string | undefined;
  const fieldEntries = Object.entries(proposal.proposedFields ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (fieldEntries.length > 0 && proposal.entryId !== "current") {
    try {
      const live = await fetchLiveEntryWithRev(
        proposal.collection,
        proposal.entryId,
        proposal.locale,
      );
      observedRev = live._rev;
      clientVerifiedMatch = fieldEntries.every(([k, v]) => live.item.data?.[k] === v);
    } catch {
      // Fall back to server-side reconciliation if browser read fails.
    }
  }
  return callOpenClawChat({
    action: "reconcile_proposal",
    conversationId: proposal.conversationId,
    proposalId: proposal.proposalId,
    ...(clientVerifiedMatch !== undefined ? { clientVerifiedMatch } : {}),
    ...(observedRev ? { observedRev } : {}),
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
    action: "rebase_proposal",
    conversationId: proposal.conversationId,
    proposalId: proposal.proposalId,
    baseRev: live._rev,
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
  onReconnect?: () => void;
}): () => void {
  let stopped = false;
  let hasConnectedOnce = false;
  let activeController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const start = async (attempt: number) => {
    if (stopped) return;
    activeController = new AbortController();
    let established = false;
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

      established = true;
      const isReconnect = hasConnectedOnce || attempt > 0;
      hasConnectedOnce = true;
      options.onStatus("live");
      if (isReconnect) {
        options.onReconnect?.();
      }
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
      const nextAttempt = established ? 1 : attempt + 1;
      const delay = Math.min(8_000, 800 * Math.pow(1.6, established ? 0 : attempt));
      retryTimer = setTimeout(() => void start(nextAttempt), delay);
    }
  };

  void start(0);

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    activeController?.abort();
  };
}
