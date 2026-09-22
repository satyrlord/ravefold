---
name: grill-me
description: Challenge a RaveFold plan one unresolved decision at a time. Use when the user asks for a decision interview before implementation.
---

# Challenge a plan one decision at a time

Read applicable AGENTS.md instructions, the [RaveFold plan](../../../docs/plan.md),
the [private research evidence](../../../docs/research.md), and relevant code and tests.
Check current primary sources where needed. Resolve facts from these sources before
asking the user. Distinguish observed behavior, proposed behavior, and unknowns.

Respect settled requirements unless the user changes them: RaveFold runs in a modern
browser, uses the framework and UI library fixed in the
[private specification](../../../docs/research.md#binding-technology-requirements),
and includes all six reference skins. The arrangement
runs at 180 BPM in C minor. Ready rhythmic samples support only 90 or 180 BPM. Convert all
other source tempos, including other multiples of 45 BPM, to 90 or 180 BPM. Perform
required tempo stretching and pitch shifting asynchronously before a sample is ready.
Do not ask the user to reconfirm these choices.

Major or mixed-key imports remain in review; only compatible sections can become
ready in the first release. The non-tonal and free one-shot policy remains an
open choice in the plan. Keep machine-specific source paths in the ignored
`.env.local`. Refer to their variable names in documents and reports; do not copy
values into browser configuration, generated catalogs, archives or logs.

Refer to the original software only as OG in public documents. Keep third-party
names, exact source links, attribution and asset findings in the ignored private
research file. Preserve license obligations. If that file is absent, continue
source-independent decisions and identify which source-dependent decisions lack
evidence; do not guess or silently replace the required stack or skin definitions.

List unresolved choices and order them by dependency and cost of reversal. Consider
arranger interaction, musical timing, audio scheduling, sample import, tempo and key
analysis, digital signal processing (DSP), persistence, browser support, six-skin
consistency, accessibility, and verification when relevant. Prefer reversible defaults
for choices that do not block the design. Inspect the local installation or sample
library when it can answer a factual question; do not treat local availability as
permission to redistribute those assets.

For one active choice, state the evidence gap. Give two or three distinct options when
useful, explain their effects, recommend one with a concrete verification step, and
ask one decision question. Record the answer and its dependent choices before moving
on. Reopen a settled choice only when new evidence conflicts with it.

Use existing authorization for documentation edits. When authorized, update the
owning section of the plan and any conflicting guidance. Otherwise keep the interview
read-only and report the exact change needed. Implement only when the user requests
implementation; an interview does not expand the authorized scope.

Finish when the user resolves or explicitly defers each identified choice. Name the
owner and next verification step for each deferral.
