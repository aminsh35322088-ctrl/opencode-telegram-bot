export const en = {
  "cmd.description.status": "Server and session status",
  "cmd.description.new": "Create a new session",
  "cmd.description.stop": "Stop current action",
  "cmd.description.detach": "Detach from current session",
  "cmd.description.sessions": "List sessions",
  "cmd.description.messages": "Browse session messages",
  "cmd.description.settings": "Change bot settings",
  "cmd.description.projects": "List projects",
  "cmd.description.worktree": "Switch git worktrees",
  "cmd.description.task": "Create a scheduled task",
  "cmd.description.tasklist": "List scheduled tasks",
  "cmd.description.commands": "Custom commands",
  "cmd.description.skills": "Skills catalog",
  "cmd.description.mcps": "MCP servers",
  "cmd.description.memory": "Persistent memory",
  "cmd.description.opencode_start": "Start OpenCode server",
  "cmd.description.opencode_stop": "Stop OpenCode server",
  "cmd.description.ls": "List directory contents",
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
  "inline.button.close": "❌ Close",
  "inline.inactive_callback": "This menu is inactive",

  "common.cancelled": "Cancelled",
  "common.unknown": "unknown",
  "common.unknown_error": "unknown error",

  "start.welcome":
    "👋 Welcome to OpenCode Telegram Bot!\n\nUse commands:\n/projects — select project\n/sessions — session list\n/new — new session\n/commands — custom commands\n/skills — skills catalog\n/task — scheduled task\n/tasklist — scheduled tasks\n/status — status\n/help — help\n\nUse the bottom buttons to select the agent, model, and variant.",
  "help.keyboard_hint":
    "💡 Use the bottom keyboard buttons for the agent, model, variant, and context actions.",
  "help.text":
    "📖 **Help**\n\n/status - Check server status\n/sessions - Session list\n/new - Create new session\n/help - Help",

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
  "bot.photo_too_large": "⚠️ Photo is too large (max {maxSizeMb}MB)",
  "bot.photo_model_no_image": "⚠️ Current model doesn't support image input. Sending text only.",
  "bot.photo_download_error": "🔴 Failed to download photo",
  "bot.photo_no_caption": "💡 Tip: Add a caption to describe what you want to do with this photo.",
  "bot.file_downloading": "⏳ Downloading file...",
  "bot.files_downloading": "⏳ Downloading files...",
  "bot.file_too_large": "⚠️ File is too large (max {maxSizeMb}MB)",
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
  "status.line.managed_yes": "Started by bot: Yes",
  "status.line.managed_no": "Started by bot: No",
  "status.line.pid": "PID: {pid}",
  "status.line.uptime_sec": "Uptime: {seconds} sec",
  "status.line.mode": "Agent: {mode}",
  "status.line.model": "Model: {model}",
  "status.line.tts": "Audio replies: {tts}",
  "status.tts.off": "Off",
  "status.tts.all": "All",
  "status.tts.auto": "Auto",
  "status.agent_not_set": "not set",
  "status.project_selected": "Project: {project}",
  "status.worktree_selected": "Worktree: {worktree}",
  "status.project_not_selected": "Project: not selected",
  "status.project_hint": "Use /projects to select a project",
  "status.session_selected": "Current session: {title}",
  "status.session_not_selected": "Current session: not selected",
  "status.session_hint": "Use /sessions to select one or /new to create one",
  "status.server_unavailable":
    "🔴 OpenCode Server is unavailable\n\nUse /opencode_start to start the server.",

  "tts.off": "🔇 Audio replies disabled.",
  "tts.all": "🔊 Audio replies enabled for all messages.",
  "tts.auto": "🎤 Audio replies enabled for voice/audio messages only.",
  "tts.not_configured":
    "⚠️ Audio replies are unavailable. Set `TTS_API_URL` and `TTS_API_KEY` first.",
  "tts.failed": "⚠️ Failed to generate audio reply.",

  "settings.menu.title": "⚙️ Bot settings\nTap a setting to toggle its value:",
  "settings.compact_output.label": "Compact output mode",
  "settings.thinking_content.label": "Thinking content",
  "settings.response_streaming.label": "Response streaming",
  "settings.response_streaming.edit": "edit",
  "settings.response_streaming.draft": "draft (experimental)",
  "settings.diff_files.label": "Diff files",
  "settings.assistant_footer.label": "Assistant footer",
  "settings.tts.label": "Audio replies",
  "settings.prompt_queue.label": "Message queue",
  "settings.value.on": "On",
  "settings.value.off": "Off",
  "settings.saved": "✅ Setting saved.",

  "projects.empty":
    "📭 No projects found.\n\nOpen a directory in OpenCode and create at least one session, then it will appear here.",
  "projects.select": "Select a project:",
  "projects.select_with_current": "Select a project:\n\nCurrent: 🏗 {project}",
  "projects.page_indicator": "Page {current}/{total}",
  "projects.prev_page": "⬅️ Previous",
  "projects.next_page": "Next ➡️",
  "projects.fetch_error":
    "🔴 OpenCode Server is unavailable or an error occurred while loading projects.",
  "projects.page_load_error": "Cannot load this page. Please try again.",
  "projects.selected":
    "✅ Project selected: {project}\n\n📋 Session was reset. Use /sessions or /new for this project.",
  "projects.select_error": "🔴 Failed to select project.",

  "sessions.project_not_selected":
    "🏗 Project is not selected.\n\nFirst select a project with /projects.",
  "sessions.empty": "📭 No sessions found.\n\nCreate a new session with /new.",
  "sessions.select": "Select a session:",
  "sessions.select_page": "Select a session (page {page}):",
} as const;

export type I18nKey = keyof typeof en;
