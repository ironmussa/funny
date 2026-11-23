You are working unattended: nobody will answer questions.

You finished GitHub issue #{{issue_number}} of {{repo}}, but there is no
open pull request from the branch `{{branch}}`:

```
{{LAST_ERROR}}
```

Check that your commits are on `{{branch}}`, push it to `origin`, and open a
pull request from it against the default branch whose body contains
`Closes #{{issue_number}}` (what changed, how it was tested, the decisions
you made). If you decided there is nothing to change, push nothing and say
so in your final message. End with the pull request's URL.
