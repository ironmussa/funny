You are working unattended: nobody will answer questions, so make
reasonable decisions and state them in your final message.

Implement GitHub issue #{{issue_number}} of {{repo}}: {{issue_title}}
Read the issue first: {{issue_url}}
{{#triage.json.contract}}

The issue was triaged before you. Your change must meet this contract:

{{triage.json.contract}}
{{/triage.json.contract}}

How to work:

- Read the repository's agent instructions first (`AGENTS.md`, `CLAUDE.md`
  or the like, at the root and next to the code you change) and follow them.
- Work on the branch `{{branch}}`. You may already be on it (check with
  `git branch --show-current`); otherwise create it from the default branch.
- Read the code around the change before editing, follow the conventions
  you find, and keep the change to what the issue asks.
- **If the issue is ambiguous or large**, do its smallest useful part that
  stands on its own, and say in the pull request what you left out and why.
- **Find the root cause** before making changes. Do not fix symptoms.
- **Cover every case the issue names** or state in the pull request why
  one is left out. Consider concurrency and edge cases.
- **If the issue asks you to verify or measure first**, do it and report
  the result. If the issue's claim does not hold, push nothing, explain
  why in your final message, and stop.
- Add or update a **regression test** that fails without the fix and
  passes with it. Run the **full test suite** of each package you change.
- Commit, push the branch `{{branch}}` to `origin`, and open a pull
  request from it against the default branch. Its body contains
  `Closes #{{issue_number}}` and says:
  - **What changed**, and why that fixes the issue.
  - **How it was tested**, including how the regression test was shown to
    fail without the fix.
  - **Decisions** you made where the issue left a choice open.
- End with a short summary of what you changed and why.
