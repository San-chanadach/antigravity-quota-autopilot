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
  private transcriptWatcher: fs.FSWatcher | null = null;
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

  private setupTranscriptWatcher(): void {
    try {
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
      if (!fs.existsSync(brainDir)) return;

      this.transcriptWatcher = fs.watch(brainDir, { recursive: true }, (_eventType, filename) => {
        if (filename && (filename.includes('transcript') || filename.includes('logs'))) {
          this.triggerInstantQuotaCheck();
        }
      });
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
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
      if (!fs.existsSync(brainDir)) return undefined;

      const brains = fs
        .readdirSync(brainDir)
        .filter((b) => b.length > 20 && !b.startsWith('.'));
      if (brains.length === 0) return undefined;

      // Find transcripts sorted by mtime descending
      const sorted = brains
        .map((b) => {
          const p = path.join(brainDir, b, '.system_generated', 'logs', 'transcript.jsonl');
          return fs.existsSync(p) ? { p, mtime: fs.statSync(p).mtimeMs } : null;
        })
        .filter((x): x is { p: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime);

      if (sorted.length === 0) return undefined;

      const content = fs.readFileSync(sorted[0].p, 'utf8');
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

    for (const group of quota.groups) {
      for (const bucket of group.buckets) {
        if (typeof bucket.remainingFraction !== 'number') continue;

        const bucketId = bucket.bucketId;
        const currentFrac = bucket.remainingFraction;
        currentSnapshots[bucketId] = currentFrac;

        const prevFrac = this.previousSnapshots[bucketId];
        if (typeof prevFrac === 'number') {
          const delta = prevFrac - currentFrac;
          // Trigger when delta >= 0.0001 (0.01%) - captures all AI turns
          if (delta >= 0.0001) {
            const entry: ActivityLogEntry = {
              id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
              timestamp: new Date().toISOString(),
              promptTitle,
              groupName: group.displayName,
              bucketDisplayName: bucket.displayName,
              window: bucket.window || '5h',
              usedDeltaFraction: delta,
              usedPct: Math.round(delta * 1000) / 10,
              remainingFraction: currentFrac,
              remainingPct: Math.round(currentFrac * 1000) / 10,
            };
            newEntries.push(entry);
          }
        }
      }
    }

    this.previousSnapshots = currentSnapshots;
    await this.globalState.update(this.SNAPSHOT_KEY, currentSnapshots);

    if (newEntries.length > 0) {
      await this.saveEntriesToHistory(newEntries);
      this.emit('activityLogged', newEntries, this.getHistory());
    }
  }

  public getHistory(): ActivityLogEntry[] {
    return this.globalState.get<ActivityLogEntry[]>(this.HISTORY_KEY, []);
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

  public getTodaySummary(): { totalUsedTodayPct: number; logCountToday: number; latestEntry: ActivityLogEntry | null } {
    const history = this.getHistory();
    const today = new Date().toDateString();
    let totalUsedTodayPct = 0;
    let logCountToday = 0;

    for (const entry of history) {
      if (new Date(entry.timestamp).toDateString() === today) {
        totalUsedTodayPct += entry.usedPct;
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
    if (this.transcriptWatcher) {
      this.transcriptWatcher.close();
      this.transcriptWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
