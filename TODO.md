# TODO

## Pending Tasks
- [x] Skills
- [x] Create setup/configuration intro
- [x] Preview
- [ ] Debug log
- [x] Run agent with pipeline.
- [ ] Mobile view

- [ ] Having issues exiting plan mode and repeating questions
- [ ] Ability to configure different ports easily across different worktrees
- [ ] Connect profiler so AI can consult it in case of errors
- How to rollback to a certain point and fork the conversation.
- Could we use claude mem?
- Create an agent that runs security and architecture audits on a periodic basis
- Create mobile application
- In the architecture, ask how errors are handled, how users are managed, and exponential backoff.
- CSS styles should be shared as much as possible
To test the Intro, from the console
const settings = JSON.parse(localStorage.getItem('funny-settings'));
settings.state.setupCompleted = false;
localStorage.setItem('funny-settings', JSON.stringify(settings));
location.reload();
