// ============================================================
// Café write performance
// ------------------------------------------------------------
// A sale retry needs only the request id stored inside receipt details. Reading
// every column of every historical sale before each new sale made the till
// progressively slower as history grew.
// ============================================================

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
