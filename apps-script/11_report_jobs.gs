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

  // One pass over the ledger for both the group and the balances.
  var all = readOmadTransactions_(doc);
  var group = resolveReportGroupFrom_(all, job.payload);
  if (group.length === 0) {
    // The group was deleted before the report went out. Nothing to report.
    return;
  }

  // The resolved period, not the raw Month cell: balances are compared against
  // resolved periods, so passing "Avgust" (or a date cell) matched nothing and
  // every report quoted a month balance of 0.
  var balances = calculateBalancesFromTransactions_(all, transactionPeriod_(group[0]));
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
/**
 * The rows a report is about, picked out of a list already in memory.
 *
 * This used to fetch them itself, and the caller then read the whole ledger
 * again to compute the balances -- two full passes over every transaction ever
 * recorded, for every report, and a report is queued for every entry.
 */
function resolveReportGroupFrom_(all, payload) {
  var groupId = String((payload && payload.groupId) || "");
  var group = [];
  var i;

  if (groupId) {
    for (i = 0; i < all.length; i++) {
      if (String(all[i].groupId || "") === groupId) group.push(all[i]);
    }
    if (group.length > 0) return group;
  }

  var baseId = String((payload && payload.baseId) || "");
  if (!baseId) return [];
  var prefix = baseId + "_";
  for (i = 0; i < all.length; i++) {
    var id = String(all[i].id || "");
    if (id === baseId || id.indexOf(prefix) === 0) group.push(all[i]);
  }
  return group;
}

/**
 * Stamps the group's Telegram message id onto every row of the group.
 *
 * One pass over the sheet for the whole group, not one per row.
 * `updateOmadTransactionMsgId_` reads the entire sheet to find its row, so
 * calling it in a loop cost a full read per line -- two for a tenant-paid
 * pair, on every report, on top of the read that composed it.
 */
function applyMsgIdToGroup_(doc, group, messageId) {
  if (!messageId || !group || group.length === 0) return;

  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName);
  if (!txSheet || txSheet.getLastRow() < 2) return;

  var column = sheetName === OMAD_TRANSACTIONS_V2_SHEET ? 21 : 10;
  var g;

  // The ledger reader already carries each row's position, so the rows this
  // report was composed from can be written to directly -- no second pass over
  // the sheet at all.
  var known = 0;
  for (g = 0; g < group.length; g++) if (group[g].rowNumber) known++;
  if (known === group.length) {
    for (g = 0; g < group.length; g++) {
      txSheet.getRange(group[g].rowNumber, column).setValue(messageId);
    }
    return;
  }

  // The legacy reader does not, so those rows are found in one pass for the
  // whole group rather than one pass per row.
  var wanted = {};
  for (g = 0; g < group.length; g++) wanted[String(group[g].id)] = true;

  var data = txSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (wanted[String(data[i][0])]) txSheet.getRange(i + 1, column).setValue(messageId);
  }
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
