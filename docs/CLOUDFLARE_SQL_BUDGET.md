# Control Plane SQL budget

The Control Plane measures Cloudflare SQL cursor `rowsRead` and `rowsWritten`, including index visits. Result-array length is not a substitute for scanned rows.

- Counters are persisted once per invocation in `control_sql_usage`, with UTC daily rollover.
- At 1,000,000 recorded reads or 20,000 recorded writes, automatic provisioning and ordinary alarm maintenance yield until the next UTC day. Telegram admission, control menus and native cancellation remain available.
- Queue-driven provisioning observes the same budget as alarms. A paused Railway onboarding cannot restart provisioning on unrelated input.
- Telegram input drains before provisioning I/O and yields before newly admitted runs execute.
- Panel ownership uses an indexed, case-sensitive key prefix; callback retirement uses the actor/chat/thread/generation index.
- A cold constructor rearms an existing Telegram backlog after deployment/restart.
- Bootstrap-slot lookup uses the existing unique `(request, chat)` index rather than repeatedly scanning retained jobs.
- An alarm more than five seconds overdue can be rearmed by new input after platform retries were exhausted. A freshly scheduled urgent alarm cannot be postponed by a slower retry.

`control_alarm_sql_usage` reports per-alarm reads/writes and daily totals. `peakStatement` contains only an operation/table label, never bindings, credentials or submitted text. `background_sql_budget_exhausted` records background suspension.

The allowance is a conservative application safeguard, not Cloudflare account-wide billing telemetry. It starts tracking at installation; existing usage and other Workers/objects are not included. The handful of raw bookkeeping reads/writes are not included in cursor totals. A statement already executing can cross the threshold, so indexes, bounded queries and regression tests remain necessary. This does not remove platform limits or recover an already exhausted account allowance.
