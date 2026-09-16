import type { I18nDictionary } from "./en.js";

export const es: I18nDictionary = {
  "cmd.description.help": "Ayuda",

  "callback.unknown_command": "Comando desconocido",
  "callback.processing_error": "Error de procesamiento",

  "error.load_agents": "❌ No se pudo cargar la lista de agentes",
  "error.load_models": "❌ No se pudo cargar la lista de modelos",
  "error.load_variants": "❌ No se pudo cargar la lista de variantes",
  "error.context_button": "❌ No se pudo procesar el botón de contexto",
  "error.generic": "🔴 Algo salió mal.",

  "interaction.blocked.expired": "⚠️ Esta interacción ha expirado. Por favor, iníciala de nuevo.",
  "interaction.blocked.expected_callback":
    "⚠️ Para este paso, usa los botones en línea o toca Cancelar.",
  "interaction.blocked.expected_text": "⚠️ Para este paso, envía un mensaje de texto.",
  "interaction.blocked.expected_command": "⚠️ Para este paso, envía un comando.",
  "interaction.blocked.command_not_allowed":
    "⚠️ Este comando no está disponible en el paso actual.",
  "interaction.blocked.finish_current":
    "⚠️ Termina primero la interacción actual (responde o cancela) y después abre otro menú.",

  "inline.blocked.expected_choice":
    "⚠️ Elige una opción usando los botones en línea o toca Cancelar.",
  "inline.blocked.command_not_allowed":
    "⚠️ Este comando no está disponible mientras el menú en línea está activo.",

  "question.blocked.expected_answer":
    "⚠️ Responde la pregunta actual usando botones, Respuesta personalizada o Cancelar.",
  "question.blocked.command_not_allowed":
    "⚠️ Este comando no está disponible hasta que se complete el flujo de la pregunta actual.",

  "inline.button.cancel": "❌ Cancelar",
  "inline.inactive_callback": "Este menú está inactivo",

  "common.cancelled": "Cancelado",
  "common.unknown": "desconocido",
  "common.unknown_error": "error desconocido",

  "help.keyboard_hint":
    "💡 Usa los botones inferiores para agente, modelo, variante y acciones de contexto.",

  "bot.thinking": "💭 Pensando...",
  "progress.compact.activity": "{header}\n{activity}",
  "progress.compact.working_header": "⏳ Trabajando",
  "progress.compact.finished_header": "✅ Trabajo terminado",
  "progress.compact.thinking": "💭 Pensando...",
  "progress.compact.responding": "✍️ Escribiendo respuesta...",
  "progress.compact.waiting_question": "❓ Esperando tu respuesta...",
  "progress.compact.waiting_permission": "🔐 Esperando permiso...",
  "progress.compact.retrying": "🔁 Reintentando...",
  "progress.compact.task": "🤖 Tarea en ejecución",
  "progress.compact.done":
    "{header}\nllamadas de herramientas: {tools} · archivos modificados: {files}",
  "bot.project_not_selected":
    "🏗 No hay un proyecto seleccionado.\n\nPrimero selecciona un proyecto con /projects.",
  "bot.creating_session": "🔄 Creando una sesión nueva...",
  "bot.create_session_error":
    "🔴 No se pudo crear la sesión. Prueba /new o revisa el estado del servidor con /status.",
  "bot.session_created": "✅ Sesión creada: {title}",
  "bot.session_busy":
    "⏳ El agente ya está ejecutando una tarea. Espera a que termine o usa /abort para interrumpir la ejecución actual.",
  "bot.session_reset_project_mismatch":
    "⚠️ La sesión activa no coincide con el proyecto seleccionado, así que se reinició. Usa /sessions para elegir una o /new para crear una nueva.",
  "bot.prompt_send_error": "No se pudo enviar la solicitud a OpenCode.",
  "bot.empty_prompt": "⚠️ No hay nada que enviar: el mensaje queda vacío tras procesar el adjunto.",
  "bot.session_error": "🔴 OpenCode devolvió un error: {message}",
  "bot.session_retry":
    "🔁 {message}\n\nEl proveedor devuelve el mismo error en intentos repetidos. Usa /abort para detenerlo.",
  "bot.external_user_input": "Entrada externa del usuario",
  "background.session_fallback": "sesión {id}",
  "background.assistant_response":
    "🔔 El asistente respondió en una sesión en segundo plano: {session}",
  "background.question_asked": "❓ Una sesión en segundo plano necesita una respuesta: {session}",
  "background.permission_asked": "🔐 Una sesión en segundo plano solicitó permisos: {session}",
  "background.open_session_button": "Abrir sesión",
  "bot.unknown_command":
    "⚠️ Comando desconocido: {command}. Usa /help para ver los comandos disponibles.",
  "bot.photo_downloading": "⏳ Descargando foto...",
  "bot.photo_model_no_image":
    "⚠️ El modelo actual no admite entrada de imagen. Enviaré solo texto.",
  "bot.photo_download_error": "🔴 No se pudo descargar la foto",
  "bot.video_downloading": "⏳ Descargando video...",
  "bot.video_too_large": "⚠️ El video es demasiado grande (máx. {maxSizeMb}MB)",
  "bot.video_error": "🔴 Error al procesar el video",
  "bot.file_downloading": "⏳ Descargando archivo...",
  "bot.files_downloading": "⏳ Descargando archivos...",
  "bot.file_download_error": "🔴 No se pudo descargar el archivo",
  "bot.file_type_unsupported":
    "⚠️ Este tipo de archivo no es compatible. Envía una imagen, documento (PDF, DOCX, PPTX) o archivo de texto/código.",
  "bot.media_group_not_processed":
    "⚠️ Uno o más archivos de este álbum no se pueden procesar. No se envió nada a OpenCode.",
  "bot.media_group_download_error":
    "🔴 No se pudo descargar uno de los archivos. No se envió nada a OpenCode.",
  "bot.model_no_pdf": "⚠️ El modelo actual no admite entrada PDF. Enviaré solo texto.",
  "bot.document_extraction_error": "🔴 No se pudo extraer el texto del documento.",
  "bot.text_file_too_large": "⚠️ El archivo de texto es demasiado grande (max {maxSizeKb}KB)",

  "status.header_running": "🟢 OpenCode Server está en ejecución",
  "status.health.healthy": "Saludable",
  "status.health.unhealthy": "No saludable",
  "status.line.health": "Estado: {health}",
  "status.line.version": "Versión: {version}",
  "status.line.mode": "Agente: {mode}",
  "status.line.model": "Modelo: {model}",
  "status.agent_not_set": "no configurado",
  "status.project_selected": "Proyecto: {project}",
  "status.worktree_selected": "Worktree: {worktree}",
  "status.session_selected": "Sesión actual: {title}",
  "status.session_not_selected": "Sesión actual: no seleccionada",
  "status.session_hint": "Usa /sessions para elegir una o /new para crear una",
  "status.server_unavailable":
    "🔴 OpenCode Server no está disponible\n\nUsa /opencode_start para iniciar el servidor.",


  "settings.saved": "✅ Ajuste guardado.",

  "projects.empty":
    "📭 No se encontraron proyectos.\n\nAbre un directorio en OpenCode y crea al menos una sesión; entonces aparecerá aquí.",
  "projects.page_indicator": "Página {current}/{total}",
  "projects.prev_page": "⬅️ Anterior",
  "projects.next_page": "Siguiente ➡️",
  "projects.select_error": "🔴 No se pudo seleccionar el proyecto.",

  "sessions.empty": "📭 No se encontraron sesiones.\n\nCrea una sesión nueva con /new.",
  "sessions.fetch_error":
    "🔴 OpenCode Server no está disponible u ocurrió un error al cargar las sesiones.",
  "sessions.select_project_first": "🔴 No hay un proyecto seleccionado. Usa /projects.",
  "sessions.page_empty_callback": "No hay sesiones en esta página",
  "sessions.page_load_error_callback": "No se puede cargar esta página. Inténtalo de nuevo.",
  "sessions.loading_context": "⏳ Cargando contexto y los últimos mensajes...",
  "sessions.selected": "✅ Sesión seleccionada: {title}",
  "sessions.select_error": "🔴 No se pudo seleccionar la sesión.",
  "sessions.preview.empty": "No hay mensajes recientes.",
  "sessions.preview.title": "Mensajes recientes:",
  "sessions.preview.you": "Tú:",
  "sessions.preview.agent": "Agente:",

  "messages.project_not_selected":
    "🏗 No hay ningún proyecto seleccionado.\n\nPrimero selecciona un proyecto con /projects.",
  "messages.session_not_selected":
    "💬 No hay ninguna sesión seleccionada.\n\nPrimero elige una sesión con /sessions o crea una con /new.",
  "messages.session_project_mismatch":
    "⚠️ La sesión seleccionada no coincide con el proyecto actual. Vuelve a elegir la sesión con /sessions.",
  "messages.empty": "📭 No hay mensajes de usuario en la sesión actual.",
  "messages.select": "Elige un mensaje:",
  "messages.select_page": "Elige un mensaje (página {page}):",
  "messages.fetch_error":
    "🔴 OpenCode Server no está disponible o se produjo un error al cargar los mensajes.",
  "messages.inactive_callback": "Este menú de mensajes ya no está activo",
  "messages.page_empty_callback": "No hay mensajes en esta página",
  "messages.button.prev_page": "⬅️ Anterior",
  "messages.button.next_page": "Siguiente ➡️",
  "messages.button.revert": "↩️ Revert",
  "messages.button.fork": "🔀 Fork",
  "messages.button.back": "⬅️ Volver",
  "messages.button.cancel": "❌ Cancelar",
  "messages.revert_success": "✅ Revertido al mensaje:\n\n{text}",
  "messages.revert_error": "❌ No se pudo revertir el mensaje. Inténtalo de nuevo.",
  "messages.fork_success": "🔀 Fork creado desde el mensaje:\n\n{text}",
  "messages.fork_error": "❌ No se pudo crear el fork. Inténtalo de nuevo.",


  "detach.project_not_selected":
    "🏗 No hay un proyecto seleccionado.\n\nPrimero selecciona un proyecto con /projects.",
  "detach.no_active_session": "ℹ️ El bot ya no está conectado a ninguna sesión.",
  "detach.success":
    "✅ Desconectado de la sesión: {title}\n\nLa sesión de OpenCode no se detuvo. Si todavía está en ejecución, continuará por separado. Para revisarla más tarde, selecciónala de nuevo con /sessions.",
  "detach.error": "🔴 No se pudo desconectar de la sesión actual.",

  "new.created": "✅ Sesión nueva creada: {title}",
  "general.topic_only_prompt": "🚫 Este es el tema General del foro: los prompts de IA solo están permitidos dentro de los temas de IA.\n\n💬 Pulsa New Chat para iniciar un nuevo tema de código o abre uno existente desde History.\n\nEl texto solo se acepta aquí cuando el bot pide entrada explícitamente.",
  "new.create_error":
    "🔴 OpenCode Server no está disponible u ocurrió un error al crear la sesión.",

  "stop.no_active_session":
    "🛑 El agente no se inició\n\nCrea una sesión con /new o selecciona una con /sessions.",
  "stop.in_progress":
    "🛑 Flujo de eventos detenido; enviando señal de aborto...\n\nEsperando a que el agente se detenga.",
  "stop.warn_unconfirmed":
    "⚠️ Flujo de eventos detenido, pero el servidor no confirmó el aborto.\n\nRevisa /status y vuelve a intentar /abort en unos segundos.",
  "stop.warn_maybe_finished":
    "⚠️ Flujo de eventos detenido, pero el agente podría haber terminado ya.",
  "stop.success":
    "✅ Acción del agente interrumpida. No se enviarán más mensajes de esta ejecución.",
  "stop.warn_still_busy":
    "⚠️ Señal enviada, pero el agente sigue ocupado.\n\nEl flujo de eventos ya está deshabilitado, así que no se enviarán mensajes intermedios.",
  "stop.warn_timeout":
    "⚠️ Tiempo de espera agotado al solicitar el aborto.\n\nEl flujo de eventos ya está deshabilitado; vuelve a intentar /abort en unos segundos.",
  "stop.warn_local_only":
    "⚠️ Flujo de eventos detenido localmente, pero el aborto en el servidor falló.",
  "stop.error":
    "🔴 No se pudo detener la acción.\n\nEl flujo de eventos está detenido; prueba /abort otra vez.",

  "opencode_start.already_running": "✅ OpenCode Server ya está en ejecución\n\nVersión: {version}",
  "opencode_start.remote_configured":
    "⚠️ /opencode_start solo funciona con un OpenCode Server local.",
  "opencode_start.starting": "🔄 Iniciando OpenCode Server...",
  "opencode_start.start_error":
    "🔴 No se pudo iniciar OpenCode Server\n\nError: {error}\n\nRevisa que OpenCode CLI esté instalado y disponible en PATH:\nopencode --version\nnpm install -g @opencode-ai/cli",
  "opencode_start.started_not_ready":
    "⚠️ OpenCode Server se inició, pero no responde\n\nPID: {pid}\n\nEl servidor puede estar iniciando. Prueba /status en unos segundos.",
  "opencode_start.success":
    "✅ OpenCode Server iniciado correctamente\n\nPID: {pid}\nVersión: {version}",
  "opencode_start.error":
    "🔴 Ocurrió un error al iniciar el servidor.\n\nRevisa los logs de la aplicación para más detalles.",
  "opencode_stop.remote_configured":
    "⚠️ /opencode_stop solo funciona con un OpenCode Server local.",
  "opencode_stop.not_running": "⚠️ OpenCode Server no está en ejecución",
  "opencode_stop.stopping": "🛑 Deteniendo OpenCode Server...\n\nPID: {pid}",
  "opencode_stop.stop_error": "🔴 No se pudo detener OpenCode Server\n\nError: {error}",
  "opencode_stop.success": "✅ OpenCode Server detenido correctamente",
  "opencode_stop.error":
    "🔴 Ocurrió un error al detener el servidor.\n\nRevisa los logs de la aplicación para más detalles.",

  "agent.changed_message": "✅ Agente cambiado a: {name}",
  "agent.change_error_callback": "No se pudo cambiar el agente",
  "agent.menu.empty": "⚠️ No hay agentes disponibles",
  "agent.menu.error": "🔴 No se pudo obtener la lista de agentes",

  "model.changed_message": "✅ Modelo cambiado a: {name}",

  "variant.model_not_selected_callback": "Error: no hay un modelo seleccionado",
  "variant.changed_message": "✅ Variante cambiada a: {name}",
  "variant.change_error_callback": "No se pudo cambiar la variante",
  "variant.select_model_first": "⚠️ Selecciona un modelo primero",
  "variant.menu.error": "🔴 No se pudo obtener la lista de variantes",

  "context.button.confirm": "✅ Sí, compactar contexto",
  "context.no_active_session": "⚠️ No hay una sesión activa. Crea una sesión con /new",
  "context.confirm_text":
    '📊 Compactación de contexto para la sesión "{title}"\n\nEsto reducirá el uso de contexto eliminando mensajes antiguos del historial. La tarea actual no se interrumpirá.\n\n¿Continuar?',
  "context.callback_compacting": "Compactando contexto...",
  "context.progress": "⏳ Compactando contexto...",
  "context.error": "❌ La compactación de contexto falló",
  "context.success": "✅ Contexto compactado correctamente",

  "permission.inactive_callback": "La solicitud de permisos está inactiva",
  "permission.processing_error_callback": "Error de procesamiento",
  "permission.no_active_request_callback": "Error: no hay una solicitud activa",
  "permission.reply.once": "Permitido una vez",
  "permission.reply.always": "Siempre permitido",
  "permission.reply.reject": "Rechazado",
  "permission.send_reply_error": "❌ No se pudo enviar la respuesta de permisos",
  "permission.blocked.expected_reply":
    "⚠️ Primero responde a la solicitud de permisos usando los botones de arriba.",
  "permission.blocked.command_not_allowed":
    "⚠️ Este comando no está disponible hasta que respondas a la solicitud de permisos.",
  "permission.header": "{emoji} Solicitud de permisos: {name}\n\n",
  "permission.grouped_count": "\n⚠️ {count} solicitudes idénticas pendientes: tu respuesta se aplica a todas.\n",
  "permission.button.allow": "✅ Permitir una vez",
  "permission.button.always": "🔓 Permitir siempre",
  "permission.button.reject": "❌ Rechazar",
  "permission.name.bash": "Bash",
  "permission.name.edit": "Editar",
  "permission.name.write": "Escribir",
  "permission.name.read": "Leer",
  "permission.name.webfetch": "Obtener web",
  "permission.name.websearch": "Buscar en la web",
  "permission.name.glob": "Buscar archivos",
  "permission.name.grep": "Buscar contenido",
  "permission.name.list": "Listar directorio",
  "permission.name.task": "Tarea",
  "permission.name.lsp": "LSP",
  "permission.name.external_directory": "Directorio externo",

  "question.inactive_callback": "La encuesta está inactiva",
  "question.processing_error_callback": "Error de procesamiento",
  "question.select_one_required_callback": "Selecciona al menos una opción",
  "question.enter_custom_callback": "Envía tu respuesta personalizada como mensaje",
  "question.cancelled": "❌ Encuesta cancelada",
  "question.answer_already_received": "Respuesta ya recibida, espera...",
  "question.completed_no_answers": "✅ Encuesta completada (sin respuestas)",
  "question.no_active_project": "❌ No hay un proyecto activo",
  "question.no_active_request": "❌ No hay una solicitud activa",
  "question.send_answers_error": "❌ No se pudieron enviar las respuestas al agente",
  "question.multi_hint": "\n(Puedes seleccionar varias opciones)",
  "question.button.submit": "✅ Listo",
  "question.button.custom": "🔤 Respuesta personalizada",
  "question.button.cancel": "❌ Cancelar",
  "question.use_custom_button_first":
    '⚠️ Para enviar texto, primero toca "Respuesta personalizada" para la pregunta actual.',
  "question.summary.title": "✅ ¡Encuesta completada!\n\n",
  "question.summary.question": "Pregunta {index}:\n{question}\n\n",
  "question.summary.answer": "Respuesta:\n{answer}\n\n",

  "keyboard.queued_prompt": "❌ {index}. {text}",
  "queue.added":
    "📥 Añadido a la cola ({count}/{max}). Se enviará cuando termine la tarea actual.",
  "queue.full":
    "⚠️ La cola está llena ({max}). Elimina un mensaje o espera a que termine la tarea actual.",
  "queue.removed": "🗑 Mensaje eliminado de la cola.",
  "queue.not_found": "Este mensaje ya no está en la cola.",
  "queue.disabled_hint": "La cola de mensajes se activa en /settings.",
  "keyboard.updated": "⌨️ Teclado actualizado",

  "pinned.default_session_title": "sesión nueva",
  "pinned.unknown": "Desconocido",
  "pinned.line.model": "Modelo: {model}",
  "subagent.line.task": "Tarea: {task}",
  "subagent.line.agent": "Agente: {agent}",
  "subagent.working": "Trabajando...",
  "subagent.completed": "Completada",
  "subagent.failed": "Error de tarea",

  "tool.todo.overflow": "*({count} tareas más)*",
  "tool.file_header.write":
    "Escribir archivo/ruta: {path}\n============================================================\n\n",
  "tool.file_header.edit":
    "Editar archivo/ruta: {path}\n============================================================\n\n",

  "runtime.wizard.ask_token": "Introduce el token del bot de Telegram (obtenlo de @BotFather).\n> ",
  "runtime.wizard.ask_language":
    "Selecciona el idioma de la interfaz.\nIntroduce el número del idioma de la lista o el código de locale.\nPulsa Enter para mantener el idioma por defecto: {defaultLocale}\n{options}\n> ",
  "runtime.wizard.language_invalid":
    "Introduce un número de idioma de la lista o un código de locale compatible.\n",
  "runtime.wizard.language_selected": "Idioma seleccionado: {language}\n",
  "runtime.wizard.token_required": "El token es obligatorio. Inténtalo de nuevo.\n",
  "runtime.wizard.token_invalid":
    "El token parece inválido (se espera el formato <id>:<secret>). Inténtalo de nuevo.\n",
  "runtime.wizard.ask_user_id":
    "Introduce tu Telegram User ID (puedes obtenerlo de @userinfobot).\n> ",
  "runtime.wizard.user_id_invalid": "Introduce un entero positivo (> 0).\n",
  "runtime.wizard.ask_api_url":
    "Introduce la URL de la API de OpenCode (opcional).\nPulsa Enter para usar el valor por defecto: {defaultUrl}\n> ",
  "runtime.wizard.ask_server_username":
    "Introduce el nombre de usuario del servidor OpenCode (opcional).\nPulsa Enter para usar el valor por defecto: {defaultUsername}\n> ",
  "runtime.wizard.ask_server_password":
    "Introduce la contrasena del servidor OpenCode (opcional).\nPulsa Enter para dejarla vacia.\n> ",
  "runtime.wizard.api_url_invalid":
    "Introduce una URL válida (http/https) o pulsa Enter para usar el valor por defecto.\n",
  "runtime.wizard.start": "Configuración de OpenCode Telegram Bot.\n",
  "runtime.wizard.saved": "Configuración guardada:\n- {envPath}\n- {settingsPath}\n",
  "runtime.wizard.not_configured_starting":
    "La aplicación aún no está configurada. Iniciando el asistente...\n",
  "runtime.wizard.tty_required":
    "El asistente interactivo requiere un terminal TTY. Ejecuta `opencode-telegram config` en una shell interactiva.",
  "runtime.container.command_unavailable":
    "⚠️ Este comando no está disponible en la imagen Docker.",

  "rename.no_session": "⚠️ No hay una sesión activa. Crea o selecciona una sesión primero.",
  "rename.prompt": "📝 Introduce un nuevo título para la sesión:\n\nActual: {title}",
  "rename.empty_title": "⚠️ El título no puede estar vacío.",
  "rename.success": "✅ Sesión renombrada a: {title}",
  "rename.error": "🔴 No se pudo renombrar la sesión.",
  "rename.cancelled": "❌ Cambio de nombre cancelado.",
  "rename.inactive_callback": "La solicitud de cambio de nombre está inactiva",
  "rename.inactive":
    "⚠️ La solicitud de cambio de nombre no está activa. Ejecuta /rename otra vez.",
  "rename.blocked.expected_name":
    "⚠️ Introduce el nuevo nombre de la sesión como texto o toca Cancelar en el mensaje de cambio de nombre.",
  "rename.blocked.command_not_allowed":
    "⚠️ Este comando no está disponible mientras el cambio de nombre espera un nuevo nombre.",
  "rename.button.cancel": "❌ Cancelar",

  "task.prompt.schedule":
    "⏰ Envía el horario de la tarea en lenguaje natural.\n\nEjemplos:\n- cada 5 minutos\n- cada día a las 17:00\n- mañana a las 12:00",
  "task.schedule_empty": "⚠️ El horario no puede estar vacío.",
  "task.parse.in_progress": "⏳ Analizando horario...",
  "task.parse_error":
    "🔴 No se pudo interpretar el horario.\n\n{message}\n\nEnvía el periodo otra vez de forma más clara.",
  "task.schedule_preview":
    "✅ Horario interpretado\n\nEntendido como: {summary}\n{cronLine}Zona horaria: {timezone}\nTipo: {kind}\nPróxima ejecución: {nextRunAt}",
  "task.schedule_preview.cron": "Cron: {cron}",
  "task.prompt.body": "📝 Ahora envía lo que el bot debe hacer según este horario.",
  "task.prompt_empty": "⚠️ El texto de la tarea no puede estar vacío.",
  "task.created":
    "✅ Tarea programada creada\n\nTarea: {description}\nProyecto: {project}\nAgente: {agent}\nModelo: {model}\nHorario: {schedule}\n{cronLine}Próxima ejecución: {nextRunAt}",
  "task.created.cron": "Cron: {cron}",
  "task.button.retry_schedule": "🔁 Volver a introducir horario",
  "task.button.cancel": "❌ Cancelar",
  "task.retry_schedule_callback": "Volviendo a introducir el horario...",
  "task.inactive_callback": "Este flujo de tarea programada ya no está activo",
  "task.inactive": "⚠️ La creación de la tarea programada no está activa. Ejecuta /task otra vez.",
  "task.blocked.expected_input":
    "⚠️ Primero termina la configuración actual de la tarea programada: envía texto o usa el botón del mensaje del horario.",
  "task.blocked.command_not_allowed":
    "⚠️ Este comando no está disponible mientras la creación de la tarea programada está activa.",
  "task.limit_reached":
    "⚠️ Se alcanzó el límite de tareas ({limit}). Primero elimina una tarea programada existente.",
  "task.schedule_too_frequent":
    "El horario recurrente es demasiado frecuente. El intervalo mínimo permitido es una vez cada 5 minutos.",
  "task.kind.cron": "recurrente",
  "task.kind.once": "única",
  "task.run.success": "⏰ Tarea programada completada: {description}",
  "task.run.error": "🔴 La tarea programada falló: {description}\n\nError: {error}",
  "task.run.error.interactive_question":
    "La tarea programada solicitó una pregunta interactiva y no puede continuar sin supervisión.",
  "task.run.error.interactive_permission":
    "La tarea programada solicitó un permiso interactivo y no puede continuar sin supervisión.",

  "tasklist.empty": "📭 Aún no hay tareas programadas.",
  "tasklist.select": "Elige una tarea programada:",
  "tasklist.details":
    "⏰ Tarea programada\n\nTarea: {prompt}\nProyecto: {project}\nHorario: {schedule}\n{cronLine}Zona horaria: {timezone}\nPróxima ejecución: {nextRunAt}\nÚltima ejecución: {lastRunAt}\nNúmero de ejecuciones: {runCount}",
  "tasklist.details.cron": "Cron: {cron}",
  "tasklist.button.delete": "🗑 Eliminar",
  "tasklist.button.cancel": "❌ Cancelar",
  "tasklist.deleted_callback": "Eliminada",
  "tasklist.inactive_callback": "Este menú de tareas programadas está inactivo",
  "tasklist.load_error": "🔴 No se pudieron cargar las tareas programadas.",

  "commands.select": "Elige un comando de OpenCode:",
  "commands.empty": "📭 No hay comandos de OpenCode disponibles para este proyecto.",
  "commands.fetch_error": "🔴 No se pudieron cargar los comandos de OpenCode.",
  "commands.no_description": "Sin descripción",
  "commands.button.execute": "✅ Ejecutar",
  "commands.confirm":
    "Confirma la ejecución del comando {command}. Para ejecutarlo con argumentos, envía los argumentos como mensaje.",
  "commands.inactive_callback": "Este menú de comandos está inactivo",
  "commands.execute_callback": "Ejecutando comando...",
  "commands.executing_prefix": "⚡ Ejecutando comando:",
  "commands.arguments_empty":
    "⚠️ Los argumentos no pueden estar vacíos. Envía texto o toca Ejecutar.",
  "commands.execute_error": "🔴 No se pudo ejecutar el comando de OpenCode.",
  "commands.select_page": "Elige un comando de OpenCode (página {page}):",
  "commands.button.prev_page": "⬅️ Anterior",
  "commands.button.next_page": "Siguiente ➡️",
  "commands.page_empty_callback": "No hay comandos en esta página",
  "commands.download.downloading": "Descargando archivo...",
  "commands.download.not_found": "Archivo no encontrado",
  "commands.download.not_file": "La ruta no es un archivo",
  "commands.download.file_too_large": "El archivo es demasiado grande",
  "commands.download.size": "Tamaño",
  "commands.download.modified": "Modificado",
  "commands.download.error": "No se pudo descargar el archivo.",

  "skills.select": "Elige un skill de OpenCode:",
  "skills.empty": "📭 No hay skills de OpenCode disponibles para este proyecto.",
  "skills.fetch_error": "🔴 No se pudieron cargar los skills de OpenCode.",
  "skills.no_description": "Sin descripción",
  "skills.button.execute": "✅ Ejecutar",
  "skills.confirm":
    "Confirma la ejecución del skill {skill}. Para ejecutarlo con argumentos, envía los argumentos como mensaje.",
  "skills.button.refresh": "🔄 Actualizar",
  "skills.meta.developer": "👤 {developer}",
  "skills.meta.developer_version": "👤 {developer} ({version})",
  "skills.meta.source": "📍 {location}",
  "skills.meta.updated": "🕒 {date}",
  "skills.button.new": "➕ Nueva skill",
  "skills.button.delete": "🗑 Eliminar skill",
  "skills.button.edit": "✏️ Editar skill",
  "skills.button.delete_confirm": "🗑 Eliminar definitivamente",
  "skills.button.delete_cancel": "Cancelar",
  "skills.wizard.ask_name": "Envía el nombre de la skill (minúsculas, dígitos, guiones — p. ej. deploy-check).",
  "skills.wizard.invalid_name": "⚠️ Nombre de skill no válido. Usa minúsculas, dígitos y guiones simples (1-64 caracteres), p. ej. deploy-check.",
  "skills.wizard.ask_description": "Ahora envía la descripción de una línea: ¿cuándo debe usar el agente esta skill?",
  "skills.wizard.ask_body": "Ahora envía el cuerpo de la skill (instrucciones en Markdown). Consejo: mantén enfoque accionable.",
  "skills.wizard.saved": "✅ Skill \"{name}\" guardada en el directorio global de skills.",
  "skills.wizard.write_error": "🔴 No se pudo guardar la skill: {error}",
  "skills.wizard.cancelled": "Asistente de skill cancelado.",
  "skills.restart_hint": "Reinicia OpenCode (/opencode_stop + /opencode_start) para cargar el cambio.",
  "skills.delete_not_managed": "Solo se pueden eliminar skills del directorio global de skills.",
  "skills.delete_confirm": "¿Eliminar la skill {skill}? Su carpeta se quitará del directorio global de skills.",
  "skills.deleted": "🗑 Skill \"{name}\" eliminada.",
  "skills.delete_failed": "🔴 No se pudo eliminar la skill.",
  "skills.edit_not_managed": "Solo se pueden editar las skills del directorio global de skills.",
  "skills.edit.ask_description": "Envía la nueva descripción de una línea para la skill \"{name}\".",
  "skills.edit.ask_body": "Ahora envía el nuevo cuerpo de la skill (instrucciones en Markdown). Reemplazará el contenido actual.",
  "skills.edit.saved": "✅ Skill \"{name}\" actualizada.",
  "skills.button.import": "📥 Importar desde GitHub",
  "skills.button.import_confirm": "⬇️ Importar",
  "skills.import.ask_url": "Envía un enlace de GitHub a un skill: repositorio, carpeta del skill o archivo SKILL.md.",
  "skills.import.invalid_url": "⚠️ Este no es un enlace válido de GitHub. Envía una URL de repositorio, carpeta o SKILL.md.",
  "skills.import.not_found": "🔴 No se encontró SKILL.md en esa ubicación de GitHub.",
  "skills.import.fetch_error": "🔴 No se pudo obtener desde GitHub: {error}",
  "skills.import.confirm": "¿Importar el skill {skill}?\n\n{description}\n\n📍 Fuente: {url}",
  "skills.import.multiple_found": "Se encontraron {count} skills en esa ubicación. Elige una para importar:",
  "skills.imported": "✅ Skill \"{name}\" importado desde GitHub.",
  "skills.import.exists": "⚠️ El skill \"{name}\" ya existe. Edítalo o elimínalo primero.",
  "skills.import.cancelled": "Importación del skill cancelada.",
  "skills.inactive_callback": "Este menú de skills está inactivo",
  "skills.execute_callback": "Usando skill...",
  "skills.executing_prefix": "⚡ Usando skill:",
  "skills.arguments_empty":
    "⚠️ Los argumentos no pueden estar vacíos. Envía texto o toca Ejecutar.",
  "skills.select_page": "Elige un skill de OpenCode (página {page}):",
  "skills.button.prev_page": "⬅️ Anterior",
  "skills.button.next_page": "Siguiente ➡️",
  "skills.page_empty_callback": "No hay skills en esta página",

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



  "stt.uncertain": "🎤 Algunas palabras pueden ser incorrectas. Revisa y envía el texto corregido:",
  "stt.recognizing": "🎤 Reconociendo audio...",
  "stt.recognized": "🎤 Reconocido:",
  "stt.not_configured":
    "🎤 El reconocimiento de voz no está configurado.\n\nConfigura STT_API_URL y STT_API_KEY en .env para habilitarlo.",
  "stt.error": "🔴 No se pudo reconocer el audio: {error}",
  "stt.empty_result": "🎤 No se detectó voz en el mensaje de audio.",

  "worktree.branch_detached": "detached HEAD",
  "worktree.select_with_current": "Selecciona un worktree:",
  "worktree.project_not_selected":
    "🏗 No hay un proyecto seleccionado.\n\nPrimero selecciona un proyecto con /projects.",
  "worktree.not_git_repo":
    "🌿 Los git worktrees no están disponibles para el proyecto actual. Selecciona primero un repositorio git.",
  "worktree.not_git_repo_callback": "El proyecto actual no es un repositorio git",
  "worktree.empty": "📭 No se encontraron git worktrees para el repositorio actual.",
  "worktree.fetch_error": "🔴 No se pudieron cargar los git worktrees.",
  "worktree.page_empty_callback": "No hay worktrees en esta página",
  "worktree.selection_missing_callback": "El worktree seleccionado ya no está disponible",
  "worktree.already_selected_callback": "Este worktree ya está seleccionado",
  "worktree.selected":
    "✅ Worktree seleccionado: {worktree}\n\n📋 La sesión se reinició. Usa /sessions o /new para continuar.",
  "worktree.select_error": "🔴 No se pudo seleccionar el worktree.",
  "open.back": "⬆️ Subir",
  "open.roots": "📋 Volver a raíces",
  "open.prev_page": "⬅️ Anterior",
  "open.next_page": "Siguiente ➡️",
  "open.select_current": "✅ Seleccionar esta carpeta",
  "open.select_root": "📂 Selecciona un directorio raíz para explorar:",
  "open.access_denied": "⛔ Acceso denegado: la ruta está fuera de los directorios permitidos",
  "open.scan_error": "🔴 No se puede explorar el directorio: {error}",
  "open.open_error": "🔴 No se pudo abrir el explorador de directorios.",
  "open.selected":
    "✅ Proyecto añadido: {project}\n\n📋 Usa /sessions o /new para empezar a trabajar.",
  "open.select_error": "🔴 No se pudo añadir el proyecto.",
  "open.no_subfolders": "📭 Sin subcarpetas",
  "open.subfolder_count": "{count} subcarpeta",
  "open.subfolders_count": "{count} subcarpetas",
  "ls.access_denied": "⛔ Acceso denegado: la ruta está fuera del proyecto actual",
  "ls.scan_error": "🔴 No se puede listar el directorio",
  "ls.header": "Listado del directorio",
  "ls.total": "Total: {count} elementos",
  "ls.file.header": "Detalles del archivo",
  "ls.file.download": "📥 Descargar",
  "ls.file.back": "⬅️ Volver",
  "ls.file.attach": "📎 Adjuntar al siguiente prompt",
  "attachment.added": "📎 Adjuntado: {path}\n\nEnvía tu mensaje y el archivo irá con él.",
  "attachment.cancel": "❌ Cancelar adjunto",
  "attachment.cancelled": "❌ Adjunto cancelado",
  "attachment.invalid":
    "⚠️ El archivo adjunto ya no está disponible. Enviando el mensaje sin él.",
};
