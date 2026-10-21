# Changelog

Releases of `@octopusprime/openclaw-channel-plugin` (plugin id `octopus-prime`),
newest first. The same package is published on npm and listed on ClawHub. Each
entry says what changed, which Octopus Prime backend it needs and whether it
goes live only after a Gateway restart. The sections it names are in
[README.md](README.md).

## 1.38.4

A large Agent Backup no longer holds up the Gateway while it packs files. Each
4 MiB piece is now compressed on Node's worker threads instead of the
Gateway's own event loop, so chat replies, agent wakes and the connection's
heartbeat keep running during a backup; the longest pause measured on a test
backup of about 210 MB went from 83 ms to 37 ms. Backups and restores are
unchanged otherwise: the same format, still read by earlier versions. No
backend change. Goes live after a Gateway restart.

## 1.38.3

An interrupted Agent Backup resumes cleanly. When an upload fails part way (no
network, a storage error, a timeout), the pieces that already reached storage
are still confirmed to the server before the restore point is given up, so the
next backup sends only what is missing instead of everything again. A restore
point left open by a Gateway that was killed, slept or went offline before it
could say so is remembered on this computer and given up at the start of the
next backup, which no longer waits up to a day for the server to give it up.
Restores still list finished restore points only. No backend change. Goes live
after a Gateway restart.

## 1.38.2

Agent Backup says plainly when this computer's keychain fails. A keychain tool
that is not installed, a locked keychain, a cancelled prompt, a tool that never
answers or a failing exit now stops with a named reason ("The Secret Service is
locked or refused access, so it did not keep the backup key…") instead of a raw
`spawn … ENOENT` or a vague "run setup"; backup setup then turns nothing on.
The tool's own output is never repeated. The macOS Keychain's prompt on the same
line as the key no longer hides the key. The key was already passed to every
tool on standard input; the new tests prove no command line carries it and that
it is in no log line, error, file or setting. No backend change. Goes live after
a Gateway restart.

## 1.38.1

Agent Backup copies the automations database while OpenClaw is writing to it.
The copy now waits up to 5 seconds for a lock another connection holds (before,
it failed at once with "database is locked", and the backup went ahead without
the automations). Proven against a second connection committing during the copy,
rows only in the `-wal` file, a held write lock and a crashed Gateway's leftover
`-wal`; OpenClaw's own database files are never changed. No backend change.
Goes live after a Gateway restart.

## 1.38.0

Agent Backup. An encrypted copy of this Gateway's OpenClaw files, kept by
Octopus Prime, to bring its agents back on a new computer. Everything is
encrypted on the computer before it leaves (pieces of at most 4 MiB,
compressed, AES-256-GCM; ids are keyed HMACs), so the server stores
ciphertext, sizes and counts only. The data key is wrapped by a passphrase
(scrypt) and by a recovery key shown once at setup; either restores, and the
key itself stays in this computer's keychain (macOS Keychain, Linux Secret
Service or Windows DPAPI) for scheduled backups. Secrets are never collected:
credentials, `.env` files, auth profiles, sessions and transcripts, cookies,
keys, dependencies and caches are left out, `openclaw.json` is redacted, the
automations database is copied without its secret tables, and repositories
with a remote are recorded, not copied. New commands
`openclaw octopus-prime backup setup | status | now | estimate | restore | passphrase`;
restore writes into an empty OpenClaw (never overwriting without
`--overwrite`), merges the config, imports the automations, writes a rebuild
kit (repositories to clone, plugins and packages to install, skipped files)
and prints a Sign-in checklist (names only, also sent to the apps). New agent
tool `octopus_backup`: `estimate` says how big a backup would be and which
plan fits, on any Gateway, before any plan is bought, uploading nothing;
`status` says whether backups are on. The plugin asks for `agent-backup` in
the negotiation's optional field, checks every 10 minutes whether a backup is
due and answers the apps' "Back up now" (`backup.run`). Needs a Backup plan
for the Gateway and an Octopus Prime backend that offers `agent-backup`;
without them nothing changes. Goes live after a Gateway restart.

## 1.37.0

A project can remove its Agent To Agent channel, and agents no longer send each
other there. A project's people can now remove a starter channel they do not use
(Blockers, Agent To Agent, Automations, Strategize), and add it back. The
standing line every turn in a project's channel carries said to post in #Agent To
Agent; when that channel is gone, the backend says so in the message frame
(`no_agent_to_agent: true`, only then, only beside `project_id`) and the plugin
replaces the second sentence: the project has no Agent To Agent channel now, so
agents can't wake each other there; to ask another agent for work, tell the
person in the project's Strategize channel or in the agent's direct message
with them what is needed, and they can ask that agent or add the channel back.
The first sentence (add an entry to the project log) is unchanged. Needs an
Octopus Prime backend from this release for the new field (an older one never
sends it, and the standing line is as before). Goes live after a Gateway
restart.

## 1.36.0

Computer load protection. Agents are warned sooner and told what to do when
the computer running them is near full. Heavy load (memory above 85% or CPU
above 90%) now counts after 60 seconds instead of 3 minutes, and the plugin
reads the machine every 10 seconds while memory or CPU is above 80% (every 20
otherwise), decided on the Gateway. The `machine_load` block an agent's next
turn carries is rewritten so the agent coordinates: close what it opened and
pause heavy or parallel work, ask the Gateway's other agents to do the same,
check what else uses the computer and tell the owner if it is something
outside its own work (never closing programs it did not start), and explain
it if a user asks. It names what the agents' work uses (the Gateway with
every process it started, of the machine's memory). Each agent gets it at
most once in 15 minutes, and once more, stronger, if memory reaches 95%;
before, every turn carried it. Every agent on the Gateway is warned alike:
this OpenClaw does not tell which agent's processes use the memory. The
heartbeat's `machine` also says `heavy`, `warned_agents` (the agent ids warned
in this run of heavy load) and `memory_total_bytes`, for the apps' 30-day
load-warning history. A welcome or `pong` saying `load_protection: false`
turns the warnings off for that Gateway (Settings › AI agents › the Gateway ›
Computer load protection, on by default); an older backend says nothing and
they stay on. Needs an Octopus Prime backend from this release for the
setting, the owner's pop-up and the history (an older one shows the numbers
as before). Goes live after a Gateway restart.

## 1.35.0

Agents see the pictures people send them. Until now a screenshot reached the
agent only as a signed link in the message's text: OpenClaw's transcript shows
the link's signature as `***`, and the link stops working after an hour, so on
a retried or later turn the agent could not open it. The plugin now asks for
the new optional capability `inbound-media`; a backend that offers it names
each picture of a message in its frame (`files`: id, name, type and size,
never a link), and the plugin downloads each one (JPEG, PNG, WebP, GIF,
HEIC/HEIF, up to 25 MB, up to five a message) with the connector's own
credential from `GET /api/connector/files/{id}?event_id=...` when the turn
starts, saves it in OpenClaw's media store (`runtime.channel.media
.saveMediaBuffer`) and hands it to the turn as its media
(`buildChannelInboundEventContext` `media`), so the agent sees the images in
one turn and they stay in the session. The message's text keeps its links;
a picture the plugin could not get (over 25 MB, refused, not a picture) is
named in one line after the message for the agent, pointing at its link. No
address or credential is logged. Needs an Octopus Prime backend from this
release for the pictures (an older one offers no `inbound-media`, and the
agent reads the links as before). Goes live after a Gateway restart.

## 1.34.0

One clear message when an agent can't answer. While an agent's AI
account was rate-limited, each message got "Sorry, I hit a temporary problem"
and then "The workspace owner needs to check the agent's OpenClaw setup":
core's rate-limit words ("The AI service needs a short break") matched none
of the plugin's, so the failure was `unknown`, and an unknown failure in a row
was worded as a setup problem. Now a failed turn's notice names one of five
causes: `rate_limit` (new: a FailoverError `rate_limit`, HTTP 429, core's
rate-limit words or a provider's "usage limit"), `temporary`, `ai_account`,
`setup` (new: `model_not_found`, a model that isn't set up) or `unknown`. A
429 about money (out of credits, `insufficient_quota`) stays `ai_account`. A
failure in a row is no longer a setup problem, so the plugin no longer counts
failures per conversation. New words in the body, which only a backend
without failed-turn notices shows: "I'm at my usage limit right now — try
again in a few minutes.", "Something went wrong on my side — please send that
again." and "My OpenClaw setup needs attention — the workspace owner needs to
check it." Needs an Octopus Prime backend from this release for the new causes
(an older one words them as `unknown`) and for one message per run of
failures, the owner told once an hour, and no "didn't respond" alarm for a
rate limit. Goes live after a Gateway restart.

## 1.33.0

Tap-to-answer. When an agent asks a structured question with OpenClaw's
`ask_user` tool, or sends buttons or a select with the `message` tool, the
Octopus Prime apps now show them as chips people tap instead of plain text.
The channel draws buttons and selects while the backend offers the new
optional capability `ask-user` (asked for in the negotiation; the outbound
adapter's `resolvePresentationCapabilities` turns `buttons` and `selects` on
only then), and tells OpenClaw so (`agentPrompt.messageToolCapabilities`
adds `inlineButtons`, so agents are no longer told "Inline buttons OFF for
octopus-prime"). A reply's question or buttons travel as `ask` on the reply's
one frame, beside its words, which stay OpenClaw's full plain text. A
question's options, several choices or one, "Other…", and when it expires come
from OpenClaw's own record of the pending question, else from the one-question
card core builds for it; a prompt of several questions stays words. One
choice of a single-choice question, or the person's own words for "Other…",
comes back as a `question.answer` frame, which the plugin resolves through
OpenClaw's question API (`openclaw/plugin-sdk/question-gateway-runtime`,
`resolveOption`, the path Telegram's and Slack's buttons take), answering
`question.answer.result`. Several choices, and a tap on a button, arrive as the
person's own message. When a question ends on the Gateway (answered anywhere,
expired or cancelled) the plugin sends `question.closed`, so the card says so.
See "Tap-to-answer" in the README. Any Octopus Prime backend that works with
1.32.0 works with this version: an older one offers no `ask-user`, and gets the
words alone. It goes live with a Gateway restart that loads this version.

## 1.32.0

Rich replies. An agent's reply can now carry OpenClaw's message presentation,
and the Octopus Prime apps draw it natively: a card with a title and a tone,
text, context lines, dividers, tables and charts (pie, bar, line, area).
Agents get the `message` tool's `presentation` parameter on Octopus Prime
(`describeMessageTool` declares `capabilities: ["presentation"]`). The
channel's outbound adapter declares what it draws (no buttons or selects yet:
OpenClaw shows those as a context line) and renders a card in the backend's
shape, the reply's own words first, sent as `presentation` on the reply's one
frame; the frame's `body` is OpenClaw's full plain-text version, so search,
read aloud, notifications and older apps keep working. A new optional
capability, `rich-presentation`, asked for in the negotiation: only a backend
that offers it in its welcome is sent a card, and only for a reply that is
one frame within the frame limit and a card within Octopus Prime's limits
(16,000 bytes); otherwise the reply goes as its words alone, exactly as
before. See "Rich replies" in the README. Any Octopus Prime backend that
works with 1.31.0 works with this version. It goes live with a Gateway
restart that loads this version.
## 1.31.0

Approve agent actions in Octopus Prime. The plugin is one of OpenClaw's native
approval surfaces for its channel (the SDK's `approvalCapability` with a native
runtime, started per account through the `approval.native` runtime context).
When the Gateway's owner turns **Approve agent actions in Octopus** on in
Settings › Plugin (off by default), an exec or plugin approval OpenClaw raises
in a turn of one of the account's Octopus Prime conversations is forwarded
(`approval.request`: the exact command, folder and host, or the tool, title,
description and severity, the decisions offered, the id and the expiry), and
Octopus Prime shows it to the agent's owner alone, as a card and a push. The
owner's Allow once, Always allow or Deny comes back as `approval.decide` and is
handed to OpenClaw's approval service with the approval's kind
(`resolveApprovalOverGateway`), only for an approval this account forwarded,
still pending, with a decision it offered; never through chat text. Settled
approvals are reported (`approval.resolved`, `approval.expired`). `/approve` is
now an owner-only command: a manager's message that names it is not
authorized for commands. A new optional capability, `agent-approvals`: only a
backend whose welcome offers it is told anything; with the setting off, or
without that backend, approvals stay wherever OpenClaw sends them. See
"Optional: approve agent actions in Octopus Prime" in the README. Any Octopus
Prime backend that works with 1.30.0 works with this version. It goes live with
a Gateway restart that loads this version.

## 1.30.0

What each agent's turns cost. After each turn it runs for an Octopus Prime
message, the plugin reads that turn's usage from OpenClaw's session row (the
same read-only lookup the session stats use) and sends one `agent.usage`
frame: the model and provider, input, output and cache tokens, and the cost
as OpenClaw estimated it from its price list (`cost_source: "estimate"`, or no
cost when OpenClaw has no price for the model). Numbers and model names only,
never a message. A new optional capability, `agent-usage`: only a backend
whose welcome offers it is sent these. Octopus Prime shows each agent's usage
and cost by day, model and conversation to its owner and the organization's
Owners and Admins, with an optional monthly budget that alerts at 80% and
100%. See "Agent usage" in the README. Any Octopus Prime backend that works
with 1.29.0 works with this version; one without `agent-usage` gets none of
it. It goes live with a Gateway restart that loads this version.

## 1.29.0

Your agent in your meetings. People can send an agent to a Zoom, Google Meet
or Microsoft Teams meeting from Octopus Prime; the agent joins with OpenClaw's
own meeting plugins (`zoom-meetings`, `google-meet`, `teams-meetings`) as an
observe-only guest and, when the meeting should be over, posts the notes in
that conversation (summary, decisions, action items, also added to the
project's Project Log). A new optional capability, `meetings`: only on a
connection whose backend offers it does the plugin report which meeting
plugins this Gateway has (`meetings.report`, read from OpenClaw's config, shown
in Settings › Plugin), give the agent a `meeting` context block on the turn
that sends it or asks for the notes, offer the new `octopus_meeting` tool
(status and notes, on 1.28.0's `work.request`), and send `meeting.due`
when the meeting should be over. See "Your agent in your meetings" in the
README. Any Octopus Prime backend that works with 1.28.0 works with this
version; one without `meetings` gets none of it. It goes live with a Gateway
restart that loads this version.

## 1.28.0

Tasks, calendar events and projects. When someone asks, an agent can now
create and manage them in Octopus Prime with three new tools:
`octopus_tasks` (create a task with a due time, an assignee in the
conversation, this conversation or its project, a category and reminders; list
the conversation's, the project's, the agent's or the asker's tasks; mark one
done, open or cancelled, change its due time or assignee; comment in its
thread), `octopus_calendar` (create an event with people and agents of the
conversation invited, in the time zone given; list a range; change or cancel
the agent's own events) and `octopus_projects` (create a project with the
person who asked and the agent in it; list the agent's projects). The
backend acts with the permissions of the person whose message started the
turn, only where the agent is, counts each agent's creates (30 an hour) and
marks what an agent made, which the apps show as "Created by" the agent.
Nothing is deleted: a task or event is cancelled. A new optional capability,
`agent-work`: only on a connection whose backend offers it are the tools
offered, and each turn there carries one line saying the agent can use them
(a context block of type `agent_work`). See "Tasks, calendar and projects" in
the README. Any Octopus Prime backend that works with 1.27.0 works with this
version; one without `agent-work` gets none of it. It goes live with a Gateway
restart that loads this version.

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
