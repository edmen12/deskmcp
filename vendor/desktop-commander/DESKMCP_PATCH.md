# DeskMCP vendor patch provenance

- Upstream package: @wonderwhy-er/desktop-commander
- Upstream version: 0.2.52
- Upstream npm integrity: sha512-VNeKfaBR6TN/8MlP/ziTpjNEeHrGOFmmzQjrwzr52kQalBJoNNISWwaSQElPFc6+I17NOOM354KbSdS/aDrqGA==
- Upstream tarball: https://registry.npmjs.org/@wonderwhy-er/desktop-commander/-/desktop-commander-0.2.52.tgz

DeskMCP patch:
- Published dist bytes are copied unchanged from the verified installed upstream package.
- md-to-pdf is removed from the vendored package dependency manifest.
- sharp is pinned from the upstream ^0.34.5 range to security-fixed 0.35.5; published Desktop Commander dist bytes remain unchanged.
- Fresh repository-wide search of the upstream published dist found zero references to md-to-pdf, gray-matter, or chokidar.
- The removed dependency pulled an unused vulnerable chain into the production closure and prevented the zero-vulnerability release gate from passing.
- Upstream development/build scripts and devDependencies are omitted because this vendored package contains published runtime output only; DeskMCP never rebuilds the third-party package.