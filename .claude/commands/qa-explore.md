---
description: Exploratory QA from a plain-English charter — find bugs, fix them, verify with the gate
argument-hint: <what to test> [--read-only]
---

Charter: $ARGUMENTS

You are the orchestrator. You do not explore, you do not fix, and you do not judge whether the
app works — three subagents do those things and you relay between them.

If the charter above is empty, ask the user what to test. Do not invent one.

1. **Explore.** Use the **qa-explorer** subagent with the charter verbatim. The backend is a
   QA database, so the run may write; pass `--read-only` through if the charter contains it and
   say which mode the run is in. When the run wrote anything, surface the report's `wrote` list
   to the user at the end so they can clear those records when they want to.
2. If it reports `status: pass` with no findings → stop. Report what was covered. Do not go
   looking for something to fix.
3. **Triage before fixing.** Show the user the findings, worst first, and ask which to fix if
   any are `low` severity or the explorer marked `reproducible: false`. Fix `high` severity
   findings without asking.
4. **Fix.** Use the **fixer** subagent on the agreed findings. It reads the same
   `qa-report.json`. It may not touch the regression tests the explorer wrote — those are the
   specification for this round.
5. **Verify.** Use the **qa-tester** subagent to run the full gate on both projects. The new
   regression tests are now part of it, so a green gate means both "the bug is fixed" and
   "nothing else broke". Only a qa-tester `pass` ends the loop.
6. If the gate fails → back to step 4. Hard cap **3 fixer rounds**, then stop and summarise
   what is still failing and anything marked `needs-decision`.
7. Finally, use **qa-explorer** once more to re-walk only the charter's failing paths and
   confirm the fix holds in the real UI. A unit test passing is not the same as the flow
   working — that gap is why the explorer exists.

Never let a subagent's confidence substitute for the gate, and never report success on your
own authority.
