# RaveFold

A modern browser reinterpretation of OG, built around sample composition at 180
BPM in C minor.

This workspace currently contains planning documents and a project skill. There
is no application or build command yet.

Machine-specific source paths are private. Configure `APP_INSTALL_DIR` and
`SAMPLES_DIR` only in the ignored `.env.local`. These are local tooling inputs,
not browser configuration. Do not expose their values through client environment
variables, documentation, logs, manifests, or public assets.

- [Product requirements](PRODUCT.md): confirmed user decisions.
- [Delivery plan](docs/plan.md): experience, architecture, import rules,
  milestones, acceptance checks, and proposed defaults.
- [Private research](docs/research.md): exact technology requirements, reference
  skins, source evidence and attribution. This file is ignored and is available
  only in the local workspace. Public copies of this workspace will not include
  it.

Run `npm run quality:quick` to check Markdown with markdownlint and check
formatting with Prettier. The gate runs both checks and fails if either reports
an issue.
