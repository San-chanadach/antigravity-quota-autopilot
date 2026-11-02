import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { TaskSessionService } from '../taskSessionService';
import { AutopilotService } from '../autopilotService';
import {
  ActivityLogEntry,
  AutopilotConfig,
  ParsedQuotaInfo,
  PermissionPreset,
  PlanReviewPolicy,
} from '../types';

export class DashboardWebviewPanel {
  public static currentPanel: DashboardWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _quotaService: QuotaService;
  private _taskSessionService: TaskSessionService;
  private _autopilotService: AutopilotService;

  private _onQuotaUpdatedHandler: (quota: ParsedQuotaInfo) => void;
  private _onQuotaErrorHandler: (err: Error) => void;
  private _onActivityChangedHandler: () => void;
  private _onAutopilotChangedHandler: (config: AutopilotConfig) => void;

  public static createOrShow(
    extensionUri: vscode.Uri,
    quotaService: QuotaService,
    taskSessionService?: TaskSessionService,
    autopilotService?: AutopilotService
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardWebviewPanel.currentPanel) {
      DashboardWebviewPanel.currentPanel._panel.reveal(column);
      DashboardWebviewPanel.currentPanel.updateContent();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'antigravityModelLimitDashboard',
      'Antigravity Quota & Autopilot',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardWebviewPanel.currentPanel = new DashboardWebviewPanel(
      panel,
      extensionUri,
      quotaService,
      taskSessionService || TaskSessionService.getInstance(),
      autopilotService || AutopilotService.getInstance(quotaService)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    quotaService: QuotaService,
    taskSessionService: TaskSessionService,
    autopilotService: AutopilotService
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._quotaService = quotaService;
    this._taskSessionService = taskSessionService;
    this._autopilotService = autopilotService;

    this.updateContent();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          this._quotaService.refresh(false).catch(() => {});
          this._autopilotService.syncFromDisk(true);
          this._panel.webview.postMessage({
            type: 'updateActivityHistory',
            history: this._taskSessionService.getHistory(),
            todaySummary: this._taskSessionService.getTodaySummary(),
          });
          this._panel.webview.postMessage({
            type: 'updateAutopilot',
            config: this._autopilotService.getConfig(),
          });
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            try {
              const res = await this._quotaService.refresh(true);
              if (res) {
                this._panel.webview.postMessage({
                  type: 'updateQuota',
                  data: res,
                });
                this._panel.webview.postMessage({
                  type: 'updateActivityHistory',
                  history: this._taskSessionService.getHistory(),
                  todaySummary: this._taskSessionService.getTodaySummary(),
                });
              }
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'quotaError',
                message: err.message || 'Unable to connect to Antigravity Language Server.',
              });
            }
            break;
          case 'openSettings':
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'antigravityLimitMonitor'
            );
            break;
          case 'clearHistory':
            await this._taskSessionService.clearHistory();
            break;
          case 'toggleTurbo':
            await this._autopilotService.toggleTurboMode();
            break;
          case 'setPermissionPreset':
            if (
              message.preset === 'turbo' ||
              message.preset === 'default' ||
              message.preset === 'request_review'
            ) {
              await this._autopilotService.setPermissionPreset(
                message.preset as PermissionPreset
              );
            }
            break;
          case 'setPlanReviewPolicy':
            if (message.policy === 'always_proceed' || message.policy === 'always_ask') {
              await this._autopilotService.setPlanReviewPolicy(
                message.policy as PlanReviewPolicy
              );
            }
            break;
        }
      },
      null,
      this._disposables
    );

    this._onQuotaUpdatedHandler = (quota: ParsedQuotaInfo) => {
      this._panel.webview.postMessage({
        type: 'updateQuota',
        data: quota,
      });
      this._panel.webview.postMessage({
        type: 'updateActivityHistory',
        history: this._taskSessionService.getHistory(),
        todaySummary: this._taskSessionService.getTodaySummary(),
      });
    };

    this._onQuotaErrorHandler = (err: Error) => {
      this._panel.webview.postMessage({
        type: 'quotaError',
        message: err.message || 'Unable to connect to Antigravity Language Server.',
      });
    };

    this._onActivityChangedHandler = () => {
      this._panel.webview.postMessage({
        type: 'updateActivityHistory',
        history: this._taskSessionService.getHistory(),
        todaySummary: this._taskSessionService.getTodaySummary(),
      });
    };

    this._onAutopilotChangedHandler = (config: AutopilotConfig) => {
      this._panel.webview.postMessage({
        type: 'updateAutopilot',
        config,
      });
    };

    this._quotaService.on('quotaUpdated', this._onQuotaUpdatedHandler);
    this._quotaService.on('error', this._onQuotaErrorHandler);
    this._taskSessionService.on('activityLogged', this._onActivityChangedHandler);
    this._taskSessionService.on('historyCleared', this._onActivityChangedHandler);
    this._autopilotService.on('configChanged', this._onAutopilotChangedHandler);
  }

  public updateContent() {
    const quota = this._quotaService.getLastQuotaInfo();
    const history = this._taskSessionService.getHistory();
    const todaySummary = this._taskSessionService.getTodaySummary();
    const autopilot = this._autopilotService.getConfig();
    this._panel.webview.html = this._getHtmlForWebview(
      quota,
      history,
      todaySummary,
      autopilot
    );
  }

  private _getHtmlForWebview(
    quota: ParsedQuotaInfo | null,
    history: ActivityLogEntry[],
    todaySummary: any,
    autopilot: AutopilotConfig
  ): string {
    const initialDataJson = JSON.stringify(quota || null);
    const initialHistoryJson = JSON.stringify(history || []);
    const initialSummaryJson = JSON.stringify(todaySummary || null);
    const initialAutopilotJson = JSON.stringify(autopilot);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Quota & Autopilot</title>
  <style>
    :root {
      --bg-primary: #111316;
      --bg-card: #181b20;
      --bg-card-hover: #1e2228;
      --bg-control: #13161a;
      --border-color: #282d35;
      --border-strong: #383f4a;
      --text-main: #e6edf3;
      --text-muted: #8b949e;
      --accent-green: #3fb950;
      --accent-yellow: #d29922;
      --accent-red: #f85149;
      --accent-blue: #58a6ff;
      --radius: 10px;
      --transition: all 0.18s ease;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background-color: var(--vscode-editor-background, var(--bg-primary));
      color: var(--vscode-editor-foreground, var(--text-main));
      padding: 28px 32px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 820px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border-color);
    }

    .header-title {
      font-size: 19px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text-main);
    }

    .subline {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .plan-pill {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid var(--border-strong);
      color: var(--text-main);
      background: var(--bg-card);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border-color);
      padding: 6px 13px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: var(--transition);
      white-space: nowrap;
    }

    .btn:hover:not(:disabled) {
      background: var(--bg-card-hover);
      border-color: var(--border-strong);
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .btn-primary {
      background: #238636;
      border-color: #2ea043;
      color: #ffffff;
    }

    .btn-primary:hover:not(:disabled) {
      background: #2ea043;
      border-color: #3fb950;
    }

    /* Autopilot Native Controls Panel */
    .autopilot-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius);
      padding: 18px 20px;
      margin-bottom: 28px;
    }

    .autopilot-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding-bottom: 14px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--border-color);
    }

    .autopilot-heading {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-main);
    }

    .autopilot-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .turbo-toggle-btn {
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid var(--border-strong);
      background: var(--bg-control);
      color: var(--text-muted);
      transition: var(--transition);
    }

    .turbo-toggle-btn.active {
      border-color: rgba(63, 185, 80, 0.55);
      background: rgba(63, 185, 80, 0.12);
      color: var(--accent-green);
    }

    .turbo-toggle-btn:hover {
      border-color: var(--text-muted);
      color: var(--text-main);
    }

    .turbo-toggle-btn.active:hover {
      background: rgba(63, 185, 80, 0.18);
      color: var(--accent-green);
    }

    .control-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }

    .control-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .control-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
    }

    .segmented {
      display: inline-flex;
      background: var(--bg-control);
      border: 1px solid var(--border-color);
      border-radius: 7px;
      padding: 3px;
      gap: 3px;
    }

    .seg-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 500;
      padding: 5px 10px;
      border-radius: 5px;
      cursor: pointer;
      transition: var(--transition);
      white-space: nowrap;
    }

    .seg-btn:hover {
      color: var(--text-main);
    }

    .seg-btn.selected {
      background: var(--bg-card-hover);
      color: var(--text-main);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    }

    .seg-btn.selected.turbo-pill {
      color: var(--accent-green);
      background: rgba(63, 185, 80, 0.12);
    }

    /* Error Banner */
    .error-banner {
      display: none;
      background: rgba(248, 81, 73, 0.1);
      border: 1px solid rgba(248, 81, 73, 0.3);
      color: #ff7b72;
      padding: 10px 14px;
      border-radius: var(--radius);
      margin-bottom: 20px;
      font-size: 12px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .error-banner.visible {
      display: flex;
    }

    /* Quota Groups */
    .section-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .group-section {
      margin-bottom: 24px;
    }

    .group-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 10px;
    }

    .group-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-main);
    }

    .group-desc {
      font-size: 12px;
      color: var(--text-muted);
    }

    .bucket-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius);
      padding: 14px 18px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: var(--transition);
    }

    .bucket-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-strong);
    }

    .bucket-info {
      flex: 1;
      padding-right: 16px;
    }

    .bucket-name {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .bucket-meta {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 3px;
    }

    .gauge-wrapper {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .gauge-percentage {
      font-size: 16px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      min-width: 44px;
      text-align: right;
    }

    .gauge-ring {
      position: relative;
      width: 38px;
      height: 38px;
    }

    .gauge-ring svg {
      transform: rotate(-90deg);
      width: 100%;
      height: 100%;
    }

    .gauge-bg {
      fill: none;
      stroke: #262b33;
      stroke-width: 3.5;
    }

    .gauge-progress {
      fill: none;
      stroke-width: 3.5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.5s ease, stroke 0.25s ease;
    }

    /* Activity History */
    .history-section {
      margin-top: 32px;
      border-top: 1px solid var(--border-color);
      padding-top: 24px;
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .history-title-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .history-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-main);
    }

    .history-stat-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      font-weight: 500;
    }

    .history-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12.5px;
      gap: 16px;
    }

    .history-item-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }

    .history-prompt-title {
      font-weight: 500;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .history-item-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .history-item-stats {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }

    .history-pill {
      font-size: 11.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 5px;
      background: rgba(248, 81, 73, 0.1);
      color: #ff7b72;
      border: 1px solid rgba(248, 81, 73, 0.25);
      font-variant-numeric: tabular-nums;
    }

    .history-remaining {
      font-size: 11.5px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .pagination-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .pagination-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .info-footer {
      border-top: 1px solid var(--border-color);
      padding-top: 16px;
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 28px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1 class="header-title">Antigravity Quota &amp; Autopilot</h1>
        <div class="subline" id="lastSyncText">Connecting to Antigravity Engine...</div>
      </div>
      <div class="header-actions">
        <button class="btn" onclick="openSettings()">Extension Settings</button>
        <button class="btn btn-primary" onclick="refreshQuota()" id="refreshBtn">Refresh</button>
      </div>
    </div>

    <!-- Native Autopilot Control Panel -->
    <div class="autopilot-card">
      <div class="autopilot-top">
        <div>
          <div class="autopilot-heading">Native Autopilot &amp; Agent Behavior</div>
          <div class="autopilot-sub">Directly controls Antigravity Global Permissions and Plan Review Policy (Shortcut: Ctrl+Alt+A)</div>
        </div>
        <button class="turbo-toggle-btn" id="turboToggleBtn" onclick="toggleTurbo()">
          Turbo Mode: Inactive
        </button>
      </div>

      <div class="control-grid">
        <div class="control-item">
          <span class="control-label">Global Permissions (Permission Preset)</span>
          <div class="segmented" id="presetGroup">
            <button class="seg-btn turbo-pill" data-preset="turbo" onclick="selectPreset('turbo')">Turbo</button>
            <button class="seg-btn" data-preset="default" onclick="selectPreset('default')">Default</button>
            <button class="seg-btn" data-preset="request_review" onclick="selectPreset('request_review')">Request Review</button>
          </div>
        </div>

        <div class="control-item">
          <span class="control-label">Agent Behavior (Plan Review Policy)</span>
          <div class="segmented" id="policyGroup">
            <button class="seg-btn turbo-pill" data-policy="always_proceed" onclick="selectPolicy('always_proceed')">Always Proceed</button>
            <button class="seg-btn" data-policy="always_ask" onclick="selectPolicy('always_ask')">Always Ask</button>
          </div>
        </div>
      </div>
    </div>

    <div id="errorBanner" class="error-banner">
      <span id="errorMessage">Unable to connect to Antigravity Language Server.</span>
      <button class="btn" onclick="refreshQuota()">Retry</button>
    </div>

    <!-- Dynamic Model Quota Groups -->
    <div id="contentArea"></div>

    <!-- Activity History -->
    <div id="historyArea"></div>

    <div class="info-footer">
      Quota is tracked dynamically across all model groups available on your account tier (Free, Google AI Pro, Ultra, or Enterprise).
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentData = ${initialDataJson};
    let currentHistory = ${initialHistoryJson};
    let currentSummary = ${initialSummaryJson};
    let currentAutopilot = ${initialAutopilotJson};
    let currentPage = 1;
    const PAGE_SIZE = 10;

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function setRefreshing(isRefreshing) {
      const btn = document.getElementById('refreshBtn');
      if (btn) {
        btn.disabled = isRefreshing;
        btn.textContent = isRefreshing ? 'Refreshing...' : 'Refresh';
      }
    }

    function refreshQuota() {
      setRefreshing(true);
      vscode.postMessage({ command: 'refresh' });
      setTimeout(() => setRefreshing(false), 5000);
    }

    function openSettings() {
      vscode.postMessage({ command: 'openSettings' });
    }

    function clearHistory() {
      vscode.postMessage({ command: 'clearHistory' });
    }

    function toggleTurbo() {
      vscode.postMessage({ command: 'toggleTurbo' });
    }

    function selectPreset(preset) {
      vscode.postMessage({ command: 'setPermissionPreset', preset });
    }

    function selectPolicy(policy) {
      vscode.postMessage({ command: 'setPlanReviewPolicy', policy });
    }

    function updateAutopilotUI(cfg) {
      if (!cfg) return;
      currentAutopilot = cfg;

      const toggleBtn = document.getElementById('turboToggleBtn');
      if (toggleBtn) {
        if (cfg.isTurboActive) {
          toggleBtn.classList.add('active');
          toggleBtn.textContent = '🟢 Turbo Mode: Active';
        } else {
          toggleBtn.classList.remove('active');
          toggleBtn.textContent = '🟡 Turbo Mode: Inactive';
        }
      }

      document.querySelectorAll('#presetGroup .seg-btn').forEach((btn) => {
        if (btn.getAttribute('data-preset') === cfg.permissionPreset) {
          btn.classList.add('selected');
        } else {
          btn.classList.remove('selected');
        }
      });

      document.querySelectorAll('#policyGroup .seg-btn').forEach((btn) => {
        if (btn.getAttribute('data-policy') === cfg.planReviewPolicy) {
          btn.classList.add('selected');
        } else {
          btn.classList.remove('selected');
        }
      });
    }

    function formatTimeUntilReset(resetIso) {
      if (!resetIso) return '';
      const target = new Date(resetIso);
      const diffMs = target - new Date();
      if (diffMs <= 0) return 'Resetting now';

      const totalMins = Math.floor(diffMs / 60000);
      const days = Math.floor(totalMins / 1440);
      const hours = Math.floor((totalMins % 1440) / 60);
      const mins = totalMins % 60;

      const parts = [];
      if (days > 0) parts.push(days + 'd');
      if (hours > 0 || days > 0) parts.push(hours + 'h');
      if (days === 0) parts.push(mins + 'm');
      return parts.join(' ');
    }

    function getStatusDot(f) {
      if (f > 0.35) return '🟢';
      if (f > 0.15) return '🟡';
      return '🔴';
    }

    function getColorForFraction(f) {
      if (f <= 0) return '#484f58';
      if (f > 0.35) return 'var(--accent-green)';
      if (f > 0.15) return 'var(--accent-yellow)';
      return 'var(--accent-red)';
    }

    function render(data) {
      const container = document.getElementById('contentArea');
      const syncEl = document.getElementById('lastSyncText');
      if (!data || !data.groups || data.groups.length === 0) {
        container.innerHTML = '<div style="padding: 36px; text-align: center; color: var(--text-muted); font-size: 13px;">Waiting for model quota data...</div>';
        return;
      }

      if (syncEl && data.lastUpdated) {
        const d = new Date(data.lastUpdated);
        let parts = ['🟢 Synced ' + d.toLocaleTimeString()];
        if (data.userEmail) {
          parts.push(escapeHtml(data.userEmail));
        }
        let htmlSub = parts.join(' · ');
        const tierLabel = data.planName || (data.accountTier && data.accountTier !== 'unknown' ? data.accountTier.toUpperCase() : '');
        if (tierLabel) {
          htmlSub += ' <span class="plan-pill">' + escapeHtml(tierLabel) + '</span>';
        }
        syncEl.innerHTML = htmlSub;
      }

      const circumference = 2 * Math.PI * 15.5;
      let html = '<div class="section-label">Model Quota Limits</div>';

      for (const group of data.groups) {
        html += '<div class="group-section">';
        html += '<div class="group-header">';
        html += '<span class="group-title">' + escapeHtml(group.displayName) + '</span>';
        if (group.description) {
          html += '<span class="group-desc">' + escapeHtml(group.description) + '</span>';
        }
        html += '</div>';

        for (const bucket of group.buckets) {
          const frac = bucket.disabled ? 0 : (typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 1.0);
          const pct = Math.round(frac * 100);
          const dot = getStatusDot(frac);
          const color = getColorForFraction(frac);
          const offset = circumference * (1 - frac);
          const resetStr = bucket.resetTime ? formatTimeUntilReset(bucket.resetTime) : '';

          let metaLine = '';
          if (bucket.disabled) {
            metaLine = 'Weekly limit reached';
          } else if (resetStr) {
            metaLine = 'Resets in ' + resetStr;
          } else if (bucket.description) {
            metaLine = escapeHtml(bucket.description);
          }

          html += '<div class="bucket-card">';
          html += '  <div class="bucket-info">';
          html += '    <div class="bucket-name"><span>' + dot + '</span><span>' + escapeHtml(bucket.displayName) + '</span></div>';
          if (metaLine) {
            html += '    <div class="bucket-meta">' + metaLine + '</div>';
          }
          html += '  </div>';
          html += '  <div class="gauge-wrapper">';
          html += '    <div class="gauge-percentage" style="color: ' + (pct === 0 ? 'var(--text-muted)' : color) + ';">' + pct + '%</div>';
          html += '    <div class="gauge-ring">';
          html += '      <svg viewBox="0 0 38 38">';
          html += '        <circle class="gauge-bg" cx="19" cy="19" r="15.5"/>';
          html += '        <circle class="gauge-progress" cx="19" cy="19" r="15.5" ';
          html += '          stroke="' + color + '" ';
          html += '          stroke-dasharray="' + circumference + '" ';
          html += '          stroke-dashoffset="' + offset + '"/>';
          html += '      </svg>';
          html += '    </div>';
          html += '  </div>';
          html += '</div>';
        }

        html += '</div>';
      }

      container.innerHTML = html;
    }

    function changePage(delta) {
      const totalPages = Math.ceil((currentHistory || []).length / PAGE_SIZE) || 1;
      const newPage = currentPage + delta;
      if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        renderHistory(currentHistory, currentSummary);
      }
    }

    function renderHistory(history, summary) {
      const container = document.getElementById('historyArea');
      if (!container) return;

      if (!history || history.length === 0) {
        container.innerHTML = \`
          <div class="history-section">
            <div class="history-header">
              <div class="history-title-wrap">
                <span class="history-title">Activity Log</span>
                <span class="history-stat-badge">Auto-Tracking</span>
              </div>
            </div>
            <div style="padding: 22px; text-align: center; color: var(--text-muted); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius); font-size: 12.5px;">
              No quota activity recorded yet. Usage deltas per turn will appear here automatically.
            </div>
          </div>
        \`;
        return;
      }

      const totalItems = history.length;
      const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;
      if (currentPage > totalPages) currentPage = totalPages;

      const startIdx = (currentPage - 1) * PAGE_SIZE;
      const pageItems = history.slice(startIdx, startIdx + PAGE_SIZE);

      let itemsHtml = '';
      for (const item of pageItems) {
        const d = new Date(item.timestamp);
        const dateStr = d.toLocaleDateString();
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const pctUsed = item.usedPct.toFixed(1);
        const remPct = item.remainingPct.toFixed(1);
        const promptDisplay = item.promptTitle
          ? escapeHtml(item.promptTitle)
          : escapeHtml(item.groupName + ' · ' + item.bucketDisplayName);

        itemsHtml += \`
          <div class="history-card">
            <div class="history-item-left">
              <div class="history-prompt-title" title="\${escapeHtml(item.promptTitle || '')}">\${promptDisplay}</div>
              <div class="history-item-meta">
                <span>\${escapeHtml(item.groupName)} · \${escapeHtml(item.bucketDisplayName)}</span>
                <span>·</span>
                <span>\${dateStr} \${timeStr}</span>
              </div>
            </div>
            <div class="history-item-stats">
              <span class="history-remaining">\${remPct}% left</span>
              <span class="history-pill">-\${pctUsed}%</span>
            </div>
          </div>
        \`;
      }

      const todayStats = summary && summary.logCountToday > 0
        ? \`Today: -\${summary.totalUsedTodayPct}% (\${summary.logCountToday} turns)\`
        : \`\${totalItems} records\`;

      const prevDisabled = currentPage <= 1 ? 'disabled' : '';
      const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

      container.innerHTML = \`
        <div class="history-section">
          <div class="history-header">
            <div class="history-title-wrap">
              <span class="history-title">Activity Log</span>
              <span class="history-stat-badge">\${todayStats}</span>
            </div>
            <button class="btn" onclick="clearHistory()">Clear</button>
          </div>
          \${itemsHtml}
          <div class="pagination-bar">
            <div>Showing \${startIdx + 1}–\${Math.min(startIdx + PAGE_SIZE, totalItems)} of \${totalItems}</div>
            <div class="pagination-controls">
              <button class="btn" onclick="changePage(-1)" \${prevDisabled}>Prev</button>
              <span>\${currentPage} / \${totalPages}</span>
              <button class="btn" onclick="changePage(1)" \${nextDisabled}>Next</button>
            </div>
          </div>
        </div>
      \`;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateQuota') {
        currentData = msg.data;
        const errBanner = document.getElementById('errorBanner');
        if (errBanner) errBanner.classList.remove('visible');
        setRefreshing(false);
        render(currentData);
      } else if (msg.type === 'quotaError') {
        setRefreshing(false);
        const errBanner = document.getElementById('errorBanner');
        const errMsg = document.getElementById('errorMessage');
        const syncEl = document.getElementById('lastSyncText');
        if (errBanner && errMsg) {
          errMsg.textContent = msg.message || 'Unable to connect to Antigravity Language Server.';
          errBanner.classList.add('visible');
        }
        if (syncEl) {
          syncEl.textContent = '🔴 Offline';
        }
      } else if (msg.type === 'updateActivityHistory') {
        currentHistory = msg.history;
        currentSummary = msg.todaySummary;
        renderHistory(currentHistory, currentSummary);
      } else if (msg.type === 'updateAutopilot') {
        updateAutopilotUI(msg.config);
      }
    });

    // Initial render
    updateAutopilotUI(currentAutopilot);
    render(currentData);
    renderHistory(currentHistory, currentSummary);

    setInterval(() => {
      if (currentData) render(currentData);
    }, 30000);
  </script>
</body>
</html>`;
  }

  public dispose() {
    this._quotaService.off('quotaUpdated', this._onQuotaUpdatedHandler);
    this._quotaService.off('error', this._onQuotaErrorHandler);
    this._taskSessionService.off('activityLogged', this._onActivityChangedHandler);
    this._taskSessionService.off('historyCleared', this._onActivityChangedHandler);
    this._autopilotService.off('configChanged', this._onAutopilotChangedHandler);
    DashboardWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
