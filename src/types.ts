export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  description?: string;
  window?: '5h' | 'weekly' | string;
  remainingFraction: number; // 0.0 to 1.0 (e.g. 0.68895)
  resetTime?: string; // ISO 8601 string, e.g. "2026-08-26T02:21:18Z"
  disabled?: boolean;
}

export type ModelGroupType = 'gemini' | 'claude_gpt' | 'argon' | 'other';

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummaryResponse {
  response?: {
    groups?: QuotaGroup[];
    description?: string;
  };
}

export interface LanguageServerConnection {
  pid: string;
  csrfToken: string;
  port: number;
  isIde?: boolean;
  useHttp?: boolean;
}

export type AccountTier = 'free' | 'pro' | 'ultra' | 'enterprise' | 'unknown';

export interface ParsedQuotaInfo {
  groups: QuotaGroup[];
  description?: string;
  lastUpdated: Date;
  lowestFraction: number;
  lowestGroupName?: string;
  userEmail?: string;
  userName?: string;
  planName?: string;
  accountTier?: AccountTier;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: string; // ISO 8601
  promptTitle?: string; // Short snippet of the user prompt that caused the usage
  groupName: string; // e.g. "Gemini Models", "Gemini 4 Argon"
  bucketDisplayName: string; // e.g. "Five Hour Limit Remaining"
  window: string; // "5h" | "weekly"
  usedDeltaFraction: number; // e.g. 0.0185
  usedPct: number; // e.g. 1.9 (%)
  remainingFraction: number; // e.g. 0.685
  remainingPct: number; // e.g. 68.5 (%)
}

export type PermissionPreset = 'turbo' | 'default' | 'request_review';
export type PlanReviewPolicy = 'always_proceed' | 'always_ask';

export interface AutopilotConfig {
  isTurboActive: boolean;
  permissionPreset: PermissionPreset;
  planReviewPolicy: PlanReviewPolicy;
}
