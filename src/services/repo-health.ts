/**
 * Detect deleted GitHub repos and remove the VibeHub projects that pointed at them.
 */

import { GitHubClient, parseRepoUrl } from "../github/client.js";
import type { Repo } from "../db/repo.js";
import { notFound } from "../lib/errors.js";
import { connectedRepo, hasRepo, type ConnectedRepo } from "./github.js";
import type { AppEnv, ProjectRow } from "../types.js";

export function repoRemovedMessage(project: ProjectRow): string {
  const label =
    project.repo_owner && project.repo_name
      ? `${project.repo_owner}/${project.repo_name}`
      : project.repo_url ?? "the linked repository";
  return `The GitHub repository ${label} no longer exists. VibeHub removed project "${project.name}" and its tasks. Create a new project or push again with a fresh repo.`;
}

export async function githubRepoExists(client: GitHubClient): Promise<boolean> {
  return (await client.getRepoInfo()) !== null;
}

/** Deletes the project when its linked GitHub repo returns 404. Returns true if removed. */
export async function removeProjectIfRepoMissing(
  env: AppEnv,
  db: Repo,
  project: ProjectRow,
): Promise<boolean> {
  if (!hasRepo(project)) return false;

  let client: GitHubClient;
  try {
    ({ client } = await connectedRepo(env, project));
  } catch {
    return false;
  }

  if (await githubRepoExists(client)) return false;

  await db.deleteProject(project.id);
  return true;
}

/** Throws 404 when the linked GitHub repo was deleted and the project was removed. */
export async function requireLiveProject(
  env: AppEnv,
  db: Repo,
  project: ProjectRow,
): Promise<ProjectRow> {
  if (await removeProjectIfRepoMissing(env, db, project)) {
    throw notFound(repoRemovedMessage(project));
  }
  return project;
}

/** Like connectedRepo, but removes the project first when GitHub returns 404. */
export async function connectedLiveRepo(
  env: AppEnv,
  db: Repo,
  project: ProjectRow,
): Promise<ConnectedRepo> {
  await requireLiveProject(env, db, project);
  return connectedRepo(env, project);
}

/** Removes all VibeHub projects linked to a GitHub repo that no longer exists. */
export async function cleanupProjectsForDeletedGithubRepo(
  db: Repo,
  owner: string,
  repoName: string,
): Promise<string[]> {
  const matches = await db.listProjectsByGithubRepo(owner, repoName);
  const removed: string[] = [];
  for (const project of matches) {
    await db.deleteProject(project.id);
    removed.push(project.id);
  }
  return removed;
}

/** Verifies every linked project in D1 and deletes rows whose GitHub repo is gone. */
export async function purgeAllStaleLinkedProjects(env: AppEnv, db: Repo): Promise<string[]> {
  const projects = await db.listLinkedProjects();
  const removed: string[] = [];
  for (const project of projects) {
    if (await removeProjectIfRepoMissing(env, db, project)) {
      removed.push(project.id);
    }
  }
  return removed;
}

/** Verifies linked repos for a user and deletes projects whose GitHub repo is gone. */
export async function purgeStaleProjectsForUser(
  env: AppEnv,
  db: Repo,
  userId: string,
): Promise<string[]> {
  const projects = await db.listProjectsForUser(userId);
  const removed: string[] = [];

  for (const project of projects) {
    if (!hasRepo(project)) continue;
    if (await removeProjectIfRepoMissing(env, db, project)) {
      removed.push(project.id);
    }
  }

  return removed;
}

/** Returns a linked project only when its GitHub repo still exists. */
export async function findLiveProjectByRepoUrl(
  env: AppEnv,
  db: Repo,
  userId: string,
  repoUrl: string,
): Promise<ProjectRow | null> {
  const project = await db.findProjectByRepoUrlForUser(userId, repoUrl);
  if (!project) return null;
  if (!hasRepo(project)) return project;
  if (await removeProjectIfRepoMissing(env, db, project)) return null;
  return project;
}

export async function findLiveProjectByRepoName(
  env: AppEnv,
  db: Repo,
  userId: string,
  repoName: string,
): Promise<ProjectRow | null> {
  const project = await db.findProjectByRepoNameForUser(userId, repoName);
  if (!project) return null;
  if (!hasRepo(project)) return project;
  if (await removeProjectIfRepoMissing(env, db, project)) return null;
  return project;
}

/** When GitHub says a repo URL is missing, drop any VibeHub projects still pointing at it. */
export async function cleanupProjectsForRepoUrl(db: Repo, repoUrl: string): Promise<string[]> {
  const ref = parseRepoUrl(repoUrl);
  if (!ref) return [];
  return cleanupProjectsForDeletedGithubRepo(db, ref.owner, ref.repo);
}
