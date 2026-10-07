# Security policy

Guided Review deliberately feeds untrusted text (pull request diffs, titles, descriptions, comments, and linked issues) to a language model that can call read-only tools on your machine. Bugs that let that text escape its intended limits are security bugs, and reports are welcome.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/HaydenMeloche/guided-review/security/advisories/new). Do not open a public issue.

Include the `gr --version` output, the model provider, and a minimal reproduction (for example, a PR body or file that triggers the issue). You should get an acknowledgement within a week.

## Supported versions

Guided Review is pre-1.0. Only the latest release gets security fixes.

## In scope

- Text from a PR, or model output, that makes the agent read files outside the PR's worktree, run commands beyond its read-only allowlist, or query repositories other than the PR's own.
- Terminal escape sequences from untrusted text reaching your terminal, such as clipboard writes, screen spoofing, or disguised hyperlinks.
- Anything posted to GitHub without an explicit user action.
- Credentials or local files leaking to the model provider, GitHub, or the local cache.

## Out of scope

- A model producing a wrong or misleading explanation. The tour is a reading aid, not a verdict. Always read the code.
- Data you have chosen to send to your configured model provider, as described in [Data, privacy, and security](docs/security.md#data-and-privacy).
- Issues that need an attacker who already controls your machine, your `~/.guided-review` directory, or your global git config.
