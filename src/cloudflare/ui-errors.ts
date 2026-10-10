/** Fixed internal validation codes only; never reflect arbitrary exception or submitted material. */
const notices: Readonly<Record<string, string>> = Object.freeze({
  model_catalog_unavailable:
    "The Worker model catalog is unavailable. Wake or create a healthy Topic, then reopen Model Center.",
  action_extension_missing:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  action_limit:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  action_namespace_mismatch:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  action_owner_mismatch:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  configuration_draft_expired: "This configuration form expired. Reopen its menu to start again.",
  configuration_draft_mismatch:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  configuration_draft_stage_mismatch:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  configuration_entry_exists:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  configuration_entry_missing:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  configuration_revision_changed:
    "Settings changed while this form was open. Reopen the form to use the current settings.",
  duplicate_action_id:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  immutable_plugin_version_required:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_action_enabled:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_action_id:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_action_risk:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_command_field:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_command_model:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_command_subtask:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_configuration_id:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_configuration_json: "Send valid JSON, or /cancel. The configuration was not changed.",
  invalid_configuration_text:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_default:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_extension_id:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_extension_resource:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_mcp_configuration:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_mcp_enabled:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_mcp_sync:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_provider_model:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_public_endpoint:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_skill_name:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_timeout:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  memory_limit: "Memory is full. Remove an existing entry before adding another.",
  memory_missing: "This memory entry no longer exists. Reopen Memory to choose a current entry.",
  protected_credential_capability_mismatch:
    "Choose a credential reference authorized for this capability.",
  protected_credential_reference_missing:
    "Configure the referenced credential in Main Settings before saving.",
  provider_models_required:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  skill_content_hash_mismatch:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  use_protected_credential_reference:
    "Use a configured credentialRef. Never include credentials in configuration JSON.",
  model_provider_unavailable:
    "This provider is unavailable. Reopen Model Center and choose an available provider.",
  invalid_model_search:
    "Enter a model search between 1 and 128 characters. Reopen Search to try again.",
  invalid_model_provider:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_model:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
  invalid_selection:
    "This configuration value is invalid or no longer available. Correct the value or reopen its menu; no changes were saved.",
});
export function uiValidationNotice(error: unknown): string | undefined {
  return error instanceof Error && Object.hasOwn(notices, error.message)
    ? notices[error.message]
    : undefined;
}
