import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { QuotaService } from './quotaService';
import { ActivityLogEntry, ParsedQuotaInfo } from './types';

export class TaskSessionService extends EventEmitter {
  private static instance: TaskSessionService;
  private globalState: vscode.Memento;
  private quotaService: QuotaService;
  private previousSnapshots: { [bucketId: string]: number } | null = null;
  private transcriptWatchers: fs.FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly HISTORY_KEY = 'antigravity_activity_history_v2';
  private readonly SNAPSHOT_KEY = 'antigravity_baseline_snapshots_v2';
  private readonly MAX_HISTORY_ITEMS = 1000;

  private constructor(globalState: vscode.Memento, quotaService: QuotaService) {
    super();
    this.globalState = globalState;
    this.quotaService = quotaService;

    // Load persisted baseline snapshots from previous sessions if available
    this.previousSnapshots = this.globalState.get<{ [bucketId: string]: number } | null>(
      this.SNAPSHOT_KEY,
      null
    );

    // Listen for quota updates to automatically detect consumption
    this.quotaService.on('quotaUpdated', (quota: ParsedQuotaInfo) => {
      this.processQuotaUpdate(quota);
    });

    // If no persisted baseline, record current quota immediately
    const last = this.quotaService.getLastQuotaInfo();
    if (last && !this.previousSnapshots) {
      this.recordBaseline(last);
    }

    // Set up instant FileSystem watcher on Antigravity transcript logs
    this.setupTranscriptWatcher();
  }

  public static getInstance(globalState?: vscode.Memento, quotaService?: QuotaService): TaskSessionService {
    if (!TaskSessionService.instance) {
      if (!globalState || !quotaService) {
        throw new Error('TaskSessionService must be initialized with globalState and quotaService');
      }
      TaskSessionService.instance = new TaskSessionService(globalState, quotaService);
    }
    return TaskSessionService.instance;
  }

  private getCandidateBrainDirs(): string[] {
    const dirs = [
      path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
      path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'),
    ];
    return dirs.filter((d) => fs.existsSync(d));
  }

  private setupTranscriptWatcher(): void {
    try {
      const brainDirs = this.getCandidateBrainDirs();
      for (const brainDir of brainDirs) {
        try {
          const watcher = fs.watch(brainDir, { recursive: true }, (_eventType, filename) => {
            if (filename && (filename.includes('transcript') || filename.includes('logs'))) {
              this.triggerInstantQuotaCheck();
            }
          });
          this.transcriptWatchers.push(watcher);
        } catch {}
      }
    } catch {}
  }

  private triggerInstantQuotaCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    // Fast initial check 800ms after transcript activity
    this.debounceTimer = setTimeout(() => {
      this.quotaService.refresh(false).catch(() => {});
      // Secondary follow-up check 2.5s later to catch final server token accounting
      setTimeout(() => {
        this.quotaService.refresh(false).catch(() => {});
      }, 2500);
    }, 800);
  }

  private recordBaseline(quota: ParsedQuotaInfo): void {
    const snapshots: { [bucketId: string]: number } = {};
    for (const group of quota.groups) {
      for (const bucket of group.buckets) {
        if (typeof bucket.remainingFraction === 'number') {
          snapshots[bucket.bucketId] = bucket.remainingFraction;
        }
      }
    }
    this.previousSnapshots = snapshots;
    this.globalState.update(this.SNAPSHOT_KEY, snapshots);
  }

  private getLatestPromptTitle(): string | undefined {
    try {
      const brainDirs = this.getCandidateBrainDirs();
      if (brainDirs.length === 0) return undefined;

      const candidates: { p: string; mtime: number }[] = [];

      for (const brainDir of brainDirs) {
        try {
          const brains = fs
            .readdirSync(brainDir)
            .filter((b) => b.length > 20 && !b.startsWith('.'));
          
          for (const b of brains) {
            const p = path.join(brainDir, b, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(p)) {
              candidates.push({ p, mtime: fs.statSync(p).mtimeMs });
            }
          }
        } catch {}
      }

      candidates.sort((a, b) => b.mtime - a.mtime);
      if (candidates.length === 0) return undefined;

      const content = fs.readFileSync(candidates[0].p, 'utf8');
      const lines = content.trim().split('\n');

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          if (j.type === 'USER_INPUT' && j.content) {
            let text = String(j.content);

            // Ignore system checkpoint summary
            if (text.includes('{{ CHECKPOINT') && !text.includes('<USER_REQUEST>')) {
              continue;
            }

            const userMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
            if (userMatch) {
              text = userMatch[1];
            }

            const clean = text
              .replace(/\{\{[\s\S]*?\}\}/g, '')
              .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
              .replace(/```[\s\S]*?```/g, '')
              .replace(/`[^`]+`/g, '')
              .replace(/[\r\n\t]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            if (clean.length > 1) {
              return clean.length > 65 ? clean.substring(0, 62) + '...' : clean;
            }
          }
        } catch {}
      }
    } catch {}
    return undefined;
  }

  private async processQuotaUpdate(quota: ParsedQuotaInfo): Promise<void> {
    if (!this.previousSnapshots) {
      this.recordBaseline(quota);
      return;
    }

    const newEntries: ActivityLogEntry[] = [];
    const currentSnapshots: { [bucketId: string]: number } = {};
    const promptTitle = this.getLatestPromptTitle();
    const nowIso = new Date().toISOString();

    for (const group of quota.groups) {
      const fiveHourBucket = QuotaService.findBucket(group, '5h');
      const weeklyBucket = QuotaService.findBucket(group, 'weekly');

      let fiveHourDelta = 0;
      let weeklyDelta = 0;

      for (const bucket of group.buckets) {
        if (typeof bucket.remainingFraction !== 'number') continue;
        const bucketId = bucket.bucketId;
        const currentFrac = bucket.remainingFraction;
        currentSnapshots[bucketId] = currentFrac;

        const prevFrac = this.previousSnapshots[bucketId];
        if (typeof prevFrac === 'number') {
          const delta = prevFrac - currentFrac;
          if (delta >= 0.0001) {
            if (fiveHourBucket && bucket.bucketId === fiveHourBucket.bucketId) {
              fiveHourDelta = delta;
            } else if (weeklyBucket && bucket.bucketId === weeklyBucket.bucketId) {
              weeklyDelta = delta;
            } else {
              const isWeekly =
                bucket.window === 'weekly' ||
                (bucket.bucketId || '').toLowerCase().includes('weekly') ||
                (bucket.displayName || '').toLowerCase().includes('weekly');
              if (isWeekly) {
                weeklyDelta = delta;
              } else {
                fiveHourDelta = delta;
              }
            }
          }
        }
      }

      // Create a single unified turn record if either 5-hour or weekly quota was consumed
      if (fiveHourDelta >= 0.0001 || weeklyDelta >= 0.0001) {
        const has5h = fiveHourDelta >= 0.0001 && !!fiveHourBucket;
        const primaryWindow = has5h ? '5h' : 'weekly';
        const primaryDelta = has5h ? fiveHourDelta : weeklyDelta;
        const primaryBucket = has5h ? fiveHourBucket! : (weeklyBucket || group.buckets[0]);
        const primaryRemFrac =
          typeof primaryBucket?.remainingFraction === 'number'
            ? primaryBucket.remainingFraction
            : 1.0;

        const fiveHourUsedPct =
          fiveHourDelta >= 0.0001 ? Math.round(fiveHourDelta * 1000) / 10 : undefined;
        const fiveHourRemainingPct =
          fiveHourBucket && typeof fiveHourBucket.remainingFraction === 'number'
            ? Math.round(fiveHourBucket.remainingFraction * 1000) / 10
            : undefined;

        const weeklyUsedPct =
          weeklyDelta >= 0.0001 ? Math.round(weeklyDelta * 1000) / 10 : undefined;
        const weeklyRemainingPct =
          weeklyBucket && typeof weeklyBucket.remainingFraction === 'number'
            ? Math.round(weeklyBucket.remainingFraction * 1000) / 10
            : undefined;

        const entry: ActivityLogEntry = {
          id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
          timestamp: nowIso,
          promptTitle,
          groupName: group.displayName,
          bucketDisplayName: primaryBucket?.displayName || 'Quota Limit',
          window: primaryWindow,
          usedDeltaFraction: primaryDelta,
          usedPct: Math.round(primaryDelta * 1000) / 10,
          remainingFraction: primaryRemFrac,
          remainingPct: Math.round(primaryRemFrac * 1000) / 10,
          fiveHourUsedPct,
          fiveHourRemainingPct,
          weeklyUsedPct,
          weeklyRemainingPct,
        };
        newEntries.push(entry);
      }
    }

    this.previousSnapshots = currentSnapshots;
    await this.globalState.update(this.SNAPSHOT_KEY, currentSnapshots);

    if (newEntries.length > 0) {
      await this.saveEntriesToHistory(newEntries);
      this.emit('activityLogged', newEntries, this.getHistory());
    }
  }

  /**
   * Normalizes and merges legacy split records (where a single turn produced two separate entries
   * for 5h and weekly at the same timestamp) into unified turn entries.
   */
  private normalizeHistoryEntries(raw: ActivityLogEntry[]): ActivityLogEntry[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const merged: ActivityLogEntry[] = [];
    let i = 0;

    while (i < raw.length) {
      const curr = { ...raw[i] };

      // Ensure unified fields are populated on legacy single entries
      if (curr.fiveHourUsedPct === undefined && curr.weeklyUsedPct === undefined) {
        if (curr.window === 'weekly') {
          curr.weeklyUsedPct = curr.usedPct;
          curr.weeklyRemainingPct = curr.remainingPct;
        } else {
          curr.fiveHourUsedPct = curr.usedPct;
          curr.fiveHourRemainingPct = curr.remainingPct;
        }
      }

      // Check if next item is a split companion from the same turn (same group, opposite window, within 3s)
      if (i + 1 < raw.length) {
        const next = raw[i + 1];
        const t1 = new Date(curr.timestamp).getTime();
        const t2 = new Date(next.timestamp).getTime();
        const timeDiff = Math.abs(t1 - t2);

        const isOppositeWindow =
          (curr.window === '5h' && next.window === 'weekly') ||
          (curr.window === 'weekly' && next.window === '5h');

        if (
          curr.groupName === next.groupName &&
          isOppositeWindow &&
          timeDiff <= 3000 &&
          next.fiveHourUsedPct === undefined &&
          next.weeklyUsedPct === undefined
        ) {
          const fiveItem = curr.window === '5h' ? curr : next;
          const weekItem = curr.window === 'weekly' ? curr : next;

          const unified: ActivityLogEntry = {
            id: fiveItem.id,
            timestamp: fiveItem.timestamp,
            promptTitle: fiveItem.promptTitle || weekItem.promptTitle,
            groupName: fiveItem.groupName,
            bucketDisplayName: fiveItem.bucketDisplayName,
            window: '5h',
            usedDeltaFraction: fiveItem.usedDeltaFraction,
            usedPct: fiveItem.usedPct,
            remainingFraction: fiveItem.remainingFraction,
            remainingPct: fiveItem.remainingPct,
            fiveHourUsedPct: fiveItem.usedPct,
            fiveHourRemainingPct: fiveItem.remainingPct,
            weeklyUsedPct: weekItem.usedPct,
            weeklyRemainingPct: weekItem.remainingPct,
          };
          merged.push(unified);
          i += 2;
          continue;
        }
      }

      merged.push(curr);
      i++;
    }

    return merged;
  }

  public getHistory(): ActivityLogEntry[] {
    const raw = this.globalState.get<ActivityLogEntry[]>(this.HISTORY_KEY, []);
    return this.normalizeHistoryEntries(raw);
  }

  private async saveEntriesToHistory(entries: ActivityLogEntry[]): Promise<void> {
    const history = this.getHistory();
    history.unshift(...entries);
    if (history.length > this.MAX_HISTORY_ITEMS) {
      history.splice(this.MAX_HISTORY_ITEMS);
    }
    await this.globalState.update(this.HISTORY_KEY, history);
  }

  public async clearHistory(): Promise<void> {
    await this.globalState.update(this.HISTORY_KEY, []);
    this.emit('historyCleared', []);
  }

  public getTodaySummary(): {
    totalUsedTodayPct: number;
    logCountToday: number;
    latestEntry: ActivityLogEntry | null;
  } {
    const history = this.getHistory();
    const today = new Date().toDateString();
    let totalUsedTodayPct = 0;
    let logCountToday = 0;

    for (const entry of history) {
      if (new Date(entry.timestamp).toDateString() === today) {
        // Count only primary turn delta (5-Hour when available, or Weekly for weekly-only models)
        const primaryDelta =
          typeof entry.fiveHourUsedPct === 'number'
            ? entry.fiveHourUsedPct
            : entry.usedPct;
        totalUsedTodayPct += primaryDelta;
        logCountToday++;
      }
    }

    return {
      totalUsedTodayPct: Math.round(totalUsedTodayPct * 10) / 10,
      logCountToday,
      latestEntry: history.length > 0 ? history[0] : null,
    };
  }

  public dispose(): void {
    for (const watcher of this.transcriptWatchers) {
      try {
        watcher.close();
      } catch {}
    }
    this.transcriptWatchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
