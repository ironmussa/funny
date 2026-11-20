## MODIFIED Requirements

### Requirement: Host lifecycle and semantic effects

Renderer-independent logic SHALL observe route, host-window focus, and visibility changes through host lifecycle services and SHALL request notifications, toasts, and application events as semantic effects rather than invoking renderer APIs directly. Focus transitions among child controls SHALL NOT be reported as host-window lifecycle transitions; when a native runtime cannot observe window focus independently, its platform adapter SHALL preserve an explicit conservative lifecycle state rather than infer window inactivity from child-element blur.

#### Scenario: Resume a visible connected client

- **WHEN** the host reports that the application has regained focus or become visible while realtime transport is connected
- **THEN** the client SHALL apply the existing throttling and route eligibility rules before requesting thread resynchronization

#### Scenario: Move focus between native child controls

- **WHEN** keyboard or pointer interaction moves focus between controls inside the same active native window
- **THEN** the host lifecycle service SHALL NOT report that the application became inactive or invisible

#### Scenario: Native runtime lacks independent window-focus events

- **WHEN** the active native runtime exposes child-element focus but no verified host-window focus signal
- **THEN** the platform adapter SHALL NOT derive host inactivity from child-element blur and SHALL keep the limitation explicit in diagnostics or verification evidence

#### Scenario: Deliver a user-facing effect

- **WHEN** event processing produces a notification, status message, or application event
- **THEN** the active platform implementation SHALL translate that semantic effect into the host-supported presentation without changing the state transition

#### Scenario: Unsupported optional effect

- **WHEN** a host does not support an optional user-facing effect
- **THEN** processing SHALL continue without failure and the unsupported effect SHALL remain observable to diagnostics
