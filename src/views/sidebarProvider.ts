import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { AutopilotService } from '../autopilotService';
import { QuotaBucket, QuotaGroup } from '../types';

export class QuotaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: 'autopilot' | 'group' | 'bucket' | 'info' | 'error',
    public readonly group?: QuotaGroup,
    public readonly bucket?: QuotaBucket,
    public readonly infoText?: string
  ) {
    super(label, collapsibleState);

    if (itemType === 'autopilot') {
      this.contextValue = 'autopilotStatus';
      this.description = infoText;
      this.tooltip = 'Click to configure Global Permissions and Plan Review Policy (Ctrl+Alt+A)';
      this.command = {
        command: 'antigravityLimitMonitor.openQuickMenu',
        title: 'Open Autopilot Quick Menu',
      };
    } else if (itemType === 'group' && group) {
      this.contextValue = 'quotaGroup';
      const info = QuotaService.getGroupEffectiveQuota(group, 'effective');
      this.description = info.pct;
      this.tooltip = group.description || group.displayName;
    } else if (itemType === 'bucket' && bucket) {
      this.contextValue = 'quotaBucket';

      if (bucket.disabled) {
        this.description = '0% · Weekly limit reached';
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        this.tooltip = new vscode.MarkdownString(
          `**${bucket.displayName}**\n\n` +
            `- Status: Weekly limit reached\n` +
            (bucket.description ? `\n_${bucket.description}_` : '')
        );
      } else {
        const pct = QuotaService.formatPercentage(bucket.remainingFraction);
        this.description = bucket.resetTime
          ? `${pct} · ${QuotaService.formatTimeUntilReset(bucket.resetTime)}`
          : pct;

        // Functional status color indicator only
        if (bucket.remainingFraction > 0.35) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
        } else if (bucket.remainingFraction > 0.15) {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
        } else {
          this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        }

        this.tooltip = new vscode.MarkdownString(
          `**${bucket.displayName}**\n\n` +
            `- Remaining: **${pct}**\n` +
            (bucket.resetTime
              ? `- Resets in: **${QuotaService.formatTimeUntilReset(bucket.resetTime)}**\n`
              : '') +
            (bucket.description ? `\n_${bucket.description}_` : '')
        );
      }
    } else if (itemType === 'error') {
      this.contextValue = 'quotaError';
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
      this.description = infoText || 'Click to retry';
      this.tooltip = 'Click to retry connecting to Antigravity Language Server';
      this.command = {
        command: 'antigravityLimitMonitor.refresh',
        title: 'Retry Limit Monitor',
      };
    } else if (itemType === 'info') {
      this.contextValue = 'quotaInfo';
      this.description = infoText;
    }
  }
}

export class QuotaTreeDataProvider implements vscode.TreeDataProvider<QuotaTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<QuotaTreeItem | undefined | null | void> =
    new vscode.EventEmitter<QuotaTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<QuotaTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private quotaService: QuotaService;
  private autopilotService: AutopilotService;
  private lastError: Error | null = null;

  constructor(quotaService: QuotaService, autopilotService?: AutopilotService) {
    this.quotaService = quotaService;
    this.autopilotService = autopilotService || AutopilotService.getInstance(quotaService);

    this.quotaService.on('quotaUpdated', () => {
      this.lastError = null;
      this._onDidChangeTreeData.fire();
    });
    this.quotaService.on('error', (err: Error) => {
      this.lastError = err;
      this._onDidChangeTreeData.fire();
    });
    this.autopilotService.on('configChanged', () => {
      this._onDidChangeTreeData.fire();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: QuotaTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: QuotaTreeItem): Promise<QuotaTreeItem[]> {
    const quota = this.quotaService.getLastQuotaInfo();

    if (!element) {
      const items: QuotaTreeItem[] = [];

      // Autopilot control summary at top
      const cfg = this.autopilotService.getConfig();
      const presetStr = AutopilotService.formatPresetLabel(cfg.permissionPreset);
      const planStr = AutopilotService.formatPlanPolicyLabel(cfg.planReviewPolicy);
      const statusDot = cfg.isTurboActive ? '🟢' : '🟡';
      items.push(
        new QuotaTreeItem(
          `${statusDot} Autopilot`,
          vscode.TreeItemCollapsibleState.None,
          'autopilot',
          undefined,
          undefined,
          `${presetStr} · ${planStr}`
        )
      );

      if (!quota) {
        if (this.lastError) {
          items.push(
            new QuotaTreeItem(
              'Language Server Offline',
              vscode.TreeItemCollapsibleState.None,
              'error',
              undefined,
              undefined,
              'Click to retry'
            )
          );
        } else {
          items.push(
            new QuotaTreeItem(
              'Connecting...',
              vscode.TreeItemCollapsibleState.None,
              'info',
              undefined,
              undefined,
              'Please wait'
            )
          );
        }
        return items;
      }

      if (this.lastError) {
        items.push(
          new QuotaTreeItem(
            'Sync Warning',
            vscode.TreeItemCollapsibleState.None,
            'error',
            undefined,
            undefined,
            'Retry sync'
          )
        );
      }

      for (const group of quota.groups) {
        items.push(
          new QuotaTreeItem(
            group.displayName,
            vscode.TreeItemCollapsibleState.Expanded,
            'group',
            group
          )
        );
      }

      items.push(
        new QuotaTreeItem(
          'Last Synced',
          vscode.TreeItemCollapsibleState.None,
          'info',
          undefined,
          undefined,
          quota.lastUpdated.toLocaleTimeString()
        )
      );

      if (quota.userEmail) {
        items.push(
          new QuotaTreeItem(
            'Account',
            vscode.TreeItemCollapsibleState.None,
            'info',
            undefined,
            undefined,
            `${quota.userEmail}${quota.planName ? ' (' + quota.planName + ')' : ''}`
          )
        );
      }

      return items;
    }

    if (element.itemType === 'group' && element.group) {
      return element.group.buckets.map((bucket) => {
        return new QuotaTreeItem(
          bucket.displayName,
          vscode.TreeItemCollapsibleState.None,
          'bucket',
          element.group,
          bucket
        );
      });
    }

    return [];
  }
}
