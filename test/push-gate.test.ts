import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assertPushAllowed,
  recordContextRead,
  type PushAttempt,
} from "../src/services/push-gate.js";
import type { HttpError } from "../src/lib/errors.js";
import type { AppEnv } from "../src/types.js";

const appEnv = env as unknown as AppEnv;

let attemptNumber = 0;

function attempt(overrides: Partial<PushAttempt> = {}): PushAttempt {
  return {
    userId: `usr_${attemptNumber}`,
    projectId: `prj_${attemptNumber}`,
    featureId: "add-background",
    featureTitle: "Add a blurry background",
    currentVersion: 6,
    basedOnVersion: 6,
    confirmUserApproved: true,
    confirmBuiltOnLatest: true,
    approvalQuote: "yes, push it",
    ...overrides,
  };
}

async function refusalOf(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const httpError = error as HttpError;
    return {
      code: (httpError.details as { code: string }).code,
      message: httpError.message,
    };
  }
  throw new Error("Expected the push to be refused");
}

describe("push gate", () => {
  beforeEach(() => {
    attemptNumber += 1;
  });

  it("accepts a push when the agent read the project at the current version", async () => {
    const input = attempt();
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    await expect(assertPushAllowed(appEnv, input)).resolves.toBeUndefined();
  });

  it("refuses when approval was never attested", async () => {
    const input = attempt({ confirmUserApproved: false });
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    const refusal = await refusalOf(assertPushAllowed(appEnv, input));
    expect(refusal.code).toBe("approval_required");
  });

  it("refuses a retry that only flips the flags to true", async () => {
    const input = attempt({ confirmUserApproved: false });
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    await refusalOf(assertPushAllowed(appEnv, input));

    // The agent's cheapest fix: same call, flags set true. It must not work.
    const retry = await refusalOf(assertPushAllowed(appEnv, attempt()));
    expect(retry.code).toBe("resync_required");
    expect(retry.message).toMatch(/flipped to true is not enough/);
  });

  it("accepts the retry once a fresh context read follows the refusal", async () => {
    const input = attempt({ confirmUserApproved: false });
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    await refusalOf(assertPushAllowed(appEnv, input));

    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    await expect(assertPushAllowed(appEnv, attempt())).resolves.toBeUndefined();
  });

  it("refuses when the agent never read the project at this version", async () => {
    const refusal = await refusalOf(assertPushAllowed(appEnv, attempt()));
    expect(refusal.code).toBe("resync_required");
  });

  it("refuses a stale base even when both flags are true", async () => {
    const input = attempt({ basedOnVersion: 4 });
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    const refusal = await refusalOf(assertPushAllowed(appEnv, input));
    expect(refusal.code).toBe("stale_base");
  });

  it("refuses a rubber-stamped approval quote", async () => {
    const input = attempt({ approvalQuote: "true" });
    await recordContextRead(appEnv, input.userId, input.projectId, 6);
    const refusal = await refusalOf(assertPushAllowed(appEnv, input));
    expect(refusal.code).toBe("approval_quote_required");
  });
});
