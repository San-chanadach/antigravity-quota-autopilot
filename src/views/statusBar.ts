import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { TaskSessionService } from '../taskSessionService';
import { AutoAcceptService } from '../autoAcceptService';
import { ParsedQuotaInfo, QuotaBucket, QuotaGroup } from '../types';

export class StatusBarManager implements vscode.Disposable {
  private unifiedStatusBarItem: vscode.StatusBarItem;
  private quotaService: QuotaService;
  private taskSessionService: TaskSessionService;
  private autoAcceptService: AutoAcceptService;
  private lastQuota: ParsedQuotaInfo | undefined;

  constructor(
    quotaService: QuotaService,
    taskSessionService?: TaskSessionService,
    autoAcceptService?: AutoAcceptService
  ) {
    this.quotaService = quotaService;
    this.taskSessionService = taskSessionService || TaskSessionService.getInstance();
    this.autoAcceptService = autoAcceptService || AutoAcceptService.getInstance();

    // Single unified status bar item (Priority 100)
    // Clicking toggles Auto-Accept directly: Auto:ON <-> Auto:OFF
    this.unifiedStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.unifiedStatusBarItem.command = 'antigravityLimitMonitor.toggleAutoAccept';

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

    // Event listeners for Auto-Accept status
    this.autoAcceptService.on('stateChanged', () => this.render());
    this.autoAcceptService.on('choiceChanged', () => this.render());
  }

  public update(quota: ParsedQuotaInfo): void {
    this.lastQuota = quota;
    this.render();
  }

  private render(): void {
    const config = vscode.workspace.getConfiguration('antigravityLimitMonitor');
    const showAlertColors = config.get<boolean>('showStatusAlertColors', true);

    const isAuto = this.autoAcceptService.getStatus();
    const isCdp = this.autoAcceptService.getIsCdpAvailable();
    const autoStatus = isAuto ? (isCdp ? 'Auto:ON' : 'Auto:ON(Std)') : 'Auto:OFF';

    let gPct = '--%';
    let cPct = '--%';

    if (this.lastQuota) {
      const geminiGroup = this.lastQuota.groups.find((g) =>
        g.displayName.toLowerCase().includes('gemini')
      );
      const claudeGroup = this.lastQuota.groups.find(
        (g) =>
          g.displayName.toLowerCase().includes('claude') ||
          g.displayName.toLowerCase().includes('gpt') ||
          g.displayName.toLowerCase().includes('3p')
      );

      const gemini5h = this.findBucket(geminiGroup, '5h');
      const geminiWeekly = this.findBucket(geminiGroup, 'weekly');
      const claude5h = this.findBucket(claudeGroup, '5h');
      const claudeWeekly = this.findBucket(claudeGroup, 'weekly');

      const getEffectivePct = (bucket: QuotaBucket | undefined, weekly: QuotaBucket | undefined): string => {
        const target = bucket || weekly;
        if (!target) return '100%';
        if (target.disabled || (weekly && weekly.remainingFraction <= 0)) {
          return '0%';
        }
        return QuotaService.formatPercentage(target.remainingFraction);
      };

      gPct = getEffectivePct(gemini5h, geminiWeekly);
      cPct = getEffectivePct(claude5h, claudeWeekly);
    }

    // Exact format requested: Gemi:80% | Cl:80% Auto: ON
    this.unifiedStatusBarItem.text = `Gemi:${gPct} | Cl:${cPct} Auto: ${autoStatus}`;

    // Color indicators
    if (showAlertColors && this.lastQuota) {
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
        this.unifiedStatusBarItem.color = isAuto ? new vscode.ThemeColor('charts.green') : undefined;
      }
    } else {
      this.unifiedStatusBarItem.backgroundColor = undefined;
      this.unifiedStatusBarItem.color = isAuto ? new vscode.ThemeColor('charts.green') : undefined;
    }

    // Tooltip with mouse hover option picker!
    this.unifiedStatusBarItem.tooltip = this.buildCombinedTooltip();
  }

  public showQuotaError(err: Error): void {
    const isAuto = this.autoAcceptService.getStatus();
    const autoStatus = isAuto ? 'ON' : 'OFF';
    this.unifiedStatusBarItem.text = `$(warning) Gemi:--% | Cl:--% Auto: ${autoStatus}`;
    this.unifiedStatusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    this.unifiedStatusBarItem.color = undefined;
    this.unifiedStatusBarItem.tooltip = this.buildCombinedTooltip(err.message);
  }

  private findBucket(group: QuotaGroup | undefined, window: '5h' | 'weekly'): QuotaBucket | undefined {
    if (!group || !group.buckets || group.buckets.length === 0) return undefined;
    const match =
      group.buckets.find((b) => b.window === window) ||
      group.buckets.find((b) => b.bucketId.includes(window)) ||
      group.buckets.find((b) =>
        window === '5h'
          ? b.displayName.toLowerCase().includes('5-hour') || b.displayName.toLowerCase().includes('five hour')
          : b.displayName.toLowerCase().includes('weekly')
      );
    if (match) return match;
    if (window === 'weekly' && group.buckets.length === 1) {
      return group.buckets[0];
    }
    return undefined;
  }

  private buildCombinedTooltip(errorMessage?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const isAuto = this.autoAcceptService.getStatus();
    const choice = this.autoAcceptService.getChoice();
    const choiceLabel = this.autoAcceptService.getChoiceLabel();

    const isCdp = this.autoAcceptService.getIsCdpAvailable();
    const modeBadge = isCdp ? 'CDP Mode' : 'Standard Mode';

    // === SECTION 1: AUTO-ACCEPT OPTION SELECTION (MOUSE HOVER) ===
    md.appendMarkdown(`### $(zap) Auto-Accept: **${isAuto ? '$(check) ON' : '$(circle-slash) OFF'}** *(${modeBadge} · Click status bar to toggle)*\n\n`);
    md.appendMarkdown(`Current setting: **Option ${choice} — ${choiceLabel}**\n\n`);
    md.appendMarkdown(`**$(arrow-small-right) Select Option:**\n\n`);

    if (isCdp) {
      const opt1Active = choice === 1
        ? `**[$(check) Option 1: Allow once (Single prompt)  $(check) [Active]](command:antigravityLimitMonitor.selectOpt1)**`
        : `[$(circle-outline) Option 1: Allow once (Single prompt)](command:antigravityLimitMonitor.selectOpt1)`;

      const opt2Active = choice === 2
        ? `**[$(comment-discussion) Option 2: In conversation (Recommended)  $(check) [Active]](command:antigravityLimitMonitor.selectOpt2)**`
        : `[$(circle-outline) Option 2: In conversation (Recommended)](command:antigravityLimitMonitor.selectOpt2)`;

      const opt3Active = choice === 3
        ? `**[$(shield) Option 3: Always allow (Permanent)  $(check) [Active]](command:antigravityLimitMonitor.selectOpt3)**`
        : `[$(circle-outline) Option 3: Always allow (Permanent)](command:antigravityLimitMonitor.selectOpt3)`;

      md.appendMarkdown(`- ${opt1Active}\n`);
      md.appendMarkdown(`- ${opt2Active}\n`);
      md.appendMarkdown(`- ${opt3Active}\n\n`);
    } else {
      const opt1Active = `**[$(check) Option 1: Standard Auto (Native Engine)  $(check) [Active]](command:antigravityLimitMonitor.selectOpt1)**`;
      const opt2Locked = `$(lock) Option 2: In conversation *(Requires Debug Port 9333)*`;
      const opt3Locked = `$(lock) Option 3: Always allow *(Requires Debug Port 9333)*`;

      md.appendMarkdown(`- ${opt1Active}\n`);
      md.appendMarkdown(`- ${opt2Locked}\n`);
      md.appendMarkdown(`- ${opt3Locked}\n\n`);
      md.appendMarkdown(`*Tip: Standard Auto executes terminal commands and file edits directly via IDE native engine without needing Port 9333.*\n\n`);
    }
    md.appendMarkdown(`---\n\n`);

    // === SECTION 2: TODAY'S ACTIVITY SUMMARY ===
    const todaySummary = this.taskSessionService.getTodaySummary();
    if (todaySummary.logCountToday > 0) {
      md.appendMarkdown(`### $(history) Activity Today\n\n`);
      md.appendMarkdown(
        `- $(flame) **Used Today:** \`-${todaySummary.totalUsedTodayPct}%\` across \`${todaySummary.logCountToday}\` requests\n`
      );
      if (todaySummary.latestEntry) {
        const d = new Date(todaySummary.latestEntry.timestamp);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        md.appendMarkdown(
          `- $(history) **Latest:** \`-${todaySummary.latestEntry.usedPct}%\` (${todaySummary.latestEntry.groupName}) at ${timeStr}\n\n`
        );
      }
      md.appendMarkdown(`---\n\n`);
    }

    // === SECTION 3: AI LIMITS ===
    md.appendMarkdown(`### $(graph) Antigravity Model Usage Limits\n\n`);

    if (errorMessage) {
      md.appendMarkdown(`$(warning) *Offline: ${errorMessage}*\n\n`);
    } else if (this.lastQuota && this.lastQuota.groups.length > 0) {
      if (this.lastQuota.userEmail) {
        const planStr = this.lastQuota.planName ? ` (${this.lastQuota.planName})` : '';
        md.appendMarkdown(`- $(account) **Account:** \`${this.lastQuota.userEmail}\`${planStr}\n\n`);
      }

      for (const group of this.lastQuota.groups) {
        const isGemini = group.displayName.toLowerCase().includes('gemini');
        const icon = isGemini ? '$(sparkle)' : '$(hubot)';
        md.appendMarkdown(`**${icon} ${group.displayName}**\n\n`);

        for (const bucket of group.buckets) {
          if (bucket.disabled) {
            md.appendMarkdown(
              `- 🔴 **${bucket.displayName}:** \`0%\` *(does not apply - weekly limit reached)*\n`
            );
          } else {
            const pct = QuotaService.formatPercentage(bucket.remainingFraction);
            const resetStr = bucket.resetTime
              ? ` *($(clock) resets in ${QuotaService.formatTimeUntilReset(bucket.resetTime)})*`
              : '';

            const progressIcon = this.getProgressIndicator(bucket.remainingFraction);
            md.appendMarkdown(`- ${progressIcon} **${bucket.displayName}:** \`${pct}\`${resetStr}\n`);
          }
        }
        md.appendMarkdown(`\n`);
      }
      const timeStr = this.lastQuota.lastUpdated.toLocaleTimeString();
      md.appendMarkdown(`*$(history) Updated at: ${timeStr}*\n\n`);
    } else {
      md.appendMarkdown(`*$(sync~spin) Loading usage data from Language Server...*\n\n`);
    }

    md.appendMarkdown(
      `[$(dashboard) Dashboard](command:antigravityLimitMonitor.showDashboard) | [$(refresh) Refresh](command:antigravityLimitMonitor.refresh) | [$(settings-gear) Quick Menu](command:antigravityLimitMonitor.openQuickMenu)`
    );

    return md;
  }

    private getProgressIndicator(fraction: number): string {
    if (fraction >= 0.75) return '🟢';
    if (fraction >= 0.35) return '🟡';
    return '🔴';
  }

  public dispose(): void {
    this.unifiedStatusBarItem.dispose();
  }
}
