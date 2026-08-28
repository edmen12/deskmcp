## Summary

Describe what changed and why.

## Validation

- [ ] `npm test`
- [ ] `control-panel/wpf/validate.ps1`
- [ ] Secret hygiene scan passes
- [ ] No real API keys, Tunnel keys, private paths, or user data added

## Security impact

- [ ] No permission-boundary change
- [ ] Filesystem scope reviewed
- [ ] Process/session behavior reviewed
- [ ] Secret storage/logging reviewed

If this changes Read/Write/Full behavior, search exclusions, process ownership, Tunnel handling, or audit semantics, explain the before/after behavior here.

## UI / release impact

- [ ] No user-visible UI change
- [ ] Screenshots/docs updated when UI changed
- [ ] Third-party notices reviewed when dependencies changed
- [ ] Release notes updated when user-visible behavior changed