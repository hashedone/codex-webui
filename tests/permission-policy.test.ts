import { describe, expect, test } from "bun:test";
import { buildPermissionPolicy } from "../public/permission-policy.js";

describe("Codex permission policy payloads", () => {
  test("inherits the user's Codex configuration when no override is selected", () => {
    expect(buildPermissionPolicy({ kind: "inherit" }, "/tmp/project")).toEqual({
      thread: {},
      turn: {},
    });
  });

  test("overrides approval routing without replacing the sandbox or network policy", () => {
    const policy = buildPermissionPolicy({
      kind: "approval",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    }, "/tmp/project");

    expect(policy).toEqual({
      thread: { approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
      turn: { approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
    });
    expect("sandbox" in policy.thread).toBe(false);
    expect("sandboxPolicy" in policy.turn).toBe(false);
  });

  test("selects a named profile without adding unrelated overrides", () => {
    expect(buildPermissionPolicy({ kind: "profile", profileId: "team-safe" }, "/tmp/project")).toEqual({
      thread: { permissions: "team-safe" },
      turn: { permissions: "team-safe" },
    });
  });

  test("serializes the explicit full-access override using the installed app-server schema", () => {
    expect(buildPermissionPolicy({
      kind: "fullAccess",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    }, "/tmp/project")).toEqual({
      thread: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
  });
});
