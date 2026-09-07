# Triage labels

| Skill role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer evaluation |
| `needs-info` | `needs-info` | Awaiting reporter information |
| `ready-for-agent` | `ready-for-agent` | Specified for an autonomous agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

Wayfinder uses `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, and `wayfinder:task` on the same tracker.
Verify provisioning with `env -u GITHUB_TOKEN gh label list --repo varity-labs/varity-mcp --limit 1000`.
Preserve existing label meanings; a missing configured label is a setup gap, not a substitute role.
