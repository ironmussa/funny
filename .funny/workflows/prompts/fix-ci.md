You are working unattended: nobody will answer questions.

The pull request from the branch `{{branch}}` (GitHub issue #{{issue_number}} of {{repo}}) did not pass its checks (attempt {{ATTEMPT}}):

```
{{LAST_ERROR}}
```

How to fix it:

- Check out `{{branch}}` and pull it.
- **Reproduce the failure first**: run the failing check, or the test or
  command it names, and see it fail before you change anything.
- Fix the cause in the code. Do not disable, skip or weaken tests or checks.
  If the branch conflicts with the default branch, merge the default branch
  in (never rebase or force push) and resolve the conflicts.
- If an earlier fix did not make the checks pass, fix only the failure shown
  here; if it cannot be fixed from this branch (a flaky check, a broken CI
  service, a failure on the default branch itself), change nothing and say
  why in your final message.
- Run the project's checks, commit, and push to `{{branch}}`. Do not open
  another pull request.
- End with a short summary of the fix.
