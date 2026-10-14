# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org). (This statement applies once the project is approved and releases are signed. Until then releases are unsigned.)

## What is signed

Only release artifacts built from this repository's source by the GitHub Actions workflow `.github/workflows/release.yml` are submitted for signing: the Frameforge installer (`Frameforge-Setup-<version>.exe`). Artifacts are never built or signed on a developer machine.

## Team roles

| Role      | Member                                          |
| --------- | ----------------------------------------------- |
| Author    | [PREETHAM1590](https://github.com/PREETHAM1590) |
| Committer | [PREETHAM1590](https://github.com/PREETHAM1590) |
| Reviewer  | [PREETHAM1590](https://github.com/PREETHAM1590) |
| Approver  | [PREETHAM1590](https://github.com/PREETHAM1590) |

Each signing request is approved manually by the approver after confirming it comes from a tagged release build.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

## Licensing

Frameforge is released under the [MIT license](../LICENSE). Bundled third-party components are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
