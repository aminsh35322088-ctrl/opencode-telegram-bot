import type { I18nDictionary } from "./en.js";

export const fr: I18nDictionary = {
  "cmd.description.help": "Aide",

  "callback.unknown_command": "Commande inconnue",
  "callback.processing_error": "Erreur de traitement",

  "error.load_agents": "❌ Impossible de charger la liste des modes",
  "error.load_models": "❌ Impossible de charger la liste des modèles",
  "error.load_variants": "❌ Impossible de charger la liste des variantes",
  "error.context_button": "❌ Impossible de traiter le bouton de contexte",
  "error.generic": "🔴 Une erreur s'est produite.",

  "interaction.blocked.expired": "⚠️ Cette interaction a expiré. Veuillez la relancer.",
  "interaction.blocked.expected_callback":
    "⚠️ Veuillez utiliser les boutons inline pour cette étape ou appuyer sur Annuler.",
  "interaction.blocked.expected_text": "⚠️ Veuillez envoyer un message texte pour cette étape.",
  "interaction.blocked.expected_command": "⚠️ Veuillez envoyer une commande pour cette étape.",
  "interaction.blocked.command_not_allowed":
    "⚠️ Cette commande n'est pas disponible à l'étape actuelle.",
  "interaction.blocked.finish_current":
    "⚠️ Terminez d'abord l'interaction en cours (réponse ou annulation), puis ouvrez un autre menu.",

  "inline.blocked.expected_choice":
    "⚠️ Choisissez une option avec les boutons inline ou appuyez sur Annuler.",
  "inline.blocked.command_not_allowed":
    "⚠️ Cette commande n'est pas disponible tant que le menu inline est actif.",

  "question.blocked.expected_answer":
    "⚠️ Répondez à la question en cours avec les boutons, Réponse personnalisée ou Annuler.",
  "question.blocked.command_not_allowed":
    "⚠️ Cette commande n'est pas disponible tant que le flux de question actuel n'est pas terminé.",

  "inline.inactive_callback": "Ce menu est inactif",

  "common.cancelled": "Annulé",
  "common.unknown": "inconnu",
  "common.unknown_error": "erreur inconnue",

  "help.keyboard_hint":
    "💡 Utilisez les boutons du bas pour l'agent, le modèle, la variante et les actions de contexte.",

  "bot.thinking": "💭 Réflexion en cours...",
  "progress.compact.activity": "{header}\n{activity}",
  "progress.compact.working_header": "⏳ Travail en cours",
  "progress.compact.finished_header": "✅ Travail terminé",
  "progress.compact.thinking": "💭 Réflexion en cours...",
  "progress.compact.responding": "✍️ Rédaction de la réponse...",
  "progress.compact.waiting_question": "❓ En attente de votre réponse...",
  "progress.compact.waiting_permission": "🔐 En attente d'autorisation...",
  "progress.compact.retrying": "🔁 Nouvelle tentative...",
  "progress.compact.task": "🤖 Tâche en cours",
  "progress.compact.done": "{header}\nappels d’outils : {tools} · fichiers modifiés : {files}",
  "bot.project_not_selected":
    "🏗 Aucun projet n'est sélectionné.\n\nSélectionnez d'abord un projet avec /projects.",
  "bot.creating_session": "🔄 Création d'une nouvelle session...",
  "bot.create_session_error":
    "🔴 Impossible de créer la session. Essayez /new ou vérifiez l'état du serveur avec /status.",
  "bot.session_created": "✅ Session créée : {title}",
  "bot.session_busy":
    "⏳ L'agent exécute déjà une tâche. Attendez la fin ou utilisez /abort pour interrompre l'exécution en cours.",
  "bot.session_reset_project_mismatch":
    "⚠️ La session active ne correspond pas au projet sélectionné, elle a donc été réinitialisée. Utilisez /sessions pour en choisir une ou /new pour créer une nouvelle session.",
  "bot.prompt_send_error": "Impossible d'envoyer la requête à OpenCode.",
  "bot.empty_prompt": "⚠️ Rien à envoyer : le message est vide après le traitement de la pièce jointe.",
  "bot.session_error": "🔴 OpenCode a renvoyé une erreur : {message}",
  "bot.session_retry":
    "🔁 {message}\n\nLe fournisseur renvoie la même erreur à chaque nouvelle tentative. Utilisez /abort pour arrêter.",
  "bot.external_user_input": "Entrée utilisateur externe",
  "background.session_fallback": "session {id}",
  "background.assistant_response":
    "🔔 L'assistant a répondu dans une session en arrière-plan : {session}",
  "background.question_asked": "❓ Une session en arrière-plan attend une réponse : {session}",
  "background.permission_asked":
    "🔐 Une session en arrière-plan a demandé des autorisations : {session}",
  "background.open_session_button": "Ouvrir la session",
  "bot.unknown_command":
    "⚠️ Commande inconnue : {command}. Utilisez /help pour voir les commandes disponibles.",
  "bot.photo_downloading": "⏳ Téléchargement de la photo...",
  "bot.photo_model_no_image":
    "⚠️ Le modèle actuel ne prend pas en charge les images. Envoi du texte uniquement.",
  "bot.photo_download_error": "🔴 Impossible de télécharger la photo",
  "bot.file_downloading": "⏳ Téléchargement du fichier...",
  "bot.files_downloading": "⏳ Téléchargement des fichiers...",
  "bot.file_download_error": "🔴 Impossible de télécharger le fichier",
  "bot.file_type_unsupported":
    "⚠️ Ce type de fichier n'est pas pris en charge. Envoyez une image, un document (PDF, DOCX, PPTX) ou un fichier texte/code.",
  "bot.media_group_not_processed":
    "⚠️ Un ou plusieurs fichiers de cet album ne peuvent pas être traités. Rien n'a été envoyé à OpenCode.",
  "bot.media_group_download_error":
    "🔴 Impossible de télécharger l'un des fichiers. Rien n'a été envoyé à OpenCode.",
  "bot.model_no_pdf":
    "⚠️ Le modèle actuel ne prend pas en charge les PDF. Envoi du texte uniquement.",
  "bot.document_extraction_error":
    "🔴 Échec de l'extraction du texte du document.",
  "bot.text_file_too_large": "⚠️ Le fichier texte est trop volumineux (max {maxSizeKb}KB)",

  "status.header_running": "🟢 Le serveur OpenCode est en cours d'exécution",
  "status.health.healthy": "Sain",
  "status.health.unhealthy": "Dégradé",
  "status.line.health": "Statut : {health}",
  "status.line.version": "Version : {version}",
  "status.line.mode": "Agent : {mode}",
  "status.line.model": "Modèle : {model}",
  "status.agent_not_set": "non défini",
  "status.project_selected": "Projet : {project}",
  "status.worktree_selected": "Worktree : {worktree}",
  "status.session_selected": "Session actuelle : {title}",
  "status.session_not_selected": "Session actuelle : non sélectionnée",
  "status.session_hint": "Utilisez /sessions pour en sélectionner une ou /new pour en créer une",
  "status.server_unavailable":
    "🔴 Le serveur OpenCode est indisponible\n\nUtilisez /opencode_start pour démarrer le serveur.",


  "settings.saved": "✅ Paramètre enregistré.",

  "projects.empty":
    "📭 Aucun projet trouvé.\n\nOuvrez un répertoire dans OpenCode et créez au moins une session, il apparaîtra ensuite ici.",
  "projects.page_indicator": "Page {current}/{total}",
  "projects.prev_page": "⬅️ Précédent",
  "projects.next_page": "Suivant ➡️",
  "projects.select_error": "🔴 Impossible de sélectionner le projet.",

  "sessions.empty": "📭 Aucune session trouvée.\n\nCréez une nouvelle session avec /new.",
  "sessions.fetch_error":
    "🔴 Le serveur OpenCode est indisponible ou une erreur s'est produite lors du chargement des sessions.",
  "sessions.select_project_first": "🔴 Aucun projet n'est sélectionné. Utilisez /projects.",
  "sessions.page_empty_callback": "Aucune session sur cette page",
  "sessions.page_load_error_callback": "Impossible de charger cette page. Veuillez réessayer.",
  "sessions.loading_context": "⏳ Chargement du contexte et des derniers messages...",
  "sessions.selected": "✅ Session sélectionnée : {title}",
  "sessions.select_error": "🔴 Impossible de sélectionner la session.",
  "sessions.preview.empty": "Aucun message récent.",
  "sessions.preview.title": "Messages récents :",
  "sessions.preview.you": "Vous :",
  "sessions.preview.agent": "Agent :",

  "messages.project_not_selected":
    "🏗 Aucun projet sélectionné.\n\nSélectionnez d'abord un projet avec /projects.",
  "messages.session_not_selected":
    "💬 Aucune session sélectionnée.\n\nChoisissez d'abord une session avec /sessions ou créez-en une avec /new.",
  "messages.session_project_mismatch":
    "⚠️ La session sélectionnée ne correspond pas au projet actuel. Choisissez à nouveau la session via /sessions.",
  "messages.empty": "📭 Aucun message utilisateur dans la session actuelle.",
  "messages.select": "Choisissez un message :",
  "messages.select_page": "Choisissez un message (page {page}) :",
  "messages.fetch_error":
    "🔴 OpenCode Server est indisponible ou une erreur est survenue pendant le chargement des messages.",
  "messages.inactive_callback": "Ce menu de messages est inactif",
  "messages.page_empty_callback": "Aucun message sur cette page",
  "messages.button.prev_page": "⬅️ Précédent",
  "messages.button.next_page": "Suivant ➡️",
  "messages.button.revert": "↩️ Revert",
  "messages.button.fork": "🔀 Fork",
  "messages.button.back": "⬅️ Retour",
  "messages.button.cancel": "❌ Annuler",
  "messages.revert_success": "✅ Retour au message :\n\n{text}",
  "messages.revert_error": "❌ Impossible de revenir au message. Veuillez réessayer.",
  "messages.fork_success": "🔀 Fork créé à partir du message :\n\n{text}",
  "messages.fork_error": "❌ Échec de la création du fork. Veuillez réessayer.",


  "detach.project_not_selected":
    "🏗 Aucun projet n'est sélectionné.\n\nSélectionnez d'abord un projet avec /projects.",
  "detach.no_active_session": "ℹ️ Le bot n'est déjà attaché à aucune session.",
  "detach.success":
    "✅ Détaché de la session : {title}\n\nLa session OpenCode n'a pas été arrêtée. Si elle est toujours en cours, elle continuera séparément. Pour la consulter plus tard, sélectionnez-la à nouveau via /sessions.",
  "detach.error": "🔴 Impossible de se détacher de la session actuelle.",

  "new.created": "✅ Nouvelle session créée : {title}",
  "general.topic_only_prompt": "🚫 Ceci est le sujet Général du forum — les prompts IA sont uniquement autorisés dans les sujets IA.\n\n💬 Appuyez sur New Chat pour démarrer un nouveau sujet de code, ou ouvrez un sujet existant depuis History.\n\nLe texte n'est accepté ici que lorsque le bot demande explicitement une saisie.",
  "new.create_error":
    "🔴 Le serveur OpenCode est indisponible ou une erreur s'est produite lors de la création de la session.",

  "stop.no_active_session":
    "🛑 L'agent n'a pas été démarré\n\nCréez une session avec /new ou sélectionnez-en une via /sessions.",
  "stop.in_progress":
    "🛑 Flux d'événements arrêté, envoi du signal d'abandon...\n\nEn attente de l'arrêt de l'agent.",
  "stop.warn_unconfirmed":
    "⚠️ Le flux d'événements a été arrêté, mais le serveur n'a pas confirmé l'abandon.\n\nVérifiez /status et réessayez /abort dans quelques secondes.",
  "stop.warn_maybe_finished":
    "⚠️ Le flux d'événements a été arrêté, mais l'agent a peut-être déjà terminé.",
  "stop.success":
    "✅ Action de l'agent interrompue. Aucun autre message de cette exécution ne sera envoyé.",
  "stop.warn_still_busy":
    "⚠️ Le signal a été envoyé, mais l'agent est toujours occupé.\n\nLe flux d'événements est déjà désactivé, donc aucun message intermédiaire ne sera envoyé.",
  "stop.warn_timeout":
    "⚠️ Délai dépassé pour la requête d'abandon.\n\nLe flux d'événements est déjà arrêté, réessayez /abort dans quelques secondes.",
  "stop.warn_local_only":
    "⚠️ Le flux d'événements a été arrêté localement, mais l'abandon côté serveur a échoué.",
  "stop.error":
    "🔴 Impossible d'arrêter l'action.\n\nLe flux d'événements est arrêté, essayez /abort à nouveau.",

  "opencode_start.already_running":
    "✅ Le serveur OpenCode est déjà en cours d'exécution\n\nVersion : {version}",
  "opencode_start.remote_configured":
    "⚠️ /opencode_start fonctionne uniquement avec un serveur OpenCode local.",
  "opencode_start.starting": "🔄 Démarrage du serveur OpenCode...",
  "opencode_start.start_error":
    "🔴 Impossible de démarrer le serveur OpenCode\n\nErreur : {error}\n\nVérifiez que l'interface en ligne de commande OpenCode est installée et disponible dans le PATH :\nopencode --version\nnpm install -g @opencode-ai/cli",
  "opencode_start.started_not_ready":
    "⚠️ Le serveur OpenCode a démarré, mais ne répond pas encore\n\nPID : {pid}\n\nLe serveur est peut-être encore en cours de démarrage. Essayez /status dans quelques secondes.",
  "opencode_start.success":
    "✅ Serveur OpenCode démarré avec succès\n\nPID : {pid}\nVersion : {version}",
  "opencode_start.error":
    "🔴 Une erreur s'est produite lors du démarrage du serveur.\n\nConsultez les logs de l'application pour plus de détails.",
  "opencode_stop.remote_configured":
    "⚠️ /opencode_stop fonctionne uniquement avec un serveur OpenCode local.",
  "opencode_stop.not_running": "⚠️ Le serveur OpenCode n'est pas en cours d'exécution",
  "opencode_stop.stopping": "🛑 Arrêt du serveur OpenCode...\n\nPID : {pid}",
  "opencode_stop.stop_error": "🔴 Impossible d'arrêter le serveur OpenCode\n\nErreur : {error}",
  "opencode_stop.success": "✅ Serveur OpenCode arrêté avec succès",
  "opencode_stop.error":
    "🔴 Une erreur s'est produite lors de l'arrêt du serveur.\n\nConsultez les logs de l'application pour plus de détails.",

  "agent.changed_message": "✅ Agent défini sur : {name}",
  "agent.change_error_callback": "Impossible de modifier l'agent",
  "agent.menu.empty": "⚠️ Aucun mode disponible",
  "agent.menu.error": "🔴 Impossible de récupérer la liste des modes",

  "model.changed_message": "✅ Modèle défini sur : {name}",

  "variant.model_not_selected_callback": "Erreur : aucun modèle sélectionné",
  "variant.changed_message": "✅ Variante définie sur : {name}",
  "variant.change_error_callback": "Impossible de modifier la variante",
  "variant.select_model_first": "⚠️ Sélectionnez d'abord un modèle",
  "variant.menu.error": "🔴 Impossible de récupérer la liste des variantes",

  "context.button.confirm": "✅ Oui, compacter le contexte",
  "context.no_active_session": "⚠️ Aucune session active. Créez une session avec /new",
  "context.confirm_text":
    "📊 Réduction du contexte pour la session \"{title}\"\n\nCela réduira l'utilisation du contexte en supprimant les anciens messages de l'historique. La tâche en cours ne sera pas interrompue.\n\nContinuer ?",
  "context.callback_compacting": "Réduction du contexte en cours...",
  "context.progress": "⏳ Réduction du contexte en cours...",
  "context.error": "❌ La réduction du contexte a échoué",
  "context.success": "✅ Contexte compacté avec succès",

  "permission.inactive_callback": "La demande d'autorisation est inactive",
  "permission.processing_error_callback": "Erreur de traitement",
  "permission.no_active_request_callback": "Erreur : aucune demande active",
  "permission.reply.once": "Autorisé une fois",
  "permission.reply.always": "Toujours autorisé",
  "permission.reply.reject": "Refusé",
  "permission.send_reply_error": "❌ Impossible d'envoyer la réponse d'autorisation",
  "permission.blocked.expected_reply":
    "⚠️ Veuillez d'abord répondre à la demande d'autorisation avec les boutons ci-dessus.",
  "permission.blocked.command_not_allowed":
    "⚠️ Cette commande n'est pas disponible tant que vous n'avez pas répondu à la demande d'autorisation.",
  "permission.header": "{emoji} Demande d'autorisation : {name}\n\n",
  "permission.grouped_count": "\n⚠️ {count} demandes identiques en attente — votre réponse s'applique à toutes.\n",
  "permission.button.allow": "✅ Autoriser une fois",
  "permission.button.always": "🔓 Toujours autoriser",
  "permission.button.reject": "❌ Refuser",
  "permission.name.bash": "Bash",
  "permission.name.edit": "Modifier",
  "permission.name.write": "Écrire",
  "permission.name.read": "Lire",
  "permission.name.webfetch": "Récupération web",
  "permission.name.websearch": "Recherche web",
  "permission.name.glob": "Recherche de fichiers",
  "permission.name.grep": "Recherche de contenu",
  "permission.name.list": "Lister le répertoire",
  "permission.name.task": "Tâche",
  "permission.name.lsp": "LSP",
  "permission.name.external_directory": "Répertoire externe",

  "question.inactive_callback": "Le sondage est inactif",
  "question.processing_error_callback": "Erreur de traitement",
  "question.select_one_required_callback": "Sélectionnez au moins une option",
  "question.enter_custom_callback": "Envoyez votre réponse personnalisée sous forme de message",
  "question.cancelled": "❌ Sondage annulé",
  "question.answer_already_received": "Réponse déjà reçue, veuillez patienter...",
  "question.completed_no_answers": "✅ Sondage terminé (aucune réponse)",
  "question.no_active_project": "❌ Aucun projet actif",
  "question.no_active_request": "❌ Aucune demande active",
  "question.send_answers_error": "❌ Impossible d'envoyer les réponses à l'agent",
  "question.multi_hint": "\n(Vous pouvez sélectionner plusieurs options)",
  "question.button.submit": "✅ Terminer",
  "question.button.custom": "🔤 Réponse personnalisée",
  "question.button.cancel": "❌ Annuler",
  "question.use_custom_button_first":
    "⚠️ Pour envoyer du texte, appuyez d'abord sur « Réponse personnalisée » pour la question actuelle.",
  "question.summary.title": "✅ Sondage terminé !\n\n",
  "question.summary.question": "Question {index} :\n{question}\n\n",
  "question.summary.answer": "Réponse :\n{answer}\n\n",

  "keyboard.queued_prompt": "❌ {index}. {text}",
  "queue.added":
    "📥 Ajouté à la file d'attente ({count}/{max}). Le message sera envoyé à la fin de la tâche en cours.",
  "queue.full":
    "⚠️ La file d'attente est pleine ({max}). Supprimez un message ou attendez la fin de la tâche en cours.",
  "queue.removed": "🗑 Message retiré de la file d'attente.",
  "queue.not_found": "Ce message n'est plus dans la file d'attente.",
  "queue.disabled_hint": "La file d'attente des messages s'active dans /settings.",
  "keyboard.updated": "⌨️ Clavier mis à jour",

  "pinned.default_session_title": "nouvelle session",
  "pinned.unknown": "Inconnu",
  "pinned.line.model": "Modèle : {model}",
  "subagent.line.task": "Tache : {task}",
  "subagent.line.agent": "Agent : {agent}",
  "subagent.working": "En cours...",
  "subagent.completed": "Terminee",
  "subagent.failed": "Echec de la tache",

  "tool.todo.overflow": "*({count} tâches supplémentaires)*",
  "tool.file_header.write":
    "Écrire Fichier/Chemin : {path}\n============================================================\n\n",
  "tool.file_header.edit":
    "Modifier Fichier/Chemin : {path}\n============================================================\n\n",

  "runtime.wizard.ask_token":
    "Entrez le token du bot Telegram (obtenez-le auprès de @BotFather).\n> ",
  "runtime.wizard.ask_language":
    "Sélectionnez la langue de l'interface.\nEntrez le numéro de la langue dans la liste ou le code locale.\nAppuyez sur Entrée pour conserver la langue par défaut : {defaultLocale}\n{options}\n> ",
  "runtime.wizard.language_invalid":
    "Entrez un numéro de langue de la liste ou un code locale pris en charge.\n",
  "runtime.wizard.language_selected": "Langue sélectionnée : {language}\n",
  "runtime.wizard.token_required": "Le token est requis. Veuillez réessayer.\n",
  "runtime.wizard.token_invalid":
    "Le token semble invalide (format attendu <id>:<secret>). Veuillez réessayer.\n",
  "runtime.wizard.ask_user_id":
    "Entrez votre identifiant utilisateur Telegram (vous pouvez l'obtenir auprès de @userinfobot).\n> ",
  "runtime.wizard.user_id_invalid": "Entrez un entier positif (> 0).\n",
  "runtime.wizard.ask_api_url":
    "Entrez l'URL de l'API OpenCode (optionnel).\nAppuyez sur Entrée pour utiliser la valeur par défaut : {defaultUrl}\n> ",
  "runtime.wizard.ask_server_username":
    "Entrez le nom d'utilisateur du serveur OpenCode (optionnel).\nAppuyez sur Entrée pour utiliser la valeur par défaut : {defaultUsername}\n> ",
  "runtime.wizard.ask_server_password":
    "Entrez le mot de passe du serveur OpenCode (optionnel).\nAppuyez sur Entrée pour le laisser vide.\n> ",
  "runtime.wizard.api_url_invalid":
    "Entrez une URL valide (http/https) ou appuyez sur Entrée pour la valeur par défaut.\n",
  "runtime.wizard.start": "Configuration d'OpenCode Telegram Bot.\n",
  "runtime.wizard.saved": "Configuration enregistrée :\n- {envPath}\n- {settingsPath}\n",
  "runtime.wizard.not_configured_starting":
    "L'application n'est pas encore configurée. Lancement de l'assistant...\n",
  "runtime.wizard.tty_required":
    "L'assistant interactif nécessite un terminal TTY. Exécutez `opencode-telegram config` dans un shell interactif.",
  "runtime.container.command_unavailable":
    "⚠️ Cette commande n'est pas disponible dans l'image Docker.",

  "rename.no_session": "⚠️ Aucune session active. Créez ou sélectionnez d'abord une session.",
  "rename.prompt": "📝 Entrez le nouveau titre de la session :\n\nActuel : {title}",
  "rename.empty_title": "⚠️ Le titre ne peut pas être vide.",
  "rename.success": "✅ Session renommée en : {title}",
  "rename.error": "🔴 Impossible de renommer la session.",
  "rename.cancelled": "❌ Renommage annulé.",
  "rename.inactive_callback": "La demande de renommage est inactive",
  "rename.inactive": "⚠️ La demande de renommage n'est pas active. Exécutez /rename à nouveau.",
  "rename.blocked.expected_name":
    "⚠️ Entrez le nouveau nom de la session sous forme de texte ou appuyez sur Annuler dans le message de renommage.",
  "rename.blocked.command_not_allowed":
    "⚠️ Cette commande n'est pas disponible tant que le renommage attend un nouveau nom.",
  "rename.button.cancel": "❌ Annuler",

  "task.prompt.schedule":
    "⏰ Envoyez le planning de la tâche en langage naturel.\n\nExemples :\n- toutes les 5 minutes\n- chaque jour à 17:00\n- demain à 12:00",
  "task.schedule_empty": "⚠️ Le planning ne peut pas être vide.",
  "task.parse.in_progress": "⏳ Analyse du planning...",
  "task.parse_error":
    "🔴 Impossible d'interpréter le planning.\n\n{message}\n\nEnvoyez le créneau à nouveau de façon plus claire.",
  "task.schedule_preview":
    "✅ Planning interprété\n\nCompris comme : {summary}\n{cronLine}Fuseau horaire : {timezone}\nType : {kind}\nProchaine exécution : {nextRunAt}",
  "task.schedule_preview.cron": "Cron : {cron}",
  "task.prompt.body": "📝 Envoyez maintenant ce que le bot doit faire selon ce planning.",
  "task.prompt_empty": "⚠️ Le texte de la tâche ne peut pas être vide.",
  "task.created":
    "✅ Tâche planifiée créée\n\nTâche : {description}\nProjet : {project}\nAgent : {agent}\nModèle : {model}\nPlanning : {schedule}\n{cronLine}Prochaine exécution : {nextRunAt}",
  "task.created.cron": "Cron : {cron}",
  "task.button.retry_schedule": "🔁 Ressaisir le planning",
  "task.button.cancel": "❌ Annuler",
  "task.retry_schedule_callback": "Retour à la saisie du planning...",
  "task.inactive_callback": "Ce flux de tâche planifiée n'est plus actif",
  "task.inactive": "⚠️ La création de tâche planifiée n'est pas active. Relancez /task.",
  "task.blocked.expected_input":
    "⚠️ Terminez d'abord la configuration de la tâche planifiée : envoyez du texte ou utilisez le bouton dans le message du planning.",
  "task.blocked.command_not_allowed":
    "⚠️ Cette commande n'est pas disponible pendant la création d'une tâche planifiée.",
  "task.limit_reached":
    "⚠️ Limite de tâches atteinte ({limit}). Supprimez d'abord une tâche planifiée existante.",
  "task.schedule_too_frequent":
    "Le planning récurrent est trop fréquent. L'intervalle minimum autorisé est d'une fois toutes les 5 minutes.",
  "task.kind.cron": "récurrente",
  "task.kind.once": "ponctuelle",
  "task.run.success": "⏰ Tâche planifiée terminée : {description}",
  "task.run.error": "🔴 Échec de la tâche planifiée : {description}\n\nErreur : {error}",
  "task.run.error.interactive_question":
    "La tâche planifiée a demandé une question interactive et ne peut pas continuer sans intervention.",
  "task.run.error.interactive_permission":
    "La tâche planifiée a demandé une autorisation interactive et ne peut pas continuer sans intervention.",

  "tasklist.empty": "📭 Aucune tâche planifiée pour le moment.",
  "tasklist.select": "Sélectionnez une tâche planifiée :",
  "tasklist.details":
    "⏰ Tâche planifiée\n\nTâche : {prompt}\nProjet : {project}\nPlanning : {schedule}\n{cronLine}Fuseau horaire : {timezone}\nProchaine exécution : {nextRunAt}\nDernière exécution : {lastRunAt}\nNombre d'exécutions : {runCount}",
  "tasklist.details.cron": "Cron : {cron}",
  "tasklist.button.delete": "🗑 Supprimer",
  "tasklist.button.cancel": "❌ Annuler",
  "tasklist.deleted_callback": "Supprimée",
  "tasklist.inactive_callback": "Ce menu des tâches planifiées est inactif",
  "tasklist.load_error": "🔴 Impossible de charger les tâches planifiées.",

  "commands.select": "Choisissez une commande OpenCode :",
  "commands.empty": "📭 Aucune commande OpenCode n'est disponible pour ce projet.",
  "commands.fetch_error": "🔴 Impossible de charger les commandes OpenCode.",
  "commands.no_description": "Aucune description",
  "commands.button.execute": "✅ Exécuter",
  "commands.confirm":
    "Confirmez l'exécution de la commande {command}. Pour l'exécuter avec des arguments, envoyez-les dans un message.",
  "commands.inactive_callback": "Ce menu de commandes est inactif",
  "commands.execute_callback": "Exécution de la commande...",
  "commands.executing_prefix": "⚡ Exécution de la commande :",
  "commands.arguments_empty":
    "⚠️ Les arguments ne peuvent pas être vides. Envoyez du texte ou appuyez sur Exécuter.",
  "commands.execute_error": "🔴 Impossible d'exécuter la commande OpenCode.",
  "commands.select_page": "Choisissez une commande OpenCode (page {page}) :",
  "commands.button.prev_page": "⬅️ Précédent",
  "commands.button.next_page": "Suivant ➡️",
  "commands.page_empty_callback": "Aucune commande sur cette page",
  "commands.download.downloading": "Téléchargement du fichier...",
  "commands.download.not_found": "Fichier introuvable",
  "commands.download.not_file": "Le chemin n'est pas un fichier",
  "commands.download.file_too_large": "Le fichier est trop volumineux",
  "commands.download.size": "Taille",
  "commands.download.modified": "Modifié",
  "commands.download.error": "Impossible de télécharger le fichier.",

  "skills.select": "Choisissez un skill OpenCode :",
  "skills.empty": "📭 Aucun skill OpenCode n'est disponible pour ce projet.",
  "skills.fetch_error": "🔴 Impossible de charger les skills OpenCode.",
  "skills.no_description": "Aucune description",
  "skills.button.execute": "✅ Exécuter",
  "skills.confirm":
    "Confirmez l'exécution du skill {skill}. Pour l'exécuter avec des arguments, envoyez-les dans un message.",
  "skills.inactive_callback": "Ce menu de skills est inactif",
  "skills.execute_callback": "Utilisation du skill...",
  "skills.executing_prefix": "⚡ Utilisation du skill :",
  "skills.arguments_empty":
    "⚠️ Les arguments ne peuvent pas être vides. Envoyez du texte ou appuyez sur Exécuter.",
  "skills.select_page": "Choisissez un skill OpenCode (page {page}) :",
  "skills.button.prev_page": "⬅️ Précédent",
  "skills.button.next_page": "Suivant ➡️",
  "skills.page_empty_callback": "Aucun skill sur cette page",

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



  "stt.uncertain": "🎤 Certains mots peuvent être incorrects. Vérifiez et envoyez le texte corrigé :",
  "stt.recognizing": "🎤 Reconnaissance audio en cours...",
  "stt.recognized": "🎤 Reconnu :",
  "stt.not_configured":
    "🎤 La reconnaissance vocale n'est pas configurée.\n\nDéfinissez STT_API_URL et STT_API_KEY dans .env pour l'activer.",
  "stt.error": "🔴 Impossible de reconnaître l'audio : {error}",
  "stt.empty_result": "🎤 Aucune parole détectée dans le message audio.",

  "worktree.branch_detached": "detached HEAD",
  "worktree.select_with_current": "Sélectionnez un worktree :",
  "worktree.project_not_selected":
    "🏗 Aucun projet sélectionné.\n\nSélectionnez d'abord un projet avec /projects.",
  "worktree.not_git_repo":
    "🌿 Les git worktrees ne sont pas disponibles pour le projet actuel. Sélectionnez d'abord un dépôt git.",
  "worktree.not_git_repo_callback": "Le projet actuel n'est pas un dépôt git",
  "worktree.empty": "📭 Aucun git worktree trouvé pour le dépôt actuel.",
  "worktree.fetch_error": "🔴 Impossible de charger les git worktrees.",
  "worktree.page_empty_callback": "Aucun worktree sur cette page",
  "worktree.selection_missing_callback": "Le worktree sélectionné n'est plus disponible",
  "worktree.already_selected_callback": "Ce worktree est déjà sélectionné",
  "worktree.selected":
    "✅ Worktree sélectionné : {worktree}\n\n📋 La session a été réinitialisée. Utilisez /sessions ou /new pour continuer.",
  "worktree.select_error": "🔴 Impossible de sélectionner le worktree.",
  "open.back": "⬆️ Remonter",
  "open.roots": "📋 Retour aux racines",
  "open.prev_page": "⬅️ Précédent",
  "open.next_page": "Suivant ➡️",
  "open.select_current": "✅ Sélectionner ce dossier",
  "open.select_root": "📂 Sélectionnez un répertoire racine à parcourir :",
  "open.access_denied": "⛔ Accès refusé : le chemin est en dehors des répertoires autorisés",
  "open.scan_error": "🔴 Impossible de parcourir le répertoire : {error}",
  "open.open_error": "🔴 Impossible d'ouvrir l'explorateur de répertoires.",
  "open.selected": "✅ Projet ajouté : {project}\n\n📋 Utilisez /sessions ou /new pour commencer.",
  "open.select_error": "🔴 Impossible d'ajouter le projet.",
  "open.no_subfolders": "📭 Aucun sous-dossier",
  "open.subfolder_count": "{count} sous-dossier",
  "open.subfolders_count": "{count} sous-dossiers",
  "ls.access_denied": "⛔ Accès refusé : le chemin est en dehors du projet actuel",
  "ls.scan_error": "🔴 Impossible de lister le répertoire",
  "ls.header": "Liste du répertoire",
  "ls.total": "Total : {count} éléments",
  "ls.file.header": "Détails du fichier",
  "ls.file.download": "📥 Télécharger",
  "ls.file.back": "⬅️ Retour",
  "ls.file.attach": "📎 Joindre au prochain prompt",
  "attachment.added": "📎 Joint : {path}\n\nEnvoyez votre message et le fichier partira avec.",
  "attachment.cancel": "❌ Annuler la pièce jointe",
  "attachment.cancelled": "❌ Pièce jointe annulée",
  "attachment.invalid":
    "⚠️ Le fichier joint n'est plus disponible. Envoi du message sans celui-ci.",
};
