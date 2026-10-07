# DeskMCP vendor patch provenance

- Upstream package: @wonderwhy-er/desktop-commander
- Upstream version: 0.2.52
- Upstream npm integrity: sha512-VNeKfaBR6TN/8MlP/ziTpjNEeHrGOFmmzQjrwzr52kQalBJoNNISWwaSQElPFc6+I17NOOM354KbSdS/aDrqGA==
- Upstream tarball: https://registry.npmjs.org/@wonderwhy-er/desktop-commander/-/desktop-commander-0.2.52.tgz

DeskMCP patch:
- The vendored runtime starts from the upstream 0.2.52 published dist.
- dist/tools/pdf/markdown.js replaces md-to-pdf with markdown-it + playwright-core while preserving Chrome discovery/cache/install behavior through an explicit @puppeteer/browsers dependency.
- dist/tools/schemas.js updates the stale md-to-pdf option comment only.
- md-to-pdf is removed from the dependency manifest, eliminating its vulnerable chokidar/gray-matter/js-yaml chain.
- sharp is pinned from the upstream ^0.34.5 range to security-fixed 0.35.5.
- Upstream development/build scripts and devDependencies are omitted because this vendored package contains published runtime output only; DeskMCP never rebuilds the third-party package.
- The patched Markdown-to-PDF path is verified by generating a real PDF with system Chrome during DeskMCP release validation.
