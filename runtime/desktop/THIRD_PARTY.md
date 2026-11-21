# P0 runtime third-party inventory

This prototype installs unmodified packages from Debian's signed repositories. Package copyrights and license texts remain in `/usr/share/doc/<package>/copyright` inside the image. This file is an inventory, not a replacement for those licenses or a completed redistribution review.

- Node.js Docker Official Image: default `node:22-bookworm-slim`; an alternative official publishing location used in this environment is `public.ecr.aws/docker/library/node:22-bookworm-slim` (maintained by the Node.js Docker Team). The base image and Debian packages retain their own licenses.
- Chromium, Openbox, Xvfb, x11vnc, noVNC, websockify, ImageMagick, fonts, and their dependencies: unmodified Debian packages, with the package-level licenses retained in the image.
- `deploy/compose/chromium-seccomp.json`: copied from Microsoft Playwright, `https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json`, retrieved 2026-11-19. Playwright is copyright Microsoft Corporation and contributors, licensed under Apache-2.0; upstream license: `https://github.com/microsoft/playwright/blob/main/LICENSE`. Retrieved profile SHA-256: `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`. The profile keeps a default-deny policy and permits user namespace creation for Chromium's sandbox; it does not make a shared container a multi-tenant security guarantee.

Before public release, pin the base image digest and exact runtime package set; ship the required license/NOTICE/source materials for the actual distribution. The application has not yet selected its public open-source license, and this inventory does not grant a license to third-party brands or commercial software.
