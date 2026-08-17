// ============================================================
// Café write performance
// ------------------------------------------------------------
// A sale retry needs only the request id stored inside receipt details. Reading
// every column of every historical sale before each new sale made the till
// progressively slower as history grew.
// ============================================================

/**
 * Fast stock-movement duplicate detection.
 *
 * A purchase, a spillage or a correction is idempotent on `requestId`, which
 * lives in the last column. The old lookup read all twelve columns of every
 * movement ever recorded before applying one, so recording stock got slower for
 * ever — and it runs under the script lock, which the till also needs.
 *
 * The full row is still returned for the exact match, because the caller reads
 * it. Blank ids never match: an empty `requestId` is refused before this runs,
 * and a row with none is not a retry of anything.
 */
var findCafeMovementByRequestIdBeforeWritePerf_ = findCafeMovementByRequestId_;
findCafeMovementByRequestId_ = function (sheet, requestId) {
  var wanted = String(requestId || "");
  if (!sheet || !wanted || sheet.getLastRow() < 2) return null;

  var lastRow = sheet.getLastRow();
  var column = CAFE_MOVEMENTS_HEADER.length;
  var idRange = sheet.getRange(2, column, lastRow - 1, 1);
  var rowNumber = 0;

  // Production Sheets can find the cell without transferring even the one
  // column; the test harness has no TextFinder, so the bounded one-column
  // fallback keeps the behaviour identical everywhere. Request ids are
  // case-sensitive strings, so TextFinder is held to that rule.
  if (typeof idRange.createTextFinder === "function") {
    var finder = idRange.createTextFinder(wanted).matchEntireCell(true);
    if (typeof finder.matchCase === "function") finder.matchCase(true);
    var matches = finder.findAll();
    for (var m = 0; m < matches.length; m++) {
      var candidate = matches[m].getRow();
      if (!rowNumber || candidate < rowNumber) rowNumber = candidate;
    }
  } else {
    var ids = idRange.getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) !== wanted) continue;
      rowNumber = i + 2;
      break;
    }
  }

  if (!rowNumber) return null;
  return {
    rowNumber: rowNumber,
    row: sheet.getRange(rowNumber, 1, 1, CAFE_MOVEMENTS_HEADER.length).getValues()[0]
  };
};

/**
 * Only the movements a screen is going to show.
 *
 * The answer was always the last `limit` rows; it just used to arrive by reading
 * the whole history and throwing all but the tail away. The tail is the same
 * tail, and `total` is still the count of every movement recorded.
 */
var readCafeStockMovementsBeforeWritePerf_ = readCafeStockMovements_;
readCafeStockMovements_ = function (doc, limit) {
  var sheet = doc.getSheetByName(CAFE_MOVEMENTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { rows: [], total: 0 };

  var want = Math.min(200, Math.max(1, Number(limit) || CAFE_MOVEMENTS_PAGE));
  var lastRow = sheet.getLastRow();
  var total = lastRow - 1;
  var take = Math.min(want, total);
  var startRow = lastRow - take + 1;
  var data = sheet.getRange(startRow, 1, take, CAFE_MOVEMENTS_HEADER.length).getValues();

  var rows = [];
  for (var i = 0; i < data.length; i++) {
    rows.push({
      date: data[i][0], direction: String(data[i][1] || ""), reason: String(data[i][2] || ""),
      reasonLabel: CAFE_MOVEMENT_REASONS[String(data[i][2] || "")] || String(data[i][2] || ""),
      inventoryId: String(data[i][3] || ""), name: String(data[i][4] || ""),
      qty: Number(data[i][5]) || 0, unit: String(data[i][6] || ""),
      cost: Number(data[i][7]) || 0, remaining: Number(data[i][8]) || 0,
      note: String(data[i][9] || ""), by: String(data[i][10] || "")
    });
  }
  rows.reverse();
  return { rows: rows, total: total };
};

var findCafeSaleByRequestIdBeforeWritePerf_ = findCafeSaleByRequestId_;
findCafeSaleByRequestId_ = function (salesSheet, requestId) {
  var wanted = String(requestId || "");
  if (!salesSheet || !wanted || salesSheet.getLastRow() < 2) return null;

  var lastRow = salesSheet.getLastRow();
  var detailValues = salesSheet.getRange(2, 5, lastRow - 1, 1).getValues();
  var needle = '"requestId":' + JSON.stringify(wanted);

  for (var i = 0; i < detailValues.length; i++) {
    var rawDetail = detailValues[i][0];
    var rawText = typeof rawDetail === "string" ? rawDetail : String(rawDetail || "");
    if (rawText.indexOf(needle) === -1) continue;

    var detail = safeParseJSON_(rawDetail, null);
    if (!detail || String(detail.requestId || "") !== wanted) continue;

    var rowNumber = i + 2;
    var row = salesSheet.getRange(rowNumber, 1, 1, CAFE_SALES_HEADER.length).getValues()[0];
    return { rowNumber: rowNumber, row: row, detail: detail };
  }
  return null;
};
