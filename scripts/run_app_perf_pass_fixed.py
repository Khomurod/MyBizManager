#!/usr/bin/env python3
from pathlib import Path
import os
import sys

root = Path(__file__).resolve().parents[1]
script = root / 'scripts' / 'apply_app_perf_pass.py'
text = script.read_text()

old_id = '''    var finder = idRange.createTextFinder(String(wanted)).matchEntireCell(true);\n    if (typeof finder.matchCase === "function") finder.matchCase(true);\n    var matches = finder.findAll();'''
new_id = '''    var finder = idRange.createTextFinder(String(wanted));\n    if (finder && typeof finder.matchEntireCell === "function" &&\n        typeof finder.findAll === "function") {\n      finder = finder.matchEntireCell(true);\n      if (typeof finder.matchCase === "function") finder.matchCase(true);\n      var matches = finder.findAll();'''
if text.count(old_id) != 2:
    raise RuntimeError('expected two ID TextFinder snippets, found %d' % text.count(old_id))
text = text.replace(old_id, new_id)

old_id_close = '''      if (String(row[0] || "") === wanted) return { rowNumber: rowNumber, row: row };\n    }\n    return null;\n  }\n\n  var ids = idRange.getValues();'''
new_id_close = '''      if (String(row[0] || "") === wanted) return { rowNumber: rowNumber, row: row };\n    }\n      return null;\n    }\n  }\n\n  var ids = idRange.getValues();'''
if text.count(old_id_close) != 1:
    raise RuntimeError('expected one task TextFinder closing snippet, found %d' % text.count(old_id_close))
text = text.replace(old_id_close, new_id_close)

old_ledger_close = '''      if (String(row[0] || "") === wanted) return ledgerRowToTransaction_(row, rowNumber);\n    }\n    return null;\n  }\n\n  var ids = idRange.getValues();'''
new_ledger_close = '''      if (String(row[0] || "") === wanted) return ledgerRowToTransaction_(row, rowNumber);\n    }\n      return null;\n    }\n  }\n\n  var ids = idRange.getValues();'''
if text.count(old_ledger_close) != 1:
    raise RuntimeError('expected one ledger TextFinder closing snippet, found %d' % text.count(old_ledger_close))
text = text.replace(old_ledger_close, new_ledger_close)

old_move = '''    var finder = range.createTextFinder(wanted).matchEntireCell(true);\n    if (typeof finder.matchCase === "function") finder.matchCase(true);\n    var matches = finder.findAll();'''
new_move = '''    var finder = range.createTextFinder(wanted);\n    if (finder && typeof finder.matchEntireCell === "function" &&\n        typeof finder.findAll === "function") {\n      finder = finder.matchEntireCell(true);\n      if (typeof finder.matchCase === "function") finder.matchCase(true);\n      var matches = finder.findAll();'''
if text.count(old_move) != 1:
    raise RuntimeError('expected one cafe TextFinder snippet, found %d' % text.count(old_move))
text = text.replace(old_move, new_move)

old_move_close = '''      if (String(row[requestColumn - 1] || "") === wanted) return { rowNumber: rowNumber, row: row };\n    }\n    return null;\n  }\n\n  var ids = range.getValues();'''
new_move_close = '''      if (String(row[requestColumn - 1] || "") === wanted) return { rowNumber: rowNumber, row: row };\n    }\n      return null;\n    }\n  }\n\n  var ids = range.getValues();'''
if text.count(old_move_close) != 1:
    raise RuntimeError('expected one cafe TextFinder closing snippet, found %d' % text.count(old_move_close))
text = text.replace(old_move_close, new_move_close)

script.write_text(text)
# Keep the feature branch clean: the main driver will commit this deletion with
# its other temporary-tool cleanup after all tests have passed.
Path(__file__).unlink()
os.execv(sys.executable, [sys.executable, str(script)])
