import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Runtime environment: the wrangler-generated `Env` plus the secrets wrangler
 * cannot see.
 */
export interface AppEnv extends Env {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  DEV_LOGIN?: string;
  CORS_ORIGINS?: string;
  PUSH_PAYLOADS: KVNamespace;
  ASSETS?: Fetcher;

  OAUTH_PROVIDER: OAuthHelpers;
}

export type TestMode = "actions" | "skip";

/** Base URL of this deployment, without a trailing slash. */
export function publicUrl(env: AppEnv): string {
  return env.PUBLIC_URL.replace(/\/$/, "");
}

/** Stored feature status. Prefer writing available / in_progress / merged; public API maps to assigned / working / done. */
export type FeatureStatus =
  | "available"
  | "claimed"
  | "in_progress"
  | "merged"
  | "blocked"
  | "assigned"
  | "working"
  | "done";
export type PushStatus = "testing" | "conflict" | "merged" | "failed";
export type PushStage = "queued" | "applying" | "building" | "done";

export interface UserRow {
  id: string;
  github_login: string | null;
  display_name: string;
  avatar_url: string | null;
  github_token_enc: string | null;
  email: string | null;
  password_hash: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  storage_provider: string;
  current_version: number;
  created_at: string;
  repo_owner: string | null;
  repo_name: string | null;
  default_branch: string;
  github_token_enc: string | null;
  test_mode: TestMode;
  shared_file_warnings: string;
  created_by: string | null;
}

export interface FeatureRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  description: string;
  status: FeatureStatus;
  assigned_to: string | null;
  scope_notes: string;
  manifest: string;
  test_spec: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  project_id: string;
  version_number: number;
  commit_sha: string | null;
  created_by_feature_id: string | null;
  changed_paths: string;
  created_at: string;
}

export interface PushRow {
  id: string;
  project_id: string;
  feature_id: string;
  based_on_version: number;
  status: PushStatus;
  stage: PushStage;
  changed_paths: string;
  conflict_paths: string;
  conflict_reason: string | null;
  staging_ref: string | null;
  commit_sha: string | null;
  merged_version: number | null;
  build_output: string | null;
  error: string | null;
  notes: string | null;
  callback_token_hash: string | null;
  webhook_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SnapshotRow {
  id: string;
  project_id: string;
  feature_id: string | null;
  description: string;
  storage_ref: string;
  created_by: string | null;
  created_at: string;
}

export interface BlockerRow {
  id: string;
  project_id: string;
  feature_id: string;
  reason: string;
  reported_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ProjectInviteRow {
  id: string;
  project_id: string;
  invitee_user_id: string;
  invited_by: string;
  role: string;
  status: "pending" | "accepted" | "declined";
  created_at: string;
  responded_at: string | null;
}

/**
 * Props attached to an authenticated MCP session by the OAuth provider. The
 * index signature is required by the Agents SDK's props constraint.
 */
export interface McpProps extends Record<string, unknown> {
  userId: string;
  displayName: string;
  /** How the caller authenticated. Recorded for auditability. */
  via: "oauth" | "token";
}
