# Local Claude subscriptions and quota waits

A local Claude run keeps its working directory, native session and tools on the
Mac. When Core has an enabled Anthropic subscription, Orb routes model requests
through Core's native Messages endpoint. Conversation context and tool results
therefore pass through the configured Core server. Core's existing subscription
pool chooses an available account; Orb does not copy or replace the Mac's saved
Claude login. With no connected Core subscription, Claude uses its native login.

Each routed run receives a separate proxy key, not the desktop's owner token.
Orb revokes that key after launch failure or when the native run ends. Provider
catalog errors fail the launch rather than silently changing authentication.
The Core connection must use HTTPS (loopback HTTP is allowed for development).

When Claude reports subscription exhaustion, Orb keeps its input channel and
child processes alive, displays a quota wait, and sends one continuation after
the reported reset plus a small margin. A missing reset falls back to one hour;
a just-expired reset waits at least one minute. Stop cancels the timer. This
handling applies to both error results and standalone quota notices returned as
successful results. Authentication errors and safeguard refusals are not quota
waits and are not automatically retried by this mechanism.

Install the desktop update when local runs are idle. Existing CLI processes keep
the environment with which they were launched; they cannot acquire routing from
a replaced app binary. Resume the saved chat after updating. Do not restart or
kill builds to activate this feature. Quota waiting cannot keep a process alive
through an operating-system shutdown or forced app termination.

Validation covers reset parsing and timezones, cancellation, the native stream
remaining open, child-process survival, unchanged session identity, inherited
auth precedence and subscription-catalog selection. A tools-disabled synthetic
Claude request through Core verifies the installed CLI's gateway compatibility.
