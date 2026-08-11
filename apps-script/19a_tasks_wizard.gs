// ============================================================
// Tasks — the /yangi "Vazifa" wizard
// ------------------------------------------------------------
// Creating a task from the private Telegram bot, one question at a time.
//
// This is the single place where the private accounting conversation and the
// task module meet, so the boundary is drawn deliberately:
//
//   * every callback uses the `bot_vz` prefix, so it is dispatched from inside
//     handleOmadTelegramUpdate_ and inherits the private-chat check and the
//     authorization gate. A `t_` prefix would instead have been claimed by
//     isTaskTelegramUpdate_, which applies neither.
//   * the session reuses the accounting key ("yangi_" + fromId) with a
//     `flow: "task"` discriminator, so there is one session per user, one TTL
//     and one cleanup path — and typing /yangi already wipes it.
//   * neither entry point receives `configSheet`. "The wizard never reads
//     financial config" is therefore enforced by the function signatures rather
//     than by discipline: getActiveTenantNames_ is simply not callable here.
//
// The wizard writes tasks and nothing else. It never touches a transaction, a
// tenant, a rate or a backup.
//
// Wizard messages are plain text with no parse_mode. Titles, names and step
// text are free-form user input, and staying out of HTML mode removes the
// whole escaping bug class from this surface. The *group* cards are HTML —
// that is buildTaskOccurrenceMessage_'s job, and it escapes them.
// ============================================================

var WIZARD_FLOW = "task";

// A serialised session lives in the script cache, which rejects values over
// ~100 KB. Every free-text field is capped well below that, so this is a
// backstop that turns "the draft silently vanished" into something the user
// can act on.
var WIZARD_MAX_STATE_CHARS = 8000;
var WIZARD_SESSION_TTL_SECONDS = 21600; // matches the accounting flow

var WIZARD_MAX_TITLE = 200;
var WIZARD_MAX_DESC = 2000;
var WIZARD_MAX_NAME = 200;
// 20 steps means 20 occurrences, 20 notify jobs and up to 20 group messages
// from a single confirm. That is the ceiling, not a target.
var WIZARD_MAX_STEPS = 20;
var WIZARD_MAX_RESP_CHOICES = 6;

var WIZARD_TIME_PRESETS = ["09:00", "12:00", "18:00", "20:00"];
var WIZARD_REMINDER_PRESETS = ["08:00", "09:00", "12:00", "18:00", "20:00"];
var WIZARD_MONTHDAY_PRESETS = ["1", "5", "10", "15", "25"];
// Uzbek weekday labels against JS weekday numbers (0 = Sunday), Monday first.
var WIZARD_WEEKDAYS = [["Du", 1], ["Se", 2], ["Chor", 3], ["Pay", 4], ["Jum", 5], ["Shan", 6], ["Yak", 0]];

var WIZARD_PRIORITY_LABELS = {
  low: "⚪️ Past", normal: "🔵 Oddiy", high: "🟠 Yuqori", urgent: "🔴 Shoshilinch"
};

var WIZARD_EXPIRED_MESSAGE = "⌛️ Sessiya tugagan. /yangi bilan qaytadan boshlang.";
var WIZARD_STALE_BUTTON_MESSAGE = "Bu tugma eskirgan.";
var WIZARD_TOO_BIG_MESSAGE = "Juda ko'p ma'lumot. Matnni qisqartiring.";
var WIZARD_CANCELLED_MESSAGE = "❌ Bekor qilindi.";

// ------------------------------------------------------------------ session

/**
 * Writes the session back, refusing anything that would no longer fit in the
 * script cache. Returns false instead of losing the draft silently.
 */
function putWizardState_(cache, key, state) {
  var serialised = JSON.stringify(state);
  if (serialised.length > WIZARD_MAX_STATE_CHARS) return false;
  cache.put(key, serialised, WIZARD_SESSION_TTL_SECONDS);
  return true;
}

/**
 * The one way out. Every exit path — cancel, expiry, success, post-save error
 * — funnels through here, so no cache key is ever left behind.
 */
function finishWizard_(cache, key) {
  cache.remove(key);
}

/** The live wizard session, or null when there is not one. */
function readWizardState_(cache, key) {
  var state = safeParseJSON_(cache.get(key), null);
  return state && state.flow === WIZARD_FLOW ? state : null;
}

function newWizardDraft_(type) {
  return {
    type: type,
    title: "",
    description: "",
    responsible: "",
    priority: "normal",
    photoRequired: false,
    deadlineKey: "",
    deadlineTime: "",
    recurrence: { freq: "daily", interval: 1, weekdays: [], monthDay: 1, intervalDays: 1 },
    startKey: "",
    endKey: "",
    dueTime: "",
    steps: [],
    reminderTimes: [],
    // Only ever set from the vz_remdaily answer, and only asked when a
    // one-time task has both a deadline and reminder times. Everything else
    // derives it at save time rather than pretending the user chose.
    remindDaily: false
  };
}

// ------------------------------------------------------------------ parsing

/**
 * A typed date, accepted only when it is a real calendar day.
 *
 * isTaskDateKey_ is purely syntactic — "2026-13-45" satisfies it — and an
 * invalid startKey is silently replaced with today by normalizeTaskInput_,
 * which would create a routine nobody asked for. Round-tripping through the
 * day anchor is what proves the date exists: Date.UTC rolls 2026-13-45 over
 * into 2027-02-14, and the comparison catches it.
 */
function wizardParseDate_(value) {
  var text = String(value || "").trim().replace(/[.\/]/g, "-");
  if (!isTaskDateKey_(text)) return "";
  var anchor = taskKeyAnchorMs_(text);
  if (!isFinite(anchor)) return "";
  return taskKeyFromAnchorMs_(anchor) === text ? text : "";
}

/** A typed clock time normalised to HH:MM, or "" when it is not one. */
function wizardParseTime_(value) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return "";
  var normalised = taskPad2_(m[1]) + ":" + m[2];
  return isTaskTimeKey_(normalised) ? normalised : "";
}

// ------------------------------------------------------------------ choices

/**
 * Names already used on other tasks, most recent first.
 *
 * Deliberately NOT getActiveTenantNames_: that reads Omad_Tenants, and the
 * wizard must never touch accounting config. `configSheet` is not even in
 * scope here, which is what makes the rule structural rather than a promise.
 */
function wizardResponsibleChoices_(doc) {
  var rows = readTaskRows_(doc);
  var seen = {};
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < WIZARD_MAX_RESP_CHOICES; i--) {
    var name = String(rows[i].responsible || "").trim();
    if (!name || seen[name]) continue;
    seen[name] = true;
    out.push(name);
  }
  return out;
}

// ------------------------------------------------------------ the step order

/**
 * The step that follows `from`, given what the draft already knows.
 *
 * Kept as one function so the shape of the conversation is readable in one
 * place instead of being scattered across twenty handlers.
 */
function wizardNextStep_(state, from) {
  var draft = state.draft || {};
  switch (from) {
    case "vz_type": return "vz_title";
    case "vz_title": return "vz_desc";
    case "vz_desc": return "vz_resp";
    case "vz_resp": return "vz_pri";
    case "vz_resp_text": return "vz_pri";
    case "vz_pri": return "vz_photo";
    case "vz_photo":
      if (draft.type === "once") return "vz_date";
      if (draft.type === "routine") return "vz_freq";
      return "vz_steps";

    // once — a task with no deadline has no time to ask about either.
    case "vz_date": return draft.deadlineKey ? "vz_time" : "vz_reminders";
    case "vz_time": return "vz_reminders";

    // routine
    case "vz_freq":
      if (draft.recurrence.freq === "weekly") return "vz_weekdays";
      if (draft.recurrence.freq === "monthly") return "vz_monthday";
      if (draft.recurrence.freq === "custom") return "vz_interval";
      return "vz_start";
    case "vz_weekdays": return "vz_start";
    case "vz_monthday": return "vz_start";
    case "vz_interval": return "vz_start";
    case "vz_start": return "vz_end";
    case "vz_end": return "vz_duetime";
    case "vz_duetime": return "vz_reminders";

    // goal
    case "vz_steps": return "vz_reminders";

    case "vz_reminders": return wizardAsksRemindDaily_(draft) ? "vz_remdaily" : "vz_confirm";
    case "vz_remdaily": return "vz_confirm";
  }
  return "vz_confirm";
}

/**
 * Whether the draft needs the "how should these repeat?" question.
 *
 * Only a dated one-time task has two honest answers: every day until it is
 * done, or once on the deadline day. A deadline-less one has no deadline day
 * to attach a reminder to, a routine's reminders belong to the day they were
 * scheduled for, and a goal's repeat daily by definition — asking there would
 * offer a choice that does not exist.
 */
function wizardAsksRemindDaily_(draft) {
  return draft.type === "once" && !!draft.deadlineKey && draft.reminderTimes.length > 0;
}

/** Per-step setup that has to happen as the step is entered, not rendered. */
function wizardOnEnterStep_(state, doc) {
  if (state.step === "vz_resp") {
    // Captured once, so the list cannot shift between render and press and
    // turn bot_vz_resp:<i> into a different person.
    state.respChoices = wizardResponsibleChoices_(doc);
  } else if (state.respChoices) {
    delete state.respChoices;
  }
}

// ---------------------------------------------------------------- rendering

function wizardButton_(text, data) {
  return { text: text, callback_data: data };
}

function wizardSkipButton_(what, label) {
  return wizardButton_(label || "⏭ O'tkazish", "bot_vz_skip:" + what);
}

/** A row of preset clock times plus the manual-entry escape, for one family. */
function wizardTimeRows_(prefix, presets) {
  var row = [];
  for (var i = 0; i < presets.length; i++) row.push(wizardButton_(presets[i], prefix + presets[i]));
  return [row, [wizardButton_("✍️ Vaqt", prefix + "other")]];
}

function wizardPriorityLabel_(priority) {
  return WIZARD_PRIORITY_LABELS[priority] || WIZARD_PRIORITY_LABELS.normal;
}

/**
 * The prompt and keyboard for wherever the conversation currently is.
 * Pure: everything it needs is already on the session.
 */
function wizardStepView_(state) {
  var draft = state.draft || {};
  var step = state.step;
  var rows;
  var i;

  if (step === "vz_type") {
    return {
      text: "Vazifa turini tanlang:",
      keyboard: { inline_keyboard: [[
        wizardButton_("📝 Bir martalik", "bot_vz_t:once"),
        wizardButton_("🔁 Muntazam", "bot_vz_t:routine"),
        wizardButton_("🎯 Maqsad", "bot_vz_t:goal")
      ]] }
    };
  }

  if (step === "vz_title") return { text: "📌 Vazifa sarlavhasini kiriting:", keyboard: null };

  if (step === "vz_desc") {
    return {
      text: "📝 Tavsif kiriting:",
      keyboard: { inline_keyboard: [[wizardSkipButton_("desc")]] }
    };
  }

  if (step === "vz_resp") {
    rows = [];
    var choices = state.respChoices || [];
    for (i = 0; i < choices.length; i++) rows.push([wizardButton_(choices[i], "bot_vz_resp:" + i)]);
    rows.push([wizardButton_("✍️ Boshqa ism", "bot_vz_resp_other"), wizardSkipButton_("resp")]);
    return { text: "👤 Mas'ul kim?", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_resp_text") return { text: "👤 Mas'ul ismini kiriting:", keyboard: null };

  if (step === "vz_pri") {
    return {
      text: "🎚 Muhimlik darajasi:",
      keyboard: { inline_keyboard: [
        [wizardButton_(WIZARD_PRIORITY_LABELS.low, "bot_vz_pri:low"),
         wizardButton_(WIZARD_PRIORITY_LABELS.normal, "bot_vz_pri:normal")],
        [wizardButton_(WIZARD_PRIORITY_LABELS.high, "bot_vz_pri:high"),
         wizardButton_(WIZARD_PRIORITY_LABELS.urgent, "bot_vz_pri:urgent")]
      ] }
    };
  }

  if (step === "vz_photo") {
    return {
      text: "📷 Rasm tasdiqi talab qilinsinmi?",
      keyboard: { inline_keyboard: [[
        wizardButton_("Ha", "bot_vz_photo:1"), wizardButton_("Yo'q", "bot_vz_photo:0")
      ]] }
    };
  }

  if (step === "vz_date") {
    return {
      text: "📅 Muddat sanasi:",
      keyboard: { inline_keyboard: [
        [wizardButton_("Bugun", "bot_vz_date:today"), wizardButton_("Ertaga", "bot_vz_date:tomorrow")],
        [wizardButton_("✍️ Sana kiriting", "bot_vz_date:other"), wizardSkipButton_("date", "⏭ Muddatsiz")]
      ] }
    };
  }

  if (step === "vz_date_text" || step === "vz_start_text" || step === "vz_end_text") {
    return { text: "📅 Sanani YYYY-MM-DD ko'rinishida kiriting (masalan 2026-08-15):", keyboard: null };
  }

  if (step === "vz_time") {
    rows = wizardTimeRows_("bot_vz_time:", WIZARD_TIME_PRESETS);
    rows[1].push(wizardSkipButton_("time", "⏭ Vaqtsiz"));
    return { text: "🕓 Muddat vaqti:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_time_text" || step === "vz_duetime_text" || step === "vz_rem_text") {
    return { text: "🕓 Vaqtni HH:MM ko'rinishida kiriting (masalan 20:00):", keyboard: null };
  }

  if (step === "vz_freq") {
    return {
      text: "🔁 Qanchalik tez-tez takrorlansin?",
      keyboard: { inline_keyboard: [
        [wizardButton_("Har kuni", "bot_vz_freq:daily"), wizardButton_("Hafta kunlari", "bot_vz_freq:weekly")],
        [wizardButton_("Oylik", "bot_vz_freq:monthly"), wizardButton_("Har N kunda", "bot_vz_freq:custom")]
      ] }
    };
  }

  if (step === "vz_weekdays") {
    var picked = draft.recurrence.weekdays || [];
    var toggles = [];
    for (i = 0; i < WIZARD_WEEKDAYS.length; i++) {
      var wd = WIZARD_WEEKDAYS[i][1];
      var mark = picked.indexOf(wd) !== -1 ? "✅ " : "";
      toggles.push(wizardButton_(mark + WIZARD_WEEKDAYS[i][0], "bot_vz_wd:" + wd));
    }
    rows = [toggles.slice(0, 4), toggles.slice(4)];
    // Offering "done" with nothing selected would only produce a refusal.
    if (picked.length) rows.push([wizardButton_("✅ Tayyor", "bot_vz_wd_done")]);
    return { text: "📆 Hafta kunlarini tanlang:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_monthday") {
    var dayRow = [];
    for (i = 0; i < WIZARD_MONTHDAY_PRESETS.length; i++) {
      dayRow.push(wizardButton_(WIZARD_MONTHDAY_PRESETS[i] + "-kun", "bot_vz_md:" + WIZARD_MONTHDAY_PRESETS[i]));
    }
    return {
      text: "📆 Oyning qaysi kuni?",
      keyboard: { inline_keyboard: [
        dayRow,
        [wizardButton_("Oxirgi kun", "bot_vz_md:last"), wizardButton_("✍️ Kun", "bot_vz_md:other")]
      ] }
    };
  }

  if (step === "vz_monthday_text") return { text: "📆 Kun raqamini kiriting (1-31):", keyboard: null };

  if (step === "vz_interval") return { text: "🔢 Necha kunda bir marta? Raqam kiriting:", keyboard: null };

  if (step === "vz_start") {
    return {
      text: "▶️ Boshlanish sanasi:",
      keyboard: { inline_keyboard: [[
        wizardButton_("Bugundan", "bot_vz_start:today"), wizardButton_("✍️ Sana", "bot_vz_start:other")
      ]] }
    };
  }

  if (step === "vz_end") {
    return {
      text: "⏹ Tugash sanasi:",
      keyboard: { inline_keyboard: [[
        wizardSkipButton_("end", "⏭ Tugashsiz"), wizardButton_("✍️ Sana", "bot_vz_end:other")
      ]] }
    };
  }

  if (step === "vz_duetime") {
    rows = wizardTimeRows_("bot_vz_due:", WIZARD_TIME_PRESETS);
    rows[1].push(wizardSkipButton_("duetime", "⏭ Vaqtsiz"));
    return { text: "🕓 Kunlik muddat vaqti:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_steps") {
    var lines = ["🎯 Bosqichlarni birma-bir yuboring. Tugagach ✅ Tayyor."];
    if (draft.steps.length) {
      lines.push("");
      for (i = 0; i < draft.steps.length; i++) lines.push((i + 1) + ". " + draft.steps[i]);
    }
    rows = [];
    if (draft.steps.length) {
      rows.push([wizardButton_("↩️ Oxirgi qadamni o'chirish", "bot_vz_step_undo")]);
      // Absent until there is at least one step, so normalizeTaskInput_'s
      // "kamida bitta qadam" refusal is unreachable rather than reported late.
      rows.push([wizardButton_("✅ Tayyor", "bot_vz_step_done")]);
    }
    return { text: lines.join("\n"), keyboard: rows.length ? { inline_keyboard: rows } : null };
  }

  if (step === "vz_reminders") {
    var chosen = draft.reminderTimes || [];
    var remRow = [];
    for (i = 0; i < WIZARD_REMINDER_PRESETS.length; i++) {
      var time = WIZARD_REMINDER_PRESETS[i];
      remRow.push(wizardButton_((chosen.indexOf(time) !== -1 ? "✅ " : "") + time, "bot_vz_rem:" + time));
    }
    rows = [remRow, [wizardButton_("✍️ Boshqa vaqt", "bot_vz_rem_other")]];
    rows.push([chosen.length
      ? wizardButton_("✅ Tayyor", "bot_vz_rem_done")
      : wizardSkipButton_("reminders")]);
    return { text: "🔔 Eslatma vaqtlari:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_remdaily") {
    return {
      text: "🔔 Eslatmalar qanday takrorlansin?",
      keyboard: { inline_keyboard: [
        [wizardButton_("🔁 Har kuni, bajarilguncha", "bot_vz_rd:daily")],
        [wizardButton_("📅 Faqat muddat kunida", "bot_vz_rd:deadline")]
      ] }
    };
  }

  if (step === "vz_confirm") {
    return {
      text: buildWizardSummary_(draft),
      keyboard: { inline_keyboard: [[
        wizardButton_("✅ Saqlash", "bot_vz_save"), wizardButton_("❌ Bekor", "bot_vz_cancel")
      ]] }
    };
  }

  return { text: WIZARD_EXPIRED_MESSAGE, keyboard: null };
}

/** The review card: everything the draft says, in the order it was asked. */
function buildWizardSummary_(draft) {
  var lines = ["Tekshirib, saqlang:", ""];
  lines.push("📌 " + draft.title);

  var meta = [];
  if (draft.responsible) meta.push("👤 " + draft.responsible);
  meta.push(wizardPriorityLabel_(draft.priority));
  meta.push("📷 " + (draft.photoRequired ? "Ha" : "Yo'q"));
  lines.push(meta.join(" · "));

  if (draft.description) lines.push("📝 " + draft.description);

  if (draft.type === "once") {
    lines.push(draft.deadlineKey
      ? "📅 " + formatTaskDateKey_(draft.deadlineKey) + (draft.deadlineTime ? " " + draft.deadlineTime : "")
      : "📅 Muddatsiz");
  } else if (draft.type === "routine") {
    lines.push("🔁 " + describeRecurrence_({
      type: "routine", recurrence: draft.recurrence, startKey: draft.startKey
    }));
    lines.push("▶️ " + formatTaskDateKey_(draft.startKey) +
      (draft.endKey ? " — " + formatTaskDateKey_(draft.endKey) : ""));
    if (draft.dueTime) lines.push("🕓 " + draft.dueTime);
  } else {
    lines.push("🎯 Bosqichlar:");
    for (var i = 0; i < draft.steps.length; i++) lines.push("  " + (i + 1) + ". " + draft.steps[i]);
  }

  if (draft.reminderTimes.length) {
    // The repeat rule is as much a decision as the times are, so the review
    // card states it rather than leaving the user to assume one. A routine has
    // no rule to state: each day's occurrence carries its own reminders.
    var repeat = draft.type === "routine" ? ""
      : (wizardRemindDaily_(draft) ? " · har kuni" : " · muddat kunida");
    lines.push("🔔 " + draft.reminderTimes.join(", ") + repeat);
  }
  return lines.join("\n");
}

/**
 * What `remindDaily` will be saved as.
 *
 * A dated one-time task carries the answer the user gave at vz_remdaily. Every
 * other shape has only one reading that does anything: reminders on something
 * with no deadline day can only mean "every day until it is done", which is the
 * same rule goalRemindDaily_ applies to a goal's steps.
 */
function wizardRemindDaily_(draft) {
  if (draft.type === "routine") return false;
  if (wizardAsksRemindDaily_(draft)) return !!draft.remindDaily;
  return draft.reminderTimes.length > 0;
}

// ------------------------------------------------------------- step movement

/**
 * Renders the current step, editing `editMsgId` when the previous interaction
 * was a button press and sending a fresh card when it was typed text (the old
 * prompt is no longer the last message in the chat).
 */
function renderWizardStep_(state, chatId, key, cache, editMsgId, note) {
  var view = wizardStepView_(state);
  var text = note ? (note + "\n\n" + view.text) : view.text;

  if (editMsgId) {
    editTelegramMessage_(chatId, editMsgId, text, view.keyboard || { inline_keyboard: [] });
    state.msgId = editMsgId;
  } else {
    var sent = extractTelegramMessageId_(sendTelegramMessage_(chatId, text, view.keyboard || undefined));
    if (sent) state.msgId = sent;
  }

  if (!putWizardState_(cache, key, state)) {
    finishWizard_(cache, key);
    sendTelegramMessage_(chatId, WIZARD_TOO_BIG_MESSAGE);
  }
}

/** Moves to whatever follows `fromStep` and renders it. */
function advanceWizard_(state, fromStep, chatId, key, cache, editMsgId, doc) {
  state.step = wizardNextStep_(state, fromStep);
  wizardOnEnterStep_(state, doc);
  renderWizardStep_(state, chatId, key, cache, editMsgId);
}

/**
 * Re-renders where the user actually is, with a note explaining why.
 *
 * Used for invalid input and for a tap on a card that has been superseded. It
 * never mutates the draft, which is what makes correctness independent of
 * which card happened to be tapped.
 */
function repromptWizard_(state, chatId, key, cache, note) {
  renderWizardStep_(state, chatId, key, cache, 0, note);
}

// ------------------------------------------------------------------ callbacks

/**
 * Every `bot_vz` button. Reached only from processOmadCallback_, so the
 * private-chat check and gate #1 have already run; authorization is re-checked
 * here for the same reason the accounting steps re-check it.
 */
function handleTaskWizardCallback_(callback, chatId, key, cache, data, doc, fromId) {
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var msgId = (callback.message && callback.message.message_id) || 0;
  var state;

  // The entry button is the only one allowed to start from nothing.
  if (data === "bot_vz_type") {
    state = {
      flow: WIZARD_FLOW,
      sessionId: Utilities.getUuid().split("-").join(""),
      step: "vz_type",
      msgId: msgId,
      draft: newWizardDraft_("")
    };
    renderWizardStep_(state, chatId, key, cache, msgId);
    return;
  }

  state = readWizardState_(cache, key);
  if (!state) {
    // Deliberately NOT resurrected. processOmadCallback_ rebuilds a missing
    // accounting session from the button that arrived; a wizard draft cannot
    // be rebuilt that way, and a half-empty one would create a junk task.
    //
    // Answered with a new message rather than by editing the card: the tapped
    // card may be the finished "✅ Vazifa yaratildi" one, and a redelivered
    // press must not overwrite the outcome with an expiry notice.
    sendTelegramMessage_(chatId, WIZARD_EXPIRED_MESSAGE);
    return;
  }

  if (data === "bot_vz_cancel") {
    finishWizard_(cache, key);
    if (msgId) editTelegramMessage_(chatId, msgId, WIZARD_CANCELLED_MESSAGE, { inline_keyboard: [] });
    else sendTelegramMessage_(chatId, WIZARD_CANCELLED_MESSAGE);
    return;
  }

  var draft = state.draft;

  if (data.indexOf("bot_vz_t:") === 0) {
    if (state.step !== "vz_type") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var type = data.slice("bot_vz_t:".length);
    if (TASK_TYPES.indexOf(type) === -1) return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.draft = newWizardDraft_(type);
    return advanceWizard_(state, "vz_type", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_skip:") === 0) {
    return handleWizardSkip_(state, data.slice("bot_vz_skip:".length), chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_resp_other") {
    if (state.step !== "vz_resp") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.step = "vz_resp_text";
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data.indexOf("bot_vz_resp:") === 0) {
    if (state.step !== "vz_resp") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var picked = (state.respChoices || [])[Number(data.slice("bot_vz_resp:".length))];
    if (!picked) return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.responsible = picked;
    return advanceWizard_(state, "vz_resp", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_pri:") === 0) {
    if (state.step !== "vz_pri") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.priority = normalizeTaskPriority_(data.slice("bot_vz_pri:".length));
    return advanceWizard_(state, "vz_pri", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_photo:") === 0) {
    if (state.step !== "vz_photo") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.photoRequired = data.slice("bot_vz_photo:".length) === "1";
    return advanceWizard_(state, "vz_photo", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_date:") === 0) {
    if (state.step !== "vz_date") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var which = data.slice("bot_vz_date:".length);
    if (which === "other") {
      state.step = "vz_date_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    var today = taskTodayKey_(Date.now());
    draft.deadlineKey = which === "tomorrow" ? taskDateKeyAddDays_(today, 1) : today;
    return advanceWizard_(state, "vz_date", chatId, key, cache, msgId, doc);
  }

  // The value carries its own colon, so it is read by length — never split(":").
  if (data.indexOf("bot_vz_time:") === 0) {
    if (state.step !== "vz_time") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var timeValue = data.slice("bot_vz_time:".length);
    if (timeValue === "other") {
      state.step = "vz_time_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.deadlineTime = wizardParseTime_(timeValue);
    return advanceWizard_(state, "vz_time", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_freq:") === 0) {
    if (state.step !== "vz_freq") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.recurrence.freq = data.slice("bot_vz_freq:".length);
    return advanceWizard_(state, "vz_freq", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_wd:") === 0) {
    if (state.step !== "vz_weekdays") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var weekday = Number(data.slice("bot_vz_wd:".length));
    var at = draft.recurrence.weekdays.indexOf(weekday);
    if (at === -1) draft.recurrence.weekdays.push(weekday);
    else draft.recurrence.weekdays.splice(at, 1);
    draft.recurrence.weekdays.sort(function (a, b) { return a - b; });
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_wd_done") {
    if (state.step !== "vz_weekdays") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    if (!draft.recurrence.weekdays.length) {
      return renderWizardStep_(state, chatId, key, cache, msgId, "Kamida bitta kun tanlang.");
    }
    return advanceWizard_(state, "vz_weekdays", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_md:") === 0) {
    if (state.step !== "vz_monthday") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var monthDay = data.slice("bot_vz_md:".length);
    if (monthDay === "other") {
      state.step = "vz_monthday_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.recurrence.monthDay = monthDay === "last" ? "last" : Number(monthDay);
    return advanceWizard_(state, "vz_monthday", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_start:") === 0) {
    if (state.step !== "vz_start") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    if (data.slice("bot_vz_start:".length) === "other") {
      state.step = "vz_start_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.startKey = taskTodayKey_(Date.now());
    return advanceWizard_(state, "vz_start", chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_end:other") {
    if (state.step !== "vz_end") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.step = "vz_end_text";
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data.indexOf("bot_vz_due:") === 0) {
    if (state.step !== "vz_duetime") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var dueValue = data.slice("bot_vz_due:".length);
    if (dueValue === "other") {
      state.step = "vz_duetime_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.dueTime = wizardParseTime_(dueValue);
    return advanceWizard_(state, "vz_duetime", chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_step_undo") {
    if (state.step !== "vz_steps") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.steps.pop();
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_step_done") {
    if (state.step !== "vz_steps") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    if (!draft.steps.length) {
      return renderWizardStep_(state, chatId, key, cache, msgId, "Kamida bitta bosqich kiriting.");
    }
    return advanceWizard_(state, "vz_steps", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_rem:") === 0) {
    if (state.step !== "vz_reminders") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var reminder = data.slice("bot_vz_rem:".length);
    var remAt = draft.reminderTimes.indexOf(reminder);
    if (remAt === -1) draft.reminderTimes.push(reminder);
    else draft.reminderTimes.splice(remAt, 1);
    draft.reminderTimes.sort();
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_rem_other") {
    if (state.step !== "vz_reminders") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.step = "vz_rem_text";
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_rem_done") {
    if (state.step !== "vz_reminders") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    return advanceWizard_(state, "vz_reminders", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_rd:") === 0) {
    if (state.step !== "vz_remdaily") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var repeatMode = data.slice("bot_vz_rd:".length);
    if (repeatMode !== "daily" && repeatMode !== "deadline") {
      return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    }
    draft.remindDaily = repeatMode === "daily";
    return advanceWizard_(state, "vz_remdaily", chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_save") {
    if (state.step !== "vz_confirm") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    return handleWizardSave_(state, chatId, key, cache, doc, fromId);
  }

  repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
}

/** Every "⏭ O'tkazish" button, which is simply "leave the field empty". */
function handleWizardSkip_(state, what, chatId, key, cache, msgId, doc) {
  var expected = {
    desc: "vz_desc", resp: "vz_resp", date: "vz_date", time: "vz_time",
    end: "vz_end", duetime: "vz_duetime", reminders: "vz_reminders"
  }[what];
  if (!expected || state.step !== expected) {
    return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
  }
  // Skipping the deadline also skips its time; wizardNextStep_ reads the empty
  // deadlineKey and routes past vz_time on its own.
  return advanceWizard_(state, expected, chatId, key, cache, msgId, doc);
}

// ---------------------------------------------------------------- free text

/**
 * Every typed answer while a wizard session is live. Reached only from
 * processOmadTextStep_, below the private-chat check and gates #1 and #3.
 */
function handleTaskWizardText_(text, chatId, key, cache, state, doc, fromId) {
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var value = String(text || "").trim();
  var draft = state.draft;

  // /bekor only ever matters while a wizard session exists, which is exactly
  // when control reaches here. The accounting flow never sees it.
  if (value === "/bekor") {
    finishWizard_(cache, key);
    sendTelegramMessage_(chatId, WIZARD_CANCELLED_MESSAGE);
    return;
  }

  // A slash command is never an answer. This matters most at vz_title, where
  // it would otherwise quietly become the task's name. (/yangi never reaches
  // here — handleOmadTelegramUpdate_ claims it and restarts the session.)
  if (value.indexOf("/") === 0) {
    return repromptWizard_(state, chatId, key, cache, "Buyruq o'rniga javob kiriting yoki /bekor bilan to'xtating.");
  }

  switch (state.step) {
    case "vz_title":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Sarlavha bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_TITLE) {
        return repromptWizard_(state, chatId, key, cache, "Sarlavha juda uzun (" + WIZARD_MAX_TITLE + " belgigacha).");
      }
      draft.title = value;
      return advanceWizard_(state, "vz_title", chatId, key, cache, 0, doc);

    case "vz_desc":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Tavsif bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_DESC) {
        return repromptWizard_(state, chatId, key, cache, "Tavsif juda uzun (" + WIZARD_MAX_DESC + " belgigacha).");
      }
      draft.description = value;
      return advanceWizard_(state, "vz_desc", chatId, key, cache, 0, doc);

    case "vz_resp_text":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Ism bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_NAME) {
        return repromptWizard_(state, chatId, key, cache, "Ism juda uzun.");
      }
      draft.responsible = value;
      return advanceWizard_(state, "vz_resp_text", chatId, key, cache, 0, doc);

    case "vz_date_text":
      var deadline = wizardParseDate_(value);
      if (!deadline) return repromptWizard_(state, chatId, key, cache, "Sana noto'g'ri.");
      draft.deadlineKey = deadline;
      return advanceWizard_(state, "vz_date", chatId, key, cache, 0, doc);

    case "vz_time_text":
      var deadlineTime = wizardParseTime_(value);
      if (!deadlineTime) return repromptWizard_(state, chatId, key, cache, "Vaqt noto'g'ri.");
      draft.deadlineTime = deadlineTime;
      return advanceWizard_(state, "vz_time", chatId, key, cache, 0, doc);

    case "vz_monthday_text":
      var day = Number(value);
      if (!isFinite(day) || day < 1 || day > 31) {
        return repromptWizard_(state, chatId, key, cache, "Kun 1 dan 31 gacha bo'lishi kerak.");
      }
      draft.recurrence.monthDay = Math.floor(day);
      return advanceWizard_(state, "vz_monthday", chatId, key, cache, 0, doc);

    case "vz_interval":
      var days = Number(value);
      if (!isFinite(days) || days < 1) {
        return repromptWizard_(state, chatId, key, cache, "Kamida 1 kun bo'lishi kerak.");
      }
      draft.recurrence.intervalDays = Math.floor(days);
      return advanceWizard_(state, "vz_interval", chatId, key, cache, 0, doc);

    case "vz_start_text":
      var startKey = wizardParseDate_(value);
      if (!startKey) return repromptWizard_(state, chatId, key, cache, "Sana noto'g'ri.");
      draft.startKey = startKey;
      return advanceWizard_(state, "vz_start", chatId, key, cache, 0, doc);

    case "vz_end_text":
      var endKey = wizardParseDate_(value);
      if (!endKey) return repromptWizard_(state, chatId, key, cache, "Sana noto'g'ri.");
      if (draft.startKey && endKey < draft.startKey) {
        return repromptWizard_(state, chatId, key, cache, "Tugash sanasi boshlanish sanasidan oldin.");
      }
      draft.endKey = endKey;
      return advanceWizard_(state, "vz_end", chatId, key, cache, 0, doc);

    case "vz_duetime_text":
      var dueTime = wizardParseTime_(value);
      if (!dueTime) return repromptWizard_(state, chatId, key, cache, "Vaqt noto'g'ri.");
      draft.dueTime = dueTime;
      return advanceWizard_(state, "vz_duetime", chatId, key, cache, 0, doc);

    case "vz_rem_text":
      var reminder = wizardParseTime_(value);
      if (!reminder) return repromptWizard_(state, chatId, key, cache, "Vaqt noto'g'ri.");
      if (draft.reminderTimes.indexOf(reminder) === -1) draft.reminderTimes.push(reminder);
      draft.reminderTimes.sort();
      state.step = "vz_reminders";
      return renderWizardStep_(state, chatId, key, cache, 0);

    case "vz_steps":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Bosqich nomi bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_TITLE) {
        return repromptWizard_(state, chatId, key, cache, "Bosqich nomi juda uzun.");
      }
      if (draft.steps.length >= WIZARD_MAX_STEPS) {
        return repromptWizard_(state, chatId, key, cache, "Bosqichlar soni chegarasi: " + WIZARD_MAX_STEPS + ".");
      }
      draft.steps.push(value);
      return renderWizardStep_(state, chatId, key, cache, 0);
  }

  // Text arrived at a button-only step: re-send the step rather than swallow it.
  return repromptWizard_(state, chatId, key, cache, "Quyidagi tugmalardan birini tanlang.");
}

// -------------------------------------------------------------------- saving

/** The web-API payload the draft describes. */
function wizardTaskPayload_(draft, fromId, requestId) {
  var payload = {
    type: draft.type,
    title: draft.title,
    description: draft.description,
    responsible: draft.responsible,
    priority: draft.priority,
    photoRequired: draft.photoRequired,
    reminderTimes: draft.reminderTimes,
    createdBy: ("telegram:" + fromId).slice(0, 60),
    meta: { source: "telegram", tgRequestId: requestId }
  };

  if (draft.type === "once") {
    payload.deadlineKey = draft.deadlineKey;
    payload.deadlineTime = draft.deadlineTime;
    // A dated task carries the answer given at vz_remdaily; a deadline-less one
    // has no deadline day to attach a reminder to, so its times can only mean
    // "every day until it is done". Never inferred for a dated task.
    payload.remindDaily = wizardRemindDaily_(draft);
  } else if (draft.type === "routine") {
    payload.recurrence = draft.recurrence;
    payload.startKey = draft.startKey;
    payload.endKey = draft.endKey;
    payload.dueTime = draft.dueTime;
  } else {
    payload.steps = draft.steps;
  }
  return payload;
}

/**
 * The durable half of the idempotency story.
 *
 * Tasks have no Request_ID column, so the conversation's id is carried in
 * Meta_JSON instead. This is what catches a redelivery that arrives after the
 * task was written but before the session could be removed.
 */
function findTaskByTelegramRequestId_(doc, requestId) {
  if (!requestId) return null;
  var rows = readTaskRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].meta && String(rows[i].meta.tgRequestId || "") === String(requestId)) return rows[i];
  }
  return null;
}

/**
 * Creates the task, exactly once.
 *
 * Two layers do the work. The script lock serialises concurrent deliveries, so
 * a second one only ever runs after the first has finished; it then finds the
 * task by the conversation's request id and reports the same success instead of
 * creating a second. Removing the session on success turns every later
 * redelivery into an ordinary expiry.
 *
 * There is deliberately no "currently saving" flag. Under the lock it could
 * only ever be observed by a delivery arriving after a run died mid-save — and
 * in the sub-case where that matters (died before the row was written) refusing
 * to retry is worse than retrying, because the retry is what finally creates
 * the task the user asked for.
 */
function handleWizardSave_(state, chatId, key, cache, doc, fromId) {
  var requestId = "tg_" + fromId + "_" + state.sessionId;
  var payload = wizardTaskPayload_(state.draft, fromId, requestId);

  if (state.msgId) {
    editTelegramMessage_(chatId, state.msgId, "⏳ Saqlanmoqda...", { inline_keyboard: [] });
  }

  var taskId = "";
  var duplicate = false;
  var gone = false;
  var failure = "";

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockError) {
    // Busy, not broken: the draft is intact and pressing again works.
    return repromptWizard_(state, chatId, key, cache, "⏳ Tizim band. Biroz kutib, qayta urinib ko'ring.");
  }
  try {
    // The durable key is checked first: it is the only test that still works
    // after the session has gone.
    var already = findTaskByTelegramRequestId_(doc, requestId);
    if (already) {
      taskId = already.id;
      duplicate = true;
    } else {
      var fresh = readWizardState_(cache, key);
      if (!fresh) {
        gone = true;
      } else {
        var result = saveTaskAction_(doc, payload);
        if (result.status === "success") {
          taskId = result.taskId;
        } else {
          // The draft survives, so the user can fix it or cancel.
          failure = String(result.message || "Saqlanmadi.");
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (failure) {
    state.step = "vz_confirm";
    return repromptWizard_(state, chatId, key, cache, "⚠️ " + failure);
  }
  if (gone || !taskId) {
    if (state.msgId) editTelegramMessage_(chatId, state.msgId, WIZARD_EXPIRED_MESSAGE, { inline_keyboard: [] });
    return;
  }

  finishWizard_(cache, key);
  if (!duplicate) {
    // saveTaskAction_'s own audit row records only the id and type, and
    // createdBy has until now always been the literal "admin".
    appendAuditRow_(doc, "task_created_via_telegram", taskId + " by:" + fromId);
  }

  // runTaskScheduler_ takes the script lock itself, so announcing happens after
  // releaseLock() — never nested. Re-announcing a duplicate is harmless: the
  // scheduler only announces occurrences whose Notified_At is still empty,
  // which is exactly the "saved but died before announcing" case.
  try {
    runTaskScheduler_(doc, Date.now());
  } catch (error) {
    debugLog_(doc, "task_wizard_schedule_failed", String(error));
  }
  drainJobQueueQuietly_(doc, null);

  if (state.msgId) {
    // "yuboriladi" (will be sent), never "yuborildi" (was sent): only one job
    // drains inline, a future-dated routine announces nothing today, and with
    // no Tasks group configured the card never goes out at all.
    editTelegramMessage_(chatId, state.msgId, "✅ Vazifa yaratildi va guruhga yuboriladi.", { inline_keyboard: [] });
  }
}
