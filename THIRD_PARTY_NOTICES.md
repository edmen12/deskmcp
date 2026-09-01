# Third-Party Notices

This notice is generated from the actual Windows x64 release stage for DeskMCP 0.9.3. DeskMCP itself is licensed under Apache License 2.0; see the repository root `LICENSE`. Third-party components retain the licenses documented below.

## Bundled runtimes and major components

- **Node.js 24.19.0** — distributed with its upstream `node/LICENSE`, which includes Node.js and bundled third-party notices.
- **.NET 10 Windows x64 self-contained runtime** — the release carries `licenses/dotnet/LICENSE.txt` and `licenses/dotnet/ThirdPartyNotices.txt` copied from the exact SDK used to publish the desktop application.
- **OpenAI tunnel-client v0.0.13** — Apache-2.0; its upstream `LICENSE`, `NOTICE`, third-party licenses text, and SPDX document remain under `tunnel-client/v0.0.13/bin/`.
- **Desktop Commander MCP 0.2.47** — MIT. Its package-local license remains in the bundled production `node_modules`.
- **sharp-win32-x64 0.35.4** — package metadata declares Apache-2.0 AND LGPL-3.0-or-later. Its package-local LICENSE and README, including the bundled libvips/native-library license table, remain in the release.

## Manual license resolution

### buffers 0.1.1

The npm package metadata does not declare a license and the published tarball contains no LICENSE file. Debian's reviewed source record for node-buffers 0.1.1-2 identifies the upstream package as MIT and links the upstream commit that added the declaration. A copy of that MIT notice is included as `licenses/buffers-0.1.1-MIT.txt`.

Evidence:
- https://www.npmjs.com/package/buffers
- https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/
- https://github.com/substack/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87

## Production Node package inventory

The complete machine-generated inventory is `licenses/production-node-packages.csv`. It records package name, version, resolved license expression, package-local license files, and its path inside the target release stage.

Package/license counts for this stage:
- MIT: 431
- ISC: 32
- Apache-2.0: 10
- BSD-3-Clause: 7
- BSD-2-Clause: 4
- BlueOak-1.0.0: 4
- MIT/X11: 2
- (MIT AND Zlib): 2
- 0BSD: 2
- Apache-2.0 AND LGPL-3.0-or-later: 1
- Python-2.0: 1
- Unlicense: 1
- MIT (manual resolution): 1
- (MIT OR GPL-3.0-or-later): 1
- (WTFPL OR MIT): 1
- (MIT OR GPL-3.0): 1

For `jszip` and `pizzip`, this distribution elects the MIT option expressly offered by their dual-license files.

License expressions requiring special attention or explicit choice:
- `@img/sharp-win32-x64@0.35.4` — Apache-2.0 AND LGPL-3.0-or-later; files: LICENSE
- `buffers@0.1.1` — MIT (manual resolution)
- `jszip@3.10.1` — (MIT OR GPL-3.0-or-later); files: LICENSE.markdown
- `pizzip@3.2.0` — (MIT OR GPL-3.0); files: LICENSE.markdown

## Preservation rule

Do not strip package-local LICENSE, NOTICE, COPYING, COPYRIGHT, README license tables, Node's LICENSE, platform runtime notices, or tunnel-client notice/SPDX files when optimizing a release payload.
