# Antigravity Quota Monitor & Autopilot

[![Open VSX](https://img.shields.io/badge/Open%20VSX-v1.1.0-blue.svg)](https://open-vsx.org/extension/san-chanadach/antigravity-quota-autopilot)
[![Author: San Chanadach](https://img.shields.io/badge/Author-San%20Chanadach-blue.svg)](https://github.com/San-chanadach)
[![Antigravity IDE: v2.5.5](https://img.shields.io/badge/Antigravity%20IDE-v2.5.5-purple.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)

The all-in-one companion extension for **Google Antigravity IDE (Version: 2.5.5)** — featuring real-time AI model quota monitoring (Gemini & Claude), an automated 1,000-log activity history tracker, and a hands-free **Autopilot (Auto-Accept)** engine for step approvals and terminal commands.

---

## Highlights

- **🎯 Antigravity IDE v2.5.5 Verified**: Tested and guaranteed compatible with **Google Antigravity IDE Version: 2.5.5**.
- **⚡ Hands-Free Autopilot**: Automatically approve agent file changes and run terminal commands with granular safety levels.
- **📊 Real-Time AI Quotas**: Instant visibility of remaining quotas for Gemini 3.7 / 3.1 Pro / Flash, Claude 3.7 / 3.5 Sonnet, and GPT models across 5-Hour and Weekly rolling windows.
- **🕒 100% Automated Activity Logger**: Automatically records up to 1,000 turns with prompt snippet tagging, timestamp, and percentage consumed.
- **🎨 Native Vector UI**: Built using VS Code Codicons and sleek SVGs — zero emoji clutter, seamless dark-mode design.
- **🔌 Zero Configuration**: Auto-discovers and connects to the local Antigravity Language Server with zero API keys required.

---

## Features in Detail

### 1. Hands-Free Autopilot (Auto-Accept)

Tired of clicking "Accept" and "Allow" dozens of times during long agent coding sessions? The built-in Autopilot handles approvals automatically so you can focus on building.

#### 3 Granular Approval Options
| Option | Name | Best For |
|---|---|---|
| **Option 1** | **Allow this time (Once)** | High-security tasks requiring prompt-by-prompt verification. |
| **Option 2** | **In conversation (Recommended)** | Typical workflows: auto-approves within the current chat session. |
| **Option 3** | **Always allow (Permanent)** | Unattended, overnight, or autonomous multi-step tasks. |

#### Minimalist Status Bar Integration
- **Clean Format**: `Gemi:80% | Cl:80% Auto: ON`
- **1-Click Direct Toggle**: Click the status bar item to toggle Autopilot `ON` ↔ `OFF` instantly.
- **Mouse Hover Selector**: Hovering over the status bar item opens a rich tooltip where you can switch between Option 1, Option 2, and Option 3 in a single click without opening dialogs.

#### Dual-Layer Engine
1. **Layer 1 (Native Antigravity Commands)**: Continuously evaluates internal approval handlers with minimal CPU overhead.
2. **Layer 2 (Pure Node.js CDP Engine - Port 9333)**: Connects to the IDE UI over standard remote debugging to auto-select permission radio options and confirm dialogs smoothly without any third-party npm dependencies.

---

### 2. Real-Time Quota Monitoring

Never get caught off guard by quota limits mid-task.

- **Status Bar Display**: Shows remaining capacity for both Gemini and Claude models with automatic weekly-limit detection.
- **Smart Health Thresholds**:
  - 🟢 **Healthy**: `> 35%` remaining
  - 🟡 **Warning**: `15% - 35%` remaining
  - 🔴 **Critical**: `< 15%` remaining (status bar automatically alerts)
- **Countdown to Reset**: Tooltips and the dashboard show the exact countdown until your rolling quota window resets.

---

### 3. Automated 1,000-Turn Activity Logger & Dashboard

- **Prompt Snippet Tagging**: Automatically detects and pairs each quota drop with your actual prompt text.
- **FIFO 1,000-Log History**: Stores your last 1,000 interactions locally in extension state.
- **Visual Analytics Dashboard**:
  - Circular animated SVG gauges for each model family.
  - Paginated activity log (`10 items per page`).
  - Daily consumption stats (total percentage consumed today across all requests).

---

## Status Bar Display Modes

Customize the status bar layout via `antigravityLimitMonitor.statusBarFormat` or by clicking **Switch Status Bar Display Mode**:

| Mode | Example Preview |
|---|---|
| **All Active (Default)** | `Gemi:80% | Cl:80% Auto: ON` |
| **Gemini Only** | `Gem: 80% (5h) · 65% (W) Auto: ON` |
| **5-Hour Only** | `Gem: 80% | Cl: 80% Auto: ON` |
| **Compact** | `80% Auto: ON` |
| **Smart Lowest** | `Claude (W): 12% Auto: ON` |

---

## Extension Settings

Add these options to your `.vscode/settings.json` or global user settings:

```jsonc
{
  // Interval in seconds to poll model quota limits (default: 10)
  "antigravityLimitMonitor.refreshIntervalSeconds": 10,

  // Status bar display mode: "all" | "geminiOnly" | "fiveHourOnly" | "compact" | "smartLowest"
  "antigravityLimitMonitor.statusBarFormat": "all",

  // Highlight status bar with warning/error colors when limits are low (default: true)
  "antigravityLimitMonitor.showStatusAlertColors": true,

  // Remaining quota percentage threshold to trigger low quota notification (default: 20, 0 to disable)
  "antigravityLimitMonitor.lowQuotaWarningThreshold": 20,

  // Default Auto-Accept permission option: 1 (Once), 2 (Conversation), 3 (Always)
  "antigravityLimitMonitor.autoAccept.choice": 2,

  // Polling frequency in ms for auto-accepting steps and terminal commands (default: 800)
  "antigravityLimitMonitor.autoAccept.pollIntervalMs": 800,

  // Connect to Chrome DevTools Protocol port to select permission options (default: true)
  "antigravityLimitMonitor.autoAccept.enableCdpMode": true,

  // Remote debugging port for CDP connection (default: 9333)
  "antigravityLimitMonitor.autoAccept.cdpPort": 9333
}
```

---

## Contributed Commands

| Command | Identifier | Description |
|---|---|---|
| **Toggle Auto-Accept (ON/OFF)** | `antigravityLimitMonitor.toggleAutoAccept` | Quickly toggles hands-free step & terminal approvals. |
| **Set Auto-Accept Option** | `antigravityLimitMonitor.setAutoAcceptChoice` | Opens quick-pick to select Option 1, 2, or 3. |
| **Show Limit Monitor Dashboard** | `antigravityLimitMonitor.showDashboard` | Opens the full visual webview dashboard and activity logs. |
| **Clear Activity History Logs** | `antigravityLimitMonitor.clearHistory` | Clears the 1,000 saved activity history records. |
| **Refresh Model Limits** | `antigravityLimitMonitor.refresh` | Forces an immediate quota refresh from the Language Server. |
| **Switch Status Bar Display Mode** | `antigravityLimitMonitor.toggleDisplayMode` | Switches status bar text formatting style. |
| **Open Limit Monitor Quick Menu** | `antigravityLimitMonitor.openQuickMenu` | Opens the consolidated action menu. |

---

## Requirements & Setup

### 1. Supported Platform
- **Antigravity IDE**: **Version 2.5.5** (tested and verified).

### 2. Autopilot Remote Debugging Port (`--remote-debugging-port=9333`)
To enable the **Autopilot (Auto-Accept)** engine to automatically select permission options (**Option 1 / Option 2 / Option 3**) and submit confirmation dialogs hands-free, **Antigravity IDE must be launched with the `--remote-debugging-port=9333` flag**.

#### How to configure:

- **Method A: Desktop / Taskbar Shortcut (Recommended)**
  1. Right-click your **Antigravity IDE** shortcut &rarr; select **Properties**.
  2. In the **Shortcut** tab, find the **Target** field.
  3. Append ` --remote-debugging-port=9333` at the end of the line (with a space before `--`), for example:
     ```text
     "C:\Users\<YourUsername>\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-port=9333
     ```
  4. Click **Apply** and **OK**. Launch Antigravity IDE via this shortcut.

- **Method B: Terminal / PowerShell**
  ```powershell
  & "C:\Users\$env:USERNAME\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-port=9333
  ```

> **Note:** The **Real-Time Quota Monitor**, **Activity Tracker**, and **Visual Dashboard** work out of the box via the local Language Server without requiring any flags. The `--remote-debugging-port=9333` flag is specifically required for the hands-free Autopilot modal automation.

---

## Installation

### Method 1: Install from Open VSX Registry (Recommended)
1. In Antigravity IDE, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **`Antigravity Quota Monitor & Autopilot`**.
3. Click **Install**.

### Method 2: Install from `.vsix` Release
1. Download `antigravity-quota-autopilot-1.1.0.vsix` from [GitHub Releases](https://github.com/San-chanadach/antigravity-quota-autopilot/releases).
2. Open Antigravity IDE.
3. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and choose **Extensions: Install from VSIX...**.
4. Select the downloaded `.vsix` file and reload the window.

---

## Development & Building

```bash
# Clone the repository
git clone https://github.com/San-chanadach/antigravity-quota-autopilot.git
cd antigravity-quota-autopilot

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Build production bundle with esbuild
npm run build

# Package into .vsix file
npx @vscode/vsce package --no-dependencies
```

---

## Author

Developed and maintained by **San Chanadach** ([@San-chanadach](https://github.com/San-chanadach)).

---

## License

This project is licensed under the [MIT License](LICENSE).

