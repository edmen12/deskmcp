# Project License Decision

## Decision

**DeskMCP uses Apache License 2.0.** The canonical license text is in the repository root `LICENSE`. The comparison below is retained as the decision record.

## MIT

- Very short and permissive.
- Allows commercial use, modification, redistribution, and sublicensing.
- Requires preserving the copyright and permission notice.
- Does not include an explicit patent license.
- Best fit when the priority is maximum simplicity and low contributor friction.

## Apache License 2.0

- Also permissive and commercial-friendly.
- Includes an explicit patent grant and patent-termination terms.
- Requires preserving the license and applicable NOTICE information.
- Longer and more formal than MIT.
- Best fit when explicit patent terms are important.

## Third-party dependencies

The project license choice does not replace third-party licenses. `jszip` and `pizzip` expressly offer an MIT option and this distribution elects MIT for them. `sharp`/libvips and all other bundled components keep their own notices and obligations as documented in `THIRD_PARTY_NOTICES.md`.

## Owner decision

Decision completed: **Apache License 2.0**.
