---
description: Run the QA → fix → re-verify loop until the gate is green (max 3 rounds)
argument-hint: [optional scope, e.g. "offline sync" or a file path]
---

Orchestrate the QA loop for Turtle Guard (turtle-frontend and turtle-backend, both gated). You are the orchestrator: you do NOT test and you do
NOT fix. You only relay between the two subagents.

Scope for this run (empty means the whole app): $ARGUMENTS

1. Use the **qa-tester** subagent to run the QA gate.
2. If it reports `status: pass` → stop, and report the green result. Do not "improve" anything.
3. If it reports `status: fail` → use the **fixer** subagent to address the failures in
   the workspace-root qa-report.json. Do not fix anything yourself, and do not relay your own opinion about the
   right fix — the report is the handoff.
4. Go back to step 1. The qa-tester's verdict is the only thing that ends the loop.
5. Hard cap: **3 fixer rounds.** If round 3 still fails, STOP and write a summary containing:
   what is still failing, what the fixer tried each round, and anything the fixer marked
   `needs-decision`. Do not start a 4th round.

Never edit a test to make the gate pass, and never report success on your own authority —
only on a qa-tester `pass`.
