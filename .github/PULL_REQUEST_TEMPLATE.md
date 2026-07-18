## Summary

<!-- What user or operator outcome changes? -->

## Architecture impact

Architecture impact: <!-- choose none or updated -->
Reason: <!-- one concrete sentence -->
Affected runtime services/modules: <!-- names or none -->
Interfaces/data/security/topology changed: no
Architecture/ADR files: none

Choose `updated` and list the changed architecture/ADR files when ownership,
interfaces, state, credential custody, transport topology, or failure semantics
change. Implementation-only changes behind unchanged interfaces may use
`none`. The placeholder intentionally fails CI until the author chooses.

## Verification

- [ ] `npm run check:architecture`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] User-facing tool descriptions and responses match workspace positioning
      and pricing canon, if applicable
- [ ] No secret, private environment value, provider credential, or customer
      data appears in the diff or test output
