const notices: Readonly<Record<string, string>> = Object.freeze({
  integration_unauthorized: "The account API rejected this credential. Check whether it is valid or revoked, then reconnect.",
  integration_forbidden: "This credential cannot access the account API. Check its permissions before reconnecting.",
  integration_unavailable: "The account API is temporarily unavailable. Reopen the connection form and try again.",
  integration_invalid_response: "The account API returned an unexpected response. The credential was not activated.",
  tailscale_api_token_required: "Use a Tailscale API access token (tskey-api-…), not a device enrollment auth key.",
  invalid_integration_credential: "The integration credential could not be validated. The previous account remains active.",
  invalid_credential_input: "This credential form is invalid or expired. Reopen the account connection menu and try again.",
  credential_revoked: "This credential is invalid or revoked. Reconnect the account.",
  repository_unavailable: "The repository is unavailable to this credential. Check its name and selected repository access.",
  repository_not_authorized: "This credential is not authorized for the selected repository.",
  insufficient_read_permission: "This credential needs repository read permission.",
  insufficient_write_permission: "This credential needs repository write permission.",
  enrollment_not_authorized: "Tailscale enrollment is not authorized. Check API access and ownership of tag:opencode-bot.",
  integration_account_unavailable: "This account reference has expired. Reopen Main Settings and select a current account.",
});
/** Only exact internal codes reach presentation. Arbitrary upstream exception text is discarded. */
export function integrationFailureNotice(error: unknown): string | undefined {
  return error instanceof Error && Object.hasOwn(notices, error.message) ? notices[error.message] : undefined;
}
export function integrationFailureCategory(error: unknown): string {
  return error instanceof Error && Object.hasOwn(notices, error.message)
    ? error.message : "operation_failed";
}
