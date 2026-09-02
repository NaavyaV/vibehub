/**
 * Public task statuses shown in the UI and MCP.
 * DB still stores available / in_progress / merged for compatibility.
 */

import type { FeatureStatus } from "../types.js";

export type PublicTaskStatus = "assigned" | "working" | "done";

export function toPublicStatus(status: string): PublicTaskStatus {
  if (status === "merged" || status === "done") return "done";
  if (status === "in_progress" || status === "working") return "working";
  return "assigned";
}

export function fromPublicStatus(status: string): FeatureStatus {
  const value = status.trim().toLowerCase();
  if (value === "done" || value === "merged") return "merged";
  if (value === "working" || value === "in_progress") return "in_progress";
  if (
    value === "assigned" ||
    value === "available" ||
    value === "claimed" ||
    value === "blocked"
  ) {
    return "available";
  }
  throw new Error(`Unknown task status "${status}". Use assigned, working, or done.`);
}

export function isDoneStatus(status: string): boolean {
  return toPublicStatus(status) === "done";
}

export function isWorkingStatus(status: string): boolean {
  return toPublicStatus(status) === "working";
}

export const PUBLIC_STATUS_LABEL: Record<PublicTaskStatus, string> = {
  assigned: "Assigned",
  working: "Working",
  done: "Done",
};
