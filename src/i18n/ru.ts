import type { I18nDictionary } from "./en.js";

export const ru: I18nDictionary = {
  "cmd.description.help": "Справка",

  "callback.unknown_command": "Неизвестная команда",
  "callback.processing_error": "Ошибка обработки",

  "error.load_agents": "❌ Ошибка при загрузке списка агентов",
  "error.load_models": "❌ Ошибка при загрузке списка моделей",
  "error.load_variants": "❌ Ошибка при загрузке списка вариантов",
  "error.context_button": "❌ Ошибка при обработке кнопки контекста",
  "error.generic": "🔴 Произошла ошибка.",

  "interaction.blocked.expired": "⚠️ Текущая интеракция устарела. Запустите ее снова.",
  "interaction.blocked.expected_callback":
    "⚠️ Для этого шага используйте inline-кнопки или нажмите Отмена.",
  "interaction.blocked.expected_text": "⚠️ Для этого шага отправьте текстовое сообщение.",
  "interaction.blocked.expected_command": "⚠️ Для этого шага отправьте команду.",
  "interaction.blocked.command_not_allowed": "⚠️ Эта команда недоступна на текущем шаге.",
  "interaction.blocked.finish_current":
    "⚠️ Сначала завершите текущую интеракцию (ответьте или отмените), затем откройте другое меню.",

  "inline.blocked.expected_choice": "⚠️ Выберите вариант через inline-кнопки или нажмите Отмена.",
  "inline.blocked.command_not_allowed": "⚠️ Эта команда недоступна, пока активно inline-меню.",

  "question.blocked.expected_answer":
    "⚠️ Ответьте на текущий вопрос кнопками, через Свой ответ, или нажмите Отмена.",
  "question.blocked.command_not_allowed":
    "⚠️ Эта команда недоступна, пока не завершен текущий опрос.",

  "inline.button.cancel": "❌ Отмена",
  "inline.inactive_callback": "Это меню уже неактивно",

  "common.cancelled": "Отменено",
  "common.unknown": "неизвестна",
  "common.unknown_error": "неизвестная ошибка",

  "help.keyboard_hint":
    "💡 Агент, модель, вариант и действия с контекстом доступны через нижние кнопки клавиатуры.",

  "bot.thinking": "💭 Думаю...",
  "progress.compact.activity": "{header}\n{activity}",
  "progress.compact.working_header": "⏳ Работаю",
  "progress.compact.finished_header": "✅ Работа завершена",
  "progress.compact.thinking": "💭 Думаю...",
  "progress.compact.responding": "✍️ Пишу ответ...",
  "progress.compact.waiting_question": "❓ Жду ваш ответ...",
  "progress.compact.waiting_permission": "🔐 Жду разрешение...",
  "progress.compact.retrying": "🔁 Повторяю запрос...",
  "progress.compact.task": "🤖 Выполняю задачу",
  "progress.compact.done": "{header}\nвызовы инструментов: {tools} · изменённые файлы: {files}",
  "bot.project_not_selected": "🏗 Проект не выбран.\n\nСначала выберите проект командой /projects.",
  "bot.creating_session": "🔄 Создаю новую сессию...",
  "bot.create_session_error":
    "🔴 Не удалось создать сессию. Попробуйте команду /new или проверьте статус сервера /status.",
  "bot.session_created": "✅ Сессия создана: {title}",
  "bot.session_busy":
    "⏳ Агент уже выполняет задачу. Дождитесь завершения или используйте /abort, чтобы прервать текущий запуск.",
  "bot.session_reset_project_mismatch":
    "⚠️ Активная сессия не соответствует выбранному проекту, поэтому была сброшена. Используйте /sessions для выбора или /new для создания новой сессии.",
  "bot.prompt_send_error": "Не удалось отправить запрос в OpenCode.",
  "bot.empty_prompt": "⚠️ Нечего отправлять: сообщение пусто после обработки вложения.",
  "bot.session_error": "🔴 OpenCode вернул ошибку: {message}",
  "bot.session_retry":
    "🔁 {message}\n\nПровайдер возвращает одну и ту же ошибку при повторных запросах. Используйте /abort для остановки.",
  "bot.external_user_input": "Внешний ввод пользователя",
  "background.session_fallback": "сессия {id}",
  "background.assistant_response": "🔔 В фоновой сессии пришёл ответ ассистента: {session}",
  "background.question_asked": "❓ В фоновой сессии нужен ответ: {session}",
  "background.permission_asked": "🔐 В фоновой сессии запрошены права: {session}",
  "background.open_session_button": "Открыть сессию",
  "bot.unknown_command": "⚠️ Неизвестная команда: {command}. Используйте /help для списка команд.",
  "bot.photo_downloading": "⏳ Скачиваю фото...",
  "bot.photo_model_no_image":
    "⚠️ Текущая модель не поддерживает изображения. Отправляю только текст.",
  "bot.photo_download_error": "🔴 Не удалось скачать фото",
  "bot.video_downloading": "⏳ Загружаю видео...",
  "bot.video_too_large": "⚠️ Видео слишком большое (макс. {maxSizeMb}МБ)",
  "bot.video_error": "🔴 Не удалось обработать видео",
  "bot.file_downloading": "⏳ Скачиваю файл...",
  "bot.files_downloading": "⏳ Скачиваю файлы...",
  "bot.file_download_error": "🔴 Не удалось скачать файл",
  "bot.file_type_unsupported":
    "⚠️ Этот тип файла не поддерживается. Отправьте изображение, документ (PDF, DOCX, PPTX) или текстовый/кодовый файл.",
  "bot.media_group_not_processed":
    "⚠️ Один или несколько файлов в альбоме нельзя обработать. В OpenCode ничего не отправлено.",
  "bot.media_group_download_error":
    "🔴 Не удалось скачать один из файлов. В OpenCode ничего не отправлено.",
  "bot.model_no_pdf": "⚠️ Текущая модель не поддерживает PDF. Отправляю только текст.",
  "bot.document_extraction_error": "🔴 Не удалось извлечь текст из документа.",
  "bot.text_file_too_large": "⚠️ Текстовый файл слишком большой (макс. {maxSizeKb}КБ)",

  "status.header_running": "🟢 OpenCode Server запущен",
  "status.health.healthy": "Healthy",
  "status.health.unhealthy": "Unhealthy",
  "status.line.health": "Статус: {health}",
  "status.line.version": "Версия: {version}",
  "status.line.mode": "Агент: {mode}",
  "status.line.model": "Модель: {model}",
  "status.agent_not_set": "не установлен",
  "status.project_selected": "Проект: {project}",
  "status.worktree_selected": "Worktree: {worktree}",
  "status.session_selected": "Текущая сессия: {title}",
  "status.session_not_selected": "Текущая сессия: не выбрана",
  "status.session_hint": "Используйте /sessions для выбора или /new для создания",
  "status.server_unavailable":
    "🔴 OpenCode Server недоступен\n\nИспользуйте /opencode_start для запуска сервера.",


  "settings.saved": "✅ Настройка сохранена.",

  "projects.empty":
    "📭 Проектов нет.\n\nОткройте директорию в OpenCode и создайте хотя бы одну сессию, после этого она появится здесь.",
  "projects.page_indicator": "Страница {current}/{total}",
  "projects.prev_page": "⬅️ Назад",
  "projects.next_page": "Вперёд ➡️",
  "projects.select_error": "🔴 Ошибка при выборе проекта.",

  "sessions.empty": "📭 Сессий нет.\n\nСоздайте новую сессию командой /new.",
  "sessions.fetch_error":
    "🔴 OpenCode Server недоступен или произошла ошибка при получении списка сессий.",
  "sessions.select_project_first": "🔴 Проект не выбран. Используйте /projects.",
  "sessions.page_empty_callback": "На этой странице нет сессий",
  "sessions.page_load_error_callback":
    "Не удалось загрузить эту страницу. Пожалуйста, попробуйте снова.",
  "sessions.loading_context": "⏳ Загружаю контекст и последние сообщения...",
  "sessions.selected": "✅ Сессия выбрана: {title}",
  "sessions.select_error": "🔴 Ошибка при выборе сессии.",
  "sessions.preview.empty": "Последних сообщений нет.",
  "sessions.preview.title": "Последние сообщения:",
  "sessions.preview.you": "Вы:",
  "sessions.preview.agent": "Агент:",

  "messages.project_not_selected":
    "🏗 Проект не выбран.\n\nСначала выберите проект командой /projects.",
  "messages.session_not_selected":
    "💬 Сессия не выбрана.\n\nСначала выберите сессию через /sessions или создайте новую через /new.",
  "messages.session_project_mismatch":
    "⚠️ Выбранная сессия не соответствует текущему проекту. Повторно выберите сессию через /sessions.",
  "messages.empty": "📭 В текущей сессии нет сообщений пользователя.",
  "messages.select": "Выберите сообщение:",
  "messages.select_page": "Выберите сообщение (страница {page}):",
  "messages.fetch_error":
    "🔴 OpenCode Server недоступен или произошла ошибка при получении списка сообщений.",
  "messages.inactive_callback": "Это меню сообщений уже неактивно",
  "messages.page_empty_callback": "На этой странице нет сообщений",
  "messages.button.prev_page": "⬅️ Назад",
  "messages.button.next_page": "Вперёд ➡️",
  "messages.button.revert": "↩️ Revert",
  "messages.button.redo": "↪️ Повторить",
  "messages.button.fork": "🔀 Fork",
  "messages.button.back": "⬅️ Назад",
  "messages.button.cancel": "❌ Отмена",
  "messages.revert_success": "✅ Откатили до сообщения:\n\n{text}",
  "messages.revert_error": "❌ Не удалось откатить сообщение. Попробуйте ещё раз.",
  "messages.redo_error": "❌ Не удалось повторить. Попробуйте снова.",
  "messages.fork_success": "🔀 Создан форк от сообщения:\n\n{text}",
  "messages.fork_error": "❌ Не удалось создать форк. Попробуйте ещё раз.",
  "session.no_session": "ℹ️ Нет активной сессии OpenCode. Сначала откройте или подключитесь к сессии.",
  "session.header": "🧭 Сессия OpenCode",
  "session.state": "Состояние: {status}",
  "session.status_idle": "🟢 ожидание",
  "session.status_busy": "🟡 занята",
  "session.status_retry": "🔁 повтор",
  "session.status_unknown": "⚪ неизвестно",
  "session.todos_none": "📝 Задачи: нет",
  "session.todos_summary": "📝 Задачи: всего {total} · активных {active} · выполнено {done}",
  "session.todos_unavailable": "📝 Задачи: недоступно",
  "session.changes_none": "🧩 Изменения: нет",
  "session.changes_summary": "🧩 Изменения: файлов {files} · +{additions} / -{deletions}",
  "session.changes_unavailable": "🧩 Изменения: недоступно",
  "session.children_none": "🌿 Подсессии: нет",
  "session.children_summary": "🌿 Подсессии: {count}",
  "session.children_unavailable": "🌿 Подсессии: недоступно",
  "session.more": "…и ещё {count}",


  "detach.project_not_selected":
    "🏗 Проект не выбран.\n\nСначала выберите проект командой /projects.",
  "detach.no_active_session": "ℹ️ Бот уже не привязан ни к одной сессии.",
  "detach.success":
    "✅ Отсоединился от сессии: {title}\n\nOpenCode-сессия не остановлена. Если она еще выполняется, выполнение продолжится отдельно. Чтобы проверить ее позже, снова выберите эту сессию через /sessions.",
  "detach.error": "🔴 Не удалось отсоединиться от текущей сессии.",

  "new.created": "✅ Создана новая сессия: {title}",
  "general.topic_only_prompt": "🚫 Это общая тема форума — запросы к ИИ разрешены только внутри ИИ-топиков.\n\n💬 Нажмите New Chat, чтобы создать новую тему для кода, или откройте существующую через History.\n\nТекст принимается здесь только когда бот явно запрашивает ввод.",
  "new.create_error": "🔴 OpenCode Server недоступен или произошла ошибка при создании сессии.",

  "stop.no_active_session":
    "🛑 Агент не был запущен\n\nСначала создайте сессию командой /new или выберите существующую через /sessions.",
  "stop.in_progress":
    "🛑 Отключил поток событий и отправляю сигнал прерывания...\n\nОжидание остановки агента.",
  "stop.warn_unconfirmed":
    "⚠️ Поток событий остановлен, но сервер не подтвердил прерывание.\n\nПроверьте /status и повторите /abort через пару секунд.",
  "stop.warn_maybe_finished":
    "⚠️ Поток событий остановлен, но агент мог уже завершиться к моменту запроса.",
  "stop.success":
    "✅ Действие агента прервано. Новые сообщения от текущего запуска больше не придут.",
  "stop.warn_still_busy":
    "⚠️ Сигнал отправлен, но агент еще busy.\n\nПоток событий уже отключен, поэтому бот не будет присылать промежуточные сообщения.",
  "stop.warn_timeout":
    "⚠️ Таймаут запроса на прерывание.\n\nПоток событий уже отключен, повторите /abort через пару секунд.",
  "stop.warn_local_only":
    "⚠️ Поток событий остановлен локально, но при прерывании на сервере произошла ошибка.",
  "stop.error":
    "🔴 Ошибка при прерывании действия.\n\nПоток событий остановлен, попробуйте /abort еще раз.",

  "opencode_start.already_running": "✅ OpenCode Server уже запущен\n\nВерсия: {version}",
  "opencode_start.remote_configured":
    "⚠️ /opencode_start работает только с локальным OpenCode Server.",
  "opencode_start.starting": "🔄 Запускаю OpenCode Server...",
  "opencode_start.start_error":
    "🔴 Не удалось запустить OpenCode Server\n\nОшибка: {error}\n\nПроверьте, что OpenCode CLI установлен и доступен в PATH:\nopencode --version\nnpm install -g @opencode-ai/cli",
  "opencode_start.started_not_ready":
    "⚠️ OpenCode Server запущен, но не отвечает\n\nPID: {pid}\n\nСервер может запускаться. Попробуйте /status через несколько секунд.",
  "opencode_start.success": "✅ OpenCode Server успешно запущен\n\nPID: {pid}\nВерсия: {version}",
  "opencode_start.error":
    "🔴 Произошла ошибка при запуске сервера.\n\nПроверьте логи приложения для подробностей.",
  "opencode_stop.remote_configured":
    "⚠️ /opencode_stop работает только с локальным OpenCode Server.",
  "opencode_stop.not_running": "⚠️ OpenCode Server не запущен",
  "opencode_stop.stopping": "🛑 Останавливаю OpenCode Server...\n\nPID: {pid}",
  "opencode_stop.stop_error": "🔴 Не удалось остановить OpenCode Server\n\nОшибка: {error}",
  "opencode_stop.success": "✅ OpenCode Server успешно остановлен",
  "opencode_stop.error":
    "🔴 Произошла ошибка при остановке сервера.\n\nПроверьте логи приложения для подробностей.",

  "agent.changed_message": "✅ Агент изменен на: {name}",
  "agent.change_error_callback": "Ошибка при смене агента",
  "agent.menu.empty": "⚠️ Нет доступных агентов",
  "agent.menu.error": "🔴 Не удалось получить список агентов",

  "model.changed_message": "✅ Модель изменена на: {name}",

  "variant.model_not_selected_callback": "Ошибка: модель не выбрана",
  "variant.changed_message": "✅ Вариант изменен на: {name}",
  "variant.change_error_callback": "Ошибка при смене варианта",
  "variant.select_model_first": "⚠️ Сначала выберите модель",
  "variant.menu.error": "🔴 Не удалось получить список вариантов",

  "context.button.confirm": "✅ Да, сжать контекст",
  "context.no_active_session": "⚠️ Нет активной сессии. Создайте сессию командой /new",
  "context.confirm_text":
    '📊 Сжатие контекста для сессии "{title}"\n\nЭто уменьшит использование контекста, удалив старые сообщения из истории. Текущая задача не будет прервана.\n\nПродолжить?',
  "context.callback_compacting": "Сжатие контекста...",
  "context.progress": "⏳ Сжимаю контекст...",
  "context.error": "❌ Ошибка при сжатии контекста",
  "context.success": "✅ Контекст успешно сжат",

  "permission.inactive_callback": "Запрос разрешения неактивен",
  "permission.processing_error_callback": "Ошибка при обработке",
  "permission.no_active_request_callback": "Ошибка: нет активного запроса",
  "permission.reply.once": "Разрешено однократно",
  "permission.reply.always": "Разрешено всегда",
  "permission.reply.reject": "Отклонено",
  "permission.send_reply_error": "❌ Не удалось отправить ответ на запрос разрешения",
  "permission.blocked.expected_reply": "⚠️ Сначала ответьте на запрос разрешения кнопками выше.",
  "permission.blocked.command_not_allowed":
    "⚠️ Эта команда недоступна, пока вы не ответите на запрос разрешения.",
  "permission.header": "{emoji} Запрос разрешения: {name}\n\n",
  "permission.grouped_count": "\n⚠️ Ожидают {count} одинаковых запроса — ваш ответ применится ко всем.\n",
  "permission.button.allow": "✅ Разрешить один раз",
  "permission.button.always": "🔓 Разрешить всегда",
  "permission.button.reject": "❌ Отклонить",
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
  "permission.name.external_directory": "Внешняя директория",

  "question.inactive_callback": "Опрос неактивен",
  "question.processing_error_callback": "Ошибка при обработке",
  "question.select_one_required_callback": "Выберите хотя бы один вариант",
  "question.enter_custom_callback": "Введите свой ответ сообщением",
  "question.cancelled": "❌ Опрос отменен",
  "question.answer_already_received": "Ответ уже получен, подождите...",
  "question.completed_no_answers": "✅ Опрос завершен (без ответов)",
  "question.no_active_project": "❌ Нет активного проекта",
  "question.no_active_request": "❌ Нет активного запроса",
  "question.send_answers_error": "❌ Не удалось отправить ответы агенту",
  "question.multi_hint": "\n(Можно выбрать несколько вариантов)",
  "question.button.submit": "✅ Готово",
  "question.button.custom": "🔤 Свой ответ",
  "question.button.cancel": "❌ Отмена",
  "question.use_custom_button_first":
    '⚠️ Чтобы отправить текст, сначала нажмите кнопку "Свой ответ" для текущего вопроса.',
  "question.summary.title": "✅ Опрос завершен!\n\n",
  "question.summary.question": "Вопрос {index}:\n{question}\n\n",
  "question.summary.answer": "Ответ:\n{answer}\n\n",

  "keyboard.queued_prompt": "❌ {index}. {text}",
  "queue.added": "📥 Добавлено в очередь ({count}/{max}). Сообщение уйдёт после завершения текущей задачи.",
  "queue.full": "⚠️ Очередь заполнена ({max}). Удалите сообщение или дождитесь завершения текущей задачи.",
  "queue.removed": "🗑 Сообщение удалено из очереди.",
  "queue.not_found": "Этого сообщения больше нет в очереди.",
  "queue.disabled_hint": "Очередь сообщений включается в /settings.",

  "pinned.default_session_title": "новая сессия",
  "pinned.unknown": "Неизвестно",
  "pinned.line.model": "Модель: {model}",
  "subagent.line.task": "Задача: {task}",
  "subagent.line.agent": "Агент: {agent}",
  "subagent.working": "В работе...",
  "subagent.completed": "Завершена",
  "subagent.failed": "Ошибка задачи",

  "tool.todo.overflow": "*(ещё {count} задач)*",
  "tool.file_header.write":
    "Write File/Path: {path}\n============================================================\n\n",
  "tool.file_header.edit":
    "Edit File/Path: {path}\n============================================================\n\n",

  "runtime.wizard.ask_token": "Введите токен Telegram-бота (получить у @BotFather).\n> ",
  "runtime.wizard.ask_language":
    "Выберите язык интерфейса.\nВведите номер языка из списка или код локали.\nНажмите Enter, чтобы оставить язык по умолчанию: {defaultLocale}\n{options}\n> ",
  "runtime.wizard.language_invalid":
    "Введите номер языка из списка или поддерживаемый код локали.\n",
  "runtime.wizard.language_selected": "Выбран язык: {language}\n",
  "runtime.wizard.token_required": "Токен обязателен. Попробуйте еще раз.\n",
  "runtime.wizard.token_invalid":
    "Похоже на невалидный токен (ожидается формат <id>:<secret>). Попробуйте еще раз.\n",
  "runtime.wizard.ask_user_id": "Введите ваш Telegram User ID (можно узнать у @userinfobot).\n> ",
  "runtime.wizard.user_id_invalid": "Введите положительное целое число (> 0).\n",
  "runtime.wizard.ask_api_url":
    "Введите URL OpenCode API (опционально).\nНажмите Enter для значения по умолчанию: {defaultUrl}\n> ",
  "runtime.wizard.ask_server_username":
    "Введите логин OpenCode сервера (опционально).\nНажмите Enter для значения по умолчанию: {defaultUsername}\n> ",
  "runtime.wizard.ask_server_password":
    "Введите пароль OpenCode сервера (опционально).\nНажмите Enter, чтобы оставить пустым.\n> ",
  "runtime.wizard.api_url_invalid":
    "Введите корректный URL (http/https) или нажмите Enter для значения по умолчанию.\n",
  "runtime.wizard.start": "Настройка OpenCode Telegram Bot.\n",
  "runtime.wizard.saved": "Конфигурация сохранена:\n- {envPath}\n- {settingsPath}\n",
  "runtime.wizard.not_configured_starting":
    "Приложение еще не сконфигурировано. Запускаю wizard...\n",
  "runtime.wizard.tty_required":
    "Интерактивный wizard требует TTY-терминал. Запустите `opencode-telegram config` в интерактивной оболочке.",
  "runtime.container.command_unavailable":
    "⚠️ Эта команда недоступна в Docker-образе.",

  "rename.no_session": "⚠️ Нет активной сессии. Сначала создайте или выберите сессию.",
  "rename.prompt": "📝 Введите новое название сессии:\n\nТекущее: {title}",
  "rename.empty_title": "⚠️ Название не может быть пустым.",
  "rename.success": "✅ Сессия переименована в: {title}",
  "rename.error": "🔴 Не удалось переименовать сессию.",
  "rename.cancelled": "❌ Переименование отменено.",
  "rename.inactive_callback": "Запрос переименования неактивен",
  "rename.inactive": "⚠️ Запрос переименования неактивен. Выполните /rename снова.",
  "rename.blocked.expected_name":
    "⚠️ Введите новое название текстом или нажмите Отмена в сообщении переименования.",
  "rename.blocked.command_not_allowed":
    "⚠️ Эта команда недоступна, пока ожидается новое название сессии.",
  "rename.button.cancel": "❌ Отмена",

  "task.prompt.schedule":
    "⏰ Отправьте расписание задачи обычным языком.\n\nПримеры:\n- каждые 5 минут\n- каждый день в 17:00\n- завтра в 12:00",
  "task.schedule_empty": "⚠️ Расписание не может быть пустым.",
  "task.parse.in_progress": "⏳ Распознаю расписание...",
  "task.parse_error":
    "🔴 Не удалось распознать расписание.\n\n{message}\n\nОтправьте период еще раз в более явном виде.",
  "task.schedule_preview":
    "✅ Расписание распознано\n\nКак я понял: {summary}\n{cronLine}Часовой пояс: {timezone}\nТип: {kind}\nСледующий запуск: {nextRunAt}",
  "task.schedule_preview.cron": "Cron: {cron}",
  "task.prompt.body": "📝 Теперь отправьте текст задачи, которую нужно выполнять по расписанию.",
  "task.prompt_empty": "⚠️ Текст задачи не может быть пустым.",
  "task.created":
    "✅ Задача по расписанию создана\n\nЗадача: {description}\nПроект: {project}\nАгент: {agent}\nМодель: {model}\nРасписание: {schedule}\n{cronLine}Следующий запуск: {nextRunAt}",
  "task.created.cron": "Cron: {cron}",
  "task.button.retry_schedule": "🔁 Ввести период заново",
  "task.button.cancel": "❌ Отмена",
  "task.retry_schedule_callback": "Возвращаю ввод периода...",
  "task.inactive_callback": "Этот сценарий создания задачи уже неактивен",
  "task.inactive": "⚠️ Сценарий создания задачи неактивен. Запустите /task снова.",
  "task.blocked.expected_input":
    "⚠️ Сначала завершите создание задачи по расписанию: отправьте текст или используйте кнопку в сообщении с расписанием.",
  "task.blocked.command_not_allowed":
    "⚠️ Эта команда недоступна, пока идет создание задачи по расписанию.",
  "task.limit_reached":
    "⚠️ Достигнут лимит задач ({limit}). Сначала удалите одну из существующих задач по расписанию.",
  "task.schedule_too_frequent":
    "Повторяющееся расписание слишком частое. Минимально допустимый интервал - один запуск в 5 минут.",
  "task.kind.cron": "повторяющаяся",
  "task.kind.once": "однократная",
  "task.run.success": "⏰ Задача по расписанию выполнена: {description}",
  "task.run.error": "🔴 Ошибка выполнения задачи по расписанию: {description}\n\nОшибка: {error}",
  "task.run.error.interactive_question":
    "Задача по расписанию задала интерактивный вопрос и не может продолжить выполнение без участия пользователя.",
  "task.run.error.interactive_permission":
    "Задача по расписанию запросила интерактивное разрешение и не может продолжить выполнение без участия пользователя.",

  "tasklist.empty": "📭 Задач по расписанию пока нет.",
  "tasklist.select": "Выберите задачу по расписанию:",
  "tasklist.details":
    "⏰ Задача по расписанию\n\nЗадача: {prompt}\nПроект: {project}\nРасписание: {schedule}\n{cronLine}Часовой пояс: {timezone}\nСледующий запуск: {nextRunAt}\nПоследний запуск: {lastRunAt}\nКоличество запусков: {runCount}",
  "tasklist.details.cron": "Cron: {cron}",
  "tasklist.button.delete": "🗑 Удалить",
  "tasklist.button.cancel": "❌ Отмена",
  "tasklist.deleted_callback": "Удалено",
  "tasklist.inactive_callback": "Это меню задач по расписанию уже неактивно",
  "tasklist.load_error": "🔴 Не удалось загрузить задачи по расписанию.",

  "commands.select": "Выберите команду OpenCode:",
  "commands.empty": "📭 Для этого проекта нет доступных команд OpenCode.",
  "commands.fetch_error": "🔴 Не удалось загрузить список команд OpenCode.",
  "commands.no_description": "Без описания",
  "commands.button.execute": "✅ Выполнить",
  "commands.confirm":
    "Подтвердите выполнение команды {command}. Для выполнения с аргументами отправьте аргументы отдельным сообщением.",
  "commands.inactive_callback": "Это меню команд уже неактивно",
  "commands.execute_callback": "Запускаю команду...",
  "commands.executing_prefix": "⚡ Выполнение команды:",
  "commands.arguments_empty":
    "⚠️ Аргументы не могут быть пустыми. Отправьте текст или нажмите Выполнить.",
  "commands.execute_error": "🔴 Не удалось выполнить команду OpenCode.",
  "commands.select_page": "Выберите команду OpenCode (страница {page}):",
  "commands.button.prev_page": "⬅️ Назад",
  "commands.button.next_page": "Вперёд ➡️",
  "commands.page_empty_callback": "На этой странице нет команд",
  "commands.download.downloading": "Скачиваю файл...",
  "commands.download.not_found": "Файл не найден",
  "commands.download.not_file": "Путь не является файлом",
  "commands.download.file_too_large": "Файл слишком большой",
  "commands.download.size": "Размер",
  "commands.download.modified": "Изменён",
  "commands.download.error": "Не удалось скачать файл.",

  "skills.select": "Выберите скилл OpenCode:",
  "skills.empty": "📭 Для этого проекта нет доступных скиллов OpenCode.",
  "skills.fetch_error": "🔴 Не удалось загрузить список скиллов OpenCode.",
  "skills.no_description": "Без описания",
  "skills.button.execute": "✅ Выполнить",
  "skills.confirm":
    "Подтвердите запуск скилла {skill}. Чтобы запустить его с аргументами, отправьте аргументы следующим сообщением.",
  "skills.button.refresh": "🔄 Обновить",
  "skills.meta.developer": "👤 {developer}",
  "skills.meta.developer_version": "👤 {developer} ({version})",
  "skills.meta.source": "📍 {location}",
  "skills.meta.updated": "🕒 {date}",
  "skills.button.new": "➕ Новый скилл",
  "skills.button.delete": "🗑 Удалить скилл",
  "skills.button.edit": "✏️ Изменить скилл",
  "skills.button.delete_confirm": "🗑 Удалить навсегда",
  "skills.button.delete_cancel": "Отмена",
  "skills.wizard.ask_name": "Отправьте название скилла (строчные буквы, цифры, дефисы — например deploy-check).",
  "skills.wizard.invalid_name": "⚠️ Недопустимое название. Используйте строчные буквы, цифры и одиночные дефисы (1-64 символа), например deploy-check.",
  "skills.wizard.ask_description": "Теперь отправьте однострочное описание: когда агенту использовать этот скилл?",
  "skills.wizard.ask_body": "Теперь отправьте тело скилла (инструкции в Markdown). Совет: держите сфокусированно и практично.",
  "skills.wizard.saved": "✅ Скилл \"{name}\" сохранён в глобальной папке скиллов.",
  "skills.wizard.write_error": "🔴 Не удалось сохранить скилл: {error}",
  "skills.wizard.cancelled": "Мастер скиллов отменён.",
  "skills.restart_hint": "Перезапустите OpenCode (/opencode_stop + /opencode_start), чтобы загрузить изменение.",
  "skills.delete_not_managed": "Удалять можно только скиллы из глобальной папки скиллов.",
  "skills.delete_confirm": "Удалить скилл {skill}? Папка будет удалена из глобальной папки скиллов.",
  "skills.deleted": "🗑 Скилл \"{name}\" удалён.",
  "skills.delete_failed": "🔴 Не удалось удалить скилл.",
  "skills.edit_not_managed": "Редактировать можно только скиллы из глобальной папки скиллов.",
  "skills.edit.ask_description": "Отправьте новое однострочное описание для скилла \"{name}\".",
  "skills.edit.ask_body": "Теперь отправьте новое тело скилла (инструкции в Markdown). Оно заменит текущее содержимое.",
  "skills.edit.saved": "✅ Скилл \"{name}\" обновлён.",
  "skills.button.import": "📥 Импорт с GitHub",
  "skills.button.import_confirm": "⬇️ Импорт",
  "skills.import.ask_url": "Отправьте ссылку GitHub на скилл: репозиторий, папку скилла или файл SKILL.md.",
  "skills.import.invalid_url": "⚠️ Это некорректная ссылка GitHub. Отправьте URL репозитория, папки или файла SKILL.md.",
  "skills.import.not_found": "🔴 В этом расположении GitHub не найден файл SKILL.md.",
  "skills.import.fetch_error": "🔴 Не удалось получить с GitHub: {error}",
  "skills.import.confirm": "Импортировать скилл {skill}?\n\n{description}\n\n📍 Источник: {url}",
  "skills.import.multiple_found": "В этом расположении найдено скиллов: {count}. Выберите один для импорта:",
  "skills.imported": "✅ Скилл \"{name}\" импортирован с GitHub.",
  "skills.import.exists": "⚠️ Скилл \"{name}\" уже существует. Сначала измените или удалите его.",
  "skills.import.cancelled": "Импорт скилла отменён.",
  "skills.inactive_callback": "Это меню скиллов уже неактивно",
  "skills.execute_callback": "Использую скилл...",
  "skills.executing_prefix": "⚡ Использую скилл:",
  "skills.arguments_empty":
    "⚠️ Аргументы не могут быть пустыми. Отправьте текст или нажмите Выполнить.",
  "skills.select_page": "Выберите скилл OpenCode (страница {page}):",
  "skills.button.prev_page": "⬅️ Назад",
  "skills.button.next_page": "Вперёд ➡️",
  "skills.page_empty_callback": "На этой странице нет скиллов",

  "mcps.select": "MCP серверы:",
  "mcps.fetch_error": "🔴 Не удалось загрузить MCP серверы.",
  "mcps.toggle_error": "🔴 Не удалось переключить MCP сервер.",
  "mcps.enabling": "Включаю...",
  "mcps.disabling": "Выключаю...",
  "mcps.status.connected": "🟢 Подключен",
  "mcps.status.disabled": "🔴 Отключен",
  "mcps.status.failed": "⚠️ Ошибка",
  "mcps.status.needs_auth": "🔒 Требуется авторизация",
  "mcps.status.needs_client_registration": "🔒 Требуется регистрация",
  "mcps.detail.title": "Сервер: {name}",
  "mcps.detail.status": "Статус: {status}",
  "mcps.detail.error": "Ошибка: {error}",
  "mcps.button.enable": "🟢 Включить",
  "mcps.button.disable": "🔴 Выключить",
  "mcps.button.back": "⬅️ Назад",
  "mcps.auth_required": "Этот сервер требует авторизации и не может быть включен из бота.",



  "stt.uncertain": "🎤 Некоторые слова могли быть распознаны неверно. Проверьте и отправьте исправленный текст:",
  "stt.recognizing": "🎤 Распознаю аудио...",
  "stt.recognized": "🎤 Распознано:",
  "stt.not_configured":
    "🎤 Распознавание голоса не настроено.\n\nУстановите STT_API_URL и STT_API_KEY в .env для включения.",
  "stt.error": "🔴 Не удалось распознать аудио: {error}",
  "stt.empty_result": "🎤 В аудиосообщении не обнаружена речь.",

  "worktree.branch_detached": "detached HEAD",
  "worktree.select_with_current": "Выберите worktree:",
  "worktree.project_not_selected":
    "🏗 Проект не выбран.\n\nСначала выберите проект командой /projects.",
  "worktree.not_git_repo":
    "🌿 Git worktree недоступны для текущего проекта. Сначала выберите git-репозиторий.",
  "worktree.not_git_repo_callback": "Текущий проект не является git-репозиторием",
  "worktree.empty": "📭 Для текущего репозитория не найдено ни одного worktree.",
  "worktree.fetch_error": "🔴 Не удалось загрузить git worktree.",
  "worktree.page_empty_callback": "На этой странице нет worktree",
  "worktree.selection_missing_callback": "Выбранный worktree больше недоступен",
  "worktree.already_selected_callback": "Этот worktree уже выбран",
  "worktree.selected":
    "✅ Выбран worktree: {worktree}\n\n📋 Сессия была сброшена. Используйте /sessions или /new для продолжения.",
  "worktree.select_error": "🔴 Не удалось выбрать worktree.",
  "open.back": "⬆️ Наверх",
  "open.roots": "📋 К списку корней",
  "open.prev_page": "⬅️ Назад",
  "open.next_page": "Далее ➡️",
  "open.select_current": "✅ Выбрать эту папку",
  "open.select_root": "📂 Выберите корневой каталог для просмотра:",
  "open.access_denied": "⛔ Доступ запрещён: путь за пределами разрешённых каталогов",
  "open.scan_error": "🔴 Не удалось открыть каталог: {error}",
  "open.open_error": "🔴 Не удалось открыть обозреватель каталогов.",
  "open.selected":
    "✅ Проект добавлен: {project}\n\n📋 Используйте /sessions или /new для начала работы.",
  "open.select_error": "🔴 Не удалось добавить проект.",
  "open.no_subfolders": "📭 Нет подпапок",
  "open.subfolder_count": "{count} подпапка",
  "open.subfolders_count": "{count} подпапок",
  "ls.access_denied": "⛔ Доступ запрещён: путь находится за пределами текущего проекта",
  "ls.scan_error": "🔴 Не удается перечислить каталог",
  "ls.header": "Список каталога",
  "ls.total": "Всего: {count} элементов",
  "ls.file.header": "Сведения о файле",
  "ls.file.download": "📥 Скачать",
  "ls.file.back": "⬅️ Назад",
  "ls.file.attach": "📎 Прикрепить к следующему промпту",
  "attachment.added": "📎 Прикреплён: {path}\n\nОтправьте сообщение — файл уйдёт вместе с ним.",
  "attachment.cancel": "❌ Отменить вложение",
  "attachment.cancelled": "❌ Вложение отменено",
  "attachment.invalid": "⚠️ Прикреплённый файл больше недоступен. Отправляю сообщение без него.",
};
