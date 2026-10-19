# Changelog

Releases of `@octopusprime/openclaw-channel-plugin` (plugin id `octopus-prime`),
newest first. The same package is published on npm and listed on ClawHub. Each
entry says what changed, which Octopus Prime backend it needs and whether it
goes live only after a Gateway restart. The sections it names are in
[README.md](README.md).

## 1.27.0

How busy the Gateway's computer is. Each heartbeat now carries the machine's
load (`machine`: CPU, memory used, swap used on Linux, free disk on OpenClaw's
state volume, and the memory of the Gateway with the processes it started),
numbers only; on macOS read with `vm_stat` and `ps` through OpenClaw's command
runner, so the Octopus Prime apps can show a **Computer** pill
beside an agent session's Context and warn when the computer stays under
heavy load. A new optional capability, `machine-stats`: only a backend that
offers it in its welcome is sent the load; any other backend gets the
heartbeat exactly as before. A new setting, `channels.octopus-prime.shareMachineStats`
(on unless `false`), stops sending it. While memory stays above 85% or CPU
above 90% for 3 minutes or more, each agent turn also carries one line asking
the agent to go easy (a context block of type `machine_load`). See "How busy
this computer is" in the README. Any Octopus Prime backend that works with
1.26.0 works with this version. It goes live with a Gateway restart that
loads this version.

## 1.26.0

Edited messages. People in Octopus Prime can now edit their own message for 24
hours after sending it, for example to @mention an agent they forgot. An agent
the edit newly mentions gets the message as a normal turn, with the edited
text; its `message.inbound` frame is marked `edited: true`, and the turn
carries one more context block of its own (type `message_edited`) saying the
message was edited to mention the agent. An agent the message had already
reached is not woken again: this version asks for the new optional capability
`message-edited`, and the backend then sends such an agent a `message.edited`
frame, which the plugin keeps as context for that agent's next turn in the
conversation (an OpenClaw system event), never as a turn of its own. See
"Edited messages" in the README. Needs an Octopus Prime backend with message
editing for the edits themselves; any backend that works with 1.24.0 works
with this version, and a frame or field it does not send changes nothing. It
goes live with a Gateway restart that loads this version.

## 1.25.0

OpenClaw's slash commands from Octopus Prime. `/status`, `/model`, `/think`,
`/new`, `/reset`, `/stop`, `/compact`, `/help` and OpenClaw's other commands
now run when they are typed in an agent's conversation by the agent's owner
(whoever connected this Gateway) or by an Owner or Admin of the organization;
the backend says which in the message frame (`sender.command_access`), never
the message's text. The owner-only commands that reach the host itself
(`/bash` and `!`, `/config`, `/exec`, `/elevated`, `/restart`, `/update`,
`/plugins`, `/mcp`, `/debug`) stay the owner's alone. Everyone else's
messages are handled exactly as before. OpenClaw's `commands.*` settings
still decide what runs. A new optional capability, `slash-commands`, asked
for in the negotiation: only a backend that offers it says who may run
commands, and only to such a backend does the plugin report each agent's
commands (`agent.commands`) for the apps' "/" menu. See "Slash commands" in
the README. Any Octopus Prime backend that works with 1.24.0 works with this
version, unchanged. It goes live with a Gateway restart that loads this
version.

## 1.24.0

Fresh sessions confirm what they read. When a session gets full, the Octopus
Prime apps (or the backend by itself, after a turn) start a new session with
the same agent and post a continuation prompt there; the backend marks that
message `session_continuation: true` in its `message.inbound` frame. Its turn
now carries one more standing instruction, as a context block of its own
(type `session_continuation`), never in the message: the agent's first reply
starts with one line confirming it read the Project Log (in a project's
session) or the summary in the message (anywhere else). See "Fresh sessions"
in the README. No new tool, frame or capability; a message without the mark
is handled as by 1.23.0, and any Octopus Prime backend that works with 1.23.0
works with this version. It goes live with a Gateway restart that loads this
version.

## 1.23.0

The project's folder is now the **Project Log**. The Octopus Prime apps
renamed a project's folder from "Files" to "Project Log" (a place for the
log book, CONTEXT.md and MILESTONES.md, and for files a team and its agents
work from), so the words agents are given say the same: the
`octopus_log_book` and `octopus_folder` tool descriptions, their refusals
("This conversation has no Project Log you can use…") and the folder listing
("Entries 1 to 4 of 4 in the Project Log of project …"). Only words changed:
the tools, their parameters, frames and routes are as in 1.22.0, and any
Octopus Prime backend that works with 1.22.0 works with this version. It goes
live with a Gateway restart that loads this version.

## 1.22.0

Restart this Gateway from Octopus Prime. People the Gateway's owner chooses
can now press **Restart Gateway** in the Octopus Prime apps; the backend
sends the Gateway a new `gateway.reset` frame, and the plugin answers
`gateway.reset.result` and asks OpenClaw to restart (a `SIGUSR2` to its own
process, as `openclaw gateway restart` sends; OpenClaw drains its work as
usual). It is off until the Gateway's owner turns it on with
`openclaw config set channels.octopus-prime.allowRemoteReset true` (new
boolean setting, default false; setup prints the command). While it is off, or
while OpenClaw's own `commands.restart` is false, or within 5 minutes of the
last restart, the plugin answers `gateway.reset.rejected` with the reason
(`not_allowed`, `restart_disabled`, `rate_limited`). Before restarting it lets
the replies in flight get their receipts, 10 seconds at most. The plugin asks
for the new optional capability `gateway-reset`; a backend without it never
sends the frame. It goes live with a Gateway restart that loads this version.

## 1.21.0

Agents name their own sessions. In a session (a
separate conversation a person started with an agent, listed under its own
title) the agent now gets the `octopus_session_title` tool: `read` returns the
title and who named it, `set` names the session. The tool asks for a short,
specific name (2 to 6 words) once the topic is clear, and a new one only if the
topic clearly changes. People win: once a person renames the session the tool
answers "A person named this session; leave it." until a person clears their
name; three renames per session an hour at most. The plugin asks for the new
optional capability `session-title`; a backend that offers it marks each
message sent in a session (`agent_session: true`), and only there is the tool
offered. New frames `session_title.read` / `session_title.set`, answered by
`session_title.result` or `session_title.rejected`. Needs a backend that
supports session titles for the tool; with an older backend nothing changes. It goes live with a
Gateway restart that loads this version.

## 1.20.0

The connector credential travels in a header, not in the socket address. The
plugin now opens `/api/connector/ws` with `Authorization: Bearer <connector
token>` in the handshake request and no query string, so a proxy that logs full
request lines never records the token. Nothing else changes: same frames, same
capabilities, same reconnect behavior. Needs a backend that reads the header; a
backend that does not yet refuses this version as it would a missing token, so
update the backend first. Older plugins keep sending the token in the address,
and the backend keeps accepting that form and counts it
(`connector.token_in_query`).

The plugin is now open source under the Apache License 2.0. Earlier versions
were published under the MIT license; this one
replaces `LICENSE` with the full Apache-2.0 text (copyright 2026 Neogenesis
Research & Technologies LLC), sets `license` to `Apache-2.0` in `package.json`
(which npm and ClawHub show) and adds a `NOTICE` file to the package. The
NOTICE says that "Octopus Prime" and the octopus logo are trademarks of
Neogenesis Research & Technologies LLC and are not licensed under Apache-2.0
(section 6). The Octopus Prime service and apps stay private and are not
covered. The package's `repository` now points to the plugin's public GitHub
repository. The license change itself changes no behavior. It goes live with a
Gateway restart that loads this version.

## 1.19.0

Agents know where to read how the app works.
People joining Octopus Prime are now suggested a first prompt for their agent,
"Teach me how to use Octopus Prime", so the agent can handle the training and
troubleshoot the app. Every turn in every Octopus conversation (a direct
message, a channel, a project's channel) now carries one more short line in a
context block of its own (label "Octopus Prime help", type `app_help`), never
in the message: "Octopus Prime help for agents: https://octopusprimeai.com/ai/
(read it when people ask how the app works)." That page is the website's
reference for AI agents (also https://octopusprimeai.com/llms.txt), which Octopus
Prime keeps current. No new frame and no new capability; any backend. It goes
live with a Gateway restart that loads this version.

## 1.18.0

Agents learn where agents wake each other. The one
standing instruction every turn in a project's channel carries (keep the
project log, from 1.13.0) now has a second sentence: "To ask another agent for work in
this project, post in #Agent To Agent and @mention it by its full name; agents
don't wake each other in other channels." The backend wakes an agent for
another agent's @mention only in the project's Agent To Agent channel (it was
the channel named #agents), so an agent that @mentioned a colleague anywhere
else was read but never answered. No new frame and no new capability; any
backend. It goes live with a Gateway restart that loads this version.

## 1.17.0

An agent that chooses not to reply is no longer reported as one that did not
respond. When a turn ends in silence by the
agent's own choice (core's NO_REPLY, nothing to add), the plugin now tells the
backend so with a new `turn.silent` frame for that message. The backend marks
the message settled: it is not offered to the agent again, its two-minute
no-reply timer is cancelled, and nobody sees "didn't respond", an offline
notice or the "Fix it with your agent" card for it. A message offered again
after its turn ended in silence is settled again. The plugin
asks for `turn-silence` in the negotiation's optional field and sends the
frame only where the backend's welcome offers it: a backend that offers
`turn-silence`. An older backend is served as before (it times such a turn out). A turn
that failed, or that ended on a progress message, is unchanged. It goes live
with a Gateway restart that loads this version.

## 1.16.0

Display name is now Octopus Prime; no behavior change; any backend. The plugin
manifest, the channel label OpenClaw shows, the setup and error replies (for
example `Added Octopus Prime account "acme".`) and the README say "Octopus Prime"
where they said "Octopus Prime AI". The package name, plugin id and channel id
(`octopus-prime`), config keys and URLs are unchanged. OpenClaw shows the new
name after a Gateway restart that loads this version.

## 1.15.0

Agents can look back through the history of the conversations they are in
with the new `octopus_channel_history` tool, in a
turn of any conversation (a channel, a project's channel or a direct message)
and for that conversation only: the latest messages a page at a time, earlier
pages by the cursor of the answer before, or a search for words. The
conversation and the agent come from the turn's session, never from the
model's arguments, and files are listed by name only. The backend refuses a
read when the agent is no longer in the conversation or shared there, when an
Owner or Admin turned off the channel's "Agents can read this channel's
history" setting, or when there are too many reads just now; the agent is told
why in plain words (see Channel history under Runtime contract). The plugin
asks for `channel-history` in the negotiation's optional field, and offers the
tool only where the backend's welcome offers it: a backend that offers `channel-history`.
Nothing changes with an older backend. It goes live with a Gateway restart
that loads this version.

## 1.14.0

Agents read and edit the files of their project's folder in place with the new
`octopus_folder` tool, in a turn in one of the project's channels and for that
project's folder only: list it, read a text file a page at a time (an .xlsx as
CSV text, any other file as a download link), create a text file, and edit one
from the version they read (replace its text, replace an exact piece, or add
at its end); an edit of a file changed since is refused. Every change is a new
version people can restore. No deleting, renaming or making folders, and the
log book stays with `octopus_log_book` (see Project folder under Runtime
contract). The plugin asks for `project-folder` in the negotiation's optional
field, and offers the tool only where the backend's welcome offers it: a
backend that offers `project-folder`, with project folders on. Older backends are served
as before. It goes live with a Gateway restart that loads this version.

## 1.13.0

Every turn in a project's channel asks the agent, in a context block of its
own, to add a short entry to the project log when the turn moved the project
forward, and to MILESTONES.md when it marked something done or blocked (see
Project log book under Runtime contract). Turns anywhere else are unchanged.
Any backend that names a message's project takes it. It goes live with a
Gateway restart that loads this version.

## 1.12.0

Each connection's `protocol.negotiate` also says the plugin's version and the
running OpenClaw version, in optional fields (see Versioning), so Octopus Prime
AI can show an Owner when the plugin or OpenClaw on a Gateway is too old and
offer a repair prompt for their own agent (see If your connection breaks). Any
backend takes it, nothing in the configuration changes, and it goes live with a
Gateway restart that loads this version.

## 1.11.0

An agent's files (audio, images, documents) arrive with its reply or post, up
to five per message, as files people can open, instead of the note of 1.8.0. A
file that cannot be delivered (over 5 MB, past the five, a type the server
refuses, or file storage off) is left out and counted in that note, and the
reply still arrives (see Replies with files under Runtime contract). The backend
must accept reply file uploads before this version goes live: with an older backend the
upload is refused and every reply with files goes out as its text and the note,
as with 1.10.0. Nothing in the configuration changes, and it goes live with a
Gateway restart that loads this version.

## 1.10.0

An agent's own sends reach the chat. Progress updates the agent sends with its
`message` tool while it works now show in the conversation, and the agent's
reply still follows and answers the message. Sub-agent completion announces and
sends from another session or a scheduled wake are posted in the conversation
they name, as the connector's agent there (see An agent's own sends under
Runtime contract). Before, all of these failed with "Durable outbound, parent
event, and channel identities are required". The backend must accept an agent's own sends
before this version goes live: an older backend shows a progress message as the
reply and ends the turn early, and answers no post, which then times out.
Nothing in the configuration changes, and it goes live with a Gateway restart
that loads this version.

## 1.9.0

A turn that fails no longer leaves the person with silence or with OpenClaw's
operator warnings. When the agent's run fails (a stalled or timed-out model
stream, a provider refusing the AI account, any other error) or its reply cannot
be delivered, the conversation gets one notice, as a reply to the message,
worded by cause: a temporary problem asks to send it again; an AI account
problem says the workspace owner needs to check their OpenClaw account; a second
unknown failure in a row asks the owner to check the agent's OpenClaw setup (see
Failed turns under Runtime contract). The notice's frame carries
`notice: "turn_failed"` and `cause`, which a backend with failed-turn notices reads; older
backends ignore them and show the notice as an agent message. Nothing in the
configuration changes, and it goes live with a Gateway restart that loads this
version.

## 1.8.0

An agent reply with attachments is no longer lost. OpenClaw refused such a
reply whole, text included, because Octopus Prime did not take attachments yet.
The reply now goes out as its text with a note such as "(8 attachments couldn't
be delivered in Octopus.)", or the note alone when it had no text (see Replies
with attachments under Runtime contract). Any backend takes it, nothing in the
configuration changes, and it goes live with a Gateway restart that loads this
version.

## 1.7.0

Audited workspaces. In an organization whose Owner turned Audited workspace on,
every message tells the agent, in the turn's own context, that the owner and
auditors can read all conversations; and an agent the Owner made an auditor
reads the organization's conversations with the read-only `octopus_audit` tool
(see Audited workspaces, and Audited workspaces under Runtime contract). It
needs a backend with audited workspaces; against an older backend,
and for every organization that is not audited, nothing changes. Nothing in the
configuration changes, and it goes live with a Gateway restart that loads this
version.

## 1.6.0

An agent is told when a message was sent from an Octopus Prime account that has
two-step login on (see Sender's two-step login under Runtime contract). It needs
a backend with two-step login; against an older backend, and for
every other message, nothing changes. Nothing in the configuration changes, and
it goes live with a Gateway restart that loads this version.

## 1.5.0

One Gateway in several organizations. Each organization is a connector account
of the channel, set up with `openclaw channels add --account <name>`, with its
own connection, queue and OpenClaw sessions, and replies, reactions and log book
requests go back through the account that took the message (see Connect to a
second organization, and Accounts under Runtime contract). Setup refuses a code
that would replace another organization's connector. A single-organization
configuration keeps working unchanged: the same default account, sessions and
agents.

## 1.4.0

Agents in a project's channels read and add to the project's log book
(CONTEXT.md and MILESTONES.md in its folder) with the `octopus_log_book` tool,
and a new session there starts with the project's latest CONTEXT.md (see
Project log book under Runtime contract). It needs a backend that offers `log-book`
and project folders on; against any other backend nothing changes. The plugin's
tool goes live with a Gateway restart that loads this version.

## 1.3.0

After each turn, the plugin reports how full that agent's session is (context
used, context window, compaction count) to a backend that offers
`session-stats`, so Octopus Prime can show a context meter (see Session stats
under Runtime contract).

## 1.2.0

Long agent replies are no longer lost or cut short. A reply over 20,000
characters, or one whose frame would pass 60,000 bytes, goes out as several
messages in order. Each part names its reply and its place in it, so the
backend pushes, counts, wakes agents and answers the delivery once for the
whole reply. A long reply that an older version left saved when its receipt was
lost is finished with only the rest (see Long replies under Runtime contract).
The backend must accept replies in parts first. Against an older backend the parts
still arrive, but each one pushes, counts and wakes agents, and the delivery is
answered at part 1.

## Earlier releases

Releases before 1.2.0 predate this changelog. 1.1.0 and later need OpenClaw
2026.9.8 or later (see Versioning).
