/**
 * The push gate's memory.
 *
 * `confirm_user_approved` and `confirm_built_on_latest` are attestations, and an
 * attestation an agent can satisfy by retrying with `true` is not a control. So
 * the server keeps a small ledger per (user, project):
 *
 *   - every time an agent reads the project's current version, that read is
 *     recorded;
 *   - every refused push is recorded.
 *
 * A push is only accepted if the agent read the *current* version, and read it
 * *after* its last refusal. Flipping the booleans and calling again therefore
 * fails: the agent has to go back and re-sync (and, per the tool description,
 * ask the user) before the retry can be accepted.
 */

import { badRequest } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

const LEDGER_TTL_SECONDS = 60 * 60 * 24;

export type PushRefusalCode =
  | "approval_required"
  | "latest_version_unconfirmed"
  | "approval_quote_required"
  | "stale_base"
  | "resync_required";

interface ContextRead {
  version: number;
  at: number;
}

interface Refusal {
  code: PushRefusalCode;
  at: number;
}

const contextKey = (userId: string, projectId: string) => `gate:ctx:${userId}:${projectId}`;
const refusalKey = (userId: string, projectId: string, featureId: string) =>
  `gate:rej:${userId}:${projectId}:${featureId}`;

/** Records that this agent has seen the project at `version`. */
export async function recordContextRead(
  env: AppEnv,
  userId: string,
  projectId: string,
  version: number,
): Promise<void> {
  const read: ContextRead = { version, at: Date.now() };
  await env.PUSH_PAYLOADS.put(contextKey(userId, projectId), JSON.stringify(read), {
    expirationTtl: LEDGER_TTL_SECONDS,
  });
}

export async function recordPushRefusal(
  env: AppEnv,
  userId: string,
  projectId: string,
  featureId: string,
  code: PushRefusalCode,
): Promise<void> {
  const refusal: Refusal = { code, at: Date.now() };
  await env.PUSH_PAYLOADS.put(refusalKey(userId, projectId, featureId), JSON.stringify(refusal), {
    expirationTtl: LEDGER_TTL_SECONDS,
  });
}

async function clearPushRefusal(
  env: AppEnv,
  userId: string,
  projectId: string,
  featureId: string,
): Promise<void> {
  await env.PUSH_PAYLOADS.delete(refusalKey(userId, projectId, featureId)).catch(() => undefined);
}

function refuse(code: PushRefusalCode, message: string, nextSteps: string[]): never {
  throw badRequest(message, { code, next_steps: nextSteps });
}

/** Words that are the agent talking to the API, not a human granting permission. */
const NOT_A_QUOTE = new Set(["true", "yes", "y", "ok", "confirmed", "approved", "user approved"]);

export interface PushAttempt {
  userId: string;
  projectId: string;
  featureId: string;
  featureTitle: string;
  currentVersion: number;
  basedOnVersion: number;
  confirmUserApproved: boolean;
  confirmBuiltOnLatest: boolean;
  approvalQuote: string | null;
}

/**
 * Throws a structured refusal unless every precondition genuinely holds. The
 * refusal is recorded, which is what makes an immediate retry fail.
 */
export async function assertPushAllowed(env: AppEnv, attempt: PushAttempt): Promise<void> {
  const deny = async (
    code: PushRefusalCode,
    message: string,
    nextSteps: string[],
  ): Promise<never> => {
    await recordPushRefusal(env, attempt.userId, attempt.projectId, attempt.featureId, code);
    refuse(code, message, nextSteps);
  };

  if (!attempt.confirmUserApproved) {
    await deny(
      "approval_required",
      `Push refused: you have not attested that the user approved pushing "${attempt.featureTitle}".`,
      [
        `Ask the user, in chat: "Ready to push ${attempt.featureTitle} to VibeHub?"`,
        "Wait for an explicit yes. Finishing or implementing the task is not permission.",
        "Do NOT simply retry with confirm_user_approved: true — that is the failure this check exists to catch.",
      ],
    );
  }

  if (!attempt.confirmBuiltOnLatest) {
    await deny(
      "latest_version_unconfirmed",
      "Push refused: you have not attested that this work is based on the project's latest version.",
      [
        "Call get_project_context and note current_version.",
        "pull_snapshot at that version for every path you changed and reconcile any upstream drift.",
        "Set based_on_version to that same current_version, then push.",
      ],
    );
  }

  const quote = (attempt.approvalQuote ?? "").trim();
  if (quote.length < 3 || NOT_A_QUOTE.has(quote.toLowerCase())) {
    await deny(
      "approval_quote_required",
      "Push refused: user_approval_quote must be the user's own words granting permission for this push.",
      [
        `Ask the user: "Ready to push ${attempt.featureTitle} to VibeHub?"`,
        'Pass their reply verbatim, e.g. user_approval_quote: "yes, ship it".',
        "This is recorded on the push and shown to the team, so it must be a real message.",
      ],
    );
  }

  if (attempt.basedOnVersion !== attempt.currentVersion) {
    await deny(
      "stale_base",
      `Push refused: you attested you were on the latest version, but you built on v${attempt.basedOnVersion} and main is v${attempt.currentVersion}.`,
      [
        `pull_diff({ project_id: "${attempt.projectId}", based_on_version: ${attempt.basedOnVersion} }) and apply the changes locally.`,
        "Re-run get_project_context to pick up the new current_version.",
        "Ask the user to test and approve again, then push with the new based_on_version.",
      ],
    );
  }

  const [read, refusal] = await Promise.all([
    env.PUSH_PAYLOADS.get(contextKey(attempt.userId, attempt.projectId), "json") as Promise<
      ContextRead | null
    >,
    env.PUSH_PAYLOADS.get(refusalKey(attempt.userId, attempt.projectId, attempt.featureId), "json") as Promise<
      Refusal | null
    >,
  ]);

  if (!read || read.version !== attempt.currentVersion) {
    return deny(
      "resync_required",
      `Push refused: you have not read this project at v${attempt.currentVersion} in this session.`,
      [
        `Call get_project_context({ project_id: "${attempt.projectId}" }) to see the live version and files.`,
        "Reconcile your local changes against it, then push.",
      ],
    );
  }

  if (refusal && read.at <= refusal.at) {
    await deny(
      "resync_required",
      `Push refused: the previous push of "${attempt.featureTitle}" was rejected (${refusal.code}) and nothing has been re-checked since. Retrying with the confirmation flags flipped to true is not enough.`,
      [
        "Ask the user for explicit permission to push this feature now.",
        "Re-run get_project_context, then pull_snapshot at current_version and reconcile your changed files.",
        "Only then push again — the retry is accepted once a fresh read follows the rejection.",
      ],
    );
  }

  await clearPushRefusal(env, attempt.userId, attempt.projectId, attempt.featureId);
}
