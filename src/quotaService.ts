import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
  AccountTier,
  LanguageServerConnection,
  ModelGroupType,
  ParsedQuotaInfo,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryResponse,
} from './types';

const execAsync = promisify(exec);

interface CandidateProcess {
  pid: string;
  csrfToken: string;
  ports: number[];
  httpPort?: number;
  httpsPort?: number;
  isIde: boolean;
  isWorkspaceMatch: boolean;
  isHubSubclient?: boolean;
  useHttp: boolean;
  numPid: number;
  createTime?: number;
  source?: 'daemon_file' | 'process_scan' | 'settings';
}

interface UserStatusResult {
  name?: string;
  email?: string;
  planName?: string;
  rawUserStatus?: any;
}

export class QuotaService extends EventEmitter {
  private static instance: QuotaService;
  private cachedConnection: LanguageServerConnection | null = null;
  private lastQuotaInfo: ParsedQuotaInfo | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isRefreshing: boolean = false;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    super();
    this.outputChannel = vscode.window.createOutputChannel('AI Model Limit Monitor');
    this.log('QuotaService initialized.');
  }

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  public log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  public showOutputChannel(): void {
    this.outputChannel.show();
  }

  public getLastQuotaInfo(): ParsedQuotaInfo | null {
    return this.lastQuotaInfo;
  }

  public startPolling(intervalSeconds: number = 30): void {
    this.stopPolling();
    this.refresh();
    const intervalMs = Math.max(5, intervalSeconds) * 1000;
    this.log(`Starting polling every ${intervalSeconds}s.`);
    this.pollingTimer = setInterval(() => {
      this.refresh();
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollingTimer) {
      this.log('Stopping polling.');
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Sends a native JetboxWriteState RPC update to Antigravity IDE v2.6.0+ daemon (agy).
   * Broadcasts to secondary open IDE windows in the background to keep multi-window state in sync.
   */
  public async sendJetboxWriteState(userSettingsPatch: Record<string, any>): Promise<boolean> {
    // 1. Fast path via cached daemon connection
    if (this.cachedConnection) {
      const ok = await this.postJetboxWriteStateToEndpoint(
        this.cachedConnection.port,
        this.cachedConnection.csrfToken,
        userSettingsPatch,
        2000,
        !!this.cachedConnection.useHttp
      );
      if (ok) {
        this.log(`JetboxWriteState succeeded on cached port ${this.cachedConnection.port} (PID ${this.cachedConnection.pid}).`);
        const primaryPid = this.cachedConnection.pid;
        this.broadcastJetboxWriteState(userSettingsPatch, primaryPid).catch(() => {});
        return true;
      }
      this.log(`JetboxWriteState failed on cached port ${this.cachedConnection.port}. Re-discovering...`);
      this.cachedConnection = null;
    }

    // 2. Discover daemon connection and send
    try {
      const conn = await this.discoverAndConnect();
      if (conn) {
        this.cachedConnection = conn;
        const ok = await this.postJetboxWriteStateToEndpoint(
          conn.port,
          conn.csrfToken,
          userSettingsPatch,
          2500,
          !!conn.useHttp
        );
        if (ok) {
          this.log(`JetboxWriteState succeeded on discovered port ${conn.port} (PID ${conn.pid}).`);
          this.broadcastJetboxWriteState(userSettingsPatch, conn.pid).catch(() => {});
          return true;
        }
      }
    } catch (err: any) {
      this.log(`JetboxWriteState discovery error: ${err.message || err}`);
    }

    return false;
  }

  private async broadcastJetboxWriteState(
    userSettingsPatch: Record<string, any>,
    excludePid: string
  ): Promise<void> {
    try {
      const daemonCandidates = this.findDaemonFileCandidates();
      const procCandidates = daemonCandidates.length > 0 ? [] : await this.findCandidateProcesses();
      const all = [...daemonCandidates, ...procCandidates];
      const seenPids = new Set<string>([excludePid]);
      for (const c of all) {
        if (seenPids.has(c.pid) || c.ports.length === 0) continue;
        seenPids.add(c.pid);
        const port = c.httpPort || c.ports[0];
        const useHttp = c.httpPort ? true : c.useHttp;
        await this.postJetboxWriteStateToEndpoint(
          port,
          c.csrfToken,
          userSettingsPatch,
          1200,
          useHttp
        );
      }
    } catch {}
  }

  private postJetboxWriteStateToEndpoint(
    port: number,
    csrfToken: string,
    userSettingsPatch: Record<string, any>,
    timeoutMs: number = 2000,
    useHttp: boolean = true
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            req.destroy();
          } catch {}
          resolve(false);
        }
      }, timeoutMs);

      const payload = JSON.stringify({
        userConfig: {
          userSettings: userSettingsPatch,
        },
      });

      const client = useHttp ? http : https;
      const req = client.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/exa.language_server_pb.LanguageServerService/JetboxWriteState',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-codeium-csrf-token': csrfToken,
            'Connect-Protocol-Version': '1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            clearTimeout(timer);
            if (isSettled) return;
            isSettled = true;
            if (res.statusCode === 200) {
              // Ensure it's JSON (not SPA HTML fallback)
              const trimmed = data.trim();
              if (trimmed.startsWith('{') || trimmed === '') {
                resolve(true);
                return;
              }
            }
            resolve(false);
          });
        }
      );

      req.on('error', () => {
        clearTimeout(timer);
        if (!isSettled) {
          isSettled = true;
          resolve(false);
        }
      });

      req.write(payload);
      req.end();
    });
  }

  public async refresh(forceFresh: boolean = false): Promise<ParsedQuotaInfo | null> {
    if (this.isRefreshing) {
      if (!forceFresh) {
        return this.lastQuotaInfo;
      }
      // Wait briefly for in-flight polling to finish before running fresh discovery
      await new Promise((r) => setTimeout(r, 400));
    }
    this.isRefreshing = true;

    try {
      if (forceFresh) {
        this.log('Force fresh refresh requested. Clearing cached connection.');
        this.cachedConnection = null;
      }

      // 1. Try with cached connection first (only during routine background polling)
      if (this.cachedConnection && !forceFresh) {
        this.log(`Testing cached connection (port ${this.cachedConnection.port}, PID ${this.cachedConnection.pid}, HTTP: ${this.cachedConnection.useHttp})...`);
        try {
          const result = await this.fetchQuotaWithFallback(
            this.cachedConnection.port,
            this.cachedConnection.csrfToken,
            2500,
            !!this.cachedConnection.useHttp
          );
          if (result && result.quota) {
            const parsed = this.parseQuotaResponse(result.quota, result.userInfo);
            this.lastQuotaInfo = parsed;
            this.emit('quotaUpdated', parsed);
            this.isRefreshing = false;
            return parsed;
          }
          this.log('Cached connection returned empty quota groups. Invalidating cache.');
          this.cachedConnection = null;
        } catch (err: any) {
          this.log(`Cached connection failed: ${err.message || err}. Invalidating cache.`);
          this.cachedConnection = null;
        }
      }

      // 2. Discover running Antigravity daemon / language server (daemon JSON first, then process scan)
      this.log('Discovering running Antigravity Daemon / Language Server / AGY...');
      const connection = await this.discoverAndConnect();
      if (connection) {
        this.log(`Connection established! Using port ${connection.port}, PID ${connection.pid}, HTTP: ${connection.useHttp}`);
        this.cachedConnection = connection;
        const result = await this.fetchQuotaWithFallback(
          connection.port,
          connection.csrfToken,
          3000,
          !!connection.useHttp
        );
        if (result && result.quota) {
          const parsed = this.parseQuotaResponse(result.quota, result.userInfo);
          this.lastQuotaInfo = parsed;
          this.emit('quotaUpdated', parsed);
          this.isRefreshing = false;
          return parsed;
        }
      }

      this.log('ERROR: Unable to connect to any Antigravity Language Server / AGY.');
      const err = new Error('Unable to connect to Antigravity Language Server / AGY.');
      this.emit('error', err);
      throw err;
    } catch (err: any) {
      this.log(`ERROR in refresh loop: ${err.message || err}`);
      this.emit('error', err);
      return this.lastQuotaInfo;
    } finally {
      this.isRefreshing = false;
    }
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM means the process exists but belongs to another user/elevation
      return err && err.code === 'EPERM';
    }
  }

  /**
   * Stage 1 (Fast Path): Reads Antigravity daemon registry files (~/.gemini/antigravity/daemon/*.json).
   * Works instantaneously (< 30ms) across Windows, macOS, and Linux without spawning PowerShell/ps/lsof/netstat,
   * and remains resilient even if CLI flags, binary names, or WMI policies change.
   */
  private findDaemonFileCandidates(): CandidateProcess[] {
    const home = os.homedir();
    const daemonDirs = [
      path.join(home, '.gemini', 'antigravity', 'daemon'),
      path.join(home, '.gemini', 'antigravity-ide', 'daemon'),
      path.join(home, '.gemini', 'antigravity-cli', 'daemon'),
      path.join(home, '.antigravity', 'daemon'),
    ];

    const rawEntries: { candidate: CandidateProcess; mtimeMs: number }[] = [];
    const seenPids = new Set<string>();

    for (const dir of daemonDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        const withStats = files
          .map((f) => {
            const fullPath = path.join(dir, f);
            try {
              return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter((x): x is { fullPath: string; mtimeMs: number } => x !== null)
          .sort((a, b) => b.mtimeMs - a.mtimeMs);

        for (const file of withStats) {
          try {
            const content = fs.readFileSync(file.fullPath, 'utf8');
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object') continue;

            const numPid = Number(parsed.pid);
            const csrfToken = String(parsed.csrfToken || parsed.csrf_token || '').trim();
            const httpPort = Number(parsed.httpPort || parsed.http_port || parsed.port || 0) || undefined;
            const httpsPort = Number(parsed.httpsPort || parsed.https_port || 0) || undefined;

            if (!numPid || !csrfToken || (!httpPort && !httpsPort)) continue;
            if (!this.isPidAlive(numPid)) continue;

            const pidStr = String(numPid);
            if (seenPids.has(pidStr)) continue;
            seenPids.add(pidStr);

            const ports: number[] = [];
            if (httpPort) ports.push(httpPort);
            if (httpsPort && httpsPort !== httpPort) ports.push(httpsPort);

            rawEntries.push({
              mtimeMs: file.mtimeMs,
              candidate: {
                pid: pidStr,
                csrfToken,
                ports,
                httpPort,
                httpsPort,
                isIde: true,
                isWorkspaceMatch: false,
                useHttp: !!httpPort,
                numPid,
                createTime: file.mtimeMs,
                source: 'daemon_file',
              },
            });
          } catch {}
        }
      } catch (err: any) {
        this.log(`Daemon dir read error (${dir}): ${err.message || err}`);
      }
    }

    rawEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (rawEntries.length > 0) {
      this.log(`Found ${rawEntries.length} live daemon file candidate(s) (newest PID ${rawEntries[0].candidate.pid}).`);
    }
    return rawEntries.map((e) => e.candidate);
  }

  private async probeCandidate(candidate: CandidateProcess): Promise<LanguageServerConnection | null> {
    const targets: { port: number; useHttp: boolean }[] = [];

    if (candidate.httpPort || candidate.httpsPort) {
      if (candidate.httpPort) targets.push({ port: candidate.httpPort, useHttp: true });
      if (candidate.httpsPort) targets.push({ port: candidate.httpsPort, useHttp: false });
      for (const p of candidate.ports) {
        if (p !== candidate.httpPort && p !== candidate.httpsPort) {
          targets.push({ port: p, useHttp: candidate.useHttp });
          targets.push({ port: p, useHttp: !candidate.useHttp });
        }
      }
    } else {
      const protocols = candidate.useHttp ? [true, false] : [false, true];
      for (const port of candidate.ports) {
        for (const useHttp of protocols) {
          targets.push({ port, useHttp });
        }
      }
    }

    if (targets.length === 0) return null;

    const probePromises = targets.map(async ({ port, useHttp }) => {
      const res = await this.fetchQuotaWithFallback(port, candidate.csrfToken, 2000, useHttp);
      if (res && res.quota) {
        return { port, useHttp };
      }
      throw new Error(`Port ${port} (HTTP: ${useHttp}) returned empty quota`);
    });

    try {
      const winner = await Promise.any(probePromises);
      this.log(`SUCCESS on PID ${candidate.pid} (${candidate.source || 'scan'}) via port ${winner.port} (HTTP: ${winner.useHttp})!`);
      return {
        pid: candidate.pid,
        csrfToken: candidate.csrfToken,
        port: winner.port,
        isIde: candidate.isIde,
        useHttp: winner.useHttp,
      };
    } catch {
      this.log(`Candidate PID ${candidate.pid} (${candidate.source || 'scan'}) failed on all ports: ${candidate.ports.join(', ')}.`);
      return null;
    }
  }

  private async discoverAndConnect(): Promise<LanguageServerConnection | null> {
    // Stage 1: Fast path via ~/.gemini/antigravity/daemon/*.json (no PowerShell/ps/lsof required)
    const daemonCandidates = this.findDaemonFileCandidates();
    for (const candidate of daemonCandidates) {
      const conn = await this.probeCandidate(candidate);
      if (conn) return conn;
    }

    // Stage 2: Process scan fallback (handles legacy Antigravity / custom launches / missing daemon dir)
    const procCandidates = await this.findCandidateProcesses();
    if (procCandidates.length === 0) {
      this.log('No language_server or agy processes found in daemon files or process list.');
      return null;
    }

    this.log(`Found ${procCandidates.length} process candidate(s) via OS scan.`);
    const alreadyTriedPids = new Set(daemonCandidates.map((c) => c.pid));

    for (const candidate of procCandidates) {
      if (alreadyTriedPids.has(candidate.pid)) continue;
      this.log(`Testing candidate PID ${candidate.pid} (isIde: ${candidate.isIde}, wsMatch: ${candidate.isWorkspaceMatch}, hubSub: ${!!candidate.isHubSubclient}, useHttp: ${candidate.useHttp}) with ports: ${candidate.ports.join(', ')}`);
      const conn = await this.probeCandidate(candidate);
      if (conn) return conn;
    }

    return null;
  }

  private extractCsrfToken(cmdLine: string): string | null {
    const match = cmdLine.match(/--(?:extension_server_)?csrf_token[=\s]+["']?([^\s"']+)["']?/i);
    return match ? match[1] : null;
  }

  private extractGuessedPorts(cmdLine: string): { ports: number[]; httpPort?: number; httpsPort?: number } {
    const ports: number[] = [];
    let httpPort: number | undefined;
    let httpsPort: number | undefined;

    const hubPortMatch = cmdLine.match(/--hub-port[=\s]+(\d+)/i);
    if (hubPortMatch) {
      const p = parseInt(hubPortMatch[1], 10);
      if (p > 0) {
        httpPort = p;
        ports.push(p);
      }
    }

    const httpPortMatch = cmdLine.match(/--http_server_port[=\s]+(\d+)/i);
    if (httpPortMatch) {
      const p = parseInt(httpPortMatch[1], 10);
      if (p > 0) {
        httpPort = httpPort || p;
        ports.push(p);
      }
    }

    const httpsPortMatch = cmdLine.match(/--https_server_port[=\s]+(\d+)/i);
    if (httpsPortMatch) {
      const p = parseInt(httpsPortMatch[1], 10);
      if (p > 0) {
        httpsPort = p;
        ports.push(p);
      }
    }

    const extPortMatch = cmdLine.match(/--extension_server_port[=\s]+(\d+)/i);
    if (extPortMatch) {
      const basePort = parseInt(extPortMatch[1], 10);
      if (basePort > 0) {
        for (let i = 1; i <= 6; i++) {
          ports.push(basePort + i);
        }
      }
    }

    return { ports: Array.from(new Set(ports)), httpPort, httpsPort };
  }

  private async getAllWindowsListeningPortsByPid(): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    try {
      const winDir = process.env.SystemRoot || 'C:\\Windows';
      const { stdout: netstatOut } = await execAsync(`"${winDir}\\System32\\netstat.exe" -ano`, {
        encoding: 'utf8',
        timeout: 4000,
      });
      const lines = netstatOut.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.includes('LISTENING')) continue;
        const pidMatch = trimmed.match(/\s(\d+)$/);
        if (!pidMatch) continue;
        const pid = pidMatch[1];
        const portMatch = trimmed.match(/(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d+)/);
        if (!portMatch) continue;
        const p = parseInt(portMatch[1], 10);
        if (isNaN(p) || p <= 0) continue;
        const existing = map.get(pid) || [];
        if (!existing.includes(p)) {
          existing.push(p);
          map.set(pid, existing);
        }
      }
    } catch {}
    return map;
  }

  private async findCandidateProcesses(): Promise<CandidateProcess[]> {
    const platform = os.platform();
    const candidates: CandidateProcess[] = [];
    const currentWorkspaces = (vscode.workspace.workspaceFolders || []).map((f) =>
      f.uri.fsPath.toLowerCase()
    );

    this.log(`Scanning processes on platform: ${platform}`);

    if (platform === 'darwin' || platform === 'linux') {
      try {
        let psOut = '';
        try {
          // Use wide non-truncated output so long --add-dir paths never cut off --csrf_token
          const res = await execAsync('ps -eo pid=,args=', { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
          psOut = res.stdout;
        } catch {
          const res = await execAsync('ps auxww', { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
          psOut = res.stdout;
        }
        const lines = psOut.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const isLsp = trimmed.includes('language_server');
          const isAgy = trimmed.includes('agy') || trimmed.includes('--hub');
          const hasCsrf = trimmed.includes('csrf_token');

          if ((isLsp || isAgy || hasCsrf) && hasCsrf) {
            const pidMatch = trimmed.match(/^(\d+)\s+/) || trimmed.match(/^\S+\s+(\d+)\s+/);
            const csrfToken = this.extractCsrfToken(trimmed);
            if (pidMatch && csrfToken) {
              const pid = pidMatch[1];
              const isHubSubclient = trimmed.includes('--subclient_type hub');
              const isIde =
                trimmed.includes('--subclient_type ide') ||
                trimmed.includes('antigravity') ||
                isAgy;

              const lineLower = trimmed.toLowerCase();
              const isWorkspaceMatch = currentWorkspaces.some((w) => lineLower.includes(w));

              const guessed = this.extractGuessedPorts(trimmed);
              const activePorts = await this.getListeningPortsForPid(pid);
              const ports = Array.from(new Set([...guessed.ports, ...activePorts]));

              if (ports.length === 0) continue;

              this.log(`Discovered Unix candidate PID ${pid} (Active: ${activePorts.join(',')} | Guessed: ${guessed.ports.join(',')} | isAgy: ${isAgy} | hubSub: ${isHubSubclient})`);
              candidates.push({
                pid,
                csrfToken,
                ports,
                httpPort: guessed.httpPort,
                httpsPort: guessed.httpsPort,
                isIde,
                isWorkspaceMatch,
                isHubSubclient,
                useHttp: isAgy || !!guessed.httpPort,
                numPid: parseInt(pid, 10) || 0,
                source: 'process_scan',
              });
            }
          }
        }
      } catch (err: any) {
        this.log(`Error discovering processes via ps: ${err.message || err}`);
      }
    } else if (platform === 'win32') {
      try {
        const psScript = `$ProgressPreference = 'SilentlyContinue'; $procs = Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*csrf_token*') -or (($_.Name -like '*language_server*' -or $_.Name -like '*agy*' -or $_.Name -like '*antigravity*') -and ($_.CommandLine -like '*--hub-port*' -or $_.CommandLine -like '*--extension_server_port*')) } | Select-Object ProcessId, Name, CommandLine, CreationDate; if ($procs) { $procs | ConvertTo-Json -Compress } else { '[]' }`;
        const base64Script = Buffer.from(psScript, 'utf16le').toString('base64');
        const [{ stdout: rawOut }, portsByPid] = await Promise.all([
          execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Script}`, {
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 8 * 1024 * 1024,
          }),
          this.getAllWindowsListeningPortsByPid(),
        ]);

        const jsonStart = rawOut.indexOf('[');
        const jsonStartObj = rawOut.indexOf('{');
        const startIdx = (jsonStart !== -1 && jsonStartObj !== -1)
          ? Math.min(jsonStart, jsonStartObj)
          : (jsonStart !== -1 ? jsonStart : jsonStartObj);

        const cleanJson = startIdx !== -1 ? rawOut.substring(startIdx).trim() : '';
        if (cleanJson) {
          const items = JSON.parse(cleanJson);
          const list = Array.isArray(items) ? items : [items];

          for (const item of list) {
            if (!item || !item.CommandLine) continue;
            const cmdLine = String(item.CommandLine);
            const csrfToken = this.extractCsrfToken(cmdLine);
            if (!csrfToken) continue;

            const pid = String(item.ProcessId);
            const isHubSubclient = cmdLine.includes('--subclient_type hub');
            const isAgy = cmdLine.toLowerCase().includes('agy') || cmdLine.includes('--hub');
            const isIde = cmdLine.toLowerCase().includes('antigravity') || isAgy;

            const cmdLower = cmdLine.toLowerCase();
            const isWorkspaceMatch = currentWorkspaces.some((w) => cmdLower.includes(w));

            const guessed = this.extractGuessedPorts(cmdLine);
            const activePorts = portsByPid.get(pid) || [];
            const ports = Array.from(new Set([...guessed.ports, ...activePorts]));
            if (ports.length === 0) continue;

            let createTime = 0;
            if (item.CreationDate) {
              const numMatch = String(item.CreationDate).match(/\d+/);
              if (numMatch) {
                createTime = parseInt(numMatch[0], 10);
              } else {
                createTime = new Date(item.CreationDate).getTime() || 0;
              }
            }
            this.log(`Discovered Windows candidate PID ${pid} (Active: ${activePorts.join(',')} | Guessed: ${guessed.ports.join(',')} | wsMatch: ${isWorkspaceMatch} | isAgy: ${isAgy} | hubSub: ${isHubSubclient})`);
            candidates.push({
              pid,
              csrfToken,
              ports,
              httpPort: guessed.httpPort,
              httpsPort: guessed.httpsPort,
              isIde,
              isWorkspaceMatch,
              isHubSubclient,
              useHttp: isAgy || !!guessed.httpPort,
              numPid: parseInt(pid, 10) || 0,
              createTime,
              source: 'process_scan',
            });
          }
        }
      } catch (err: any) {
        this.log(`Windows process search error: ${err.message || err}`);
      }
    }

    // Sort priority:
    // 1. Matching workspace directory first
    // 2. Non-hub-subclient IDE processes before standalone --subclient_type hub
    // 3. isIde first
    // 4. Newest process by CreationDate (falling back to PID)
    candidates.sort((a, b) => {
      if (b.isWorkspaceMatch !== a.isWorkspaceMatch) return (b.isWorkspaceMatch ? 1 : 0) - (a.isWorkspaceMatch ? 1 : 0);
      if (!!a.isHubSubclient !== !!b.isHubSubclient) return (a.isHubSubclient ? 1 : 0) - (b.isHubSubclient ? 1 : 0);
      if (b.isIde !== a.isIde) return (b.isIde ? 1 : 0) - (a.isIde ? 1 : 0);
      if (b.createTime && a.createTime && b.createTime !== a.createTime) {
        return b.createTime - a.createTime;
      }
      return b.numPid - a.numPid;
    });

    return candidates;
  }

  private async getListeningPortsForPid(pid: string): Promise<number[]> {
    const platform = os.platform();
    const ports: number[] = [];

    if (platform === 'darwin' || platform === 'linux') {
      const lsofPaths = [
        '/usr/sbin/lsof',
        '/usr/bin/lsof',
        '/sbin/lsof',
        '/bin/lsof',
        'lsof'
      ];

      for (const lsofPath of lsofPaths) {
        try {
          const { stdout: lsofOut } = await execAsync(`${lsofPath} -nP -a -p ${pid} -iTCP -sTCP:LISTEN`, {
            encoding: 'utf8',
            timeout: 2500,
          });
          if (lsofOut) {
            const matches = [...lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)];
            for (const m of matches) {
              const p = parseInt(m[1], 10);
              if (!isNaN(p) && !ports.includes(p)) {
                ports.push(p);
              }
            }
            if (ports.length > 0) break;
          }
        } catch {}
      }

      if (ports.length === 0) {
        const netstatPaths = ['/usr/sbin/netstat', '/usr/bin/netstat', '/sbin/netstat', '/bin/netstat', 'netstat'];
        for (const netstatPath of netstatPaths) {
          try {
            const { stdout: netstatOut } = await execAsync(`${netstatPath} -anp 2>/dev/null | grep ${pid}`, {
              encoding: 'utf8',
              timeout: 2500,
            });
            const matches = [...netstatOut.matchAll(/(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|::):(\d+)/g)];
            for (const m of matches) {
              const p = parseInt(m[1], 10);
              if (!isNaN(p) && !ports.includes(p)) {
                ports.push(p);
              }
            }
            if (ports.length > 0) break;
          } catch {}
        }
      }

      if (ports.length === 0 && platform === 'linux') {
        try {
          const { stdout: ssOut } = await execAsync(`ss -tlnp 2>/dev/null | grep "pid=${pid},"`, {
            encoding: 'utf8',
            timeout: 2500,
          });
          const matches = [...ssOut.matchAll(/(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\*):(\d+)/g)];
          for (const m of matches) {
            const p = parseInt(m[1], 10);
            if (!isNaN(p) && !ports.includes(p)) {
              ports.push(p);
            }
          }
        } catch {}
      }
    } else if (platform === 'win32') {
      const portsByPid = await this.getAllWindowsListeningPortsByPid();
      return portsByPid.get(pid) || [];
    }

    return ports;
  }

  private async fetchUserStatusFromEndpoint(
    port: number,
    csrfToken: string,
    timeoutMs: number = 1500,
    useHttp: boolean = false
  ): Promise<UserStatusResult | null> {
    return new Promise((resolve) => {
      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try { req.destroy(); } catch {}
          resolve(null);
        }
      }, timeoutMs);

      const payload = JSON.stringify({});
      const client = useHttp ? http : https;
      const req = client.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-codeium-csrf-token': csrfToken,
            'Connect-Protocol-Version': '1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            clearTimeout(timer);
            if (isSettled) return;
            isSettled = true;
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                const user = parsed.userStatus;
                if (user) {
                  resolve({
                    name: user.name,
                    email: user.email,
                    planName:
                      user.planStatus?.planInfo?.planName ||
                      user.userTier?.name ||
                      user.plan,
                    rawUserStatus: user,
                  });
                  return;
                }
              } catch {}
            }
            resolve(null);
          });
        }
      );

      req.on('error', () => {
        clearTimeout(timer);
        if (!isSettled) {
          isSettled = true;
          resolve(null);
        }
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Builds a compatible QuotaSummaryResponse from GetUserStatus.cascadeModelConfigData.clientModelConfigs
   * when RetrieveUserQuotaSummary is unavailable or returns empty groups on certain Antigravity builds.
   */
  private buildFallbackQuotaFromUserStatus(rawUserStatus: any): QuotaSummaryResponse | null {
    const configs = rawUserStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(configs) || configs.length === 0) return null;

    const groupMap = new Map<string, { displayName: string; minFrac: number; resetTime?: string }>();

    for (const cfg of configs) {
      const qi = cfg?.quotaInfo;
      if (!qi || typeof qi.remainingFraction !== 'number') continue;
      const label = String(cfg.label || '');
      const lower = label.toLowerCase();

      let key = 'other';
      let displayName = 'Other Models';
      if (lower.includes('carbon')) {
        key = 'carbon';
        displayName = 'Gemini 4 Carbon';
      } else if (lower.includes('argon')) {
        key = 'argon';
        displayName = 'Gemini 4 Argon';
      } else if (lower.includes('gemini') || lower.includes('orchestrator')) {
        key = 'gemini';
        displayName = 'Gemini Models';
      } else if (lower.includes('claude') || lower.includes('gpt')) {
        key = 'claude_gpt';
        displayName = 'Claude and GPT models';
      }

      const prev = groupMap.get(key);
      if (!prev || qi.remainingFraction < prev.minFrac) {
        groupMap.set(key, {
          displayName,
          minFrac: qi.remainingFraction,
          resetTime: qi.resetTime || prev?.resetTime,
        });
      }
    }

    if (groupMap.size === 0) return null;

    const groups: QuotaGroup[] = [];
    for (const [key, info] of groupMap.entries()) {
      const resetMs = info.resetTime ? new Date(info.resetTime).getTime() - Date.now() : 0;
      const isWeeklyOnly = key === 'argon' || (key === 'carbon' && resetMs > 12 * 60 * 60 * 1000);
      groups.push({
        displayName: info.displayName,
        buckets: [
          {
            bucketId: `${key}-${isWeeklyOnly ? 'weekly' : '5h'}`,
            displayName: isWeeklyOnly ? `${info.displayName} Weekly Limit` : 'Five Hour Limit Remaining',
            window: isWeeklyOnly ? 'weekly' : '5h',
            remainingFraction: info.minFrac,
            resetTime: info.resetTime,
          },
        ],
      });
    }

    return { response: { groups } };
  }

  private async fetchQuotaWithFallback(
    port: number,
    csrfToken: string,
    timeoutMs: number = 2500,
    useHttp: boolean = false
  ): Promise<{ quota: QuotaSummaryResponse; userInfo: UserStatusResult | null } | null> {
    let summary: QuotaSummaryResponse | null = null;
    try {
      const res = await this.fetchQuotaFromEndpoint(port, csrfToken, timeoutMs, useHttp);
      const groups = res?.response?.groups || (res as any)?.groups;
      if (Array.isArray(groups) && groups.length > 0) {
        summary = res?.response?.groups ? res : { response: { groups } };
      }
    } catch {}

    const userInfo = await this.fetchUserStatusFromEndpoint(
      port,
      csrfToken,
      Math.min(timeoutMs, 1800),
      useHttp
    );

    if (summary) {
      return { quota: summary, userInfo };
    }

    if (userInfo?.rawUserStatus) {
      const fallback = this.buildFallbackQuotaFromUserStatus(userInfo.rawUserStatus);
      if (fallback) {
        this.log(`Using GetUserStatus fallback quota on port ${port} (HTTP: ${useHttp}).`);
        return { quota: fallback, userInfo };
      }
    }

    return null;
  }

  private async fetchQuotaFromEndpoint(
    port: number,
    csrfToken: string,
    timeoutMs: number = 2000,
    useHttp: boolean = false
  ): Promise<QuotaSummaryResponse | null> {
    return new Promise((resolve, reject) => {
      let isSettled = false;

      // Hard safety timer to prevent any TLS handshake / unresponding socket hang
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            req.destroy(new Error('Request timed out'));
          } catch {}
          reject(new Error(`Request to port ${port} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const cleanup = () => clearTimeout(timer);

      const payload = JSON.stringify({});
      const client = useHttp ? http : https;
      const req = client.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-codeium-csrf-token': csrfToken,
            'Connect-Protocol-Version': '1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            cleanup();
            if (isSettled) return;
            isSettled = true;
            if (res.statusCode === 200) {
              try {
                const parsed: QuotaSummaryResponse = JSON.parse(data);
                resolve(parsed);
              } catch (e) {
                reject(new Error(`JSON parse error: ${e}`));
              }
            } else {
              reject(new Error(`HTTP status ${res.statusCode}: ${data}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        cleanup();
        if (isSettled) return;
        isSettled = true;
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }

  private parseQuotaResponse(
    data: QuotaSummaryResponse,
    userInfo?: { name?: string; email?: string; planName?: string } | null
  ): ParsedQuotaInfo {
    const rawGroups: QuotaGroup[] = data.response?.groups || (data as any).groups || [];
    // Keep only groups that actually possess at least one bucket (prevents --% on Free/custom plans)
    const groups = rawGroups.filter((g) => Array.isArray(g.buckets) && g.buckets.length > 0);

    let lowest = 1.0;
    let lowestGroupName: string | undefined;

    for (const group of groups) {
      const weeklyBucket = QuotaService.findBucket(group, 'weekly');
      const isWeeklyExhausted =
        weeklyBucket &&
        typeof weeklyBucket.remainingFraction === 'number' &&
        weeklyBucket.remainingFraction <= 0;

      for (const bucket of group.buckets || []) {
        // If weekly is exhausted or explicitly marked disabled by LSP
        if (
          bucket.disabled ||
          (isWeeklyExhausted && (bucket.window === '5h' || (bucket.bucketId || '').includes('5h')))
        ) {
          bucket.disabled = true;
        }
      }

      const groupQuota = QuotaService.getGroupEffectiveQuota(group, 'fiveHourPreferred');
      if (groupQuota.fraction < lowest) {
        lowest = groupQuota.fraction;
        lowestGroupName = group.displayName;
      }
    }

    const accountTier = QuotaService.detectAccountTier(userInfo?.planName, groups);
    const normalizedPlanName = QuotaService.getNormalizedPlanLabel(accountTier, userInfo?.planName);

    return {
      groups,
      description: data.response?.description,
      lastUpdated: new Date(),
      lowestFraction: lowest,
      lowestGroupName,
      userEmail: userInfo?.email,
      userName: userInfo?.name,
      planName: normalizedPlanName || undefined,
      accountTier,
    };
  }

  /**
   * Classifies a model group across Free, Plus, Pro, Ultra, and Enterprise accounts.
   * Checks 'carbon' and 'argon' before 'gemini' since "Gemini 4 Carbon" and "Gemini 4 Argon" contain "gemini".
   */
  public static identifyGroupType(group: QuotaGroup): ModelGroupType {
    const nameLower = (group.displayName || '').toLowerCase();
    const hasCarbonBucket = (group.buckets || []).some((b) => {
      const id = (b.bucketId || '').toLowerCase();
      const dn = (b.displayName || '').toLowerCase();
      return id.includes('carbon') || dn.includes('carbon');
    });
    const hasArgonBucket = (group.buckets || []).some((b) => {
      const id = (b.bucketId || '').toLowerCase();
      const dn = (b.displayName || '').toLowerCase();
      return id.includes('argon') || dn.includes('argon');
    });

    if (nameLower.includes('carbon') || hasCarbonBucket) {
      return 'carbon';
    }
    if (nameLower.includes('argon') || hasArgonBucket) {
      return 'argon';
    }
    if (nameLower.includes('gemini')) {
      return 'gemini';
    }
    if (
      nameLower.includes('claude') ||
      nameLower.includes('gpt') ||
      nameLower.includes('3p') ||
      (group.buckets || []).some((b) => (b.bucketId || '').toLowerCase().includes('3p'))
    ) {
      return 'claude_gpt';
    }
    return 'other';
  }

  /**
   * Returns a concise status-bar label for any model group.
   */
  public static getShortGroupLabel(group: QuotaGroup): string {
    const type = QuotaService.identifyGroupType(group);
    switch (type) {
      case 'carbon':
        return 'Carb';
      case 'argon':
        return 'Ar';
      case 'gemini':
        return 'Gemi';
      case 'claude_gpt':
        return 'Cl';
      default: {
        const cleaned = (group.displayName || 'Model').replace(/[^a-zA-Z0-9\s]/g, '').trim();
        const firstWord = cleaned.split(/\s+/)[0] || 'Mod';
        return firstWord.length > 4 ? firstWord.slice(0, 4) : firstWord;
      }
    }
  }

  /**
   * Locates the 5-hour or weekly bucket within a group without misclassifying weekly-only or student/discounted groups.
   */
  public static findBucket(
    group: QuotaGroup | undefined,
    window: '5h' | 'weekly'
  ): QuotaBucket | undefined {
    if (!group || !group.buckets || group.buckets.length === 0) return undefined;

    const isWeeklyBucket = (b: QuotaBucket): boolean => {
      const win = (b.window || '').toLowerCase();
      const id = (b.bucketId || '').toLowerCase();
      const dn = (b.displayName || '').toLowerCase();
      return (
        win === 'weekly' ||
        win === 'week' ||
        win === '7d' ||
        id.includes('weekly') ||
        id.includes('week') ||
        id.includes('7d') ||
        dn.includes('weekly') ||
        dn.includes('week') ||
        dn.includes('7-day') ||
        dn.includes('7 day')
      );
    };

    const isFiveHourBucket = (b: QuotaBucket): boolean => {
      const win = (b.window || '').toLowerCase();
      const id = (b.bucketId || '').toLowerCase();
      const dn = (b.displayName || '').toLowerCase();
      return (
        win === '5h' ||
        win === '5-hour' ||
        win === 'rolling' ||
        win === 'hourly' ||
        win === 'session' ||
        id.includes('5h') ||
        id.includes('5-hour') ||
        id.includes('rolling') ||
        id.includes('hourly') ||
        id.includes('session') ||
        dn.includes('5-hour') ||
        dn.includes('five hour') ||
        dn.includes('5 hour') ||
        dn.includes('rolling') ||
        dn.includes('hourly') ||
        dn.includes('session')
      );
    };

    if (window === '5h') {
      const explicit5h = group.buckets.find(isFiveHourBucket);
      if (explicit5h) return explicit5h;

      // If multiple buckets exist and one is weekly, the non-weekly bucket is the 5-hour rolling limit
      if (group.buckets.length >= 2) {
        const nonWeekly = group.buckets.find((b) => !isWeeklyBucket(b));
        if (nonWeekly) return nonWeekly;
      }

      // If single bucket and it is NOT weekly (e.g. Free/Plus single rolling bucket), treat as 5h
      if (group.buckets.length === 1 && !isWeeklyBucket(group.buckets[0])) {
        return group.buckets[0];
      }

      return undefined;
    } else {
      const explicitWeekly = group.buckets.find(isWeeklyBucket);
      if (explicitWeekly) return explicitWeekly;

      // If multiple buckets exist and one is 5h, the non-5h bucket is weekly
      if (group.buckets.length >= 2) {
        const non5h = group.buckets.find((b) => !isFiveHourBucket(b));
        if (non5h) return non5h;
      }

      return undefined;
    }
  }

  /**
   * Computes the remaining fraction and text for a model group.
   * Defaults to 'fiveHourPreferred' so the Status Bar always shows the active 5-hour rolling limit
   * (unless weekly limit is 0% exhausted or the model is weekly-only like Gemini 4 Argon).
   */
  public static getGroupEffectiveQuota(
    group: QuotaGroup,
    mode: 'effective' | 'fiveHourPreferred' = 'fiveHourPreferred'
  ): {
    fraction: number;
    pct: string;
    fiveHourBucket?: QuotaBucket;
    weeklyBucket?: QuotaBucket;
    isWeeklyOnly: boolean;
  } {
    const fiveHourBucket = QuotaService.findBucket(group, '5h');
    const weeklyBucket = QuotaService.findBucket(group, 'weekly');
    const isWeeklyOnly = !fiveHourBucket && !!weeklyBucket;

    const weeklyExhausted =
      weeklyBucket &&
      typeof weeklyBucket.remainingFraction === 'number' &&
      weeklyBucket.remainingFraction <= 0;

    if (weeklyExhausted) {
      return {
        fraction: 0,
        pct: '0%',
        fiveHourBucket,
        weeklyBucket,
        isWeeklyOnly,
      };
    }

    if (mode === 'fiveHourPreferred' && fiveHourBucket) {
      const frac = fiveHourBucket.disabled ? 0 : fiveHourBucket.remainingFraction;
      return {
        fraction: frac,
        pct: QuotaService.formatPercentage(frac),
        fiveHourBucket,
        weeklyBucket,
        isWeeklyOnly,
      };
    }

    let minFrac = 1.0;
    let found = false;
    for (const b of group.buckets || []) {
      if (typeof b.remainingFraction === 'number') {
        const eff = b.disabled ? 0 : b.remainingFraction;
        if (!found || eff < minFrac) {
          minFrac = eff;
          found = true;
        }
      }
    }

    const finalFrac = found ? minFrac : 1.0;
    return {
      fraction: finalFrac,
      pct: QuotaService.formatPercentage(finalFrac),
      fiveHourBucket,
      weeklyBucket,
      isWeeklyOnly,
    };
  }

  public static detectAccountTier(planName?: string, groups: QuotaGroup[] = []): AccountTier {
    if (planName) {
      const lower = planName.toLowerCase();
      if (lower.includes('ultra')) return 'ultra';
      if (lower.includes('enterprise') || lower.includes('business') || lower.includes('team')) {
        return 'enterprise';
      }
      if (lower.includes('plus')) return 'plus';
      if (
        lower.includes('pro') ||
        lower.includes('student') ||
        lower.includes('edu') ||
        lower.includes('campus') ||
        lower.includes('sheerid') ||
        lower.includes('discount') ||
        lower.includes('advanced')
      ) {
        return 'pro';
      }
      if (lower.includes('free')) return 'free';
    }

    if (groups.length > 0) {
      const hasCarbon = groups.some((g) => QuotaService.identifyGroupType(g) === 'carbon');
      if (hasCarbon) return 'ultra';

      const hasProModels = groups.some((g) => {
        const t = QuotaService.identifyGroupType(g);
        return t === 'argon' || t === 'claude_gpt';
      });
      return hasProModels ? 'pro' : 'free';
    }

    return 'unknown';
  }

  /**
   * Returns a clean, unified plan label for UI display.
   * Student, education, or discounted Pro variants are unified as "PRO" (never displays a Student banner).
   * Google AI Plus is displayed as "PLUS".
   */
  public static getNormalizedPlanLabel(accountTier?: AccountTier, rawPlanName?: string): string {
    const tier =
      accountTier && accountTier !== 'unknown'
        ? accountTier
        : QuotaService.detectAccountTier(rawPlanName);

    switch (tier) {
      case 'ultra':
        return 'ULTRA';
      case 'enterprise':
        return 'ENTERPRISE';
      case 'pro':
        return 'PRO';
      case 'plus':
        return 'PLUS';
      case 'free':
        return 'FREE';
      default: {
        if (!rawPlanName) return '';
        const cleaned = rawPlanName
          .replace(
            /\b(student|students|education|edu|discount|discounted|trial|campus|sheerid)\b/gi,
            ''
          )
          .replace(/[()[\]\-_]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned ? cleaned.toUpperCase() : 'PRO';
      }
    }
  }

  /**
   * Helper utility to format remaining duration until reset
   */
  public static formatTimeUntilReset(resetTimeIso?: string): string {
    if (!resetTimeIso) return '';
    const resetDate = new Date(resetTimeIso);
    const now = new Date();
    const diffMs = resetDate.getTime() - now.getTime();

    if (diffMs <= 0) return 'Resetting now';

    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const days = Math.floor(diffMinutes / (60 * 24));
    const hours = Math.floor((diffMinutes % (60 * 24)) / 60);
    const minutes = diffMinutes % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (days === 0) parts.push(`${minutes}m`);

    return parts.join(' ');
  }

  /**
   * Helper to format percentage (0-100%)
   */
  public static formatPercentage(fraction: number): string {
    return `${Math.round(fraction * 100)}%`;
  }
}
