// ============================================================
// Tasks — Telegram namespace
// ------------------------------------------------------------
// Task messages and callbacks are handled in complete isolation from the
// private `/yangi` accounting flow:
//
//   * `/yangi` only ever runs in a PRIVATE chat with the single authorized
//     user; this handler only ever acts on the configured Tasks GROUP.
//   * Task callbacks use their own `t_done:` namespace, distinct from the
//     `bot_type:`/`bot_ten:`/`bot_curr:` accounting callbacks.
//   * A task callback never writes a financial record, and an accounting
//     update never reaches this handler.
//
// Completion is gated by the webhook secret (checked in doPost) and by the
// callback originating in the configured Tasks group. Anyone in that group may
// press the button; who pressed it is recorded.
// ============================================================

var TASK_CALLBACK_PREFIX = "t_";
var TASK_DONE_CALLBACK = "t_done:";
var TASK_DONE_BUTTON_TEXT = "✅ Ish bajarildi";

function taskDoneMarkup_(occurrenceId) {
  return { inline_keyboard: [[{ text: TASK_DONE_BUTTON_TEXT, callback_data: TASK_DONE_CALLBACK + occurrenceId }]] };
}

function taskClearedMarkup_() {
  return { inline_keyboard: [] };
}

function taskPriorityEmoji_(priority) {
  if (priority === "urgent") return "🔴";
  if (priority === "high") return "🟠";
  if (priority === "low") return "⚪️";
  return "🔵";
}

function taskDisplayName_(from) {
  if (!from) return "Noma'lum";
  var name = [from.first_name, from.last_name].filter(function (p) { return p; }).join(" ").trim();
  if (name) return name;
  if (from.username) return "@" + from.username;
  return String(from.id || "Noma'lum");
}

// --------------------------------------------------------- message building

function buildTaskCardBody_(occ) {
  var lines = [];
  lines.push("👤 Mas'ul: " + (occ.responsible || "—"));
  if (occ.dueAt !== "" && isFinite(occ.dueAt)) {
    lines.push("📅 Muddat: " + formatTaskInstant_(occ.dueAt));
  } else if (occ.dateKey) {
    lines.push("📅 Sana: " + formatTaskDateKey_(occ.dateKey));
  } else {
    lines.push("📅 Muddat: belgilanmagan");
  }
  lines.push("📷 Rasm tasdiqi: " + (occ.photoRequired ? "Ha" : "Yo'q"));
  return lines.join("\n");
}

/** The message posted when a task/occurrence first appears in the group. */
function buildTaskOccurrenceMessage_(occ) {
  return [
    "🆕 " + taskPriorityEmoji_(occ.priority) + " Yangi vazifa",
    "",
    "📌 " + occ.title,
    buildTaskCardBody_(occ)
  ].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

/** The message posted as a reminder for an open occurrence. */
function buildTaskReminderMessage_(occ) {
  return [
    "🔔 " + taskPriorityEmoji_(occ.priority) + " Eslatma",
    "",
    "📌 " + occ.title,
    buildTaskCardBody_(occ)
  ].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

/** The message an occurrence's card is edited into once it reaches an end state. */
function buildTaskStatusMessage_(occ, nowMs) {
  var display = occurrenceDisplayStatus_(occ, nowMs === undefined ? Date.now() : nowMs);

  if (occ.status === TASK_STATUS_COMPLETED) {
    var lines = ["✅ Bajarildi", "", "📌 " + occ.title];
    lines.push("👤 Bajardi: " + (occ.completedByName || "—"));
    if (occ.completedAt) lines.push("🕒 " + formatTaskInstant_(Date.parse(occ.completedAt)));
    if (occ.onTime === false && occ.lateMs !== "" && Number(occ.lateMs) > 0) {
      lines.push("⚠️ " + formatTaskDuration_(occ.lateMs) + " kech bajarildi");
    } else if (occ.onTime === true) {
      lines.push("⏱ O'z vaqtida");
    }
    if (occ.proofFileId) lines.push("📷 Rasm bilan tasdiqlangan");
    return lines.join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
  }

  if (occ.status === TASK_STATUS_WAITING) {
    return ["⏳ Rasm kutilmoqda", "", "📌 " + occ.title,
      "👤 " + (occ.completedByName || "—") + " bajarildi deb belgiladi.",
      "📷 Tasdiqlash uchun rasm yuboring."].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
  }

  if (occ.status === TASK_STATUS_CANCELLED) {
    return ["🚫 Bekor qilindi", "", "📌 " + occ.title].join("\n");
  }
  if (occ.status === TASK_STATUS_SKIPPED) {
    return ["⏭ O'tkazib yuborildi", "", "📌 " + occ.title].join("\n");
  }
  return buildTaskOccurrenceMessage_(occ);
}

/**
 * The ForceReply prompt asking one named person for the proof photo.
 *
 * Titles are capped at 200 characters upstream, so nothing here is truncated -
 * slicing an HTML string could cut an entity in half.
 */
function buildTaskProofPromptMessage_(occ, options) {
  var name = escapeTelegramHtml_((options && options.userName) || occ.completedByName || "");
  var id = options && options.userId ? String(options.userId) : "";
  var mention = id ? '<a href="tg://user?id=' + id + '">' + name + '</a>' : name;
  return "📷 " + mention + ", \"" + escapeTelegramHtml_(occ.title) +
    "\" ni tasdiqlash uchun shu xabarga javob (reply) qilib rasm yuboring.";
}

// ------------------------------------------------------------- completion

/**
 * Marks an occurrence complete, recording who, when, whether it was on time,
 * and any photo proof. Remaining reminders stop automatically because the
 * scheduler and the reminder job both act only on still-open occurrences.
 *
 * Returns the updated occurrence object (already persisted).
 */
function completeTaskOccurrence_(doc, occ, options) {
  var opts = options || {};
  var nowMs = opts.nowMs === undefined ? Date.now() : opts.nowMs;

  occ.status = TASK_STATUS_COMPLETED;
  occ.completedById = String(opts.byId || "");
  occ.completedByName = String(opts.byName || "");
  occ.completedAt = new Date(nowMs).toISOString();
  occ.proofAwaitingUserId = "";
  if (opts.proofFileId) occ.proofFileId = String(opts.proofFileId);
  if (opts.proofMsgId) occ.proofMsgId = String(opts.proofMsgId);
  occ.meta = occ.meta || {};
  occ.meta.source = opts.source || "telegram";
  // A stale prompt pointer must not be able to match a later photo.
  occ.meta.proofPromptMsgId = "";

  if (occ.dueAt !== "" && isFinite(occ.dueAt)) {
    if (nowMs > occ.dueAt) { occ.onTime = false; occ.lateMs = nowMs - occ.dueAt; }
    else { occ.onTime = true; occ.lateMs = 0; }
  } else {
    occ.onTime = true; occ.lateMs = "";
  }

  writeOccurrenceRow_(doc, occ);
  appendAuditRow_(doc, "task_occurrence_completed",
    occ.id + " by:" + (occ.completedByName || occ.completedById) + " onTime:" + occ.onTime);

  // Keep the group message current instead of posting a duplicate.
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });

  // Goals derive their progress from their step occurrences.
  if (occ.taskType === "goal") maybeCompleteGoal_(doc, occ.taskId, nowMs);

  return occ;
}

/** Completes the parent goal when every one of its steps is done. */
function maybeCompleteGoal_(doc, taskId, nowMs) {
  var task = findTask_(doc, taskId);
  if (!task || task.type !== "goal" || task.status === TASK_DEF_COMPLETED) return;
  var progress = goalProgress_(occurrencesForTask_(readOccurrenceRows_(doc), taskId));
  if (progress.total > 0 && progress.done >= progress.total) {
    task.status = TASK_DEF_COMPLETED;
    task.updatedAt = new Date(nowMs).toISOString();
    updateTaskRow_(doc, task);
    appendAuditRow_(doc, "task_goal_completed", taskId);
    var chatId = getTasksGroupChatId_();
    if (chatId) {
      try {
        sendTelegramMessage_(chatId, "🎯 Maqsad bajarildi: " + task.title + " (100%)");
      } catch (error) {
        debugLog_(doc, "task_goal_notify_failed", String(error));
      }
    }
  }
}

// --------------------------------------------------------- update routing

/**
 * True when a Telegram update belongs to the task namespace and must be
 * handled here instead of by the accounting `/yangi` flow. Deliberately
 * narrow: task callbacks, and photo/reply messages inside the Tasks group.
 */
function isTaskTelegramUpdate_(update) {
  if (!update) return false;
  if (update.callback_query) {
    return String(update.callback_query.data || "").indexOf(TASK_CALLBACK_PREFIX) === 0;
  }
  var message = update.message;
  if (!message) return false;
  var tasksGroup = getTasksGroupChatId_();
  if (!tasksGroup) return false;
  if (String(message.chat && message.chat.id) !== String(tasksGroup)) return false;
  return !!(message.photo || message.reply_to_message);
}

function handleTaskTelegramUpdate_(update, doc, configSheet) {
  try {
    if (update.callback_query) {
      handleTaskCallback_(update.callback_query, doc);
    } else if (update.message) {
      handleTaskGroupMessage_(update.message, doc);
    }
    // Best-effort: reflect the change on the group message promptly. Never
    // throws into the webhook response — Telegram must always get a 200.
    drainJobQueueQuietly_(doc, null);
  } catch (error) {
    debugLog_(doc, "task_update_error", String(error));
  }
  return okHtmlOutput_();
}

function handleTaskCallback_(callback, doc) {
  var data = String(callback.data || "");
  if (data.indexOf(TASK_DONE_CALLBACK) !== 0) {
    answerCallbackQuery_(callback.id);
    return;
  }

  var tasksGroup = getTasksGroupChatId_();
  var chatId = callback.message && callback.message.chat ? callback.message.chat.id : "";
  // Isolation gate: task completions only count inside the configured group.
  if (!tasksGroup || String(chatId) !== String(tasksGroup)) {
    answerCallbackQuery_(callback.id, "Bu tugma bu yerda ishlamaydi.");
    return;
  }

  var occurrenceId = data.slice(TASK_DONE_CALLBACK.length);
  var occ = findOccurrence_(doc, occurrenceId);
  if (!occ) { answerCallbackQuery_(callback.id, "Vazifa topilmadi."); return; }
  if (occ.status === TASK_STATUS_COMPLETED) { answerCallbackQuery_(callback.id, "Allaqachon bajarilgan."); return; }
  if (occ.status === TASK_STATUS_CANCELLED) { answerCallbackQuery_(callback.id, "Bu vazifa bekor qilingan."); return; }
  if (occ.status === TASK_STATUS_SKIPPED) { answerCallbackQuery_(callback.id, "Bu vazifa o'tkazib yuborilgan."); return; }

  var from = callback.from || {};

  if (occ.status === TASK_STATUS_WAITING) {
    // The proof is somebody's to deliver. A second presser must not be able to
    // take the task from them, or to overwrite who is recorded as doing it.
    if (String(occ.proofAwaitingUserId) === String(from.id)) {
      enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
        occurrenceId: occ.id, userId: String(from.id), userName: taskDisplayName_(from)
      });
      answerCallbackQuery_(callback.id, "📷 Rasm kutilmoqda — so'ralgan xabarga javob qiling.");
    } else {
      answerCallbackQuery_(callback.id,
        (occ.completedByName || "Boshqa foydalanuvchi") + " tasdiqlamoqda.");
    }
    return;
  }

  if (occ.photoRequired) {
    occ.status = TASK_STATUS_WAITING;
    occ.proofAwaitingUserId = String(from.id || "");
    occ.completedByName = taskDisplayName_(from);   // provisional; confirmed on proof
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = "";
    occ.meta.proofRequestedAt = new Date().toISOString();
    writeOccurrenceRow_(doc, occ);

    enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
      occurrenceId: occ.id, userId: String(from.id || ""), userName: taskDisplayName_(from)
    });
    answerCallbackQuery_(callback.id, "📷 Iltimos, so'ralgan xabarga rasm bilan javob bering.");
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    return;
  }

  completeTaskOccurrence_(doc, occ, {
    byId: from.id, byName: taskDisplayName_(from), source: "telegram"
  });
  answerCallbackQuery_(callback.id, "✅ Bajarildi.");
}

/**
 * A photo in the Tasks group.
 *
 * Proof is only proof of the thing that was asked for: the photo has to be a
 * reply to that occurrence's prompt (or to its card), and it has to come from
 * the person who claimed it. Guessing "probably their most recent pending
 * task" is how an unrelated photo silently completed the wrong job.
 */
function handleTaskGroupMessage_(message, doc) {
  if (!message.photo || !message.photo.length) return;
  var from = message.from || {};
  var replyTo = message.reply_to_message ? String(message.reply_to_message.message_id) : "";

  var pendingForUser = 0;
  var target = null;
  var claimedByOther = null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status !== TASK_STATUS_WAITING) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) pendingForUser++;
    if (!replyTo) continue;
    var meta = occ.meta || {};
    var answersThis = String(meta.proofPromptMsgId || "") === replyTo || String(occ.msgId || "") === replyTo;
    if (!answersThis) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) target = occ;
    else claimedByOther = occ;
  }

  if (!target) {
    if (claimedByOther) {
      trySendTaskGroupMessage_(doc, "⚠️ Bu vazifani " +
        (claimedByOther.completedByName || "boshqa foydalanuvchi") + " tasdiqlamoqda.");
    } else if (pendingForUser > 0) {
      trySendTaskGroupMessage_(doc,
        "⚠️ Rasmni qabul qilish uchun so'ralgan xabarga javob (reply) qilib yuboring.");
    }
    return;   // an unrelated photo is just a photo
  }

  var largest = message.photo[message.photo.length - 1] || {};
  completeTaskOccurrence_(doc, target, {
    byId: from.id,
    byName: taskDisplayName_(from),
    source: "telegram",
    proofFileId: largest.file_id || "",
    proofMsgId: message.message_id
  });
  trySendTaskGroupMessage_(doc, "✅ Rasm qabul qilindi — \"" + target.title + "\" bajarildi.");
}

/** Group chatter is never worth failing a webhook over. */
function trySendTaskGroupMessage_(doc, text) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) return;
  try {
    sendTelegramMessage_(chatId, text);
  } catch (error) {
    debugLog_(doc, "task_group_notice_failed", String(error));
  }
}
