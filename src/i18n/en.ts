export const en = {
  "cmd.description.help": "Help",

  "callback.unknown_command": "Unknown command",
  "callback.processing_error": "Processing error",

  "error.load_agents": "❌ Failed to load agents list",
  "error.load_models": "❌ Failed to load models list",
  "error.load_variants": "❌ Failed to load variants list",
  "error.context_button": "❌ Failed to process context button",
  "error.generic": "🔴 Something went wrong.",

  "interaction.blocked.expired": "⚠️ This interaction has expired. Please start it again.",
  "interaction.blocked.expected_callback":
    "⚠️ Please use the inline buttons for this step or tap Cancel.",
  "interaction.blocked.expected_text": "⚠️ Please send a text message for this step.",
  "interaction.blocked.expected_command": "⚠️ Please send a command for this step.",
  "interaction.blocked.command_not_allowed":
    "⚠️ This command is not available in the current step.",
  "interaction.blocked.finish_current":
    "⚠️ Finish the current interaction first (answer or cancel), then open another menu.",

  "inline.blocked.expected_choice": "⚠️ Choose an option using the inline buttons or tap Cancel.",
  "inline.blocked.command_not_allowed":
    "⚠️ This command is not available while inline menu is active.",

  "question.blocked.expected_answer":
    "⚠️ Answer the current question using buttons, Custom answer, or Cancel.",
  "question.blocked.command_not_allowed":
    "⚠️ This command is not available until current question flow is completed.",

  "inline.button.cancel": "❌ Cancel",
  "inline.inactive_callback": "This menu is inactive",

  "common.cancelled": "Cancelled",
  "common.unknown": "unknown",
  "common.unknown_error": "unknown error",

  "help.keyboard_hint":
    "💡 Use the bottom keyboard buttons for the agent, model, variant, and context actions.",

  "bot.thinking": "💭 Thinking...",
  "progress.compact.activity": "{header}\n{activity}",
  "progress.compact.working_header": "⏳ Working",
  "progress.compact.finished_header": "✅ Finished Work",
  "progress.compact.thinking": "💭 Thinking...",
  "progress.compact.responding": "✍️ Writing answer...",
  "progress.compact.waiting_question": "❓ Waiting for your answer...",
  "progress.compact.waiting_permission": "🔐 Waiting for permission...",
  "progress.compact.retrying": "🔁 Retrying...",
  "progress.compact.task": "🤖 Running Task",
  "progress.compact.done": "{header}\ntool calls: {tools} · changed files: {files}",
  "bot.project_not_selected":
    "🏗 Project is not selected.\n\nFirst select a project with /projects.",
  "bot.creating_session": "🔄 Creating a new session...",
  "bot.create_session_error":
    "🔴 Failed to create session. Try /new or check server status with /status.",
  "bot.session_created": "✅ Session created: {title}",
  "bot.session_busy":
    "⏳ Agent is already running a task. Wait for completion or use /abort to interrupt current run.",
  "bot.session_reset_project_mismatch":
    "⚠️ Active session does not match the selected project, so it was reset. Use /sessions to pick one or /new to create a new session.",
  "bot.prompt_send_error": "Failed to send request to OpenCode.",
  "bot.empty_prompt": "⚠️ Nothing to send: the message is empty after attachment handling.",
  "bot.empty_response":
    "⚠️ The model finished without producing any text. Try rephrasing the request or use /abort and retry.",
  "bot.session_stalled":
    "⏸️ The model stopped making progress and the run was stopped. No response was produced; please retry.",
  "bot.session_error": "🔴 OpenCode returned an error: {message}",
  "bot.session_retry":
    "🔁 {message}\n\nProvider keeps returning the same error on repeated retries. Use /abort to abort.",
  "bot.external_user_input": "External user input",
  "background.session_fallback": "session {id}",
  "background.assistant_response": "🔔 Assistant replied in background session: {session}",
  "background.question_asked": "❓ Background session needs an answer: {session}",
  "background.permission_asked": "🔐 Background session requested permissions: {session}",
  "background.open_session_button": "Open session",
  "bot.unknown_command": "⚠️ Unknown command: {command}. Use /help to see available commands.",
  "bot.photo_downloading": "⏳ Downloading photo...",
  "bot.photo_model_no_image": "⚠️ Current model doesn't support image input. Sending text only.",
  "bot.photo_download_error": "🔴 Failed to download photo",
  "bot.video_downloading": "⏳ Downloading video...",
  "bot.video_too_large": "⚠️ Video is too large (max {maxSizeMb}MB)",
  "bot.video_error": "🔴 Failed to process video",
  "bot.file_downloading": "⏳ Downloading file...",
  "bot.files_downloading": "⏳ Downloading files...",
  "bot.file_download_error": "🔴 Failed to download file",
  "bot.file_type_unsupported":
    "⚠️ This file type is not supported. Send an image, document (PDF, DOCX, PPTX), or text/code file.",
  "bot.media_group_not_processed":
    "⚠️ One or more files in this album cannot be processed. Nothing was sent to OpenCode.",
  "bot.media_group_download_error":
    "🔴 Failed to download one of the files. Nothing was sent to OpenCode.",
  "bot.model_no_pdf": "⚠️ Current model doesn't support PDF input. Sending text only.",
  "bot.document_extraction_error": "🔴 Failed to extract document text.",
  "bot.text_file_too_large": "⚠️ Text file is too large (max {maxSizeKb}KB)",

  "status.header_running": "🟢 OpenCode Server is running",
  "status.health.healthy": "Healthy",
  "status.health.unhealthy": "Unhealthy",
  "status.line.health": "Status: {health}",
  "status.line.version": "Version: {version}",
  "status.line.mode": "Agent: {mode}",
  "status.line.model": "Model: {model}",
  "status.agent_not_set": "not set",
  "status.project_selected": "Project: {project}",
  "status.worktree_selected": "Worktree: {worktree}",
  "status.session_selected": "Current session: {title}",
  "status.session_not_selected": "Current session: not selected",
  "status.session_hint": "Use /sessions to select one or /new to create one",
  "status.server_unavailable":
    "🔴 OpenCode Server is unavailable\n\nUse /opencode_start to start the server.",


  "settings.saved": "✅ Setting saved.",

  "projects.empty":
    "📭 No projects found.\n\nOpen a directory in OpenCode and create at least one session, then it will appear here.",
  "projects.page_indicator": "Page {current}/{total}",
  "projects.prev_page": "⬅️ Previous",
  "projects.next_page": "Next ➡️",
  "projects.select_error": "🔴 Failed to select project.",

  "sessions.empty": "📭 No sessions found.\n\nCreate a new session with /new.",
  "sessions.fetch_error":
    "🔴 OpenCode Server is unavailable or an error occurred while loading sessions.",
  "sessions.select_project_first": "🔴 Project is not selected. Use /projects.",
  "sessions.page_empty_callback": "No sessions on this page",
  "sessions.page_load_error_callback": "Cannot load this page. Please try again.",
  "sessions.loading_context": "⏳ Loading context and latest messages...",
  "sessions.selected": "✅ Session selected: {title}",
  "sessions.select_error": "🔴 Failed to select session.",
  "sessions.preview.empty": "No recent messages.",
  "sessions.preview.title": "Recent messages:",
  "sessions.preview.you": "You:",
  "sessions.preview.agent": "Agent:",

  "messages.project_not_selected":
    "🏗 Project is not selected.\n\nFirst select a project with /projects.",
  "messages.session_not_selected":
    "💬 Session is not selected.\n\nFirst choose a session with /sessions or create one with /new.",
  "messages.session_project_mismatch":
    "⚠️ The selected session does not match the current project. Choose the session again via /sessions.",
  "messages.empty": "📭 No user messages in the current session.",
  "messages.select": "Choose a message:",
  "messages.select_page": "Choose a message (page {page}):",
  "messages.fetch_error":
    "🔴 OpenCode Server is unavailable or an error occurred while loading messages.",
  "messages.inactive_callback": "This messages menu is inactive",
  "messages.page_empty_callback": "No messages on this page",
  "messages.button.prev_page": "⬅️ Prev",
  "messages.button.next_page": "Next ➡️",
  "messages.button.revert": "↩️ Revert",
  "messages.button.redo": "↪️ Redo",
  "messages.button.fork": "🔀 Fork",
  "messages.button.back": "⬅️ Back",
  "messages.button.cancel": "❌ Cancel",
  "messages.revert_success": "✅ Reverted to message:\n\n{text}",
  "messages.revert_error": "❌ Failed to revert message. Please try again.",
  "messages.redo_error": "❌ Failed to redo. Please try again.",
  "messages.fork_success": "🔀 Fork created from message:\n\n{text}",
  "messages.fork_error": "❌ Failed to create fork. Please try again.",

  "session.no_session": "ℹ️ No active OpenCode session. Open or attach to a session first.",
  "session.header": "🧭 OpenCode Session",
  "session.state": "State: {status}",
  "session.status_idle": "🟢 idle",
  "session.status_busy": "🟡 busy",
  "session.status_retry": "🔁 retry",
  "session.status_unknown": "⚪ unknown",
  "session.todos_none": "📝 Tasks: none",
  "session.todos_summary": "📝 Tasks: {total} total · {active} active · {done} done",
  "session.todos_unavailable": "📝 Tasks: unavailable",
  "session.changes_none": "🧩 Changes: none",
  "session.changes_summary": "🧩 Changes: {files} files · +{additions} / -{deletions}",
  "session.changes_unavailable": "🧩 Changes: unavailable",
  "session.children_none": "🌿 Sub-sessions: none",
  "session.children_summary": "🌿 Sub-sessions: {count}",
  "session.children_unavailable": "🌿 Sub-sessions: unavailable",
  "session.more": "…and {count} more",


  "detach.project_not_selected":
    "🏗 Project is not selected.\n\nFirst select a project with /projects.",
  "detach.no_active_session": "ℹ️ Bot is already detached from any session.",
  "detach.success":
    "✅ Detached from session: {title}\n\nThe OpenCode session was not stopped. If it is still running, it will continue separately. To check it later, select it again via /sessions.",
  "detach.error": "🔴 Failed to detach from the current session.",

  "new.created": "✅ New session created: {title}",
  "general.topic_only_prompt": "🚫 This is the General Topic of the forum — AI prompts are only allowed inside AI Topics.\n\n💬 Press New Chat to start a fresh coding Topic, or open an existing Topic from History.\n\nText is accepted here only when the bot explicitly asks you for input.",
  "new.create_error":
    "🔴 OpenCode Server is unavailable or an error occurred while creating session.",

  "stop.no_active_session":
    "🛑 Agent was not started\n\nCreate a session with /new or select one via /sessions.",
  "stop.in_progress":
    "🛑 Event stream stopped, sending abort signal...\n\nWaiting for agent to stop.",
  "stop.warn_unconfirmed":
    "⚠️ Event stream stopped, but server did not confirm abort.\n\nCheck /status and retry /abort in a few seconds.",
  "stop.warn_maybe_finished": "⚠️ Event stream stopped, but the agent may have already finished.",
  "stop.success": "✅ Agent action interrupted. No more messages from this run will be sent.",
  "stop.warn_still_busy":
    "⚠️ Signal sent, but agent is still busy.\n\nEvent stream is already disabled, so no intermediate messages will be sent.",
  "stop.warn_timeout":
    "⚠️ Abort request timeout.\n\nEvent stream is already disabled, retry /abort in a few seconds.",
  "stop.warn_local_only": "⚠️ Event stream stopped locally, but server-side abort failed.",
  "stop.error": "🔴 Failed to stop action.\n\nEvent stream is stopped, try /abort again.",

  "opencode_start.already_running": "✅ OpenCode Server is already running\n\nVersion: {version}",
  "opencode_start.remote_configured": "⚠️ /opencode_start works only with a local OpenCode Server.",
  "opencode_start.starting": "🔄 Starting OpenCode Server...",
  "opencode_start.start_error":
    "🔴 Failed to start OpenCode Server\n\nError: {error}\n\nCheck that OpenCode CLI is installed and available in PATH:\nopencode --version\nnpm install -g @opencode-ai/cli",
  "opencode_start.started_not_ready":
    "⚠️ OpenCode Server started, but is not responding\n\nPID: {pid}\n\nServer may still be starting. Try /status in a few seconds.",
  "opencode_start.success":
    "✅ OpenCode Server started successfully\n\nPID: {pid}\nVersion: {version}",
  "opencode_start.error":
    "🔴 An error occurred while starting server.\n\nCheck application logs for details.",
  "opencode_stop.remote_configured": "⚠️ /opencode_stop works only with a local OpenCode Server.",
  "opencode_stop.not_running": "⚠️ OpenCode Server is not running",
  "opencode_stop.stopping": "🛑 Stopping OpenCode Server...\n\nPID: {pid}",
  "opencode_stop.stop_error": "🔴 Failed to stop OpenCode Server\n\nError: {error}",
  "opencode_stop.success": "✅ OpenCode Server stopped successfully",
  "opencode_stop.error":
    "🔴 An error occurred while stopping server.\n\nCheck application logs for details.",

  "agent.changed_message": "✅ Agent changed to: {name}",
  "agent.change_error_callback": "Failed to change agent",
  "agent.menu.empty": "⚠️ No available agents",
  "agent.menu.error": "🔴 Failed to get agents list",

  "model.changed_message": "✅ Model changed to: {name}",

  "variant.model_not_selected_callback": "Error: model is not selected",
  "variant.changed_message": "✅ Variant changed to: {name}",
  "variant.change_error_callback": "Failed to change variant",
  "variant.select_model_first": "⚠️ Select a model first",
  "variant.menu.error": "🔴 Failed to get variants list",

  "context.button.confirm": "✅ Yes, compact context",
  "context.no_active_session": "⚠️ No active session. Create a session with /new",
  "context.confirm_text":
    '📊 Context compaction for session "{title}"\n\nThis will reduce context usage by removing old messages from history. Current task will not be interrupted.\n\nContinue?',
  "context.callback_compacting": "Compacting context...",
  "context.progress": "⏳ Compacting context...",
  "context.error": "❌ Context compaction failed",
  "context.success": "✅ Context compacted successfully",

  "permission.inactive_callback": "Permission request is inactive",
  "permission.processing_error_callback": "Processing error",
  "permission.no_active_request_callback": "Error: no active request",
  "permission.reply.once": "Allowed once",
  "permission.reply.always": "Always allowed",
  "permission.reply.reject": "Rejected",
  "permission.send_reply_error": "❌ Failed to send permission reply",
  "permission.blocked.expected_reply":
    "⚠️ Please answer the permission request first using the buttons above.",
  "permission.blocked.command_not_allowed":
    "⚠️ This command is not available until you answer the permission request.",
  "permission.header": "{emoji} Permission request: {name}\n\n",
  "permission.grouped_count": "\n⚠️ {count} identical requests pending — your answer applies to all of them.\n",
  "permission.button.allow": "✅ Allow once",
  "permission.button.always": "🔓 Allow always",
  "permission.button.reject": "❌ Reject",
  "permission.name.bash": "Bash",
  "permission.name.edit": "Edit",
  "permission.name.write": "Write",
  "permission.name.read": "Read",
  "permission.name.webfetch": "Web Fetch",
  "permission.name.websearch": "Web Search",
  "permission.name.glob": "File Search",
  "permission.name.grep": "Content Search",
  "permission.name.list": "List Directory",
  "permission.name.task": "Task",
  "permission.name.lsp": "LSP",
  "permission.name.external_directory": "External Directory",

  "question.inactive_callback": "Poll is inactive",
  "question.processing_error_callback": "Processing error",
  "question.select_one_required_callback": "Select at least one option",
  "question.enter_custom_callback": "Send your custom answer as a message",
  "question.cancelled": "❌ Poll cancelled",
  "question.answer_already_received": "Answer already received, please wait...",
  "question.completed_no_answers": "✅ Poll completed (no answers)",
  "question.no_active_project": "❌ No active project",
  "question.no_active_request": "❌ No active request",
  "question.send_answers_error": "❌ Failed to send answers to agent",
  "question.multi_hint": "\n(You can select multiple options)",
  "question.button.submit": "✅ Done",
  "question.button.custom": "🔤 Custom answer",
  "question.button.cancel": "❌ Cancel",
  "question.use_custom_button_first":
    '⚠️ To send text, tap "Custom answer" for the current question first.',
  "question.summary.title": "✅ Poll completed!\n\n",
  "question.summary.question": "Question {index}:\n{question}\n\n",
  "question.summary.answer": "Answer:\n{answer}\n\n",

  "keyboard.queued_prompt": "❌ {index}. {text}",
  "queue.added": "📥 Added to queue ({count}/{max}). It will be sent when the current task finishes.",
  "queue.full": "⚠️ Queue is full ({max}). Remove a message or wait for the current task to finish.",
  "queue.removed": "🗑 Message removed from the queue.",
  "queue.not_found": "This message is no longer in the queue.",
  "queue.disabled_hint": "The message queue can be enabled in /settings.",

  "pinned.default_session_title": "new session",
  "pinned.unknown": "Unknown",
  "pinned.line.model": "Model: {model}",
  "subagent.line.task": "Task: {task}",
  "subagent.line.agent": "Agent: {agent}",
  "subagent.working": "Working...",
  "subagent.completed": "Completed",
  "subagent.failed": "Task failed",

  "tool.todo.overflow": "*({count} more tasks)*",
  "tool.file_header.write":
    "Write File/Path: {path}\n============================================================\n\n",
  "tool.file_header.edit":
    "Edit File/Path: {path}\n============================================================\n\n",

  "runtime.wizard.ask_token": "Enter Telegram bot token (get it from @BotFather).\n> ",
  "runtime.wizard.ask_language":
    "Select interface language.\nEnter the language number from the list or locale code.\nPress Enter to keep default language: {defaultLocale}\n{options}\n> ",
  "runtime.wizard.language_invalid":
    "Enter a language number from the list or a supported locale code.\n",
  "runtime.wizard.language_selected": "Selected language: {language}\n",
  "runtime.wizard.token_required": "Token is required. Please try again.\n",
  "runtime.wizard.token_invalid":
    "Token looks invalid (expected format <id>:<secret>). Please try again.\n",
  "runtime.wizard.ask_user_id":
    "Enter your Telegram User ID (you can get it from @userinfobot).\n> ",
  "runtime.wizard.user_id_invalid": "Enter a positive integer (> 0).\n",
  "runtime.wizard.ask_api_url":
    "Enter OpenCode API URL (optional).\nPress Enter to use default: {defaultUrl}\n> ",
  "runtime.wizard.ask_server_username":
    "Enter OpenCode server username (optional).\nPress Enter to use default: {defaultUsername}\n> ",
  "runtime.wizard.ask_server_password":
    "Enter OpenCode server password (optional).\nPress Enter to keep it empty.\n> ",
  "runtime.wizard.api_url_invalid": "Enter a valid URL (http/https) or press Enter for default.\n",
  "runtime.wizard.start": "OpenCode Telegram Bot setup.\n",
  "runtime.wizard.saved": "Configuration saved:\n- {envPath}\n- {settingsPath}\n",
  "runtime.wizard.not_configured_starting":
    "Application is not configured yet. Starting wizard...\n",
  "runtime.wizard.tty_required":
    "Interactive wizard requires a TTY terminal. Run `opencode-telegram config` in an interactive shell.",
  "runtime.container.command_unavailable":
    "⚠️ This command is not available in the Docker image.",

  "rename.no_session": "⚠️ No active session. Create or select a session first.",
  "rename.prompt": "📝 Enter new title for session:\n\nCurrent: {title}",
  "rename.empty_title": "⚠️ Title cannot be empty.",
  "rename.success": "✅ Session renamed to: {title}",
  "rename.error": "🔴 Failed to rename session.",
  "rename.cancelled": "❌ Rename cancelled.",
  "rename.inactive_callback": "Rename request is inactive",
  "rename.inactive": "⚠️ Rename request is not active. Run /rename again.",
  "rename.blocked.expected_name":
    "⚠️ Enter a new session name as text or tap Cancel in rename message.",
  "rename.blocked.command_not_allowed":
    "⚠️ This command is not available while rename is waiting for a new name.",
  "rename.button.cancel": "❌ Cancel",

  "task.prompt.schedule":
    "⏰ Send the task schedule in natural language.\n\nExamples:\n- every 5 minutes\n- every day at 17:00\n- tomorrow at 12:00",
  "task.schedule_empty": "⚠️ Schedule cannot be empty.",
  "task.parse.in_progress": "⏳ Parsing schedule...",
  "task.parse_error":
    "🔴 Failed to parse schedule.\n\n{message}\n\nSend the schedule again in a clearer form.",
  "task.schedule_preview":
    "✅ Schedule parsed\n\nHow I understood it: {summary}\n{cronLine}Timezone: {timezone}\nType: {kind}\nNext run: {nextRunAt}",
  "task.schedule_preview.cron": "Cron: {cron}",
  "task.prompt.body": "📝 Now send what the bot should do on schedule.",
  "task.prompt_empty": "⚠️ Task text cannot be empty.",
  "task.created":
    "✅ Scheduled task created\n\nTask: {description}\nProject: {project}\nAgent: {agent}\nModel: {model}\nSchedule: {schedule}\n{cronLine}Next run: {nextRunAt}",
  "task.created.cron": "Cron: {cron}",
  "task.button.retry_schedule": "🔁 Re-enter schedule",
  "task.button.cancel": "❌ Cancel",
  "task.retry_schedule_callback": "Re-entering schedule...",
  "task.inactive_callback": "This scheduled task flow is inactive",
  "task.inactive": "⚠️ Scheduled task creation is not active. Run /task again.",
  "task.blocked.expected_input":
    "⚠️ Finish the current scheduled task setup first by sending text or using the button in the schedule message.",
  "task.blocked.command_not_allowed":
    "⚠️ This command is not available while scheduled task creation is active.",
  "task.limit_reached": "⚠️ Task limit reached ({limit}). Delete an existing scheduled task first.",
  "task.schedule_too_frequent":
    "Recurring schedule is too frequent. The minimum allowed interval is once every 5 minutes.",
  "task.kind.cron": "recurring",
  "task.kind.once": "one-time",
  "task.run.success": "⏰ Scheduled task completed: {description}",
  "task.run.error": "🔴 Scheduled task failed: {description}\n\nError: {error}",
  "task.run.error.interactive_question":
    "Scheduled task requested an interactive question and cannot continue unattended.",
  "task.run.error.interactive_permission":
    "Scheduled task requested interactive permission and cannot continue unattended.",

  "tasklist.empty": "📭 No scheduled tasks yet.",
  "tasklist.select": "Select a scheduled task:",
  "tasklist.details":
    "⏰ Scheduled task\n\nTask: {prompt}\nProject: {project}\nSchedule: {schedule}\n{cronLine}Timezone: {timezone}\nNext run: {nextRunAt}\nLast run: {lastRunAt}\nRun count: {runCount}",
  "tasklist.details.cron": "Cron: {cron}",
  "tasklist.button.delete": "🗑 Delete",
  "tasklist.button.cancel": "❌ Cancel",
  "tasklist.deleted_callback": "Deleted",
  "tasklist.inactive_callback": "This scheduled task menu is inactive",
  "tasklist.load_error": "🔴 Failed to load scheduled tasks.",

  "commands.select": "Choose an OpenCode command:",
  "commands.empty": "📭 No OpenCode commands are available for this project.",
  "commands.fetch_error": "🔴 Failed to load OpenCode commands.",
  "commands.no_description": "No description",
  "commands.button.execute": "✅ Execute",
  "commands.confirm":
    "Confirm execution of command {command}. To run it with arguments, send the arguments as a message.",
  "commands.inactive_callback": "This command menu is inactive",
  "commands.execute_callback": "Executing command...",
  "commands.executing_prefix": "⚡ Executing command:",
  "commands.arguments_empty": "⚠️ Arguments cannot be empty. Send text or tap Execute.",
  "commands.execute_error": "🔴 Failed to execute OpenCode command.",
  "commands.select_page": "Choose an OpenCode command (page {page}):",
  "commands.button.prev_page": "⬅️ Prev",
  "commands.button.next_page": "Next ➡️",
  "commands.page_empty_callback": "No commands on this page",
  "commands.download.downloading": "Downloading file...",
  "commands.download.not_found": "File not found",
  "commands.download.not_file": "Path is not a file",
  "commands.download.file_too_large": "File is too large",
  "commands.download.size": "Size",
  "commands.download.modified": "Modified",
  "commands.download.error": "Failed to download file.",

  "skills.select": "Choose an OpenCode skill:",
  "skills.empty": "📭 No OpenCode skills are available for this project.",
  "skills.fetch_error": "🔴 Failed to load OpenCode skills.",
  "skills.no_description": "No description",
  "skills.button.execute": "✅ Execute",
  "skills.confirm":
    "Confirm execution of skill {skill}. To run it with arguments, send the arguments as a message.",
  "skills.button.refresh": "🔄 Refresh",
  "skills.meta.developer": "👤 {developer}",
  "skills.meta.developer_version": "👤 {developer} ({version})",
  "skills.meta.source": "📍 {location}",
  "skills.meta.updated": "🕒 {date}",
  "skills.button.new": "➕ New skill",
  "skills.button.delete": "🗑 Delete skill",
  "skills.button.edit": "✏️ Edit skill",
  "skills.button.delete_confirm": "🗑 Delete permanently",
  "skills.button.delete_cancel": "Cancel",
  "skills.wizard.ask_name": "Send the skill name (lowercase letters, digits, hyphens — e.g. deploy-check).",
  "skills.wizard.invalid_name": "⚠️ Invalid skill name. Use lowercase letters, digits and single hyphens (1-64 chars), e.g. deploy-check.",
  "skills.wizard.ask_description": "Now send the one-line description: when should the agent use this skill?",
  "skills.wizard.ask_body": "Now send the skill body (Markdown instructions). Tip: keep it focused and actionable.",
  "skills.wizard.saved": "✅ Skill \"{name}\" saved to the global skills directory.",
  "skills.wizard.write_error": "🔴 Could not save skill: {error}",
  "skills.wizard.cancelled": "Skill wizard cancelled.",
  "skills.restart_hint": "Restart OpenCode (/opencode_stop + /opencode_start) to load the change.",
  "skills.delete_not_managed": "Only skills from the global skills directory can be deleted.",
  "skills.delete_confirm": "Delete skill {skill}? Its folder will be removed from the global skills directory.",
  "skills.deleted": "🗑 Skill \"{name}\" deleted.",
  "skills.delete_failed": "🔴 Could not delete the skill.",
  "skills.edit_not_managed": "Only skills from the global skills directory can be edited.",
  "skills.edit.ask_description": "Send the new one-line description for skill \"{name}\".",
  "skills.edit.ask_body": "Now send the new skill body (Markdown instructions). It will replace the current content.",
  "skills.edit.saved": "✅ Skill \"{name}\" updated.",
  "skills.button.import": "📥 Import from GitHub",
  "skills.button.import_confirm": "⬇️ Import",
  "skills.import.ask_url": "Send a GitHub link to a skill: repository, skill folder, or a SKILL.md file.",
  "skills.import.invalid_url": "⚠️ This is not a valid GitHub skill link. Send a repository, folder, or SKILL.md URL.",
  "skills.import.not_found": "🔴 No SKILL.md was found at that GitHub location.",
  "skills.import.fetch_error": "🔴 Could not fetch from GitHub: {error}",
  "skills.import.confirm": "Import skill {skill}?\n\n{description}\n\n📍 Source: {url}",
  "skills.import.multiple_found": "Found {count} skills in that location. Pick one to import:",
  "skills.imported": "✅ Skill \"{name}\" imported from GitHub.",
  "skills.import.exists": "⚠️ Skill \"{name}\" already exists. Edit or delete it first.",
  "skills.import.cancelled": "Skill import cancelled.",
  "skills.inactive_callback": "This skill menu is inactive",
  "skills.execute_callback": "Using skill...",
  "skills.executing_prefix": "⚡ Using skill:",
  "skills.arguments_empty": "⚠️ Arguments cannot be empty. Send text or tap Execute.",
  "skills.select_page": "Choose an OpenCode skill (page {page}):",
  "skills.button.prev_page": "⬅️ Prev",
  "skills.button.next_page": "Next ➡️",
  "skills.page_empty_callback": "No skills on this page",

  "mcps.select": "MCP servers:",
  "mcps.fetch_error": "🔴 Failed to load MCP servers.",
  "mcps.toggle_error": "🔴 Failed to toggle MCP server.",
  "mcps.enabling": "Enabling...",
  "mcps.disabling": "Disabling...",
  "mcps.status.connected": "🟢 Connected",
  "mcps.status.disabled": "🔴 Disabled",
  "mcps.status.failed": "⚠️ Failed",
  "mcps.status.needs_auth": "🔒 Needs auth",
  "mcps.status.needs_client_registration": "🔒 Needs registration",
  "mcps.detail.title": "Server: {name}",
  "mcps.detail.status": "Status: {status}",
  "mcps.detail.type": "Type: {type}",
  "mcps.detail.error": "Error: {error}",
  "mcps.button.enable": "🟢 Enable",
  "mcps.button.disable": "🔴 Disable",
  "mcps.button.back": "⬅️ Back",
  "mcps.empty": "🔌 MCP Servers\n\nNo MCP servers are configured for this workspace yet.\n\nAdd one to make external tools available to OpenCode.",
  "mcps.type.local": "Local",
  "mcps.type.remote": "Remote",
  "mcps.type.unknown": "Unknown",
  "mcps.button.add": "➕ Add MCP Server",
  "mcps.button.home": "🏠 Home",
  "mcps.button.cancel": "✖ Cancel",
  "mcps.button.open_login": "🔐 Open Login",
  "mcps.button.sign_in": "🔐 Sign In",
  "mcps.button.other_auth": "⚙️ Other Auth",
  "mcps.button.authentication": "🔐 Authentication",
  "mcps.button.auto_oauth": "✨ Auto / OAuth",
  "mcps.button.local": "💻 Local",
  "mcps.button.remote": "🌐 Remote",
  "mcps.button.skip_secret": "Skip Secret",
  "mcps.button.skip_scope": "Skip Scope",
  "mcps.add.expired": "This menu has expired. Please open MCP Servers again.",
  "mcps.add.name_prompt": "➕ Add MCP Server\n\n1/3 · Server name\n\nSend a unique name for this MCP server.",
  "mcps.add.type_prompt": "➕ Add MCP Server\n\n2/3 · Server type\n\nChoose how OpenCode should connect to this server.",
  "mcps.add.remote_prompt": "➕ Add Remote MCP Server\n\n3/3 · Server URL\n\nSend the absolute MCP Streamable HTTP URL.\n\nExample: https://mcp.example.com/mcp",
  "mcps.add.local_prompt": "➕ Add Local MCP Server\n\n3/3 · Command\n\nSend the command OpenCode should run.\n\nExample: npx -y @modelcontextprotocol/server-everything",
  "mcps.add.name_too_long": "➕ Add MCP Server\n\n1/3 · Server name\n\n❌ Name must be 128 characters or fewer. Send another name.",
  "mcps.add.retry": "➕ Add MCP Server\n\n3/3 · {field}\n\n❌ {error}\n\nSend a corrected value to retry, or go Back.",
  "mcps.add.field.remote_url": "Server URL",
  "mcps.add.field.command": "Command",
  "mcps.auth.summary": "🔐 Authentication: {mode}\nCredentials: securely stored by the bot",
  "mcps.auth.reconfigure": "⚠️ Stored authentication needs reconfiguration.",
  "mcps.auth.invalid_callback_url": "🔐 MCP Login\n\n❌ Send the full callback URL from your browser address bar, including both code and state.",
  "mcps.auth.invalid_callback": "🔐 MCP Login\n\n❌ Invalid OAuth callback. The callback must contain the matching code and state from this login attempt.",
  "mcps.detail.needs_auth_hint":
    "🔐 OAuth login is required. Tap Sign In below to authorize this MCP server.",
  "mcps.detail.needs_client_registration_hint":
    "🪪 This server requires a pre-registered OAuth client. Configure its Client ID and optional Client Secret here, then continue with Sign In.",
  "mcps.auth.sign_in_title": "🔐 Sign in to {name}",
  "mcps.auth.sign_in_steps":
    "1. Tap Open Login and finish authorization in your browser.\n2. If the browser ends on an unavailable localhost page, copy the full URL from the address bar.\n3. Send that full callback URL here.\n\nThe authorization code is deleted from Telegram immediately and is never sent to the model.",
  "mcps.auth.cancelled": "Authentication setup cancelled.",
  "mcps.auth.login_cancelled": "MCP login cancelled.",
  "mcps.auth.setup_cancelled": "MCP setup cancelled.",
  "mcps.auth.not_waiting_oauth": "This MCP server is not waiting for OAuth login.",
  "mcps.auth.opening_login": "Opening secure MCP login…",
  "mcps.auth.menu_title": "🔐 Authentication · {name}",
  "mcps.auth.server_line": "Server: {url}",
  "mcps.auth.menu_prompt": "Choose how this remote MCP server authenticates.",
  "mcps.auth.menu_options":
    "✨ Auto / OAuth — recommended when the server supports browser sign-in\n🔑 Bearer Token — Authorization: Bearer …\n🗝 API Key — X-API-Key by default\n🧩 Custom Header — for provider-specific headers\n🪪 OAuth Client — pre-registered Client ID / Secret",
  "mcps.auth.secrets_note": "Secrets are encrypted by the bot and are never shown to the model.",
  "mcps.auth.outside_context": "🔒 Credentials stay outside model context.",
  "mcps.auth.header_name_prompt":
    "Send the HTTP header name used by this MCP server.\n\nExample: X-Service-Token",
  "mcps.auth.bearer_prompt":
    "Send the bearer token.\n\nThe message will be deleted immediately.",
  "mcps.auth.api_key_prompt":
    "Send the API key for X-API-Key.\n\nThe message will be deleted immediately.",
  "mcps.auth.custom_header_prompt":
    "Send the value for {header}.\n\nThe message will be deleted immediately.",
  "mcps.auth.client_id_prompt": "Send the pre-registered OAuth Client ID.",
  "mcps.auth.client_secret_prompt":
    "Send the Client Secret, or tap Skip Secret if this is a public client.\n\nThe message will be deleted immediately.",
  "mcps.auth.scope_prompt":
    "Send the OAuth scope requested by the provider, or tap Skip Scope to use the server default.",
  "mcps.auth.configure_failed":
    "❌ Authentication could not be configured.\nCheck the credential or provider settings and try again.\n\nThe submitted secret was not displayed or logged.",
  "mcps.auth.mode.bearer": "Bearer Token",
  "mcps.auth.mode.api_key": "API Key",
  "mcps.auth.mode.custom_header": "Custom Header",
  "mcps.auth.mode.oauth_client": "OAuth Client",
  "mcps.auth.step_title": "🔐 {mode} · {name}",
  "mcps.auth.step_title_client": "🪪 OAuth Client · {name}",
  "mcps.button.rename": "✏️ Rename",
  "mcps.button.delete": "🗑 Delete",
  "mcps.button.confirm_delete": "🗑 Yes, delete",
  "mcps.rename.prompt": "✏️ Rename MCP Server\n\nCurrent name: {name}\n\nSend the new server name.",
  "mcps.rename.retry": "✏️ Rename MCP Server\n\n❌ {error}\n\nSend another name to retry.",
  "mcps.rename.name_too_long": "Name must be 128 characters or fewer.",
  "mcps.delete.confirm": "🗑 Delete MCP Server\n\nDelete {name}?\n\nThis removes the bot-managed definition and stored authentication, disconnects it from active runtimes, and stops restoring it after restart.",
  "mcps.deleted": "Deleted MCP server {name}.",
  "mcps.auth.account": "👤 Account: {identity}{provider}",
  "mcps.auth.account_unknown": "👤 Account: Signed in{provider} · provider did not expose an email/username",
  "model.fallback.notice":
    "⚠️ Selected model {previous} is unavailable or not agent-capable. Switched to {next}.",



  "stt.uncertain": "🎤 Some words may be incorrect. Review and send the corrected text to continue:",
  "stt.recognizing": "🎤 Recognizing audio...",
  "stt.recognized": "🎤 Recognized:",
  "stt.not_configured":
    "🎤 Voice recognition is not configured.\n\nSet STT_API_URL and STT_API_KEY in .env to enable it.",
  "stt.error": "🔴 Failed to recognize audio: {error}",
  "stt.empty_result": "🎤 No speech detected in the audio message.",

  "worktree.branch_detached": "detached HEAD",
  "worktree.select_with_current": "Select a worktree:",
  "worktree.project_not_selected":
    "🏗 Project is not selected.\n\nFirst select a project with /projects.",
  "worktree.not_git_repo":
    "🌿 Git worktrees are unavailable for the current project. Select a git repository first.",
  "worktree.not_git_repo_callback": "Current project is not a git repository",
  "worktree.empty": "📭 No git worktrees found for the current repository.",
  "worktree.fetch_error": "🔴 Failed to load git worktrees.",
  "worktree.page_empty_callback": "No worktrees on this page",
  "worktree.selection_missing_callback": "Selected worktree is no longer available",
  "worktree.already_selected_callback": "This worktree is already selected",
  "worktree.selected":
    "✅ Worktree selected: {worktree}\n\n📋 Session was reset. Use /sessions or /new to continue.",
  "worktree.select_error": "🔴 Failed to select worktree.",
  "open.back": "⬆️ Up",
  "open.roots": "📋 Back to roots",
  "open.prev_page": "⬅️ Previous",
  "open.next_page": "Next ➡️",
  "open.select_current": "✅ Select this folder",
  "open.select_root": "📂 Select a root directory to browse:",
  "open.access_denied": "⛔ Access denied: path is outside allowed roots",
  "open.scan_error": "🔴 Cannot browse directory: {error}",
  "open.open_error": "🔴 Failed to open directory browser.",
  "open.selected": "✅ Project added: {project}\n\n📋 Use /sessions or /new to start working.",
  "open.select_error": "🔴 Failed to add project.",
  "open.no_subfolders": "📭 No subfolders",
  "open.subfolder_count": "{count} subfolder",
  "open.subfolders_count": "{count} subfolders",
  "ls.access_denied": "⛔ Access denied: path is outside the current project",
  "ls.scan_error": "🔴 Cannot list directory",
  "ls.header": "Directory Listing",
  "ls.total": "Total: {count} items",
  "ls.file.header": "File Details",
  "ls.file.download": "📥 Download",
  "ls.file.back": "⬅️ Back",
  "ls.file.attach": "📎 Attach to next prompt",
  "attachment.added": "📎 Attached: {path}\n\nSend your message and the file will go with it.",
  "attachment.cancel": "❌ Cancel attachment",
  "attachment.cancelled": "❌ Attachment cancelled",
  "attachment.invalid": "⚠️ The attached file is no longer available. Sending the message without it.",
} as const;

export type I18nKey = keyof typeof en;
export type I18nDictionary = Record<I18nKey, string>;
