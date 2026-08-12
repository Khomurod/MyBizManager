// ============================================================
// Business report jobs
// ------------------------------------------------------------
// The browser submits a business operation. The message text is composed here,
// on the server, from data the server already stored.
// ============================================================

function queueOmadTransactionReport_(doc, report) {
  if (!report || typeof report !== "object") return "";
  var operation = String(report.operation || "");
  if (operation === "transaction_delete") {
    if (!report.messageId) return "";
    return enqueueJob_(doc, "omad_transaction_delete_report", String(report.baseId || ""), {
      messageId: String(report.messageId)
    });
  }
  if (operation === "transaction_upsert") {
    var groupId = String(report.groupId || "");
    var baseId = String(report.baseId || "");
    if (!groupId && !baseId) return "";
    return enqueueJob_(doc, "omad_transaction_report", groupId || baseId, {
      // The group id is what the report resolves against. baseId rides along so
      // a job queued by an older client — or one already on the queue across a
      // deploy — still finds its rows.
      groupId: groupId,
      baseId: baseId,
      messageId: report.messageId ? String(report.messageId) : ""
    });
  }
  return "";
}

function runOmadTransactionReportJob_(doc, job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");

  var group = resolveReportGroup_(doc, job.payload);
  if (group.length === 0) {
    // The group was deleted before the report went out. Nothing to report.
    return;
  }

  // The resolved period, not the raw Month cell: balances are compared against
  // resolved periods, so passing "Avgust" (or a date cell) matched nothing and
  // every report quoted a month balance of 0.
  var balances = calculateBalancesFromTransactions_(
    readOmadTransactions_(doc), transactionPeriod_(group[0]));
  // The linked pair is one business action and gets one message that says so.
  // The kind is read off the stored rows rather than the job payload, so a
  // report re-sent after an edit always describes what the data now is.
  var text = isTenantPaidGroup_(group)
    ? buildTenantPaidReportMessage_(group, balances)
    : buildOmadGroupReportMessage_(group, balances);
  var existingMessageId = String(job.payload.messageId || group[0].msgId || "");

  if (existingMessageId) {
    editTelegramMessage_(chatId, existingMessageId, text);
    applyMsgIdToGroup_(doc, group, existingMessageId);
    return;
  }

  var response = sendTelegramMessage_(chatId, text);
  var newMessageId = extractTelegramMessageId_(response);
  if (newMessageId) applyMsgIdToGroup_(doc, group, newMessageId);
}

/**
 * The rows a report job covers.
 *
 * Stored group id first, because that is the grouping the data actually
 * asserts. The id-prefix fallback is only for jobs enqueued before the column
 * existed, which can still be sitting on the queue when this deploys.
 */
function resolveReportGroup_(doc, payload) {
  var groupId = String((payload && payload.groupId) || "");
  if (groupId) {
    var byGroup = findTransactionsByGroupId_(doc, groupId);
    if (byGroup.length > 0) return byGroup;
  }
  var baseId = String((payload && payload.baseId) || "");
  return baseId ? findTransactionGroup_(doc, baseId) : [];
}

function applyMsgIdToGroup_(doc, group, messageId) {
  for (var i = 0; i < group.length; i++) updateOmadTransactionMsgId_(doc, group[i].id, messageId);
}

/**
 * Removes a group report.
 *
 * Deleting is a statement about the end state, not about who got there first:
 * if the message is already gone the job has nothing left to do and is done.
 * Retrying that forever only produced a permanently failed queue entry, which
 * is what happened when one deletion was requested twice.
 */
function runOmadDeleteReportJob_(job) {
  var messageId = String((job.payload && job.payload.messageId) || "");
  if (!messageId) return;

  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");

  deleteTelegramMessageIfPresent_(chatId, messageId);
}

function queueCafeCloseDayReport_(doc, payload) {
  return enqueueJob_(doc, "cafe_close_day_report", "", {
    date: String(payload.date || ""),
    seller: String(payload.seller || "").slice(0, TELEGRAM_MAX_FIELD_LENGTH),
    totalRevenue: Number(payload.totalRevenue) || 0,
    totalProfit: Number(payload.totalProfit) || 0,
    summary: Array.isArray(payload.summary) ? payload.summary.slice(0, 200) : [],
    soldItems: Array.isArray(payload.soldItems) ? payload.soldItems.slice(0, 200) : []
  });
}

function runCafeCloseDayReportJob_(job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");
  var text = buildCafeCloseDayMessage_(job.payload);
  sendTelegramMessage_(chatId, text, null, "HTML");
}
