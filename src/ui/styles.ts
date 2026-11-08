export const OPENCLAW_HARNESS_CSS = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  container-type: inline-size;
  container-name: oc-harness;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.oc-root {
  --oc-bg-stage: #282a36;
  --oc-bg-left: #232530;
  --oc-bg-card: #333440;
  --oc-bg-card-hover: #3a3c4a;
  --oc-bg-composer-outer: #2c2e3b;
  --oc-bg-composer-inner: #353642;
  --oc-bg-user-bubble: #343746;
  --oc-bg-pill-active: #323442;
  --oc-bg-code: rgba(0, 0, 0, 0.24);
  --oc-border-subtle: rgba(255, 255, 255, 0.065);
  --oc-border-strong: rgba(255, 255, 255, 0.12);
  --oc-text-main: #f3f4f8;
  --oc-text-body: #e1e3ec;
  --oc-text-muted: #989cb0;
  --oc-text-faint: #6c7086;
  --oc-accent-coral: #ff6464;
  --oc-accent-coral-soft: rgba(255, 100, 100, 0.12);
  --oc-accent-purple: #a78bfa;
  --oc-accent-green: #4ade80;
  --oc-accent-red: #f87171;
  --oc-accent-amber: #fbbf24;
  --oc-btn-primary-bg: #f3f4f8;
  --oc-btn-primary-fg: #1b1d26;
  --oc-shadow-float: 0 12px 34px rgba(0, 0, 0, 0.28);

  display: flex;
  width: 100%;
  height: 100%;
  min-height: 540px;
  background: var(--oc-bg-stage);
  color: var(--oc-text-main);
  overflow: hidden;
  position: relative;
}

.oc-root[data-theme="light"] {
  --oc-bg-stage: #f7f6f3;
  --oc-bg-left: #f0eee9;
  --oc-bg-card: #ffffff;
  --oc-bg-card-hover: #f3f1ec;
  --oc-bg-composer-outer: #eceae4;
  --oc-bg-composer-inner: #ffffff;
  --oc-bg-user-bubble: #eae7e0;
  --oc-bg-pill-active: #e4e1d9;
  --oc-bg-code: rgba(20, 20, 25, 0.055);
  --oc-border-subtle: rgba(20, 20, 25, 0.085);
  --oc-border-strong: rgba(20, 20, 25, 0.16);
  --oc-text-main: #18191e;
  --oc-text-body: #2c2e38;
  --oc-text-muted: #64687a;
  --oc-text-faint: #8c90a2;
  --oc-accent-coral: #bd4531;
  --oc-accent-coral-soft: rgba(189, 69, 49, 0.09);
  --oc-accent-purple: #7c3aed;
  --oc-accent-green: #16a34a;
  --oc-accent-red: #dc2626;
  --oc-accent-amber: #d97706;
  --oc-btn-primary-bg: #18191e;
  --oc-btn-primary-fg: #ffffff;
  --oc-shadow-float: 0 10px 28px rgba(20, 20, 25, 0.08);
}

.oc-root[data-surface="editor-panel"] {
  min-height: 460px;
  height: 520px;
  border-radius: 12px;
  border: 1px solid var(--oc-border-strong);
}

/* LEFT SIDEBAR */
.oc-left-sidebar {
  width: 248px;
  flex-shrink: 0;
  background: var(--oc-bg-left);
  border-right: 1px solid var(--oc-border-subtle);
  display: flex;
  flex-direction: column;
  padding: 12px 10px 10px;
  user-select: none;
  transition: width 160ms ease, padding 160ms ease, opacity 140ms ease;
  overflow: hidden;
}

.oc-left-sidebar.is-collapsed {
  width: 0;
  padding-left: 0;
  padding-right: 0;
  border-right: none;
  opacity: 0;
  pointer-events: none;
}

.oc-left-sidebar-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.oc-left-sidebar-head .oc-new-conv-btn {
  flex: 1;
  min-width: 0;
}

.oc-sidebar-close-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 12px;
  flex-shrink: 0;
}

.oc-narrow-only {
  display: none;
}

.oc-sidebar-backdrop {
  display: none;
}

.oc-new-conv-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--oc-border-strong);
  background: rgba(255, 255, 255, 0.02);
  color: var(--oc-text-main);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.oc-new-conv-btn:hover {
  background: var(--oc-bg-pill-active);
}

.oc-nav-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.oc-nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--oc-text-body);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.oc-nav-item:hover,
.oc-nav-item.is-active {
  background: var(--oc-bg-pill-active);
  color: var(--oc-text-main);
}

.oc-nav-item-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.oc-section-heading {
  margin: 14px 8px 5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 500;
  color: var(--oc-text-faint);
  letter-spacing: 0.01em;
}

.oc-threads-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.oc-folder-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 3px;
  font-size: 11.5px;
  color: var(--oc-text-muted);
  font-weight: 500;
}

.oc-thread-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 9px 6px 18px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--oc-text-muted);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.oc-thread-btn:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--oc-text-body);
}

.oc-thread-btn.is-active {
  background: var(--oc-bg-pill-active);
  border-color: var(--oc-border-subtle);
  color: var(--oc-text-main);
  font-weight: 500;
}

.oc-thread-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.oc-thread-meta {
  font-size: 10.5px;
  color: var(--oc-text-faint);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}

.oc-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--oc-accent-purple);
  box-shadow: 0 0 8px var(--oc-accent-purple);
  animation: oc-pulse 1.5s ease-in-out infinite;
}

@keyframes oc-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.86); }
}

.oc-left-footer {
  padding-top: 8px;
  border-top: 1px solid var(--oc-border-subtle);
}

/* CENTER STAGE */
.oc-stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--oc-bg-stage);
}

.oc-topbar {
  min-height: 44px;
  padding: 6px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 10px;
  border-bottom: 1px solid var(--oc-border-subtle);
  flex-shrink: 0;
}

.oc-topbar-group {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.oc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 27px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--oc-text-muted);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}

.oc-icon-btn:hover,
.oc-icon-btn.is-active {
  background: var(--oc-bg-pill-active);
  border-color: var(--oc-border-subtle);
  color: var(--oc-text-main);
}

.oc-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--oc-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.oc-breadcrumb strong {
  color: var(--oc-text-main);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}

.oc-pill-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--oc-border-strong);
  background: rgba(255, 255, 255, 0.025);
  color: var(--oc-text-body);
  font-size: 11.5px;
  text-decoration: none;
  cursor: pointer;
}

.oc-pill-link:hover {
  background: var(--oc-bg-pill-active);
  color: var(--oc-text-main);
}

.oc-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--oc-text-muted);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--oc-border-subtle);
}

.oc-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--oc-accent-green);
}

.oc-status-dot.is-warn {
  background: var(--oc-accent-amber);
}

/* TURN NAVIGATION MINIMAP DOTS (Antigravity left gutter) */
.oc-turn-minimap {
  position: absolute;
  left: 11px;
  top: 56px;
  bottom: 132px;
  width: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  z-index: 6;
  pointer-events: auto;
}

.oc-turn-dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border-radius: 999px;
  border: none;
  background: rgba(152, 156, 176, 0.32);
  cursor: pointer;
  transition: transform 130ms ease, background 130ms ease, box-shadow 130ms ease;
}

.oc-turn-dot:hover {
  transform: scale(1.45);
  background: var(--oc-text-muted);
}

.oc-turn-dot.is-active {
  width: 7px;
  height: 7px;
  background: var(--oc-text-main);
  box-shadow: 0 0 8px rgba(243, 244, 248, 0.65);
}

/* TRANSCRIPT */
.oc-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 34px 18px 38px;
  scroll-behavior: smooth;
}

.oc-root[data-surface="editor-panel"] .oc-transcript {
  padding: 14px 14px 12px 26px;
}

.oc-transcript-inner {
  max-width: 748px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.oc-empty-hero {
  margin: 28px auto 12px;
  max-width: 580px;
  padding: 20px 22px;
  border-radius: 14px;
  background: var(--oc-bg-card);
  border: 1px solid var(--oc-border-subtle);
}

.oc-empty-hero h2 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--oc-text-main);
}

.oc-empty-hero p {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--oc-text-muted);
}

.oc-starter-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.oc-starter-chip {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--oc-border-strong);
  background: var(--oc-bg-composer-outer);
  color: var(--oc-text-body);
  font-size: 12px;
  cursor: pointer;
}

.oc-starter-chip:hover {
  background: var(--oc-bg-pill-active);
  color: var(--oc-text-main);
}

.oc-user-row {
  display: flex;
  justify-content: flex-end;
}

.oc-user-bubble {
  max-width: 82%;
  padding: 9px 14px;
  border-radius: 15px 15px 4px 15px;
  background: var(--oc-bg-user-bubble);
  border: 1px solid var(--oc-border-subtle);
  color: var(--oc-text-main);
  font-size: 13.8px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.oc-assistant-turn {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* COMPACT EXPANDABLE TOOL ROWS */
.oc-tool-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.oc-tool-row {
  border-radius: 8px;
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}

.oc-tool-row.is-open {
  background: rgba(0, 0, 0, 0.14);
  border-color: var(--oc-border-subtle);
}

.oc-tool-summary {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: transparent;
  border: none;
  color: var(--oc-text-muted);
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  text-align: left;
  cursor: pointer;
}

.oc-tool-summary:hover {
  color: var(--oc-text-main);
}

.oc-tool-Summary-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--oc-text-faint);
}

.oc-tool-payload {
  margin: 0 8px 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--oc-bg-code);
  color: var(--oc-text-body);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  overflow-x: auto;
  max-height: 190px;
  overflow-y: auto;
}

/* BORDERLESS ASSISTANT PROSE */
.oc-prose {
  font-size: 14.3px;
  line-height: 1.65;
  color: var(--oc-text-body);
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.oc-prose h3 {
  margin: 4px 0 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--oc-text-main);
}

.oc-prose p {
  margin: 0;
}

.oc-prose ul {
  margin: 0;
  padding-left: 19px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.oc-prose code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--oc-bg-code);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12.2px;
  color: var(--oc-text-main);
}

/* OPENCLAW REVISION-GUARDED PROPOSAL CARD */
.oc-proposal-card {
  border-radius: 11px;
  background: var(--oc-bg-card);
  border: 1px solid var(--oc-border-strong);
  border-left: 3px solid var(--oc-accent-coral);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: box-shadow 220ms ease, transform 180ms ease;
}

.oc-proposal-card.is-highlighted {
  box-shadow: 0 0 0 2px var(--oc-accent-coral), var(--oc-shadow-float);
}

.oc-proposal-card[data-status="applied"] {
  border-left-color: var(--oc-accent-green);
}

.oc-proposal-card[data-status="conflict"],
.oc-proposal-card[data-status="outcome_unknown"] {
  border-left-color: var(--oc-accent-amber);
}

.oc-proposal-card[data-status="superseded"] {
  opacity: 0.65;
  border-left-color: var(--oc-text-faint);
}

/* DUAL-AUTHORITY GATEWAY EXECUTION APPROVAL CARD */
.oc-exec-approval-card {
  border-radius: 11px;
  background: var(--oc-bg-card);
  border: 1px solid var(--oc-border-strong);
  border-left: 3px solid var(--oc-accent-purple);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.oc-exec-approval-card[data-status="allowed"] {
  border-left-color: var(--oc-accent-green);
}

.oc-exec-approval-card[data-status="denied"],
.oc-exec-approval-card[data-status="expired"] {
  border-left-color: var(--oc-text-faint);
}

.oc-badge.is-purple {
  background: rgba(167, 139, 250, 0.16);
  color: var(--oc-accent-purple);
}

.oc-gw-status-card {
  border-radius: 10px;
  background: var(--oc-bg-code);
  border: 1px solid var(--oc-border-subtle);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
}

.oc-readonly-notice {
  border-radius: 8px;
  background: rgba(167, 139, 250, 0.09);
  border: 1px solid rgba(167, 139, 250, 0.24);
  padding: 8px 10px;
  font-size: 11.8px;
  line-height: 1.45;
  color: var(--oc-text-body);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.oc-proposal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.oc-proposal-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.8px;
  font-weight: 600;
  color: var(--oc-text-main);
}

.oc-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background: var(--oc-bg-code);
  color: var(--oc-text-muted);
}

.oc-badge.is-coral {
  background: var(--oc-accent-coral-soft);
  color: var(--oc-accent-coral);
}

.oc-badge.is-green {
  background: rgba(74, 222, 128, 0.14);
  color: var(--oc-accent-green);
}

.oc-badge.is-amber {
  background: rgba(251, 191, 36, 0.15);
  color: var(--oc-accent-amber);
}

.oc-diff-box {
  border-radius: 8px;
  background: var(--oc-bg-code);
  border: 1px solid var(--oc-border-subtle);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
}

.oc-diff-field-name {
  font-size: 10.5px;
  color: var(--oc-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.oc-diff-minus {
  color: var(--oc-accent-red);
  white-space: pre-wrap;
  word-break: break-word;
}

.oc-diff-plus {
  color: var(--oc-accent-green);
  white-space: pre-wrap;
  word-break: break-word;
}

.oc-edit-input {
  width: 100%;
  margin-top: 4px;
  padding: 7px 9px;
  border-radius: 6px;
  border: 1px solid var(--oc-border-strong);
  background: var(--oc-bg-composer-inner);
  color: var(--oc-text-main);
  font-size: 12.5px;
  font-family: inherit;
}

.oc-proposal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.oc-btn {
  height: 29px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1px solid var(--oc-border-strong);
  background: rgba(255, 255, 255, 0.03);
  color: var(--oc-text-main);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.oc-btn:hover:not(:disabled) {
  background: var(--oc-bg-card-hover);
}

.oc-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.oc-btn-primary {
  background: var(--oc-btn-primary-bg);
  color: var(--oc-btn-primary-fg);
  border-color: transparent;
}

.oc-btn-primary:hover:not(:disabled) {
  opacity: 0.92;
  background: var(--oc-btn-primary-bg);
}

/* ANTIGRAVITY DOUBLE-RIM FLOATING COMPOSER */
.oc-composer-wrap {
  padding: 6px 24px 14px;
  flex-shrink: 0;
}

.oc-root[data-surface="editor-panel"] .oc-composer-wrap {
  padding: 6px 10px 10px;
}

.oc-composer-bezel {
  max-width: 756px;
  margin: 0 auto;
  padding: 5px;
  border-radius: 22px;
  background: var(--oc-bg-composer-outer);
  border: 1px solid var(--oc-border-strong);
  box-shadow: var(--oc-shadow-float);
  position: relative;
}

.oc-composer-core {
  border-radius: 17px;
  background: var(--oc-bg-composer-inner);
  border: 1px solid var(--oc-border-subtle);
  padding: 8px 11px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.oc-chip-tray {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.oc-context-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--oc-border-subtle);
  color: var(--oc-text-body);
  font-size: 11.5px;
}

.oc-context-chip button {
  background: none;
  border: none;
  color: var(--oc-text-muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
}

.oc-composer-textarea {
  width: 100%;
  min-height: 38px;
  max-height: 150px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--oc-text-main);
  font-size: 13.8px;
  line-height: 1.5;
  font-family: inherit;
}

.oc-composer-textarea::placeholder {
  color: var(--oc-text-faint);
}

.oc-composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.oc-composer-left-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.oc-model-selector {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--oc-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.oc-model-selector:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--oc-text-main);
}

.oc-send-circle {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: none;
  background: var(--oc-btn-primary-bg);
  color: var(--oc-btn-primary-fg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 110ms ease, opacity 110ms ease;
}

.oc-send-circle:disabled {
  opacity: 0.35;
  cursor: default;
}

.oc-send-circle:hover:not(:disabled) {
  transform: scale(1.04);
}

.oc-slash-menu {
  position: absolute;
  left: 12px;
  bottom: calc(100% + 6px);
  width: min(310px, calc(100% - 24px));
  border-radius: 11px;
  background: var(--oc-bg-card);
  border: 1px solid var(--oc-border-strong);
  box-shadow: var(--oc-shadow-float);
  padding: 5px;
  z-index: 20;
}

.oc-slash-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--oc-text-body);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.oc-slash-item:hover {
  background: var(--oc-bg-card-hover);
  color: var(--oc-text-main);
}

/* RIGHT SIDEBAR (Antigravity Floating Overview Card) */
.oc-right-sidebar {
  width: 304px;
  flex-shrink: 0;
  padding: 12px 12px 12px 4px;
  background: var(--oc-bg-stage);
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  transition: width 160ms ease, padding 160ms ease, opacity 140ms ease;
}

.oc-right-sidebar.is-collapsed {
  width: 0;
  padding: 0;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
}

.oc-overview-card {
  border-radius: 13px;
  background: var(--oc-bg-card);
  border: 1px solid var(--oc-border-subtle);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.oc-overview-head {
  padding: 10px 13px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--oc-text-muted);
}

.oc-overview-row {
  width: 100%;
  padding: 8px 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: none;
  background: transparent;
  color: var(--oc-text-body);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.oc-overview-row:hover,
.oc-overview-row.is-active {
  background: var(--oc-bg-card-hover);
  color: var(--oc-text-main);
}

.oc-overview-divider {
  height: 1px;
  background: var(--oc-border-subtle);
  margin: 4px 0;
}

.oc-overview-subhead {
  padding: 7px 13px 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--oc-text-muted);
  font-weight: 500;
}

.oc-count-pill {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--oc-text-body);
  font-size: 10.5px;
}

.oc-overview-drilldown {
  margin: 4px 10px 10px;
  padding: 10px;
  border-radius: 9px;
  background: var(--oc-bg-code);
  border: 1px solid var(--oc-border-strong);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* DRAWER / SHEET OVERLAY FOR AUTOMATIONS, CUSTOMIZATIONS, PAIRING */
.oc-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(10, 11, 16, 0.55);
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.oc-sheet {
  width: 100%;
  max-width: 560px;
  max-height: 85%;
  overflow-y: auto;
  border-radius: 14px;
  background: var(--oc-bg-card);
  border: 1px solid var(--oc-border-strong);
  box-shadow: var(--oc-shadow-float);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.oc-sheet h3 {
  margin: 0;
  font-size: 15px;
  color: var(--oc-text-main);
}

.oc-code-copy {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--oc-bg-code);
  border: 1px solid var(--oc-border-subtle);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.2px;
  color: var(--oc-text-body);
  word-break: break-all;
  white-space: pre-wrap;
}

.oc-field-label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--oc-text-muted);
}

.oc-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.oc-proposal-card[data-status="applying"] {
  border-left-color: var(--oc-accent-amber);
}

.oc-proposal-card[data-status="failed"] {
  border-left-color: var(--oc-accent-red);
}

@container oc-harness (max-width: 960px) {
  .oc-narrow-only {
    display: inline-flex;
  }

  .oc-sidebar-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 22;
    background: rgba(0, 0, 0, 0.36);
    cursor: pointer;
  }

  .oc-left-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 24;
    width: min(268px, 84%);
    box-shadow: var(--oc-shadow-float);
  }

  .oc-left-sidebar.is-collapsed {
    width: 0;
    padding-left: 0;
    padding-right: 0;
    border-right: none;
    box-shadow: none;
  }

  .oc-right-sidebar {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 24;
    width: min(312px, 88%);
    padding: 12px;
    border-left: 1px solid var(--oc-border-strong);
    box-shadow: var(--oc-shadow-float);
  }

  .oc-right-sidebar.is-collapsed {
    width: 0;
    padding: 0;
    border-left: none;
    box-shadow: none;
  }
}

@media (max-width: 960px) {
  .oc-narrow-only {
    display: inline-flex;
  }

  .oc-sidebar-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 22;
    background: rgba(0, 0, 0, 0.36);
    cursor: pointer;
  }

  .oc-left-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 24;
    width: min(268px, 84%);
    box-shadow: var(--oc-shadow-float);
  }

  .oc-left-sidebar.is-collapsed {
    width: 0;
    padding-left: 0;
    padding-right: 0;
    border-right: none;
    box-shadow: none;
  }

  .oc-right-sidebar {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 24;
    width: min(312px, 88%);
    padding: 12px;
    border-left: 1px solid var(--oc-border-strong);
    box-shadow: var(--oc-shadow-float);
  }

  .oc-right-sidebar.is-collapsed {
    width: 0;
    padding: 0;
    border-left: none;
    box-shadow: none;
  }
}

@container oc-harness (max-width: 640px) {
  .oc-turn-minimap {
    display: none;
  }

  .oc-transcript {
    padding: 14px 14px 12px;
  }

  .oc-composer-wrap {
    padding: 6px 10px 10px;
  }

  .oc-form-grid {
    grid-template-columns: 1fr;
  }

  .oc-sheet-backdrop {
    padding: 10px;
  }

  .oc-sheet {
    padding: 14px;
    max-height: 92%;
  }
}

@media (max-width: 640px) {
  .oc-turn-minimap {
    display: none;
  }

  .oc-transcript {
    padding: 14px 14px 12px;
  }

  .oc-composer-wrap {
    padding: 6px 10px 10px;
  }

  .oc-form-grid {
    grid-template-columns: 1fr;
  }

  .oc-sheet-backdrop {
    padding: 10px;
  }

  .oc-sheet {
    padding: 14px;
    max-height: 92%;
  }
}
`;
