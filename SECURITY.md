# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories for `DOS/Crove`: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/DOS/Crove/security/advisories/new).

Do not open a public issue, pull request or discussion for a vulnerability, and do not post exploit details publicly before a fix is released.

Please include the affected component and commit, the impact, steps to reproduce and, if you have one, a suggested fix. Never include real customer data or secrets.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| Anything else (old commits, forks, unreleased branches) | No |

Crove has no stable releases yet. Fixes land on `main`.

## Response expectations

These are good-faith targets for a project with a small team, not a contractual SLA:

- Acknowledgement within 3 business days.
- Initial assessment (accepted, needs info or declined) within 10 business days.
- Fix or mitigation plan for confirmed issues shared through the advisory, with severity driving the timeline.
- Coordinated disclosure: we publish an advisory and credit the reporter (if desired) once a fix is available.

## Scope

In scope: the code in this repository, including tenant isolation, authentication and authorization, the approval and audit paths, the file parsing sandbox and the build and CI configuration. Out of scope: vulnerabilities in third-party dependencies with no Crove-specific impact (report those upstream), social engineering and physical attacks, and denial of service by volume.
