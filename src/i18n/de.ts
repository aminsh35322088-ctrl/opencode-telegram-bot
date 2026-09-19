import type { I18nDictionary } from "./en.js";

export const de: I18nDictionary = {
  "cmd.description.help": "Hilfe",

  "callback.unknown_command": "Unbekannter Befehl",
  "callback.processing_error": "Verarbeitungsfehler",

  "error.load_agents": "❌ Agentenliste konnte nicht geladen werden",
  "error.load_models": "❌ Modellliste konnte nicht geladen werden",
  "error.load_variants": "❌ Variantenliste konnte nicht geladen werden",
  "error.context_button": "❌ Kontext-Button konnte nicht verarbeitet werden",
  "error.generic": "🔴 Etwas ist schiefgelaufen.",

  "interaction.blocked.expired": "⚠️ Diese Interaktion ist abgelaufen. Bitte starte sie erneut.",
  "interaction.blocked.expected_callback":
    "⚠️ Bitte benutze für diesen Schritt die Inline-Buttons oder tippe auf Abbrechen.",
  "interaction.blocked.expected_text": "⚠️ Bitte sende für diesen Schritt eine Textnachricht.",
  "interaction.blocked.expected_command": "⚠️ Bitte sende für diesen Schritt einen Befehl.",
  "interaction.blocked.command_not_allowed":
    "⚠️ Dieser Befehl ist in diesem Schritt nicht verfügbar.",
  "interaction.blocked.finish_current":
    "⚠️ Schließe zuerst die aktuelle Interaktion ab (antworten oder abbrechen), dann öffne ein anderes Menü.",

  "inline.blocked.expected_choice":
    "⚠️ Wähle eine Option über die Inline-Buttons oder tippe auf Abbrechen.",
  "inline.blocked.command_not_allowed":
    "⚠️ Dieser Befehl ist nicht verfügbar, solange das Inline-Menü aktiv ist.",

  "question.blocked.expected_answer":
    "⚠️ Beantworte die aktuelle Frage über Buttons, Eigene Antwort oder Abbrechen.",
  "question.blocked.command_not_allowed":
    "⚠️ Dieser Befehl ist erst verfügbar, wenn der aktuelle Frage-Flow abgeschlossen ist.",

  "inline.button.cancel": "❌ Abbrechen",
  "inline.inactive_callback": "Dieses Menü ist inaktiv",

  "common.cancelled": "Abgebrochen",
  "common.unknown": "unbekannt",
  "common.unknown_error": "unbekannter Fehler",

  "help.keyboard_hint":
    "💡 Nutze die unteren Buttons für Agent, Modell, Variante und Kontextaktionen.",

  "bot.thinking": "💭 Denke...",
  "progress.compact.activity": "{header}\n{activity}",
  "progress.compact.working_header": "⏳ Arbeite",
  "progress.compact.finished_header": "✅ Arbeit abgeschlossen",
  "progress.compact.thinking": "💭 Denke...",
  "progress.compact.responding": "✍️ Schreibe Antwort...",
  "progress.compact.waiting_question": "❓ Warte auf deine Antwort...",
  "progress.compact.waiting_permission": "🔐 Warte auf Berechtigung...",
  "progress.compact.retrying": "🔁 Wiederhole...",
  "progress.compact.task": "🤖 Aufgabe läuft",
  "progress.compact.done": "{header}\nTool-Aufrufe: {tools} · geänderte Dateien: {files}",
  "bot.project_not_selected":
    "🏗 Projekt ist nicht ausgewählt.\n\nWähle zuerst ein Projekt mit /projects.",
  "bot.creating_session": "🔄 Erstelle eine neue Sitzung...",
  "bot.create_session_error":
    "🔴 Sitzung konnte nicht erstellt werden. Versuche /new oder prüfe den Serverstatus mit /status.",
  "bot.session_created": "✅ Sitzung erstellt: {title}",
  "bot.session_busy":
    "⏳ Agent führt bereits eine Aufgabe aus. Warte auf Abschluss oder nutze /abort, um den aktuellen Lauf zu unterbrechen.",
  "bot.session_reset_project_mismatch":
    "⚠️ Die aktive Sitzung passt nicht zum ausgewählten Projekt und wurde daher zurückgesetzt. Nutze /sessions zur Auswahl oder /new, um eine neue Sitzung zu erstellen.",
  "bot.prompt_send_error": "Anfrage konnte nicht an OpenCode gesendet werden.",
  "bot.empty_prompt": "⚠️ Es gibt nichts zu senden: Die Nachricht ist nach der Anhangverarbeitung leer.",
  "bot.session_error": "🔴 OpenCode meldete einen Fehler: {message}",
  "bot.session_retry":
    "🔁 {message}\n\nDer Provider liefert bei wiederholten Versuchen immer wieder denselben Fehler. Mit /abort abbrechen.",
  "bot.external_user_input": "Externe Benutzereingabe",
  "background.session_fallback": "Sitzung {id}",
  "background.assistant_response":
    "🔔 Assistent hat in einer Hintergrundsitzung geantwortet: {session}",
  "background.question_asked": "❓ Hintergrundsitzung benötigt eine Antwort: {session}",
  "background.permission_asked": "🔐 Hintergrundsitzung hat Berechtigungen angefordert: {session}",
  "background.open_session_button": "Sitzung öffnen",
  "bot.unknown_command":
    "⚠️ Unbekannter Befehl: {command}. Nutze /help, um verfügbare Befehle zu sehen.",
  "bot.photo_downloading": "⏳ Lade Foto herunter...",
  "bot.photo_model_no_image":
    "⚠️ Das aktuelle Modell unterstützt keine Bildeingabe. Sende nur Text.",
  "bot.photo_download_error": "🔴 Foto konnte nicht heruntergeladen werden",
  "bot.video_downloading": "⏳ Video wird heruntergeladen...",
  "bot.video_too_large": "⚠️ Video ist zu groß (max {maxSizeMb}MB)",
  "bot.video_error": "🔴 Video konnte nicht verarbeitet werden",
  "bot.file_downloading": "⏳ Lade Datei herunter...",
  "bot.files_downloading": "⏳ Lade Dateien herunter...",
  "bot.file_download_error": "🔴 Datei konnte nicht heruntergeladen werden",
  "bot.file_type_unsupported":
    "⚠️ Dieser Dateityp wird nicht unterstützt. Sende ein Bild, Dokument (PDF, DOCX, PPTX) oder eine Text-/Code-Datei.",
  "bot.media_group_not_processed":
    "⚠️ Eine oder mehrere Dateien in diesem Album können nicht verarbeitet werden. Es wurde nichts an OpenCode gesendet.",
  "bot.media_group_download_error":
    "🔴 Eine der Dateien konnte nicht heruntergeladen werden. Es wurde nichts an OpenCode gesendet.",
  "bot.model_no_pdf": "⚠️ Das aktuelle Modell unterstützt keine PDF-Eingabe. Sende nur Text.",
  "bot.document_extraction_error": "🔴 Dokumenttext konnte nicht extrahiert werden.",
  "bot.text_file_too_large": "⚠️ Textdatei ist zu groß (max. {maxSizeKb}KB)",

  "status.header_running": "🟢 OpenCode-Server läuft",
  "status.health.healthy": "OK",
  "status.health.unhealthy": "Nicht OK",
  "status.line.health": "Status: {health}",
  "status.line.version": "Version: {version}",
  "status.line.mode": "Agent: {mode}",
  "status.line.model": "Modell: {model}",
  "status.agent_not_set": "nicht gesetzt",
  "status.project_selected": "Projekt: {project}",
  "status.worktree_selected": "Worktree: {worktree}",
  "status.session_selected": "Aktuelle Sitzung: {title}",
  "status.session_not_selected": "Aktuelle Sitzung: nicht ausgewählt",
  "status.session_hint": "Nutze /sessions zur Auswahl oder /new zum Erstellen",
  "status.server_unavailable":
    "🔴 OpenCode-Server ist nicht verfügbar\n\nNutze /opencode_start, um den Server zu starten.",


  "settings.saved": "✅ Einstellung gespeichert.",

  "projects.empty":
    "📭 Keine Projekte gefunden.\n\nÖffne ein Verzeichnis in OpenCode und erstelle mindestens eine Sitzung, dann erscheint es hier.",
  "projects.page_indicator": "Seite {current}/{total}",
  "projects.prev_page": "⬅️ Zurück",
  "projects.next_page": "Weiter ➡️",
  "projects.select_error": "🔴 Projekt konnte nicht ausgewählt werden.",

  "sessions.empty": "📭 Keine Sitzungen gefunden.\n\nErstelle eine neue Sitzung mit /new.",
  "sessions.fetch_error":
    "🔴 OpenCode-Server ist nicht verfügbar oder beim Laden der Sitzungen ist ein Fehler aufgetreten.",
  "sessions.select_project_first": "🔴 Projekt ist nicht ausgewählt. Nutze /projects.",
  "sessions.page_empty_callback": "Auf dieser Seite gibt es keine Sitzungen",
  "sessions.page_load_error_callback":
    "Diese Seite kann nicht geladen werden. Bitte versuche es erneut.",
  "sessions.loading_context": "⏳ Lade Kontext und letzte Nachrichten...",
  "sessions.selected": "✅ Sitzung ausgewählt: {title}",
  "sessions.select_error": "🔴 Sitzung konnte nicht ausgewählt werden.",
  "sessions.preview.empty": "Keine neuen Nachrichten.",
  "sessions.preview.title": "Letzte Nachrichten:",
  "sessions.preview.you": "Du:",
  "sessions.preview.agent": "Agent:",

  "messages.project_not_selected":
    "🏗 Kein Projekt ausgewählt.\n\nWähle zuerst ein Projekt mit /projects.",
  "messages.session_not_selected":
    "💬 Keine Sitzung ausgewählt.\n\nWähle zuerst eine Sitzung mit /sessions oder erstelle eine mit /new.",
  "messages.session_project_mismatch":
    "⚠️ Die ausgewählte Sitzung passt nicht zum aktuellen Projekt. Wähle die Sitzung erneut über /sessions.",
  "messages.empty": "📭 Keine Benutzernachrichten in der aktuellen Sitzung.",
  "messages.select": "Wähle eine Nachricht:",
  "messages.select_page": "Wähle eine Nachricht (Seite {page}):",
  "messages.fetch_error":
    "🔴 OpenCode Server ist nicht erreichbar oder beim Laden der Nachrichten ist ein Fehler aufgetreten.",
  "messages.inactive_callback": "Dieses Nachrichtenmenü ist nicht mehr aktiv",
  "messages.page_empty_callback": "Keine Nachrichten auf dieser Seite",
  "messages.button.prev_page": "⬅️ Zurück",
  "messages.button.next_page": "Weiter ➡️",
  "messages.button.revert": "↩️ Revert",
  "messages.button.redo": "↪️ Wiederholen",
  "messages.button.fork": "🔀 Fork",
  "messages.button.back": "⬅️ Zurück",
  "messages.button.cancel": "❌ Abbrechen",
  "messages.revert_success": "✅ Zurück zur Nachricht:\n\n{text}",
  "messages.revert_error":
    "❌ Nachricht konnte nicht zurückgesetzt werden. Bitte versuche es erneut.",
  "messages.redo_error": "❌ Wiederherstellung fehlgeschlagen. Bitte erneut versuchen.",
  "messages.fork_success": "🔀 Fork erstellt von Nachricht:\n\n{text}",
  "messages.fork_error": "❌ Fork konnte nicht erstellt werden. Bitte versuche es erneut.",
  "session.no_session": "ℹ️ Keine aktive OpenCode-Sitzung. Öffne oder verbinde zuerst eine Sitzung.",
  "session.header": "🧭 OpenCode-Sitzung",
  "session.state": "Status: {status}",
  "session.status_idle": "🟢 bereit",
  "session.status_busy": "🟡 beschäftigt",
  "session.status_retry": "🔁 erneuter Versuch",
  "session.status_unknown": "⚪ unbekannt",
  "session.todos_none": "📝 Aufgaben: keine",
  "session.todos_summary": "📝 Aufgaben: {total} gesamt · {active} aktiv · {done} erledigt",
  "session.todos_unavailable": "📝 Aufgaben: nicht verfügbar",
  "session.changes_none": "🧩 Änderungen: keine",
  "session.changes_summary": "🧩 Änderungen: {files} Dateien · +{additions} / -{deletions}",
  "session.changes_unavailable": "🧩 Änderungen: nicht verfügbar",
  "session.children_none": "🌿 Untersitzungen: keine",
  "session.children_summary": "🌿 Untersitzungen: {count}",
  "session.children_unavailable": "🌿 Untersitzungen: nicht verfügbar",
  "session.more": "…und {count} weitere",


  "detach.project_not_selected":
    "🏗 Projekt ist nicht ausgewählt.\n\nWähle zuerst ein Projekt mit /projects.",
  "detach.no_active_session": "ℹ️ Der Bot ist bereits von allen Sitzungen getrennt.",
  "detach.success":
    "✅ Von Sitzung getrennt: {title}\n\nDie OpenCode-Sitzung wurde nicht gestoppt. Falls sie noch läuft, läuft sie separat weiter. Um sie später zu prüfen, wähle sie erneut über /sessions aus.",
  "detach.error": "🔴 Trennen von der aktuellen Sitzung fehlgeschlagen.",

  "new.created": "✅ Neue Sitzung erstellt: {title}",
  "general.topic_only_prompt": "🚫 Dies ist das Allgemeine Thema der Gruppe — KI-Prompts sind nur in KI-Themen erlaubt.\n\n💬 Drücke New Chat, um ein neues Coding-Thema zu starten, oder öffne ein bestehendes Thema über History.\n\nText wird hier nur akzeptiert, wenn der Bot ausdrücklich nach Eingabe fragt.",
  "new.create_error":
    "🔴 OpenCode-Server ist nicht verfügbar oder beim Erstellen der Sitzung ist ein Fehler aufgetreten.",

  "stop.no_active_session":
    "🛑 Agent wurde nicht gestartet\n\nErstelle eine Sitzung mit /new oder wähle eine über /sessions aus.",
  "stop.in_progress":
    "🛑 Event-Stream gestoppt, sende Abbruchsignal...\n\nWarte darauf, dass der Agent stoppt.",
  "stop.warn_unconfirmed":
    "⚠️ Event-Stream gestoppt, aber der Server hat den Abbruch nicht bestätigt.\n\nPrüfe /status und versuche /abort in ein paar Sekunden erneut.",
  "stop.warn_maybe_finished":
    "⚠️ Event-Stream gestoppt, aber der Agent konnte bereits fertig sein.",
  "stop.success":
    "✅ Agent-Aktion unterbrochen. Von diesem Lauf werden keine weiteren Nachrichten gesendet.",
  "stop.warn_still_busy":
    "⚠️ Signal gesendet, aber der Agent ist noch beschäftigt.\n\nDer Event-Stream ist bereits deaktiviert, daher werden keine Zwischenmeldungen gesendet.",
  "stop.warn_timeout":
    "⚠️ Timeout beim Abbruch.\n\nDer Event-Stream ist bereits deaktiviert, versuche /abort in ein paar Sekunden erneut.",
  "stop.warn_local_only":
    "⚠️ Event-Stream lokal gestoppt, aber serverseitiger Abbruch ist fehlgeschlagen.",
  "stop.error":
    "🔴 Aktion konnte nicht gestoppt werden.\n\nEvent-Stream ist gestoppt, versuche /abort erneut.",

  "opencode_start.already_running": "✅ OpenCode-Server läuft bereits\n\nVersion: {version}",
  "opencode_start.remote_configured":
    "⚠️ /opencode_start funktioniert nur mit einem lokalen OpenCode-Server.",
  "opencode_start.starting": "🔄 Starte OpenCode-Server...",
  "opencode_start.start_error":
    "🔴 OpenCode-Server konnte nicht gestartet werden\n\nFehler: {error}\n\nPrüfe, ob OpenCode CLI installiert und im PATH verfügbar ist:\nopencode --version\nnpm install -g @opencode-ai/cli",
  "opencode_start.started_not_ready":
    "⚠️ OpenCode-Server gestartet, aber reagiert nicht\n\nPID: {pid}\n\nDer Server startet möglicherweise noch. Versuche /status in ein paar Sekunden.",
  "opencode_start.success":
    "✅ OpenCode-Server erfolgreich gestartet\n\nPID: {pid}\nVersion: {version}",
  "opencode_start.error":
    "🔴 Beim Starten des Servers ist ein Fehler aufgetreten.\n\nSiehe Anwendungslogs für Details.",
  "opencode_stop.remote_configured":
    "⚠️ /opencode_stop funktioniert nur mit einem lokalen OpenCode-Server.",
  "opencode_stop.not_running": "⚠️ OpenCode-Server läuft nicht",
  "opencode_stop.stopping": "🛑 Stoppe OpenCode-Server...\n\nPID: {pid}",
  "opencode_stop.stop_error": "🔴 OpenCode-Server konnte nicht gestoppt werden\n\nFehler: {error}",
  "opencode_stop.success": "✅ OpenCode-Server erfolgreich gestoppt",
  "opencode_stop.error":
    "🔴 Beim Stoppen des Servers ist ein Fehler aufgetreten.\n\nSiehe Anwendungslogs für Details.",

  "agent.changed_message": "✅ Agent geändert zu: {name}",
  "agent.change_error_callback": "Agent konnte nicht geändert werden",
  "agent.menu.empty": "⚠️ Keine verfügbaren Agenten",
  "agent.menu.error": "🔴 Agentenliste konnte nicht geladen werden",

  "model.changed_message": "✅ Modell geändert zu: {name}",

  "variant.model_not_selected_callback": "Fehler: Modell ist nicht ausgewählt",
  "variant.changed_message": "✅ Variante geändert zu: {name}",
  "variant.change_error_callback": "Variante konnte nicht geändert werden",
  "variant.select_model_first": "⚠️ Zuerst ein Modell auswählen",
  "variant.menu.error": "🔴 Variantenliste konnte nicht geladen werden",

  "context.button.confirm": "✅ Ja, Kontext komprimieren",
  "context.no_active_session": "⚠️ Keine aktive Sitzung. Erstelle eine Sitzung mit /new",
  "context.confirm_text":
    '📊 Kontext-Komprimierung für Sitzung "{title}"\n\nDadurch wird die Kontextnutzung reduziert, indem alte Nachrichten aus dem Verlauf entfernt werden. Die aktuelle Aufgabe wird nicht unterbrochen.\n\nFortfahren?',
  "context.callback_compacting": "Komprimiere Kontext...",
  "context.progress": "⏳ Komprimiere Kontext...",
  "context.error": "❌ Kontext-Komprimierung fehlgeschlagen",
  "context.success": "✅ Kontext erfolgreich komprimiert",

  "permission.inactive_callback": "Berechtigungsanfrage ist inaktiv",
  "permission.processing_error_callback": "Verarbeitungsfehler",
  "permission.no_active_request_callback": "Fehler: keine aktive Anfrage",
  "permission.reply.once": "Einmal erlaubt",
  "permission.reply.always": "Immer erlaubt",
  "permission.reply.reject": "Abgelehnt",
  "permission.send_reply_error": "❌ Antwort auf Berechtigungsanfrage konnte nicht gesendet werden",
  "permission.blocked.expected_reply":
    "⚠️ Bitte beantworte zuerst die Berechtigungsanfrage mit den Buttons oben.",
  "permission.blocked.command_not_allowed":
    "⚠️ Dieser Befehl ist erst verfügbar, wenn du die Berechtigungsanfrage beantwortet hast.",
  "permission.header": "{emoji} Berechtigungsanfrage: {name}\n\n",
  "permission.grouped_count": "\n⚠️ {count} identische Anfragen ausstehend – deine Antwort gilt für alle.\n",
  "permission.button.allow": "✅ Einmal erlauben",
  "permission.button.always": "🔓 Immer erlauben",
  "permission.button.reject": "❌ Ablehnen",
  "permission.name.bash": "Bash",
  "permission.name.edit": "Bearbeiten",
  "permission.name.write": "Schreiben",
  "permission.name.read": "Lesen",
  "permission.name.webfetch": "Web-Abruf",
  "permission.name.websearch": "Web-Suche",
  "permission.name.glob": "Dateisuche",
  "permission.name.grep": "Inhaltssuche",
  "permission.name.list": "Verzeichnis auflisten",
  "permission.name.task": "Task",
  "permission.name.lsp": "LSP",
  "permission.name.external_directory": "Externes Verzeichnis",

  "question.inactive_callback": "Umfrage ist inaktiv",
  "question.processing_error_callback": "Verarbeitungsfehler",
  "question.select_one_required_callback": "Wähle mindestens eine Option",
  "question.enter_custom_callback": "Sende deine eigene Antwort als Nachricht",
  "question.cancelled": "❌ Umfrage abgebrochen",
  "question.answer_already_received": "Antwort bereits erhalten, bitte warten...",
  "question.completed_no_answers": "✅ Umfrage abgeschlossen (keine Antworten)",
  "question.no_active_project": "❌ Kein aktives Projekt",
  "question.no_active_request": "❌ Keine aktive Anfrage",
  "question.send_answers_error": "❌ Antworten konnten nicht an den Agenten gesendet werden",
  "question.multi_hint": "\n(Du kannst mehrere Optionen auswählen)",
  "question.button.submit": "✅ Fertig",
  "question.button.custom": "🔤 Eigene Antwort",
  "question.button.cancel": "❌ Abbrechen",
  "question.use_custom_button_first":
    '⚠️ Um Text zu senden, tippe zuerst bei der aktuellen Frage auf "Eigene Antwort".',
  "question.summary.title": "✅ Umfrage abgeschlossen!\n\n",
  "question.summary.question": "Frage {index}:\n{question}\n\n",
  "question.summary.answer": "Antwort:\n{answer}\n\n",

  "keyboard.queued_prompt": "❌ {index}. {text}",
  "queue.added":
    "📥 Zur Warteschlange hinzugefügt ({count}/{max}). Die Nachricht wird gesendet, sobald die aktuelle Aufgabe abgeschlossen ist.",
  "queue.full":
    "⚠️ Die Warteschlange ist voll ({max}). Entferne eine Nachricht oder warte, bis die aktuelle Aufgabe abgeschlossen ist.",
  "queue.removed": "🗑 Nachricht aus der Warteschlange entfernt.",
  "queue.not_found": "Diese Nachricht ist nicht mehr in der Warteschlange.",
  "queue.disabled_hint": "Die Nachrichtenwarteschlange lässt sich in /settings aktivieren.",

  "pinned.default_session_title": "neue Sitzung",
  "pinned.unknown": "Unbekannt",
  "pinned.line.model": "Modell: {model}",
  "subagent.line.task": "Aufgabe: {task}",
  "subagent.line.agent": "Agent: {agent}",
  "subagent.working": "Arbeitet...",
  "subagent.completed": "Abgeschlossen",
  "subagent.failed": "Aufgabe fehlgeschlagen",

  "tool.todo.overflow": "*({count} weitere Aufgaben)*",
  "tool.file_header.write":
    "Datei/Pfad schreiben: {path}\n============================================================\n\n",
  "tool.file_header.edit":
    "Datei/Pfad bearbeiten: {path}\n============================================================\n\n",

  "runtime.wizard.ask_token": "Telegram-Bot-Token eingeben (von @BotFather).\n> ",
  "runtime.wizard.ask_language":
    "Oberflächensprache auswählen.\nGib die Sprach-Nummer aus der Liste oder den Locale-Code ein.\nDrücke Enter, um die Standardsprache beizubehalten: {defaultLocale}\n{options}\n> ",
  "runtime.wizard.language_invalid":
    "Gib eine Sprach-Nummer aus der Liste oder einen unterstützten Locale-Code ein.\n",
  "runtime.wizard.language_selected": "Ausgewählte Sprache: {language}\n",
  "runtime.wizard.token_required": "Token ist erforderlich. Bitte versuche es erneut.\n",
  "runtime.wizard.token_invalid":
    "Token sieht ungültig aus (erwartetes Format <id>:<secret>). Bitte versuche es erneut.\n",
  "runtime.wizard.ask_user_id":
    "Gib deine Telegram User ID ein (du bekommst sie bei @userinfobot).\n> ",
  "runtime.wizard.user_id_invalid": "Gib eine positive ganze Zahl ein (> 0).\n",
  "runtime.wizard.ask_api_url":
    "OpenCode API URL eingeben (optional).\nEnter drücken für Standard: {defaultUrl}\n> ",
  "runtime.wizard.ask_server_username":
    "OpenCode-Server-Benutzername eingeben (optional).\nEnter drücken für Standard: {defaultUsername}\n> ",
  "runtime.wizard.ask_server_password":
    "OpenCode-Server-Passwort eingeben (optional).\nEnter drücken, um es leer zu lassen.\n> ",
  "runtime.wizard.api_url_invalid":
    "Gib eine gültige URL (http/https) ein oder drücke Enter für Standard.\n",
  "runtime.wizard.start": "OpenCode Telegram Bot Einrichtung.\n",
  "runtime.wizard.saved": "Konfiguration gespeichert:\n- {envPath}\n- {settingsPath}\n",
  "runtime.wizard.not_configured_starting":
    "Anwendung ist noch nicht konfiguriert. Starte Assistent...\n",
  "runtime.wizard.tty_required":
    "Der interaktive Assistent erfordert ein TTY-Terminal. Führe `opencode-telegram config` in einer interaktiven Shell aus.",
  "runtime.container.command_unavailable":
    "⚠️ Dieser Befehl ist im Docker-Image nicht verfügbar.",

  "rename.no_session": "⚠️ Keine aktive Sitzung. Erstelle oder wähle zuerst eine Sitzung.",
  "rename.prompt": "📝 Neuen Titel für die Sitzung eingeben:\n\nAktuell: {title}",
  "rename.empty_title": "⚠️ Titel darf nicht leer sein.",
  "rename.success": "✅ Sitzung umbenannt in: {title}",
  "rename.error": "🔴 Sitzung konnte nicht umbenannt werden.",
  "rename.cancelled": "❌ Umbenennen abgebrochen.",
  "rename.inactive_callback": "Umbenennen-Anfrage ist inaktiv",
  "rename.inactive": "⚠️ Umbenennen-Anfrage ist nicht aktiv. Starte /rename erneut.",
  "rename.blocked.expected_name":
    "⚠️ Sende den neuen Sitzungsnamen als Text oder tippe in der Umbenennen-Nachricht auf Abbrechen.",
  "rename.blocked.command_not_allowed":
    "⚠️ Dieser Befehl ist nicht verfügbar, solange beim Umbenennen auf einen neuen Namen gewartet wird.",
  "rename.button.cancel": "❌ Abbrechen",

  "task.prompt.schedule":
    "⏰ Sende den Zeitplan der Aufgabe in natürlicher Sprache.\n\nBeispiele:\n- alle 5 Minuten\n- jeden Tag um 17:00\n- morgen um 12:00",
  "task.schedule_empty": "⚠️ Der Zeitplan darf nicht leer sein.",
  "task.parse.in_progress": "⏳ Zeitplan wird verarbeitet...",
  "task.parse_error":
    "🔴 Zeitplan konnte nicht erkannt werden.\n\n{message}\n\nSende den Zeitraum bitte noch einmal klarer formuliert.",
  "task.schedule_preview":
    "✅ Zeitplan erkannt\n\nVerstanden als: {summary}\n{cronLine}Zeitzone: {timezone}\nTyp: {kind}\nNächster Lauf: {nextRunAt}",
  "task.schedule_preview.cron": "Cron: {cron}",
  "task.prompt.body": "📝 Sende jetzt, was der Bot nach Zeitplan tun soll.",
  "task.prompt_empty": "⚠️ Der Aufgabentext darf nicht leer sein.",
  "task.created":
    "✅ Geplante Aufgabe erstellt\n\nAufgabe: {description}\nProjekt: {project}\nAgent: {agent}\nModell: {model}\nZeitplan: {schedule}\n{cronLine}Nächster Lauf: {nextRunAt}",
  "task.created.cron": "Cron: {cron}",
  "task.button.retry_schedule": "🔁 Zeitplan neu eingeben",
  "task.button.cancel": "❌ Abbrechen",
  "task.retry_schedule_callback": "Zeitplaneingabe wird zurückgesetzt...",
  "task.inactive_callback": "Dieser Ablauf für geplante Aufgaben ist nicht mehr aktiv",
  "task.inactive": "⚠️ Die Erstellung geplanter Aufgaben ist nicht aktiv. Starte /task erneut.",
  "task.blocked.expected_input":
    "⚠️ Schließe zuerst die aktuelle geplante Aufgabe ab: Sende Text oder nutze die Schaltfläche in der Zeitplan-Nachricht.",
  "task.blocked.command_not_allowed":
    "⚠️ Dieser Befehl ist nicht verfügbar, solange die Erstellung einer geplanten Aufgabe aktiv ist.",
  "task.limit_reached":
    "⚠️ Aufgabenlimit erreicht ({limit}). Lösche zuerst eine bestehende geplante Aufgabe.",
  "task.schedule_too_frequent":
    "Der wiederkehrende Zeitplan ist zu häufig. Das minimale erlaubte Intervall ist einmal alle 5 Minuten.",
  "task.kind.cron": "wiederkehrend",
  "task.kind.once": "einmalig",
  "task.run.success": "⏰ Geplante Aufgabe abgeschlossen: {description}",
  "task.run.error": "🔴 Geplante Aufgabe fehlgeschlagen: {description}\n\nFehler: {error}",
  "task.run.error.interactive_question":
    "Die geplante Aufgabe hat eine interaktive Frage gestellt und kann unbeaufsichtigt nicht fortfahren.",
  "task.run.error.interactive_permission":
    "Die geplante Aufgabe hat eine interaktive Berechtigung angefordert und kann unbeaufsichtigt nicht fortfahren.",

  "tasklist.empty": "📭 Noch keine geplanten Aufgaben.",
  "tasklist.select": "Wähle eine geplante Aufgabe:",
  "tasklist.details":
    "⏰ Geplante Aufgabe\n\nAufgabe: {prompt}\nProjekt: {project}\nZeitplan: {schedule}\n{cronLine}Zeitzone: {timezone}\nNächster Lauf: {nextRunAt}\nLetzter Lauf: {lastRunAt}\nAnzahl Läufe: {runCount}",
  "tasklist.details.cron": "Cron: {cron}",
  "tasklist.button.delete": "🗑 Löschen",
  "tasklist.button.cancel": "❌ Abbrechen",
  "tasklist.deleted_callback": "Gelöscht",
  "tasklist.inactive_callback": "Dieses Menü für geplante Aufgaben ist inaktiv",
  "tasklist.load_error": "🔴 Geplante Aufgaben konnten nicht geladen werden.",

  "commands.select": "Wähle einen OpenCode-Befehl:",
  "commands.empty": "📭 Für dieses Projekt sind keine OpenCode-Befehle verfügbar.",
  "commands.fetch_error": "🔴 OpenCode-Befehle konnten nicht geladen werden.",
  "commands.no_description": "Keine Beschreibung",
  "commands.button.execute": "✅ Ausführen",
  "commands.confirm":
    "Bestätige die Ausführung des Befehls {command}. Für die Ausführung mit Argumenten sende die Argumente als Nachricht.",
  "commands.inactive_callback": "Dieses Befehlsmenü ist inaktiv",
  "commands.execute_callback": "Befehl wird ausgeführt...",
  "commands.executing_prefix": "⚡ Befehl wird ausgeführt:",
  "commands.arguments_empty":
    "⚠️ Argumente dürfen nicht leer sein. Sende Text oder tippe auf Ausführen.",
  "commands.execute_error": "🔴 OpenCode-Befehl konnte nicht ausgeführt werden.",
  "commands.select_page": "Wähle einen OpenCode-Befehl (Seite {page}):",
  "commands.button.prev_page": "⬅️ Zurück",
  "commands.button.next_page": "Weiter ➡️",
  "commands.page_empty_callback": "Keine Befehle auf dieser Seite",
  "commands.download.downloading": "Datei wird heruntergeladen...",
  "commands.download.not_found": "Datei nicht gefunden",
  "commands.download.not_file": "Pfad ist keine Datei",
  "commands.download.file_too_large": "Datei ist zu groß",
  "commands.download.size": "Größe",
  "commands.download.modified": "Geändert",
  "commands.download.error": "Datei konnte nicht heruntergeladen werden.",

  "skills.select": "Wähle einen OpenCode-Skill:",
  "skills.empty": "📭 Für dieses Projekt sind keine OpenCode-Skills verfügbar.",
  "skills.fetch_error": "🔴 OpenCode-Skills konnten nicht geladen werden.",
  "skills.no_description": "Keine Beschreibung",
  "skills.button.execute": "✅ Ausführen",
  "skills.confirm":
    "Bestätige die Ausführung des Skills {skill}. Für die Ausführung mit Argumenten sende die Argumente als Nachricht.",
  "skills.button.refresh": "🔄 Aktualisieren",
  "skills.meta.developer": "👤 {developer}",
  "skills.meta.developer_version": "👤 {developer} ({version})",
  "skills.meta.source": "📍 {location}",
  "skills.meta.updated": "🕒 {date}",
  "skills.button.new": "➕ Neuer Skill",
  "skills.button.delete": "🗑 Skill löschen",
  "skills.button.edit": "✏️ Skill bearbeiten",
  "skills.button.delete_confirm": "🗑 Endgültig löschen",
  "skills.button.delete_cancel": "Abbrechen",
  "skills.wizard.ask_name": "Sende den Skill-Namen (Kleinbuchstaben, Ziffern, Bindestriche — z. B. deploy-check).",
  "skills.wizard.invalid_name": "⚠️ Ungültiger Skill-Name. Kleinbuchstaben, Ziffern und einfache Bindestriche (1–64 Zeichen), z. B. deploy-check.",
  "skills.wizard.ask_description": "Sende jetzt die einzeilige Beschreibung: Wann soll der Agent diesen Skill nutzen?",
  "skills.wizard.ask_body": "Sende jetzt den Skill-Text (Markdown-Anweisungen). Tipp: fokussiert und umsetzbar halten.",
  "skills.wizard.saved": "✅ Skill \"{name}\" im globalen Skill-Verzeichnis gespeichert.",
  "skills.wizard.write_error": "🔴 Skill konnte nicht gespeichert werden: {error}",
  "skills.wizard.cancelled": "Skill-Assistent abgebrochen.",
  "skills.restart_hint": "OpenCode neu starten (/opencode_stop + /opencode_start), um die Änderung zu laden.",
  "skills.delete_not_managed": "Nur Skills aus dem globalen Skill-Verzeichnis können gelöscht werden.",
  "skills.delete_confirm": "Skill {skill} löschen? Der Ordner wird aus dem globalen Skill-Verzeichnis entfernt.",
  "skills.deleted": "🗑 Skill \"{name}\" gelöscht.",
  "skills.delete_failed": "🔴 Skill konnte nicht gelöscht werden.",
  "skills.edit_not_managed": "Nur Skills aus dem globalen Skill-Verzeichnis können bearbeitet werden.",
  "skills.edit.ask_description": "Sende die neue einzeilige Beschreibung für Skill \"{name}\".",
  "skills.edit.ask_body": "Sende jetzt den neuen Skill-Text (Markdown-Anweisungen). Er ersetzt den aktuellen Inhalt.",
  "skills.edit.saved": "✅ Skill \"{name}\" aktualisiert.",
  "skills.button.import": "📥 Aus GitHub importieren",
  "skills.button.import_confirm": "⬇️ Importieren",
  "skills.import.ask_url": "Sende einen GitHub-Link zu einem Skill: Repository, Skill-Ordner oder SKILL.md-Datei.",
  "skills.import.invalid_url": "⚠️ Das ist kein gültiger GitHub-Skill-Link. Sende eine Repository-, Ordner- oder SKILL.md-URL.",
  "skills.import.not_found": "🔴 An dieser GitHub-Adresse wurde keine SKILL.md gefunden.",
  "skills.import.fetch_error": "🔴 Abruf von GitHub fehlgeschlagen: {error}",
  "skills.import.confirm": "Skill {skill} importieren?\n\n{description}\n\n📍 Quelle: {url}",
  "skills.import.multiple_found": "{count} Skills an diesem Ort gefunden. Wähle einen zum Importieren:",
  "skills.imported": "✅ Skill \"{name}\" aus GitHub importiert.",
  "skills.import.exists": "⚠️ Skill \"{name}\" existiert bereits. Bitte zuerst bearbeiten oder löschen.",
  "skills.import.cancelled": "Skill-Import abgebrochen.",
  "skills.inactive_callback": "Dieses Skill-Menü ist inaktiv",
  "skills.execute_callback": "Skill wird verwendet...",
  "skills.executing_prefix": "⚡ Skill wird verwendet:",
  "skills.arguments_empty":
    "⚠️ Argumente dürfen nicht leer sein. Sende Text oder tippe auf Ausführen.",
  "skills.select_page": "Wähle einen OpenCode-Skill (Seite {page}):",
  "skills.button.prev_page": "⬅️ Zurück",
  "skills.button.next_page": "Weiter ➡️",
  "skills.page_empty_callback": "Keine Skills auf dieser Seite",

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
  "mcps.detail.error": "Error: {error}",
  "mcps.button.enable": "🟢 Enable",
  "mcps.button.disable": "🔴 Disable",
  "mcps.button.back": "⬅️ Back",
  "mcps.auth_required": "This server requires authorization and cannot be enabled from the bot.",



  "stt.uncertain": "🎤 Einige Wörter sind möglicherweise falsch. Prüfe und sende den korrigierten Text:",
  "stt.recognizing": "🎤 Erkenne Audio...",
  "stt.recognized": "🎤 Erkannt:",
  "stt.not_configured":
    "🎤 Spracherkennung ist nicht konfiguriert.\n\nSetze STT_API_URL und STT_API_KEY in .env, um sie zu aktivieren.",
  "stt.error": "🔴 Audio konnte nicht erkannt werden: {error}",
  "stt.empty_result": "🎤 Keine Sprache in der Audionachricht erkannt.",

  "worktree.branch_detached": "detached HEAD",
  "worktree.select_with_current": "Worktree auswählen:",
  "worktree.project_not_selected":
    "🏗 Es ist kein Projekt ausgewählt.\n\nWähle zuerst ein Projekt mit /projects.",
  "worktree.not_git_repo":
    "🌿 Git-Worktrees sind für das aktuelle Projekt nicht verfügbar. Wähle zuerst ein Git-Repository.",
  "worktree.not_git_repo_callback": "Aktuelles Projekt ist kein Git-Repository",
  "worktree.empty": "📭 Für das aktuelle Repository wurden keine Git-Worktrees gefunden.",
  "worktree.fetch_error": "🔴 Git-Worktrees konnten nicht geladen werden.",
  "worktree.page_empty_callback": "Keine Worktrees auf dieser Seite",
  "worktree.selection_missing_callback": "Der ausgewählte Worktree ist nicht mehr verfügbar",
  "worktree.already_selected_callback": "Dieser Worktree ist bereits ausgewählt",
  "worktree.selected":
    "✅ Worktree ausgewählt: {worktree}\n\n📋 Die Sitzung wurde zurückgesetzt. Nutze /sessions oder /new, um fortzufahren.",
  "worktree.select_error": "🔴 Worktree konnte nicht ausgewählt werden.",
  "open.back": "⬆️ Hoch",
  "open.roots": "📋 Zurück zur Auswahl",
  "open.prev_page": "⬅️ Zurück",
  "open.next_page": "Weiter ➡️",
  "open.select_current": "✅ Diesen Ordner wählen",
  "open.select_root": "📂 Stammverzeichnis zum Durchsuchen wählen:",
  "open.access_denied": "⛔ Zugriff verweigert: Pfad liegt außerhalb erlaubter Verzeichnisse",
  "open.scan_error": "🔴 Verzeichnis kann nicht durchsucht werden: {error}",
  "open.open_error": "🔴 Verzeichnisbrowser konnte nicht geöffnet werden.",
  "open.selected":
    "✅ Projekt hinzugefügt: {project}\n\n📋 Verwende /sessions oder /new zum Arbeiten.",
  "open.select_error": "🔴 Projekt konnte nicht hinzugefügt werden.",
  "open.no_subfolders": "📭 Keine Unterordner",
  "open.subfolder_count": "{count} Unterordner",
  "open.subfolders_count": "{count} Unterordner",
  "ls.access_denied": "⛔ Zugriff verweigert: Pfad liegt außerhalb des aktuellen Projekts",
  "ls.scan_error": "🔴 Verzeichnis kann nicht aufgelistet werden",
  "ls.header": "Verzeichnisinhalt",
  "ls.total": "Gesamt: {count} Einträge",
  "ls.file.header": "Dateidetails",
  "ls.file.download": "📥 Herunterladen",
  "ls.file.back": "⬅️ Zurück",
  "ls.file.attach": "📎 An nächsten Prompt anhängen",
  "attachment.added": "📎 Angehängt: {path}\n\nSende deine Nachricht, dann geht die Datei mit.",
  "attachment.cancel": "❌ Anhang entfernen",
  "attachment.cancelled": "❌ Anhang entfernt",
  "attachment.invalid":
    "⚠️ Die angehängte Datei ist nicht mehr verfügbar. Die Nachricht wird ohne sie gesendet.",
};
