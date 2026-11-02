import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { QuotaService } from './quotaService';
import { AutopilotConfig, PermissionPreset, PlanReviewPolicy } from './types';

export class AutopilotService extends EventEmitter {
  private static instance: AutopilotService;
  private quotaService: QuotaService;
  private configDir: string;
  private configFilePath: string;
  private configWatcher: fs.FSWatcher | null = null;
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private ignoreWatchUntil: number = 0;

  private state: AutopilotConfig = {
    isTurboActive: false,
    permissionPreset: 'default',
    planReviewPolicy: 'always_ask',
  };

  private constructor(quotaService: QuotaService) {
    super();
    this.quotaService = quotaService;
    this.configDir = path.join(os.homedir(), '.gemini', 'config');
    this.configFilePath = path.join(this.configDir, 'config.json');

    this.syncFromDisk(false);
    this.setupConfigWatcher();
  }

  public static getInstance(quotaService?: QuotaService): AutopilotService {
    if (!AutopilotService.instance) {
      AutopilotService.instance = new AutopilotService(
        quotaService || QuotaService.getInstance()
      );
    }
    return AutopilotService.instance;
  }

  public getConfig(): AutopilotConfig {
    return { ...this.state };
  }

  public isTurboActive(): boolean {
    return this.state.isTurboActive;
  }

  public getPermissionPreset(): PermissionPreset {
    return this.state.permissionPreset;
  }

  public getPlanReviewPolicy(): PlanReviewPolicy {
    return this.state.planReviewPolicy;
  }

  public static formatPresetLabel(preset: PermissionPreset): string {
    switch (preset) {
      case 'turbo':
        return 'Turbo';
      case 'request_review':
        return 'Request Review';
      case 'default':
      default:
        return 'Default';
    }
  }

  public static formatPlanPolicyLabel(policy: PlanReviewPolicy): string {
    return policy === 'always_proceed' ? 'Always Proceed' : 'Always Ask';
  }

  /**
   * Toggles Turbo Autopilot in 1 click:
   * - ON: Global Permissions = Turbo + Plan Review Policy = Always Proceed
   * - OFF: Global Permissions = Default + Plan Review Policy = Always Ask
   */
  public async toggleTurboMode(silent: boolean = false): Promise<boolean> {
    const turnOn = !this.state.isTurboActive;
    const targetPreset: PermissionPreset = turnOn ? 'turbo' : 'default';
    const targetPlanPolicy: PlanReviewPolicy = turnOn ? 'always_proceed' : 'always_ask';

    const patch = {
      ...this.buildPresetRpcPatch(targetPreset),
      ...this.buildPlanPolicyRpcPatch(targetPlanPolicy),
    };

    const prevState = { ...this.state };
    this.updateLocalState(targetPreset, targetPlanPolicy);

    const ok = await this.applyPatch(patch);
    if (!ok) {
      this.state = prevState;
      this.emit('configChanged', this.getConfig());
      if (!silent) {
        vscode.window.showErrorMessage('Failed to update Antigravity Autopilot settings.');
      }
      return false;
    }

    if (!silent) {
      const msg = turnOn
        ? 'Turbo Autopilot: ON (Permissions: Turbo · Plan: Always Proceed)'
        : 'Turbo Autopilot: OFF (Permissions: Default · Plan: Always Ask)';
      vscode.window.setStatusBarMessage(msg, 3000);
    }
    return true;
  }

  /**
   * Updates Global Permissions (Permission Preset) natively via JetboxWriteState.
   */
  public async setPermissionPreset(
    preset: PermissionPreset,
    silent: boolean = false
  ): Promise<boolean> {
    const patch = this.buildPresetRpcPatch(preset);
    const prevState = { ...this.state };
    this.updateLocalState(preset, this.state.planReviewPolicy);

    const ok = await this.applyPatch(patch);
    if (!ok) {
      this.state = prevState;
      this.emit('configChanged', this.getConfig());
      if (!silent) {
        vscode.window.showErrorMessage('Failed to update Global Permissions preset.');
      }
      return false;
    }

    if (!silent) {
      vscode.window.setStatusBarMessage(
        `Global Permissions: ${AutopilotService.formatPresetLabel(preset)}`,
        3000
      );
    }
    return true;
  }

  /**
   * Updates Agent Behavior -> Plan Review Policy (artifactReviewMode) natively via JetboxWriteState.
   */
  public async setPlanReviewPolicy(
    policy: PlanReviewPolicy,
    silent: boolean = false
  ): Promise<boolean> {
    const patch = this.buildPlanPolicyRpcPatch(policy);
    const prevState = { ...this.state };
    this.updateLocalState(this.state.permissionPreset, policy);

    const ok = await this.applyPatch(patch);
    if (!ok) {
      this.state = prevState;
      this.emit('configChanged', this.getConfig());
      if (!silent) {
        vscode.window.showErrorMessage('Failed to update Plan Review Policy.');
      }
      return false;
    }

    if (!silent) {
      vscode.window.setStatusBarMessage(
        `Plan Review Policy: ${AutopilotService.formatPlanPolicyLabel(policy)}`,
        3000
      );
    }
    return true;
  }

  /**
   * Builds exact companion fields expected by Antigravity IDE v2.6.0+ for each Permission Preset.
   */
  private buildPresetRpcPatch(preset: PermissionPreset): Record<string, any> {
    const isWin = os.platform() === 'win32';
    switch (preset) {
      case 'turbo':
        return {
          permissionPreset: 3, // AGENT_PERMISSION_PRESET_TURBO
          autoExecutionPolicy: 3, // CASCADE_COMMANDS_AUTO_EXECUTION_EAGER
          nonWorkspaceFileAccessPolicy: 1, // AGENT_SETTING_POLICY_ALLOW
          enableTerminalSandbox: false,
        };
      case 'request_review':
        return {
          permissionPreset: 2, // AGENT_PERMISSION_PRESET_REQUEST_REVIEW
          autoExecutionPolicy: 1, // CASCADE_COMMANDS_AUTO_EXECUTION_OFF
          nonWorkspaceFileAccessPolicy: 2, // AGENT_SETTING_POLICY_ASK
          enableTerminalSandbox: false,
        };
      case 'default':
      default:
        return {
          permissionPreset: 1, // AGENT_PERMISSION_PRESET_DEFAULT
          autoExecutionPolicy: isWin ? 1 : 4, // OFF on Windows, PROCEED_IN_SANDBOX on macOS/Linux
          nonWorkspaceFileAccessPolicy: 2, // AGENT_SETTING_POLICY_ASK
          enableTerminalSandbox: !isWin,
        };
    }
  }

  private buildPlanPolicyRpcPatch(policy: PlanReviewPolicy): Record<string, any> {
    return {
      // ARTIFACT_REVIEW_MODE_TURBO = 2 ("Always Proceed"), ARTIFACT_REVIEW_MODE_ALWAYS = 1 ("Always Ask")
      artifactReviewMode: policy === 'always_proceed' ? 2 : 1,
    };
  }

  private updateLocalState(preset: PermissionPreset, planPolicy: PlanReviewPolicy): void {
    this.state = {
      isTurboActive: preset === 'turbo',
      permissionPreset: preset,
      planReviewPolicy: planPolicy,
    };
    this.emit('configChanged', this.getConfig());
  }

  private async applyPatch(patch: Record<string, any>): Promise<boolean> {
    this.ignoreWatchUntil = Date.now() + 900;
    const rpcSuccess = await this.quotaService.sendJetboxWriteState(patch);
    if (rpcSuccess) {
      return true;
    }

    // Fallback: write directly to ~/.gemini/config/config.json if daemon is temporarily unreachable
    this.quotaService.log('JetboxWriteState RPC unreachable; applying fallback update to config.json.');
    return this.writeFallbackToDisk(patch);
  }

  private writeFallbackToDisk(patch: Record<string, any>): boolean {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }

      let root: Record<string, any> = {};
      if (fs.existsSync(this.configFilePath)) {
        try {
          root = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8')) || {};
        } catch {
          root = {};
        }
      }

      if (!root.userSettings || typeof root.userSettings !== 'object') {
        root.userSettings = {};
      }

      const us = root.userSettings;
      if (patch.permissionPreset !== undefined) {
        const presetMap: Record<number, string> = {
          1: 'AGENT_PERMISSION_PRESET_DEFAULT',
          2: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW',
          3: 'AGENT_PERMISSION_PRESET_TURBO',
        };
        us.permissionPreset = presetMap[patch.permissionPreset] || us.permissionPreset;
      }

      if (patch.autoExecutionPolicy !== undefined) {
        const execMap: Record<number, string> = {
          1: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
          3: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER',
          4: 'CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX',
        };
        us.autoExecutionPolicy = execMap[patch.autoExecutionPolicy] || us.autoExecutionPolicy;
      }

      if (patch.nonWorkspaceFileAccessPolicy !== undefined) {
        const accessMap: Record<number, string> = {
          1: 'AGENT_SETTING_POLICY_ALLOW',
          2: 'AGENT_SETTING_POLICY_ASK',
        };
        us.nonWorkspaceFileAccessPolicy =
          accessMap[patch.nonWorkspaceFileAccessPolicy] || us.nonWorkspaceFileAccessPolicy;
      }

      if (patch.enableTerminalSandbox !== undefined) {
        us.enableTerminalSandbox = Boolean(patch.enableTerminalSandbox);
      }

      if (patch.artifactReviewMode !== undefined) {
        const reviewMap: Record<number, string> = {
          1: 'ARTIFACT_REVIEW_MODE_ALWAYS',
          2: 'ARTIFACT_REVIEW_MODE_TURBO',
        };
        us.artifactReviewMode = reviewMap[patch.artifactReviewMode] || us.artifactReviewMode;
      }

      fs.writeFileSync(this.configFilePath, JSON.stringify(root, null, 2), 'utf8');
      return true;
    } catch (err: any) {
      this.quotaService.log(`Failed fallback write to config.json: ${err.message || err}`);
      return false;
    }
  }

  /**
   * Synchronizes Autopilot state from ~/.gemini/config/config.json.
   */
  public syncFromDisk(emitIfChanged: boolean = true): void {
    try {
      if (!fs.existsSync(this.configFilePath)) {
        return;
      }
      const raw = fs.readFileSync(this.configFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const us = parsed?.userSettings;
      if (!us || typeof us !== 'object') {
        return;
      }

      let preset: PermissionPreset = 'default';
      const rawPreset = us.permissionPreset;
      const rawExec = us.autoExecutionPolicy;

      if (rawPreset === 'AGENT_PERMISSION_PRESET_TURBO' || rawPreset === 3) {
        preset = 'turbo';
      } else if (rawPreset === 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' || rawPreset === 2) {
        preset = 'request_review';
      } else if (rawPreset === 'AGENT_PERMISSION_PRESET_DEFAULT' || rawPreset === 1) {
        preset = 'default';
      } else if (rawExec === 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' || rawExec === 3) {
        preset = 'turbo';
      }

      let planPolicy: PlanReviewPolicy = 'always_ask';
      const rawReview = us.artifactReviewMode;
      if (rawReview === 'ARTIFACT_REVIEW_MODE_TURBO' || rawReview === 2) {
        planPolicy = 'always_proceed';
      }

      const nextState: AutopilotConfig = {
        isTurboActive: preset === 'turbo',
        permissionPreset: preset,
        planReviewPolicy: planPolicy,
      };

      const changed =
        nextState.isTurboActive !== this.state.isTurboActive ||
        nextState.permissionPreset !== this.state.permissionPreset ||
        nextState.planReviewPolicy !== this.state.planReviewPolicy;

      this.state = nextState;
      if (emitIfChanged && changed) {
        this.emit('configChanged', this.getConfig());
      }
    } catch {}
  }

  private setupConfigWatcher(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      this.configWatcher = fs.watch(this.configDir, (_eventType, filename) => {
        if (Date.now() < this.ignoreWatchUntil) {
          return;
        }
        if (!filename || filename.toLowerCase().includes('config.json')) {
          if (this.watchDebounceTimer) {
            clearTimeout(this.watchDebounceTimer);
          }
          this.watchDebounceTimer = setTimeout(() => {
            this.syncFromDisk(true);
          }, 200);
        }
      });
    } catch {}
  }

  public dispose(): void {
    if (this.configWatcher) {
      try {
        this.configWatcher.close();
      } catch {}
      this.configWatcher = null;
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
  }
}

