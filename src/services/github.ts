import { decryptSecret } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import { GitHubClient } from "../github/client.js";
import type { AppEnv, ProjectRow } from "../types.js";

export function requireEncryptionKey(env: AppEnv): string {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is not configured; cannot read or write GitHub tokens");
  }
  return env.ENCRYPTION_KEY;
}

export interface ConnectedRepo {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
}

/** Builds a GitHub client for a project, or explains what is missing. */
export async function connectedRepo(env: AppEnv, project: ProjectRow): Promise<ConnectedRepo> {
  if (!project.repo_owner || !project.repo_name || !project.github_token_enc) {
    throw badRequest(
      `Project "${project.name}" has no connected GitHub repo. Connect one before pushing or pulling.`,
    );
  }
  const token = await decryptSecret(project.github_token_enc, requireEncryptionKey(env));
  return {
    client: new GitHubClient(token, { owner: project.repo_owner, repo: project.repo_name }),
    owner: project.repo_owner,
    repo: project.repo_name,
    branch: project.default_branch,
  };
}

export function hasRepo(project: ProjectRow): boolean {
  return Boolean(project.repo_owner && project.repo_name && project.github_token_enc);
}
