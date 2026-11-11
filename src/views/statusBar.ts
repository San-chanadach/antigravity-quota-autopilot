import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { TaskSessionService } from '../taskSessionService';
import { AutopilotService } from '../autopilotService';
import { ParsedQuotaInfo, PermissionPreset, PlanReviewPolicy, QuotaGroup } from '../types';

export class StatusBarManager implements vscode.Disposable {
  private unifiedStatusBarItem: vscode.StatusBarItem;
  private quotaService: QuotaService;
  private taskSessionService: TaskSessionService;
  private autopilotService: AutopilotService;
  private lastQuota: ParsedQuotaInfo | undefined;

  constructor(
    quotaService: QuotaService,
    taskSessionService?: TaskSessionService,
    autopilotService?: AutopilotService
  ) {
    this.quotaService = quotaService;
    this.taskSessionService = taskSessionService || TaskSessionService.getInstance();
    this.autopilotService = autopilotService || AutopilotService.getInstance(quotaService);

    // Single unified status bar item (Priority 100)
    // Clicking toggles Turbo Autopilot directly: Turbo: ON <-> Turbo: OFF
    this.unifiedStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.unifiedStatusBarItem.command = 'antigravityLimitMonitor.toggleTurbo';

    this.render();
    this.unifiedStatusBarItem.show();

    // Event listeners for Quota
    this.quotaService.on('quotaUpdated', (quota: ParsedQuotaInfo) => {
      this.lastQuota = quota;
      this.render();
    });

    this.quotaService.on('error', (err: Error) => {
      this.showQuotaError(err);
    });

    // Event listeners for Automatic Activity Logger
    this.taskSessionService.on('activityLogged', () => this.render());
    this.taskSessionService.on('historyCleared', () => this.render());

    // Event listener for Native Autopilot settings
    this.autopilotService.on('configChanged', () => this.render());
  }

  public update(quota: ParsedQuotaInfo): void {
    this.lastQuota = quota;
    this.render();
  }

  private render(): void {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const format = config.get<string>('statusBarFormat', 'all');
    const showAlertColors = config.get<boolean>('showStatusAlertColors', true);

    const isTurbo = this.autopilotService.isTurboActive();
    const turboText = isTurbo ? 'Turbo: ON' : 'Turbo: OFF';

    let quotaPart = 'Quota: ...';

    if (this.lastQuota && this.lastQuota.groups.length > 0) {
      quotaPart = this.formatQuotaSegments(this.lastQuota.groups, format);
    } else if (this.lastQuota && this.lastQuota.groups.length === 0) {
      quotaPart = 'Quota: N/A';
    }

    this.unifiedStatusBarItem.text = `${quotaPart} | ${turboText}`;

    // Minimalist status alert colors
    if (showAlertColors && this.lastQuota && this.lastQuota.groups.length > 0) {
      if (this.lastQuota.lowestFraction <= 0.15) {
        this.unifiedStatusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        this.unifiedStatusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      } else if (this.lastQuota.lowestFraction <= 0.35) {
        this.unifiedStatusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        this.unifiedStatusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      } else {
        this.unifiedStatusBarItem.backgroundColor = undefined;
        this.unifiedStatusBarItem.color = isTurbo ? new vscode.ThemeColor('charts.green') : undefined;
      }
    } else {
      this.unifiedStatusBarItem.backgroundColor = undefined;
      this.unifiedStatusBarItem.color = isTurbo ? new vscode.ThemeColor('charts.green') : undefined;
    }

    this.unifiedStatusBarItem.tooltip = this.buildCombinedTooltip();
  }

  private formatQuotaSegments(groups: QuotaGroup[], format: string): string {
    if (format === 'compact' || format === 'smartLowest') {
      let lowestGroup = groups[0];
      let lowestInfo = QuotaService.getGroupEffectiveQuota(groups[0], 'fiveHourPreferred');

      for (let i = 1; i < groups.length; i++) {
        const info = QuotaService.getGroupEffectiveQuota(groups[i], 'fiveHourPreferred');
        if (info.fraction < lowestInfo.fraction) {
          lowestInfo = info;
          lowestGroup = groups[i];
        }
      }

      const shortLabel = QuotaService.getShortGroupLabel(lowestGroup);
      if (format === 'compact') {
        return groups.length > 1
          ? `Quota: ${lowestInfo.pct} (${shortLabel})`
          : `Quota: ${lowestInfo.pct}`;
      }
      return `${shortLabel}: ${lowestInfo.pct}`;
    }

    let targetGroups = groups;
    if (format === 'geminiOnly') {
      const geminiGroups = groups.filter((g) => {
        const t = QuotaService.identifyGroupType(g);
        return t === 'gemini' || t === 'argon';
      });
      if (geminiGroups.length > 0) {
        targetGroups = geminiGroups;
      }
    }

    const segments = targetGroups.map((group) => {
      const label = QuotaService.getShortGroupLabel(group);
      const info = QuotaService.getGroupEffectiveQuota(group, 'fiveHourPreferred');
      return `${label}: ${info.pct}`;
    });

    return segments.join(' | ');
  }

  public showQuotaError(err: Error): void {
    const isTurbo = this.autopilotService.isTurboActive();
    const turboText = isTurbo ? 'Turbo: ON' : 'Turbo: OFF';

    if (!this.lastQuota) {
      this.unifiedStatusBarItem.text = `Quota: Offline | ${turboText}`;
      this.unifiedStatusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      this.unifiedStatusBarItem.color = undefined;
    }
    this.unifiedStatusBarItem.tooltip = this.buildCombinedTooltip(err.message);
  }

  private buildCmdUri(command: string, ...args: any[]): string {
    if (args.length === 0) {
      return `command:${command}`;
    }
    return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
  }

  private buildCombinedTooltip(errorMessage?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = false;

    const autopilot = this.autopilotService.getConfig();
    const cleanTier = QuotaService.getNormalizedPlanLabel(
      this.lastQuota?.accountTier,
      this.lastQuota?.planName
    );
    const planBadge = cleanTier ? ` · \`${cleanTier}\`` : '';

    md.appendMarkdown(`**Antigravity Quota & Autopilot**${planBadge}\n\n`);

    if (this.lastQuota?.userEmail) {
      md.appendMarkdown(`Account: \`${this.lastQuota.userEmail}\`\n\n`);
    }

    // === SECTION 1: MINIMALIST QUOTA TABLE (SEPARATED 5-HOUR & WEEKLY COLUMNS) ===
    if (errorMessage && (!this.lastQuota || this.lastQuota.groups.length === 0)) {
      md.appendMarkdown(`🔴 Offline: ${errorMessage}\n\n`);
    } else if (this.lastQuota && this.lastQuota.groups.length > 0) {
      md.appendMarkdown(`| Model Group | 5-Hour Limit | Weekly Limit |\n`);
      md.appendMarkdown(`| :--- | :--- | :--- |\n`);

      for (const group of this.lastQuota.groups) {
        const row = this.formatTooltipGroupRow(group);
        md.appendMarkdown(
          `| ${row.dot} ${group.displayName} | ${row.fiveHourCol} | ${row.weeklyCol} |\n`
        );
      }
      md.appendMarkdown(`\n`);
    } else {
      md.appendMarkdown(`Loading model quota limits...\n\n`);
    }

    md.appendMarkdown(`---\n\n`);

    // === SECTION 2: NATIVE AUTOPILOT CONTROLS ===
    const presets: { key: PermissionPreset; label: string }[] = [
      { key: 'turbo', label: 'Turbo' },
      { key: 'default', label: 'Default' },
      { key: 'request_review', label: 'Request Review' },
    ];
    const presetLinks = presets
      .map((p) =>
        autopilot.permissionPreset === p.key
          ? `**[${p.label}]**`
          : `[${p.label}](${this.buildCmdUri('antigravityLimitMonitor.setPermissionPreset', p.key)})`
      )
      .join(' · ');

    const policies: { key: PlanReviewPolicy; label: string }[] = [
      { key: 'always_proceed', label: 'Always Proceed' },
      { key: 'always_ask', label: 'Always Ask' },
    ];
    const policyLinks = policies
      .map((p) =>
        autopilot.planReviewPolicy === p.key
          ? `**[${p.label}]**`
          : `[${p.label}](${this.buildCmdUri('antigravityLimitMonitor.setPlanReviewPolicy', p.key)})`
      )
      .join(' · ');

    md.appendMarkdown(`**Global Permissions:** ${presetLinks}\n\n`);
    md.appendMarkdown(`**Plan Review Policy:** ${policyLinks}\n\n`);
    md.appendMarkdown(`---\n\n`);

    // === SECTION 3: SUMMARY & QUICK ACTIONS ===
    const todaySummary = this.taskSessionService.getTodaySummary();
    const metaParts: string[] = [];
    if (todaySummary.logCountToday > 0) {
      metaParts.push(
        `Used today (5h): \`-${todaySummary.totalUsedTodayPct}%\` (${todaySummary.logCountToday} turns)`
      );
    }
    if (this.lastQuota) {
      metaParts.push(
        `Synced ${this.lastQuota.lastUpdated.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}`
      );
    }
    if (metaParts.length > 0) {
      md.appendMarkdown(`${metaParts.join(' · ')}\n\n`);
    }

    const toggleLabel = autopilot.isTurboActive ? 'Turn Turbo OFF' : 'Turn Turbo ON';
    md.appendMarkdown(
      `[${toggleLabel}](command:antigravityLimitMonitor.toggleTurbo) · ` +
        `[Dashboard](command:antigravityLimitMonitor.showDashboard) · ` +
        `[Refresh](command:antigravityLimitMonitor.refresh) · ` +
        `[Quick Menu](command:antigravityLimitMonitor.openQuickMenu)`
    );

    return md;
  }

  private formatTooltipGroupRow(group: QuotaGroup): {
    dot: string;
    fiveHourCol: string;
    weeklyCol: string;
  } {
    const info = QuotaService.getGroupEffectiveQuota(group, 'fiveHourPreferred');
    const dot = this.getStatusDot(info.fraction);

    if (info.weeklyBucket && info.weeklyBucket.remainingFraction <= 0) {
      const wReset = QuotaService.formatTimeUntilReset(info.weeklyBucket.resetTime);
      return {
        dot: '🔴',
        fiveHourCol: '**0%** (Blocked)',
        weeklyCol: `**0%**${wReset ? ` (${wReset})` : ''}`,
      };
    }

    let fiveHourCol = '—';
    if (info.fiveHourBucket) {
      const hFrac = info.fiveHourBucket.disabled ? 0 : info.fiveHourBucket.remainingFraction;
      const hPct = QuotaService.formatPercentage(hFrac);
      const hReset = QuotaService.formatTimeUntilReset(info.fiveHourBucket.resetTime);
      fiveHourCol = `**${hPct}**${hReset ? ` (${hReset})` : ''}`;
    }

    let weeklyCol = '—';
    if (info.weeklyBucket) {
      const wFrac = info.weeklyBucket.disabled ? 0 : info.weeklyBucket.remainingFraction;
      const wPct = QuotaService.formatPercentage(wFrac);
      const wReset = QuotaService.formatTimeUntilReset(info.weeklyBucket.resetTime);
      const formattedPct = info.isWeeklyOnly ? `**${wPct}**` : wPct;
      weeklyCol = `${formattedPct}${wReset ? ` (${wReset})` : ''}`;
    }

    return {
      dot,
      fiveHourCol,
      weeklyCol,
    };
  }

  private getStatusDot(fraction: number): string {
    if (fraction > 0.35) return '🟢';
    if (fraction > 0.15) return '🟡';
    return '🔴';
  }

  public dispose(): void {
    this.unifiedStatusBarItem.dispose();
  }
}
