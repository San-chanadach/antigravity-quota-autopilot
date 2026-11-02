import * as vscode from 'vscode';
import { QuotaService } from './quotaService';
import { TaskSessionService } from './taskSessionService';
import { AutopilotService } from './autopilotService';
import { StatusBarManager } from './views/statusBar';
import { QuotaTreeDataProvider } from './views/sidebarProvider';
import { DashboardWebviewPanel } from './views/dashboardWebview';
import { ParsedQuotaInfo, PermissionPreset, PlanReviewPolicy } from './types';

let quotaService: QuotaService;
let taskSessionService: TaskSessionService;
let autopilotService: AutopilotService;
let statusBarManager: StatusBarManager;
let treeDataProvider: QuotaTreeDataProvider;
let hasAlertedForLowQuota = false;

interface ActionQuickPickItem extends vscode.QuickPickItem {
  action?: string;
  preset?: PermissionPreset;
  policy?: PlanReviewPolicy;
}

export function activate(context: vscode.ExtensionContext) {
  quotaService = QuotaService.getInstance();
  taskSessionService = TaskSessionService.getInstance(context.globalState, quotaService);
  autopilotService = AutopilotService.getInstance(quotaService);
  statusBarManager = new StatusBarManager(quotaService, taskSessionService, autopilotService);
  treeDataProvider = new QuotaTreeDataProvider(quotaService, autopilotService);

  // Register Tree View in Activity Bar
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      'antigravityLimitMonitorView',
      treeDataProvider
    )
  );

  // Refresh Quota Limits
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.refresh', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing AI model limits...',
          cancellable: false,
        },
        async () => {
          try {
            const quota = await quotaService.refresh(true);
            if (quota) {
              vscode.window.setStatusBarMessage(
                `Quota synced at ${quota.lastUpdated.toLocaleTimeString()}`,
                3000
              );
            } else {
              const choice = await vscode.window.showErrorMessage(
                'Unable to retrieve AI model limits from Antigravity Language Server.',
                'Open Logs'
              );
              if (choice === 'Open Logs') {
                quotaService.showOutputChannel();
              }
            }
          } catch (err: any) {
            const choice = await vscode.window.showErrorMessage(
              `Failed to refresh AI model limits: ${err.message || err}`,
              'Open Logs'
            );
            if (choice === 'Open Logs') {
              quotaService.showOutputChannel();
            }
          }
        }
      );
    })
  );

  // Open Dashboard
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.showDashboard', () => {
      DashboardWebviewPanel.createOrShow(
        context.extensionUri,
        quotaService,
        taskSessionService,
        autopilotService
      );
    })
  );

  // Toggle Turbo Autopilot (1-Click Status Bar + Backwards-compatible alias)
  const handleToggleTurbo = async () => {
    await autopilotService.toggleTurboMode();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.toggleTurbo', handleToggleTurbo),
    vscode.commands.registerCommand('antigravityLimitMonitor.toggleAutoAccept', handleToggleTurbo)
  );

  // Set Global Permissions (Permission Preset)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'antigravityLimitMonitor.setPermissionPreset',
      async (presetArg?: PermissionPreset) => {
        if (
          presetArg === 'turbo' ||
          presetArg === 'default' ||
          presetArg === 'request_review'
        ) {
          await autopilotService.setPermissionPreset(presetArg);
          return;
        }

        const current = autopilotService.getPermissionPreset();
        const items: (vscode.QuickPickItem & { value: PermissionPreset })[] = [
          {
            label: '$(zap) Turbo',
            description: current === 'turbo' ? 'Active' : '',
            detail: 'Allow tools, file edits, and terminal commands automatically without prompts',
            value: 'turbo',
          },
          {
            label: '$(shield) Default',
            description: current === 'default' ? 'Active' : '',
            detail: 'Standard Antigravity permission prompts for sensitive actions',
            value: 'default',
          },
          {
            label: '$(lock) Request Review',
            description: current === 'request_review' ? 'Active' : '',
            detail: 'Always ask for confirmation before running commands or external edits',
            value: 'request_review',
          },
        ];

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Select Global Permissions Preset (Current: ${AutopilotService.formatPresetLabel(current)})`,
        });

        if (selected) {
          await autopilotService.setPermissionPreset(selected.value);
        }
      }
    )
  );

  // Set Agent Behavior -> Plan Review Policy
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'antigravityLimitMonitor.setPlanReviewPolicy',
      async (policyArg?: PlanReviewPolicy) => {
        if (policyArg === 'always_proceed' || policyArg === 'always_ask') {
          await autopilotService.setPlanReviewPolicy(policyArg);
          return;
        }

        const current = autopilotService.getPlanReviewPolicy();
        const items: (vscode.QuickPickItem & { value: PlanReviewPolicy })[] = [
          {
            label: '$(checklist) Always Proceed',
            description: current === 'always_proceed' ? 'Active' : '',
            detail: 'Agent executes plans automatically without pausing for review',
            value: 'always_proceed',
          },
          {
            label: '$(checklist) Always Ask',
            description: current === 'always_ask' ? 'Active' : '',
            detail: 'Agent asks you to review implementation plans before proceeding',
            value: 'always_ask',
          },
        ];

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Select Plan Review Policy (Current: ${AutopilotService.formatPlanPolicyLabel(current)})`,
        });

        if (selected) {
          await autopilotService.setPlanReviewPolicy(selected.value);
        }
      }
    )
  );

  // Show Logs
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.showLogs', () => {
      quotaService.showOutputChannel();
    })
  );

  // Clear Activity History
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all recorded AI activity history logs?',
        'Clear History',
        'Cancel'
      );
      if (confirm === 'Clear History') {
        await taskSessionService.clearHistory();
        vscode.window.setStatusBarMessage('Activity history cleared.', 3000);
      }
    })
  );

  // Clean Quick Menu Shortcut (Ctrl+Alt+A / Cmd+Alt+A)
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityLimitMonitor.openQuickMenu', async () => {
      autopilotService.syncFromDisk(false);
      const cfg = autopilotService.getConfig();
      const summary = taskSessionService.getTodaySummary();
      const activityDesc =
        summary.logCountToday > 0
          ? `Used today: -${summary.totalUsedTodayPct}% (${summary.logCountToday} turns)`
          : 'View model quotas & activity history';

      const items: ActionQuickPickItem[] = [
        {
          label: 'Autopilot',
          kind: vscode.QuickPickItemKind.Separator,
        },
        {
          label: `$(zap) Toggle Turbo Autopilot`,
          description: `Currently: ${cfg.isTurboActive ? 'ON' : 'OFF'}`,
          action: 'toggleTurbo',
        },
        {
          label: 'Global Permissions',
          kind: vscode.QuickPickItemKind.Separator,
        },
        {
          label: '$(shield) Global Permissions: Turbo',
          description:
            cfg.permissionPreset === 'turbo'
              ? 'Active · Allow tools & commands without prompts'
              : 'Allow tools & commands without prompts',
          action: 'setPreset',
          preset: 'turbo',
        },
        {
          label: '$(shield) Global Permissions: Default',
          description:
            cfg.permissionPreset === 'default'
              ? 'Active · Standard permission prompts'
              : 'Standard permission prompts',
          action: 'setPreset',
          preset: 'default',
        },
        {
          label: '$(shield) Global Permissions: Request Review',
          description:
            cfg.permissionPreset === 'request_review'
              ? 'Active · Ask before commands & external edits'
              : 'Ask before commands & external edits',
          action: 'setPreset',
          preset: 'request_review',
        },
        {
          label: 'Agent Behavior',
          kind: vscode.QuickPickItemKind.Separator,
        },
        {
          label: '$(checklist) Plan Review Policy: Always Proceed',
          description:
            cfg.planReviewPolicy === 'always_proceed'
              ? 'Active · Auto-execute plans'
              : 'Auto-execute plans',
          action: 'setPolicy',
          policy: 'always_proceed',
        },
        {
          label: '$(checklist) Plan Review Policy: Always Ask',
          description:
            cfg.planReviewPolicy === 'always_ask'
              ? 'Active · Wait for user review'
              : 'Wait for user review',
          action: 'setPolicy',
          policy: 'always_ask',
        },
        {
          label: 'Quota & Monitoring',
          kind: vscode.QuickPickItemKind.Separator,
        },
        {
          label: '$(graph) Open Model Limit Dashboard',
          description: activityDesc,
          action: 'dashboard',
        },
        {
          label: '$(refresh) Refresh Quota Limits',
          description: 'Sync latest usage from Antigravity Engine',
          action: 'refresh',
        },
        {
          label: '$(sliders) Switch Status Bar Display Mode',
          description: 'All Models, 5h Only, Gemini Only, Compact, or Smart Lowest',
          action: 'format',
        },
        {
          label: '$(trash) Clear Activity History',
          description: 'Clear saved activity logs',
          action: 'clearHistory',
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Antigravity Autopilot — Permissions: ${AutopilotService.formatPresetLabel(cfg.permissionPreset)} · Plan: ${AutopilotService.formatPlanPolicyLabel(cfg.planReviewPolicy)}`,
      });

      if (!selected || !selected.action) return;

      switch (selected.action) {
        case 'toggleTurbo':
          await autopilotService.toggleTurboMode();
          break;
        case 'setPreset':
          if (selected.preset) {
            await autopilotService.setPermissionPreset(selected.preset);
          }
          break;
        case 'setPolicy':
          if (selected.policy) {
            await autopilotService.setPlanReviewPolicy(selected.policy);
          }
          break;
        case 'dashboard':
          DashboardWebviewPanel.createOrShow(
            context.extensionUri,
            quotaService,
            taskSessionService,
            autopilotService
          );
          break;
        case 'refresh':
          vscode.commands.executeCommand('antigravityLimitMonitor.refresh');
          break;
        case 'format':
          vscode.commands.executeCommand('antigravityLimitMonitor.toggleDisplayMode');
          break;
        case 'clearHistory':
          vscode.commands.executeCommand('antigravityLimitMonitor.clearHistory');
          break;
      }
    })
  );

  // Switch Status Bar Display Mode
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'antigravityLimitMonitor.toggleDisplayMode',
      async () => {
        const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
        const currentMode = config.get<string>('statusBarFormat', 'all');

        const modes = [
          {
            label: 'All Active Models',
            description:
              currentMode === 'all'
                ? 'Active · e.g. Gemi: 95% | Cl: 100% | Ar: 32%'
                : 'e.g. Gemi: 95% | Cl: 100% | Ar: 32%',
            value: 'all',
          },
          {
            label: '5-Hour Limit Preferred',
            description:
              currentMode === 'fiveHourOnly'
                ? 'Active · Shows 5h limit when available, weekly for weekly-only models'
                : 'Shows 5h limit when available, weekly for weekly-only models',
            value: 'fiveHourOnly',
          },
          {
            label: 'Gemini Family Only',
            description:
              currentMode === 'geminiOnly'
                ? 'Active · Shows Gemini & Argon models only'
                : 'Shows Gemini & Argon models only',
            value: 'geminiOnly',
          },
          {
            label: 'Compact',
            description:
              currentMode === 'compact'
                ? 'Active · e.g. Quota: 32% (Ar)'
                : 'e.g. Quota: 32% (Ar)',
            value: 'compact',
          },
          {
            label: 'Smart Lowest',
            description:
              currentMode === 'smartLowest'
                ? 'Active · Shows only the group with lowest remaining quota'
                : 'Shows only the group with lowest remaining quota',
            value: 'smartLowest',
          },
        ];

        const selected = await vscode.window.showQuickPick(modes, {
          placeHolder: 'Select Status Bar display format',
        });

        if (selected) {
          await config.update(
            'statusBarFormat',
            selected.value,
            vscode.ConfigurationTarget.Global
          );
          const current = quotaService.getLastQuotaInfo();
          if (current) {
            statusBarManager.update(current);
          }
        }
      }
    )
  );

  // Low quota warning notification check
  quotaService.on('quotaUpdated', (quota: ParsedQuotaInfo) => {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const threshold = config.get<number>('lowQuotaWarningThreshold', 20);

    if (threshold > 0 && quota.groups.length > 0 && quota.lowestFraction * 100 <= threshold) {
      if (!hasAlertedForLowQuota) {
        hasAlertedForLowQuota = true;
        const pct = QuotaService.formatPercentage(quota.lowestFraction);
        const groupSuffix = quota.lowestGroupName ? ` (${quota.lowestGroupName})` : '';
        vscode.window
          .showWarningMessage(
            `Low AI Model Quota${groupSuffix}: Remaining limit is ${pct}.`,
            'Open Dashboard',
            'Dismiss'
          )
          .then((choice) => {
            if (choice === 'Open Dashboard') {
              DashboardWebviewPanel.createOrShow(
                context.extensionUri,
                quotaService,
                taskSessionService,
                autopilotService
              );
            }
          });
      }
    } else if (quota.lowestFraction * 100 > threshold + 10) {
      hasAlertedForLowQuota = false;
    }
  });

  // Watch configuration updates
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityLimitMonitor.refreshIntervalSeconds')) {
        const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
        const interval = config.get<number>('refreshIntervalSeconds', 10);
        quotaService.startPolling(interval);
      }
      if (
        e.affectsConfiguration('antigravityLimitMonitor.statusBarFormat') ||
        e.affectsConfiguration('antigravityLimitMonitor.showStatusAlertColors')
      ) {
        const current = quotaService.getLastQuotaInfo();
        if (current) {
          statusBarManager.update(current);
        }
      }
    })
  );

  // On window focus, sync quota and external config updates
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        autopilotService.syncFromDisk(true);
        quotaService.refresh(false).catch(() => {});
      }
    })
  );

  // Start polling
  const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
  const interval = config.get<number>('refreshIntervalSeconds', 10);
  quotaService.startPolling(interval);

  context.subscriptions.push(statusBarManager);
}

export function deactivate() {
  if (autopilotService) {
    autopilotService.dispose();
  }

  if (quotaService) {
    quotaService.stopPolling();
  }

  if (taskSessionService) {
    taskSessionService.dispose();
  }

  if (statusBarManager) {
    statusBarManager.dispose();
  }
}
