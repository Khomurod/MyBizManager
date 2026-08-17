#!/usr/bin/env python3
from pathlib import Path
import os
import sys

root = Path(__file__).resolve().parents[1]
old = root / 'scripts' / 'run_app_perf_pass_fixed.py'
runtime = root / 'scripts' / 'run_app_perf_pass_runtime.py'
text = old.read_text()

start = "new_19b = r'''write('apps-script/19b_tasks_write_performance.gs', r'''"
end = "''')'''\n\npattern_19b ="
if text.count(start) != 1 or text.count(end) != 1:
    raise RuntimeError('temporary runner quote markers changed unexpectedly')
text = text.replace(start, "new_19b = r\"\"\"write('apps-script/19b_tasks_write_performance.gs', r'''", 1)
text = text.replace(end, "''')\"\"\"\n\npattern_19b =", 1)
runtime.write_text(text)

# These are branch-only patch tools. Remove their source copies before handing
# control to the runtime; the runtime deletes itself after patching the real
# driver, and the real driver deletes its own workflow/tooling after green.
old.unlink()
Path(__file__).unlink()
os.execv(sys.executable, [sys.executable, str(runtime)])
