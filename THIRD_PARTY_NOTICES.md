# Third-party notices

Frameforge itself is MIT licensed (see `LICENSE`). It bundles the components below. All licenses are OSI-approved and compatible with MIT distribution. Full license texts ship inside each package (`node_modules/<pkg>/LICENSE`), in the installer's `LICENSES.chromium.html` and `LICENSE.electron.txt`, and in the upstream repositories.

## Runtime (npm, bundled into the app)

| Component                                                                       | License     |
| ------------------------------------------------------------------------------- | ----------- |
| react, react-dom, scheduler                                                     | MIT         |
| @radix-ui/\* (dialog, switch and primitives)                                    | MIT         |
| aria-hidden, get-nonce, detect-node-es                                          | MIT         |
| react-remove-scroll(-bar), react-style-singleton, use-callback-ref, use-sidecar | MIT         |
| @node-steam/vdf                                                                 | MIT         |
| zod                                                                             | MIT         |
| csstype                                                                         | MIT         |
| lucide-react (icons)                                                            | ISC         |
| tslib                                                                           | 0BSD        |
| @fontsource/space-grotesk (Space Grotesk)                                       | SIL OFL 1.1 |
| @fontsource/jetbrains-mono (JetBrains Mono)                                     | SIL OFL 1.1 |

Space Grotesk is copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk). JetBrains Mono is copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono). Both are licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The fonts are bundled unmodified and are not sold on their own.

## Application shell

| Component                                    | License                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Electron (and the bundled Chromium, Node.js) | MIT, plus Chromium's BSD-style and other permissive licenses (see `LICENSES.chromium.html`) |

## Windows helper (NuGet and runtime)

| Component                         | License |
| --------------------------------- | ------- |
| .NET 8 runtime (self-contained)   | MIT     |
| System.Management 8.0.0           | MIT     |
| System.Diagnostics.EventLog 8.0.1 | MIT     |

## Build and test only (not shipped)

Vite, Vitest, TypeScript, ESLint, Prettier, Playwright, Tailwind CSS, electron-builder, xUnit and similar tooling are used at build time only and are not distributed in the installer.
