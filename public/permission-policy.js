export function buildPermissionPolicy(selected) {
  if (selected.kind === "inherit") return { thread: {}, turn: {} };
  if (selected.kind === "approval") {
    const override = {
      approvalPolicy: selected.approvalPolicy,
      approvalsReviewer: selected.approvalsReviewer,
    };
    return { thread: { ...override }, turn: { ...override } };
  }
  if (selected.kind === "profile") {
    return {
      thread: { permissions: selected.profileId },
      turn: { permissions: selected.profileId },
    };
  }
  if (selected.kind === "fullAccess") {
    const approval = {
      approvalPolicy: selected.approvalPolicy,
      approvalsReviewer: selected.approvalsReviewer,
    };
    return {
      thread: { ...approval, sandbox: "danger-full-access" },
      turn: { ...approval, sandboxPolicy: { type: "dangerFullAccess" } },
    };
  }
  throw new Error(`Unsupported permission policy: ${selected.kind}`);
}
