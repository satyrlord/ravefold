# RaveFold

## Platform

web

## Stack

The component framework and material UI library identified in
[the private technology specification](docs/research.md#binding-technology-requirements)
are fixed user requirements. Their names are private. Other dependencies remain
proposals in [the delivery plan](docs/plan.md).

## Product purpose

RaveFold is a modern browser reinterpretation of OG. It should make sample-based
rave composition direct and approachable.

## Confirmed constraints

- The application is called RaveFold.
- The project tempo is 180 BPM and the musical key is C minor.
- Ready rhythmic samples have a tempo of 90 or 180 BPM.
- Imports at every other tempo must be converted to 90 or 180 BPM before use.
  The user explicitly confirmed this includes other multiples of 45 BPM.
- Required time stretching and pitch shifting run asynchronously in the
  background. A sample becomes ready only after processing succeeds.
- Major or mixed-key imports remain in review. Only compatible sections can
  become ready in the first release; note-level mode conversion is outside it.
- The interface uses the required framework and UI library, with all six
  reference skins defined in the private technology specification.
- Local installation and sample sources are configured privately in
  `.env.local`. Machine-specific paths must stay out of project documentation
  and browser bundles.

## Evidence and boundaries

OG and dependency references are recorded in
[the private research notes](docs/research.md). Local source files are reference
inputs; this planning task does not alter or redistribute them.

Refer to the original software only as OG in public documents. Keep third-party
names, source URLs, exact attributions and private asset findings in the ignored
research file. Required license notices must still accompany any future
dependency or copied material as its terms require; documentation cleanup does
not remove those obligations.

The current deliverable is a plan. Application implementation has not started.

## Open product decisions

The plan labels proposed audience, release scope, browser baseline, and
treatment of non-tonal audio. Those proposals do not become confirmed user
requirements merely by appearing in the plan.
