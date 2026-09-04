import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { AutoAcceptChoice } from './types';

/**
 * Pure Node.js WebSocket Client using http & crypto (Zero external npm dependencies)
 */
class PureCdpSocket {
  private socket: any = null;
  public isConnected: boolean = false;
  private wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this.wsUrl);
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key,
          },
        });
        req.on('upgrade', (res, socket) => {
          this.socket = socket;
          this.isConnected = true;
          socket.on('close', () => { this.isConnected = false; });
          socket.on('error', () => { this.isConnected = false; });
          resolve();
        });
        req.on('error', (err) => {
          this.isConnected = false;
          reject(err);
        });
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  public send(obj: any): void {
    if (!this.socket || !this.isConnected) return;
    try {
      const json = JSON.stringify(obj);
      const length = Buffer.byteLength(json);
      let frameHeader: Buffer;
      if (length <= 125) {
        frameHeader = Buffer.from([0x81, 0x80 | length]);
      } else if (length <= 65535) {
        frameHeader = Buffer.alloc(4);
        frameHeader[0] = 0x81;
        frameHeader[1] = 0x80 | 126;
        frameHeader.writeUInt16BE(length, 2);
      } else {
        frameHeader = Buffer.alloc(10);
        frameHeader[0] = 0x81;
        frameHeader[1] = 0x80 | 127;
        frameHeader.writeBigUInt64BE(BigInt(length), 2);
      }
      const mask = Buffer.alloc(4);
      const payload = Buffer.from(json);
      const buffer = Buffer.concat([frameHeader, mask, payload]);
      this.socket.write(buffer);
    } catch (e) {}
  }

  public close(): void {
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
      this.socket = null;
      this.isConnected = false;
    }
  }
}

/**
 * Intelligent DOM Observer Script for CDP injection
 * - Prioritizes user's chosen option (Option 1 / Option 2 / Option 3)
 * - Selects radio/option in permission prompts before clicking Submit
 * - Directly clicks choice action button if buttons are rendered directly
 * - Avoids clicking sidebar conversation history
 */
const DOM_OBSERVER_SCRIPT = `
(function() {
  window.__AGY_AUTO_ACCEPT_ACTIVE = true;

  if (window.__AGY_AUTO_ACCEPT_OBSERVER) {
    try { window.__AGY_AUTO_ACCEPT_OBSERVER.disconnect(); } catch(e) {}
  }
  if (window.__AGY_AUTO_ACCEPT_INTERVAL) {
    try { clearInterval(window.__AGY_AUTO_ACCEPT_INTERVAL); } catch(e) {}
  }

  var SIDEBAR_SELECTORS = '[role="tree"], [role="treeitem"], .conversation-list, .chat-history, .past-chat, [class*="history-list"], [class*="convo-list"]';

  function isSidebarElement(el) {
    if (!el || !el.closest) return false;
    if (el.closest(SIDEBAR_SELECTORS)) return true;
    return false;
  }

  function getChoiceKeywords() {
    var choice = window.__AGY_AUTO_ACCEPT_CHOICE || 1;
    if (choice === 2) {
      return ['in this conversation', 'this conversation', 'allow in this conversation', '2.'];
    } else if (choice === 3) {
      return ['always allow', 'yes, and always allow', '3.'];
    }
    return ['allow this time', 'yes, allow this time', 'allow once', '1.'];
  }

  function selectTargetOption() {
    var targetKeywords = getChoiceKeywords();
    var options = document.querySelectorAll('[role="radio"], [role="option"], input[type="radio"], .quick-input-list-row, label, .monaco-list-row');
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      if (isSidebarElement(opt)) continue;
      var optText = (opt.innerText || opt.textContent || '').trim().toLowerCase().replace(/\\s+/g, ' ');
      if (!optText) continue;

      for (var k = 0; k < targetKeywords.length; k++) {
        if (optText.indexOf(targetKeywords[k]) !== -1) {
          if (opt.getAttribute('aria-checked') !== 'true' && !opt.checked && !opt.classList.contains('selected')) {
            try { opt.click(); } catch(e) {}
          }
          return true;
        }
      }
    }
    return false;
  }

  function getTargetActionTexts() {
    var choice = window.__AGY_AUTO_ACCEPT_CHOICE || 1;
    var choiceTexts = [];
    if (choice === 2) {
      choiceTexts = ['yes, in this conversation', 'in this conversation', 'allow in this conversation'];
    } else if (choice === 3) {
      choiceTexts = ['yes, and always allow', 'always allow'];
    } else {
      choiceTexts = ['yes, allow this time', 'allow this time', 'allow once'];
    }

    return choiceTexts.concat([
      'submit',
      'run',
      'accept',
      'allow',
      'retry',
      'continue'
    ]);
  }

  function scanAndClick() {
    if (!window.__AGY_AUTO_ACCEPT_ENABLED) return;

    // 1. Auto-select user's preferred option in radio/checkbox/list prompts
    selectTargetOption();

    // 2. Scan and click buttons
    var targetTexts = getTargetActionTexts();
    var buttons = document.querySelectorAll('button, div[role="button"], a[role="button"], input[type="button"], input[type="submit"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (isSidebarElement(btn)) continue;

      var text = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase().replace(/\\s+/g, ' ');
      if (!text) continue;

      for (var t = 0; t < targetTexts.length; t++) {
        var target = targetTexts[t];
        if (text === target || text.indexOf(target) === 0 || (text.length <= 35 && text.indexOf(target) !== -1)) {
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
          if (target === 'run' && text.indexOf('always run') !== -1) continue;

          var now = Date.now();
          if (btn.__lastAgyClick && now - btn.__lastAgyClick < 2500) continue;
          btn.__lastAgyClick = now;

          try {
            btn.click();
            return;
          } catch (e) {}
        }
      }
    }
  }

  window.__AGY_SCAN_AND_CLICK = scanAndClick;
  window.__AGY_AUTO_ACCEPT_OBSERVER = new MutationObserver(scanAndClick);
  window.__AGY_AUTO_ACCEPT_OBSERVER.observe(document.body, { childList: true, subtree: true });
  window.__AGY_AUTO_ACCEPT_INTERVAL = setInterval(scanAndClick, 500);
  scanAndClick();
})();
`;

export class AutoAcceptService extends EventEmitter implements vscode.Disposable {
  private static instance: AutoAcceptService;
  private globalState?: vscode.Memento;
  private isEnabled: boolean = false;
  private choice: AutoAcceptChoice = 1;
  private pollTimer: NodeJS.Timeout | null = null;
  private cdpCheckTimer: NodeJS.Timeout | null = null;
  private cdpSockets: Map<string, PureCdpSocket> = new Map();
  private isExecuting: boolean = false;

  private constructor(globalState?: vscode.Memento) {
    super();
    this.globalState = globalState;
    this.isEnabled = this.globalState?.get<boolean>('antigravity_auto_accept_enabled', false) ?? false;
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const defaultChoice = config.get<AutoAcceptChoice>('autoAccept.choice', 1);
    this.choice = this.globalState?.get<AutoAcceptChoice>('antigravity_auto_accept_choice', defaultChoice) ?? defaultChoice;

    if (this.isEnabled) {
      this.startEngines();
    }
  }

  public static getInstance(globalState?: vscode.Memento): AutoAcceptService {
    if (!AutoAcceptService.instance) {
      AutoAcceptService.instance = new AutoAcceptService(globalState);
    } else if (globalState && !AutoAcceptService.instance.globalState) {
      AutoAcceptService.instance.globalState = globalState;
    }
    return AutoAcceptService.instance;
  }

  public getStatus(): boolean {
    return this.isEnabled;
  }

  public getChoice(): AutoAcceptChoice {
    return this.choice;
  }

  public getChoiceLabel(choice?: AutoAcceptChoice): string {
    const c = choice ?? this.choice;
    switch (c) {
      case 1: return 'Allow this time (Once)';
      case 2: return 'In this conversation (Recommended)';
      case 3: return 'Always allow (Permanent)';
      default: return 'Allow this time';
    }
  }

  public async setChoice(choice: AutoAcceptChoice, autoEnable: boolean = true): Promise<void> {
    this.choice = choice;
    await this.globalState?.update('antigravity_auto_accept_choice', choice);
    this.broadcastCdpChoice(choice);
    this.emit('choiceChanged', choice);
    if (autoEnable && !this.isEnabled) {
      await this.setEnabled(true, false);
    }
  }

  private broadcastCdpChoice(choice: AutoAcceptChoice): void {
    const expr = `window.__AGY_AUTO_ACCEPT_CHOICE = ${choice};\nif (window.__AGY_SCAN_AND_CLICK) { window.__AGY_SCAN_AND_CLICK(); }`;
    const payload = {
      id: 98,
      method: 'Runtime.evaluate',
      params: { expression: expr }
    };

    for (const [wsUrl, client] of this.cdpSockets) {
      try {
        if (client.isConnected) {
          client.send(payload);
        } else {
          this.cdpSockets.delete(wsUrl);
        }
      } catch (e) {}
    }
  }

  public async toggle(): Promise<boolean> {
    const nextState = !this.isEnabled;
    await this.setEnabled(nextState, false);
    vscode.window.setStatusBarMessage(
      nextState ? `$(zap) Auto-Accept: ON (Option ${this.choice})` : `$(circle-slash) Auto-Accept: OFF`,
      2500
    );
    return this.isEnabled;
  }

  public async setEnabled(enabled: boolean, notify: boolean = false): Promise<boolean> {
    if (this.isEnabled === enabled) return this.isEnabled;

    this.isEnabled = enabled;
    await this.globalState?.update('antigravity_auto_accept_enabled', this.isEnabled);

    if (this.isEnabled) {
      this.startEngines();
      this.broadcastCdpState(true);
      if (notify) {
        this.verifyPortAndNotify();
      }
    } else {
      this.stopEngines();
    }

    this.emit('stateChanged', this.isEnabled);
    return this.isEnabled;
  }

  public pingPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data.includes('{')));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  public async patchWindowsShortcuts(targetPort: number = 9333): Promise<number> {
    if (process.platform !== 'win32') return 0;
    return new Promise((resolve) => {
      const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$dirs = @("$env:USERPROFILE\\\\Desktop", "$env:PUBLIC\\\\Desktop", "$env:APPDATA\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs", "$env:ALLUSERSPROFILE\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs", "$env:APPDATA\\\\Microsoft\\\\Internet Explorer\\\\Quick Launch\\\\User Pinned\\\\TaskBar")
$flag = "--remote-debugging-port=${targetPort}"
$count = 0
foreach ($dir in $dirs) {
  if (Test-Path $dir) {
    $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
    foreach ($file in $files) {
      try {
        $s = $WshShell.CreateShortcut($file.FullName)
        if ($file.Name -like "*Antigravity*" -or $s.TargetPath -like "*Antigravity*") {
          if ($s.Arguments -notlike "*$flag*") {
            $s.Arguments = ("$($s.Arguments) " + $flag).Trim()
            $s.Save()
            $count++
          }
        }
      } catch {}
    }
  }
}
Write-Output $count
`;
      cp.exec(`powershell -NoProfile -NonInteractive -Command "${psScript.replace(/\r?\n/g, ' ')}"`, (err, stdout) => {
        const count = parseInt(stdout?.trim() || '0', 10);
        resolve(isNaN(count) ? 0 : count);
      });
    });
  }

  public async verifyPortAndNotify(): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const port = config.get<number>('autoAccept.cdpPort', 9333);
    const isOpen = await this.pingPort(port);
    if (isOpen) {
      vscode.window.showInformationMessage(`$(zap) Auto-Accept is ACTIVE (Debug Port ${port} connected).`);
    } else {
      const choice = await vscode.window.showWarningMessage(
        `$(zap) Auto-Accept is active for code edits, but Antigravity needs to be restarted with Debug Port ${port} to auto-click Run & Permission prompts.`,
        'Auto-Patch Shortcuts (Windows)',
        'Dismiss'
      );
      if (choice === 'Auto-Patch Shortcuts (Windows)') {
        await this.patchWindowsShortcuts(port);
        vscode.window.showInformationMessage(
          `$(check) Antigravity shortcuts patched with port ${port}! Please restart Antigravity from your Desktop or Start Menu shortcut to activate full auto-run.`,
          'Reload Window'
        ).then(action => {
          if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      }
    }
  }

  private startEngines(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdpCheckTimer) {
      clearInterval(this.cdpCheckTimer);
      this.cdpCheckTimer = null;
    }

    // 1. Layer 1: Native VS Code Commands Polling (Default 800ms)
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const intervalMs = config.get<number>('autoAccept.pollIntervalMs', 800);

    this.pollTimer = setInterval(() => {
      this.runNativeCommands();
    }, Math.max(400, intervalMs));

    // Immediate first run
    this.runNativeCommands();

    // 2. Layer 2: Optional CDP Observer Auto-Detection (every 5s)
    const enableCdp = config.get<boolean>('autoAccept.enableCdpMode', true);
    if (enableCdp) {
      this.broadcastCdpState(true);
      this.checkAndInjectCdp();
      this.cdpCheckTimer = setInterval(() => {
        this.checkAndInjectCdp();
      }, 5000);
    }
  }

  private stopEngines(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdpCheckTimer) {
      clearInterval(this.cdpCheckTimer);
      this.cdpCheckTimer = null;
    }

    // Tell injected CDP scripts to pause
    this.broadcastCdpState(false);
  }

  /**
   * Layer 1: Execute native Antigravity accept commands safely and quietly
   */
  private async runNativeCommands(): Promise<void> {
    if (!this.isEnabled || this.isExecuting) return;
    this.isExecuting = true;

    const commandsToRun = [
      'antigravity.agent.acceptAgentStep',
      'antigravity.prioritized.agentAcceptAllInFile',
      'antigravity.prioritized.agentAcceptFocusedHunk',
      'antigravity.terminalCommand.run',
      'antigravity.terminalCommand.accept',
      'antigravity.command.accept'
    ];

    for (const cmd of commandsToRun) {
      try {
        await vscode.commands.executeCommand(cmd);
      } catch (err) {
        // Silently ignore when nothing is pending
      }
    }

    this.isExecuting = false;
  }

  /**
   * Layer 2: Seamlessly check port 9333 for CDP without crashing or throwing errors
   */
  private checkAndInjectCdp(): void {
    if (!this.isEnabled) return;

    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const port = config.get<number>('autoAccept.cdpPort', 9333);

    const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) return;

      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const targets = JSON.parse(rawData);
          if (Array.isArray(targets)) {
            this.handleCdpTargets(targets);
          }
        } catch (e) {}
      });
    });

    req.on('error', () => {
      // Port is closed / not running with debugging port - totally fine, Layer 1 handles commands!
    });
  }

  private async handleCdpTargets(targets: any[]): Promise<void> {
    for (const target of targets) {
      const wsUrl = target.webSocketDebuggerUrl;
      if (!wsUrl) continue;

      // Target Workbench pages and Webviews
      const isCandidate = (target.type === 'page' || target.type === 'webview') &&
        !target.url?.includes('extension-output') &&
        !target.title?.includes('Developer Tools');

      if (!isCandidate) continue;

      if (this.cdpSockets.has(wsUrl)) {
        const client = this.cdpSockets.get(wsUrl);
        if (client && client.isConnected) {
          client.send({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression: `window.__AGY_AUTO_ACCEPT_ENABLED = ${this.isEnabled};\nwindow.__AGY_AUTO_ACCEPT_CHOICE = ${this.choice};\n${DOM_OBSERVER_SCRIPT}`
            }
          });
          continue;
        } else {
          this.cdpSockets.delete(wsUrl);
        }
      }

      try {
        const client = new PureCdpSocket(wsUrl);
        await client.connect();
        this.cdpSockets.set(wsUrl, client);

        const evalPayload = {
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `window.__AGY_AUTO_ACCEPT_ENABLED = ${this.isEnabled};\nwindow.__AGY_AUTO_ACCEPT_CHOICE = ${this.choice};\n${DOM_OBSERVER_SCRIPT}`,
            returnByValue: false
          }
        };
        client.send(evalPayload);
      } catch (e) {}
    }
  }

  private broadcastCdpState(enabled: boolean): void {
    const expr = `window.__AGY_AUTO_ACCEPT_ENABLED = ${enabled};\nif (window.__AGY_SCAN_AND_CLICK) { window.__AGY_SCAN_AND_CLICK(); }`;
    const payload = {
      id: 99,
      method: 'Runtime.evaluate',
      params: { expression: expr }
    };

    for (const [wsUrl, client] of this.cdpSockets) {
      try {
        if (client.isConnected) {
          client.send(payload);
        } else {
          this.cdpSockets.delete(wsUrl);
        }
      } catch (e) {}
    }
  }

  public dispose(): void {
    this.stopEngines();
    for (const [, client] of this.cdpSockets) {
      try { client.close(); } catch (e) {}
    }
    this.cdpSockets.clear();
  }
}
