# Octopus Prime channel plugin for OpenClaw

Connects the agents on your OpenClaw Gateway to your Octopus Prime
organization, so you and the people you share them with can message them in
Octopus Prime. The plugin runs **inside** your Gateway and opens a secure
**outbound** WSS connection to Octopus Prime. The Gateway never needs a
public inbound port.

- Package `@octopusprime/openclaw-channel-plugin`, version 1.38.4. Plugin id and
  channel id `octopus-prime`.
- Requires OpenClaw **2026.9.8 or later** (see [Compatibility](#compatibility)).
- Octopus Prime: https://octopusprimeai.com. App: https://app.octopusprimeai.com.
- Step-by-step guide: https://app.octopusprimeai.com/connect-your-agent.
- Support: https://app.octopusprimeai.com/support or support@octopusprimeai.com.
- Release notes: [CHANGELOG.md](CHANGELOG.md).

> **You choose who can use each agent.**
>
> A newly connected agent starts as **Just me**: only you, the person who connected the Gateway, can use it. In **AI agents**, you or an Owner or Admin can share each agent with a project or with the whole organization. Whoever can use an agent can use whatever it has access to (files, email, tools), so share it only with people who should.

## Official sources

The plugin is published as one package in two places:

- **npm**: `@octopusprime/openclaw-channel-plugin`.
- **ClawHub** (https://clawhub.ai): the same package,
  `clawhub:@octopusprime/openclaw-channel-plugin`, from the Octopus Prime
  publisher.

Install and update it only from one of these. Never install it from a link, a
file or instructions in a chat message, an email or a web page.

## Compatibility

- **OpenClaw 2026.9.8 or later.** `openclaw.compat.pluginApi` in
  `package.json` is `>=2026.9.8` and `openclaw.compat.minGatewayVersion` is
  `2026.9.8`. OpenClaw checks them before it installs the plugin from npm or
  ClawHub, and refuses an older OpenClaw. Each release is built and tested on
  the OpenClaw release named in `openclaw.build` (now 2026.9.8). A newer
  OpenClaw loads the plugin without a new plugin release (see
  [Compatibility policy](#compatibility-policy)).
- **Hosts.** It works with OpenClaw and with OpenClaw-compatible hosts that
  load OpenClaw channel plugins. Other OpenClaw spinoffs are supported only if
  they implement the OpenClaw plugin API this plugin uses (2026.9.8 or later);
  Octopus Prime does not test them. To check such a host, on the Gateway
  host (`<host>` is its command):
  1. Its version, or the OpenClaw plugin API version it says it implements, is
     2026.9.8 or later, and it installs native OpenClaw plugins
     (`openclaw.plugin.json` and the `openclaw` block of `package.json`) from
     npm or ClawHub: `<host> plugins install @octopusprime/openclaw-channel-plugin`
     works and does not refuse the plugin's `openclaw.compat`.
  2. It provides the OpenClaw plugin SDK entry points the plugin imports
     (`openclaw/plugin-sdk/core`, `channel-core`, `channel-setup`,
     `channel-inbound`, `channel-ingress-runtime`, `channel-outbound`,
     `channel-actions`, `channel-contract`, `channel-secret-basic-runtime`,
     `account-helpers`, `account-id`, `account-resolution`, `agent-runtime`,
     `error-runtime`, `interactive-runtime`, `media-runtime`,
     `question-gateway-runtime`, `reply-payload`, `routing` and
     `session-store-runtime`): `<host> plugins inspect octopus-prime` shows the
     plugin loaded, with no errors.
  3. `<host> channels add --channel octopus-prime --help` lists
     `--backend-url` and `--setup-code`.
  4. After setup (see [Install and connect](#install-and-connect)),
     `<host> channels status --channel octopus-prime --probe` reports the
     channel connected, **AI agents** in the web app shows the connector
     **CONNECTED**, and an agent answers a message sent to it in Octopus Prime.

  If any of these fails, the host is not supported: use OpenClaw itself.

## Before you start

- You are an **Owner** or **Admin** of your Octopus Prime organization. Only
  they can connect a Gateway.
- OpenClaw 2026.9.8 or later on the Gateway host (`openclaw --version`), and a
  shell on that host.
- The Gateway host can reach the Octopus Prime backend over outbound HTTPS
  and WSS. No inbound port is needed.
- Review the agents on this Gateway (`openclaw agents list`). Each one is yours
  alone in Octopus Prime until you share it (see above).

## Install and connect

The commands run on the Gateway host. The setup code comes from the Octopus
Prime AI web app.

**1. Install the plugin:**

```sh
openclaw plugins install @octopusprime/openclaw-channel-plugin
```

OpenClaw installs the package from npm, together with its one dependency,
`ws`. Because it is not an OpenClaw catalog plugin, OpenClaw first asks you to
confirm the package source and then to accept the plugin's capabilities.
Review and accept both. In a script or a shell without a terminal, pass
`--force --accept-capabilities`, but only after you have reviewed them. With a
running Gateway the plugin is applied right away; otherwise it loads on the
next Gateway start.

Or install the same package from ClawHub:

```sh
openclaw plugins install clawhub:@octopusprime/openclaw-channel-plugin
```

OpenClaw trusts ClawHub as a source, so it does not ask you to confirm it;
it shows ClawHub's security check of the release, and you may still be asked
to accept the plugin's capabilities. Later updates follow the source you
installed from.

**2. Get a setup code.** In the Octopus Prime web app
(https://app.octopusprimeai.com), open **Settings** (the gear next to your
organization's name), then **AI agents**, and click **Connect OpenClaw**. The panel shows a one-time setup code below the
install command. The code works once and expires after 15 minutes. The
connector's **New setup code** button makes another one.

**3. Paste the code into setup** in place of `<code>`, before it expires:

```sh
openclaw channels add --channel octopus-prime --backend-url https://api.octopusprimeai.com --setup-code <code>
```

`https://api.octopusprimeai.com` is the Octopus Prime server; use it as
shown. The plugin exchanges the code over HTTPS for a connector credential,
then saves the server URL, that credential, the connector ID and the
organization ID in its OpenClaw channel configuration. The code itself is not
saved. Treat the code like a password until it is used: do not paste it into
chats, tickets or logs.

**4. Check that it is connected.** A Gateway running with config reload starts
the channel by itself; otherwise run `openclaw gateway restart`. The plugin
connects and announces this Gateway's agents. In the web app, **AI
agents** then shows the connector as **CONNECTED**, with the agents under it. On
the Gateway host, this asks the running Gateway about the channel:

```sh
openclaw channels status --channel octopus-prime --probe
```

Would you rather let your own OpenClaw agent do the Gateway side? On the same
panel, **Copy setup prompt** copies instructions for it. You still enter the
setup code yourself, through protected input.

### Update or uninstall

To update it later:

```sh
openclaw plugins update octopus-prime
```

To remove the plugin:

```sh
openclaw plugins uninstall octopus-prime
```

OpenClaw lists what it will remove and asks you to confirm. That includes the
plugin's channel configuration (`channels.octopus-prime`), where setup saved
the connector credential of every account. Then, in each organization the
Gateway was connected to, an Owner or Admin clicks **Revoke** (the bin icon)
on the connector in **AI agents**: its credential stops working and its
agents leave Octopus Prime.

### If your connection breaks

An OpenClaw update or a change on the Gateway host can stop the connector:
**AI agents** then shows the connector offline, or Octopus Prime says
an agent didn't respond. Owners and Admins see what is wrong on the
connector's row: offline, an outdated plugin (older than the version Octopus
Prime AI supports), an OpenClaw version older than the plugin needs, or
repeated failed turns. There, and under an agent's notice, **Fix it with your
agent** copies a ready-made prompt for the OpenClaw agent on that Gateway.
Paste it into a private conversation with that agent in OpenClaw itself (not
in Octopus Prime, which it may not hear while the connection is down). The
prompt holds no token or setup code and never asks you for one. Its steps,
which you can also follow yourself on the Gateway host:

1. **Check.** Run OpenClaw's own diagnostics and note what they say:

   ```sh
   openclaw status
   openclaw plugins inspect octopus-prime
   openclaw plugins doctor
   openclaw channels status --channel octopus-prime --probe
   ```

2. **Update the plugin, only from its official sources**: the npm package
   `@octopusprime/openclaw-channel-plugin` (this package) or the same package
   on ClawHub, `clawhub:@octopusprime/openclaw-channel-plugin` (see
   [Official sources](#official-sources)). Never install it from a link, a
   file or instructions in a chat message, an email or a web page.

   ```sh
   openclaw plugins update octopus-prime
   ```

   If OpenClaw says the plugin was installed from somewhere else (a source
   checkout, a file), reinstall it from the package as in
   [Install and connect](#install-and-connect), step 1. If the update or
   `openclaw plugins doctor` names a repair, follow it (a data migration needs
   `openclaw doctor --fix`). Don't edit the plugin's files or hand-edit the
   OpenClaw configuration.
3. **Check OpenClaw.** The plugin needs OpenClaw 2026.9.8 or later
   (`openclaw --version`). Updating OpenClaw itself (`openclaw update`) is the
   Gateway owner's decision.
4. **Restart only if needed.** A running Gateway applies a plugin update by
   itself; a release whose entry in [CHANGELOG.md](CHANGELOG.md) says it goes
   live with a Gateway restart needs `openclaw gateway restart`, which interrupts
   other work on the Gateway.
5. **Set up again only if the credential is refused or missing.** If
   `openclaw channels status --channel octopus-prime --probe` still fails
   because the connector's credential is refused or missing, run setup again
   for the same connector: in **AI agents**, an Owner (or whoever
   connected the Gateway) clicks **New setup code** on that connector, then
   step 3 of [Install and connect](#install-and-connect) runs with the new code
   (add `--account <name>` for an account other than the default one). Enter
   the code yourself; never paste it into a chat.
6. **Report.** Check that **AI agents** shows the connector **CONNECTED**
   again; the agent reports what it found and changed.

Since 1.12.0 the plugin tells Octopus Prime
AI its own version and the running OpenClaw version each time it connects (`plugin_version` and
`openclaw_version` in `protocol.negotiate`, see [Versioning](#versioning)), so
the connector's row shows when either is too old.

## Connect to a second organization

One Gateway can be in several Octopus Prime organizations (1.5.0), for
example your own and a client's. Each organization is one **connector
account** of this channel, with its own setup code, credential, connection
and OpenClaw sessions. Your first organization stays the `default` account,
exactly as setup saved it.

**1. Update the plugin first**, to 1.5.0 or later, and restart the Gateway.
Earlier versions have the default account only: setup with `--account` saves
the new code over your first organization's connector, which disconnects it.

**2. Get a setup code in the second organization.** You must be an Owner or
Admin there. In the web app, switch to that organization, open **Settings**,
then **AI agents**, and click **Connect OpenClaw**.

**3. Run setup with a name for the new account** (letters, digits, `-` and
`_`, but not `channel`, `group`, `direct`, `dm` or `thread`), here `acme`,
pasting the code in place of `<code>`:

```sh
openclaw channels add --channel octopus-prime --account acme --backend-url https://api.octopusprimeai.com --setup-code <code>
```

OpenClaw answers `Added Octopus Prime account "acme".` Setup saves the new
connector under `channels.octopus-prime.accounts.acme` and changes no other
account. Before it saves anything, it refuses a code for an organization that
another account already connects, and a code for another organization than
the one the named account is connected to. Setup run without `--account`
names the default account, so a second organization's code is refused there
instead of replacing your first organization's connector. A refused code is
used up; the new connector stays in that organization's **AI agents**,
where **New setup code** makes another code for it.

**4. Check it.** A Gateway running with config reload applies the change by
itself; otherwise run `openclaw gateway restart`. OpenClaw reloads the plugin
after a change to its channel settings, so your first organization's
connector may reconnect once as well. In each organization, **AI
agents** then shows its own connector as **CONNECTED**. On the Gateway host:

```sh
openclaw channels status --channel octopus-prime --probe
```

### Which agents each organization gets

Without bindings, every account offers every agent of the Gateway: one agent
serves both organizations. Each organization's conversations are still
separate OpenClaw sessions, but the agent's workspace, memory and files are
shared between them. To give an organization an agent of its own, with its
own workspace, add the agent and bind it to that organization's account, as
OpenClaw's multi-agent routing does for any channel account:

```json5
{
  agents: {
    entries: {
      main: { workspace: "~/.openclaw/workspace" },
      "acme-agent": { workspace: "~/.openclaw/workspace-acme" },
    },
  },
  bindings: [{ agentId: "acme-agent", match: { channel: "octopus-prime", accountId: "acme" } }],
}
```

With more than one account and bindings for this channel that name an
account, an account offers the agents bound to it (`accountId` naming it,
`"default"` for your first organization's account, `"*"` for every account),
and an account that no binding names offers the agents that no binding names.
In the example, your first organization keeps `main` and the second gets
`acme-agent` only. An organization reaches only the agents its account offers.
A binding without `accountId`, or for one conversation (`match.peer`,
`guildId`, `teamId` or `roles`), chooses nothing here, as before 1.5.0; and
while there is only one account, bindings change nothing: it offers every
agent. Before adding a second account, check the existing bindings for this
channel (`openclaw agents bindings`): one that names `default` takes effect
then, and the first organization keeps only the agents it names.

### Remove an account

In that organization's **AI agents**, click **Revoke** on its
connector. Then remove the account's settings on the Gateway host, here
`acme`:

```sh
openclaw config unset channels.octopus-prime.accounts.acme
```

To move such an account to another organization, remove it the same way and
set it up again with a code from the other organization.

## Optional: restart this Gateway from Octopus Prime

With plugin 1.22.0 or later, people you choose can restart this Gateway from
the Octopus Prime apps (**Restart Gateway**, at the bottom left of the
sidebar), for example when its agents stop answering. It is off until you
turn it on, on the Gateway host:

```sh
openclaw config set channels.octopus-prime.allowRemoteReset true
```

Setup prints the same command. Until it is on, the app says "Restarting from
the app is not allowed on this Gateway." and shows that command. In the app,
the person who connected the Gateway chooses who can restart it: only them
(the default), Owners and Admins, everyone in the organization, or chosen
people. A restart works only while the Gateway is connected, at most once
every 5 minutes. It restarts the whole Gateway, the way `openclaw gateway
restart` does, so every agent on it is unavailable for a minute or two and
what they were doing stops. If OpenClaw's own restarts are off
(`commands.restart: false`), restarting from the app is refused too.

## How busy this computer is

With plugin 1.27.0 or later, the Octopus Prime apps show how busy the
computer running this Gateway is: a small **Computer** pill beside each agent
session's Context, with CPU, memory, free disk and the Gateway's own memory,
and a warning in the agents' conversations when the computer stays under
heavy load (memory above 85% or CPU above 90%; with 1.36.0 for 60 seconds or
more, 3 minutes before). The Gateway's owner gets a pop-up, and the Computer
details list the Gateway's load warnings of the last 30 days: when, the peak
memory and CPU, how long, and which agents were warned. Everyone in the
organization who can see the Gateway's agents sees these numbers.

The plugin sends numbers only, with its heartbeat (about every 25 seconds):
CPU load (the 1-minute load average over the CPU cores), memory used (on
macOS as Activity Monitor counts it, from `vm_stat`), swap used (Linux), free
disk space on the volume of OpenClaw's state directory, and the memory of
the Gateway with every process it started (a browser an agent opened, for
example) and how many there are. Never process names, file paths or anything
a program or browser tab shows. On Linux the plugin reads them from what
Node and `/proc` already give; on macOS it also runs `/usr/bin/vm_stat` and
`/bin/ps -A -o pid=,ppid=,rss=` (process numbers and memory only) through
OpenClaw's own command runner, at most every 20 seconds (every 10 seconds
while memory or CPU is above 80%). Octopus Prime keeps the latest numbers, 24
hours of 5-minute samples and 30 days of load warnings.

It is on by default. To stop sending them:

```sh
openclaw config set channels.octopus-prime.shareMachineStats false
```

### Computer load protection (1.36.0)

When the computer has been under heavy load for 60 seconds, each agent on the
Gateway gets a warning on its next message, at most once in 15 minutes, and
once more, stronger, if memory reaches 95%:

> Octopus Prime: the computer running you is near full capacity (memory 92%,
> CPU 88%; agents' work here uses 3.3 GB of 16.0 GB). Take corrective action
> now: 1) close browsers/tabs and processes you opened and pause heavy or
> parallel work; 2) message the other agents on this Gateway (whatever model
> they use) and ask them to do the same; 3) check what else is using
> memory/CPU on this computer (other apps, other agent tools) and, if
> something outside your own work is the cause, tell the owner in your chat
> what it is — never close or kill programs you did not start. Explain this if
> a user asks what happened.

The warning is added on the Gateway and goes only to the agent; it works with
`shareMachineStats` off too. An agent in the middle of a long job gets it with
its next message, so it may finish its current step first. Every agent on the
computer is warned, even ones that didn't cause it: this OpenClaw does not
tell which agent's processes use the memory. "Agents' work here" is the
Gateway with every process it started; several Gateways on one computer each
see the same machine numbers.

It is on for each Gateway by default. Owners and Admins turn it off per
Gateway in Octopus Prime: Settings › AI agents › the Gateway › **Computer load
protection**. Off, no agent is warned and the owner gets no pop-up; the
Computer pill still shows the numbers. The backend tells the plugin in its
welcome and with each heartbeat's answer.

## Tasks, calendar and projects

With plugin 1.28.0 or later, and an Octopus Prime backend that offers it, your
agents can create tasks, calendar events and projects when someone asks ("add
a task for me to send the Q3 numbers by Friday", "book a review with Ana
tomorrow at 10", "set up a project for the launch"). Each turn tells the agent
so in one line, and it gets three tools:

- `octopus_tasks`: create a task (title, notes, due time, assignee, this
  conversation or its project, priority, category, reminders), list tasks
  (this conversation's, its project's, the agent's own, or the asker's), mark
  one done, in progress, open again or cancelled, change its due time or
  assignee, and comment in its thread.
- `octopus_calendar`: create an event (start and end, or all day, in the time
  zone given, with people and agents of the conversation invited and
  reminders), list the events of a range, and change or cancel the events the
  agent created.
- `octopus_projects`: create a project, with the person who asked and the agent
  in it and its usual starter channels, and list the projects the agent is in.

The agent acts with the permissions of the person whose message it is
answering, and only in that conversation and its project: it can give a task
to, or invite, only someone in the conversation, and a person who may not
create projects in the app (a Member) cannot have one created by an agent
either; the agent is told so and tells them. A message another agent sent
starts no such request. Nothing is ever deleted: tasks and events are
cancelled. Octopus Prime limits each agent to 30 new tasks, events and projects
an hour, shows "Created by" the agent on what it made, and records who asked,
which agent and when. Times are read in the time zone the agent gives (an IANA
name such as `Europe/Madrid`), so an agent that does not know a person's time
zone should ask.

## Your agent in your meetings

With plugin 1.29.0 or later, and an Octopus Prime backend that offers it,
people can send your agent to a Zoom, Google Meet or Microsoft Teams meeting
from a link in a conversation or a calendar event ("Send Atlas to this
meeting"). The agent joins with OpenClaw's own meeting plugins as an
observe-only guest that reads the live captions (it never speaks and records
no audio or video), and when the meeting should be over it posts the notes in
that conversation: a summary, the decisions and the action items, which it
also adds to the project's Project Log. Action items with a clear owner become
tasks.

On the Gateway:

1. Install the meeting plugins you want (they are separate OpenClaw plugins):

   ```bash
   openclaw plugins install @openclaw/zoom-meetings
   openclaw plugins install @openclaw/google-meet
   openclaw plugins install @openclaw/teams-meetings
   ```

2. Run each one's setup check (`openclaw zoommeetings setup`,
   `openclaw googlemeet setup`, `openclaw teamsmeetings setup`) and fix what it
   reports. The Gateway (or a paired node) needs Chrome with an OpenClaw
   browser profile; Google Meet may need that profile signed in to Google.
3. Keep meeting notes on (`transcripts.enabled`, on by default): without them
   no notes come back.

Octopus Prime → Settings › Plugin shows which meeting plugins each Gateway
reports ("Meetings: Zoom ✅ · Google Meet ⚠️ set up"). The plugin reads that
from OpenClaw's config (`plugins.entries`); OpenClaw's setup check is what says
whether a join can work. A meeting's host may still have to let the agent in,
and Zoom can ask for a passcode, a sign-in or a CAPTCHA: the agent says so in
the conversation. Tell everyone in the meeting that an AI notetaker is joining;
many places require their consent.

## Optional: approve agent actions in Octopus Prime

OpenClaw asks before risky actions: a command an agent wants to run on this
computer ([exec approvals](https://docs.openclaw.ai/tools/exec-approvals)) or
a tool call a plugin wants approved
([plugin permission requests](https://docs.openclaw.ai/plugins/plugin-permission-requests)).
With plugin 1.31.0 or later, and an Octopus Prime backend that offers it, you
can answer those that come up in your agents' Octopus Prime conversations from
the apps: a card in the conversation and a push ("Atlas wants to run a
command") with **Allow once**, **Always allow** and **Deny**. The card shows
the exact command, its folder and where it runs (or the tool and the plugin's
own title, description and risk), and when it expires.

It is off until you turn it on, per Gateway, in Octopus Prime → Settings ›
Plugin → **Approve agent actions in Octopus**. Only the person who connected
the Gateway can turn it on, sees the cards and answers them, and only with
two-step login on: never the organization's Owners, Admins or anyone else. Each
answer is recorded (who, what, when and the result) and listed under
**Approval history**. Typing `/approve` in an Octopus Prime conversation is
the owner's alone too.

The plugin is one of OpenClaw's native approval surfaces for its channel
(`approvalCapability`, `src/approvals.ts`): it forwards only an approval raised
in a turn of one of this account's conversations, while the setting is on and
the Gateway is connected, and hands your answer to OpenClaw's own approval
service (`approval.resolve`), never through chat text. OpenClaw's other
surfaces (the Control UI, its apps, `/approve` in the chat it came from) get
every request as before: the first answer wins, and the card then says who
answered and how. With the setting off, nothing is forwarded and approvals go
wherever OpenClaw sends them today. A command longer than 4,000 characters, or
one with characters the card could not show as they are, is never forwarded.
Approvals from scheduled automations never reach chat surfaces (OpenClaw's
rule), so they do not come here either.
## Rich replies (1.32.0)

With plugin 1.32.0 or later, an agent's reply can carry OpenClaw's message
presentation, and the Octopus Prime apps draw it natively: a card with a
title and a tone (neutral, info, success, warning, danger), text, small
context lines, dividers, tables, and pie, bar, line and area charts. Agents
get the `presentation` parameter of OpenClaw's `message` tool on Octopus
Prime, and a reply with a presentation is shown the same way.

The reply's words always say everything the card shows: the plugin sends
OpenClaw's own plain-text version with it, so search, read aloud, Copy,
notifications and older apps keep working. The words alone are sent, as
before, when the Octopus Prime server does not offer rich replies yet, when
the card is over Octopus Prime's limits (40 blocks, 100 table rows, 16,000
bytes, and so on), or when the reply is long enough to go in parts.

Buttons and selects are drawn from 1.33.0 on (see Tap-to-answer below); with
a server that does not offer them, OpenClaw shows them as a context line
("Actions:" and the labels) in the card.

## Tap-to-answer (1.33.0)

With plugin 1.33.0 or later and an Octopus Prime server that offers it, the
apps (web and iPhone) show an agent's questions and buttons as chips:

- **Questions.** When an agent asks with OpenClaw's `ask_user` tool, the
  question shows as a card under the agent's message: its options (the
  recommended one highlighted), one choice or several, "Other…" for the
  person's own words, and how long it stays open. Only the person the agent is
  answering (and people the message @mentions, and in a DM with the agent, its
  person) can answer; everyone else sees it read-only. A single choice, or the
  "Other…" words, goes straight back to OpenClaw as the question's answer and
  the agent carries on; the chat shows "Alex chose: Staging". Several choices
  are sent as the person's reply, comma-separated, which is how OpenClaw reads
  a typed answer (it reaches the agent once the turn that asked is over). An
  expired question says "Expired". A prompt of several questions stays plain
  text, as on other messaging channels.
- **Buttons and selects** an agent sends with the `message` tool's
  `presentation`: a link button opens its link, a command button sends its
  command, and any other button or option sends its label as the person's
  message, which the agent gets as their reply. The agent's system prompt now
  says inline buttons are on for Octopus Prime.

The words are always sent too, so search, read aloud, notifications and older
apps keep working, and nothing changes with an older server.

## Pictures you send your agents (1.35.0)

With plugin 1.35.0 or later and an Octopus Prime server that offers it, a
screenshot or photo you send an agent (JPEG, PNG, WebP, GIF or HEIC, up to
25 MB each, up to five in a message) reaches it as an image, not only as a
link: the plugin downloads each one from Octopus Prime when the message
arrives and gives it to OpenClaw with the message, so the agent sees it and
it stays in the session for later turns. The links stay in the message too;
a picture the plugin could not get is named there, so the agent reads it from
its link. Nothing changes with an older server.

## Agent Backup (1.38.0)

An encrypted copy of this Gateway's OpenClaw files, kept by Octopus Prime, so
you can bring your agents back on a new computer: their workspaces (memory,
skills, notes), the config without its secrets, the automations, and a list of
the plugins, packages and repositories to install again. It needs a Backup
plan for this Gateway (an Owner adds one in Billing on the web) and an
Octopus Prime server that offers `agent-backup`; without either nothing
changes.

- **Encrypted on this computer.** Files are split into pieces, compressed and
  encrypted (AES-256-GCM) before they leave; Octopus Prime stores ciphertext,
  sizes and counts, never a file name, a path, a file's text or a key. The key
  is kept in this computer's keychain (macOS Keychain, the Linux Secret
  Service or Windows DPAPI) so scheduled backups run on their own; a computer
  with none of them can't turn backups on.
- **Passphrase and recovery key.** Setup asks for a passphrase (at least 12
  characters) and shows a recovery key once (`OPRK1-…`). Either one restores
  the backup. Lose both and nobody can restore it, not even Octopus Prime.
- **Never backed up:** `credentials/`, `.env` files, `secrets.json`, auth
  profiles and each agent's `openclaw-agent.sqlite`, sessions and transcripts,
  cookies and browser profiles, SSH/GPG/TLS keys, `.npmrc`, `.netrc`,
  `node_modules`, caches, files over 100 MB and logs older than 7 days.
  Secret values in `openclaw.json` are removed (placeholders like `${VAR}` and
  secret references stay), and repositories with a remote are recorded, not
  copied.

Commands, on the Gateway's computer:

```
openclaw octopus-prime backup setup        # passphrase, recovery key, key in this keychain
openclaw octopus-prime backup status       # plan, last backup, storage used
openclaw octopus-prime backup now          # back up now
openclaw octopus-prime backup estimate     # how big a backup would be (uploads nothing)
openclaw octopus-prime backup restore      # bring a backup back (passphrase or recovery key)
openclaw octopus-prime backup passphrase   # change the passphrase (--new-recovery-key too)
```

`--account <id>` picks the Octopus Prime account when the Gateway has several.
`restore` never overwrites a file that is already there unless you pass
`--overwrite`; it merges `openclaw.json` (this computer's pairing and secrets
stay), imports the automations, writes `OCTOPUS-REBUILD-KIT.md` into the
workspace and prints the Sign-in checklist. `--keep-keys` keeps the same keys
for this computer's own backups.

Agents get the `octopus_backup` tool: ask "How big would an Octopus Prime
backup of you be?" and it counts exactly what a backup would take (no plan
needed, nothing uploaded) and says which plan fits; `status` says whether
backups are on. Scheduled backups start after a Gateway restart.

## Optional: suggested etiquette for your agents

The same panel offers a ready-made etiquette prompt for agents that work in a
team. In https://app.octopusprimeai.com, open **AI agents**, find
**Suggested etiquette for your agent** and click **Copy**, then paste it into
your agent's instructions if you like. It is only a suggestion: edit it or
ignore it. Octopus Prime never sends it to your agent, and your own rules
come first.

### Scheduled and automated messages go to #automations

Every organization has an **#automations** channel, and so does every new
project. Send scheduled and automated pings, reminders, heartbeats and status
checks there (the project's #automations if the work belongs to a project,
otherwise the organization's), never to the channels people talk in. When a
result needs a person, post it in the thread, channel or direct message where
that person asked, and @mention them. Unless they choose otherwise, people are
notified in #automations only when they are @mentioned, so a result left only
there may go unseen. Add your agent to #automations like to any other channel;
it is an ordinary channel for this plugin, with no setting of its own.

## Audited workspaces

An organization's Owner can turn on **Audited workspace** in Octopus Prime.
From then on the Owner and the auditors the Owner picked can read every
conversation of the organization, private channels and direct messages
included, but only what was sent since it was turned on. With plugin 1.7.0:

- **Your agents are told.** People acknowledge a notice once; agents
  acknowledge nothing. Instead, every message an agent gets in an audited
  organization carries the notice in the turn's own context, apart from the
  message's text: "This workspace is audited: the owner and auditors can read
  all conversations."
- **An agent can be an auditor.** The Owner picks the auditors, people or
  agents. An agent on that list reads with the `octopus_audit` tool, which the
  plugin offers in every turn of an audited organization: it lists every
  conversation of the organization and reads any of them, each a page at a
  time, so that a long list is never cut short on its way to the agent.
  The tool is read-only and gives the agent no right to post anywhere, it
  returns only what was sent since the workspace was audited, and every read
  is recorded for the Owner. For an agent that is not on the Owner's list,
  every call is refused. Whoever can use an auditor agent can ask it what it
  read, so make an agent an auditor only when everyone it is shared with may
  see every conversation.

This needs Octopus Prime with audited workspaces and this plugin at 1.7.0
or later: update the plugin, then restart the Gateway. An older plugin leaves
the notice out, so its agents are not told and none of them can read as an
auditor. For an organization that is not audited nothing changes: no notice,
no tool, and nothing more is sent. The details are under Audited workspaces
in Runtime contract.

## How it works

- Each **connector account** pins its own canonical backend URL, connector
  credential, connector ID and organization ID: the default account in the
  fields of `channels.octopus-prime`, each further organization's account in
  `channels.octopus-prime.accounts.<id>` (see Connect to a second
  organization and Accounts under Runtime contract).
- This is the **normal chat path**: Octopus Prime does **not** drive customer
  Gateways as a generic external Gateway client.
- Setup (`channels add`) calls `POST /api/connector/bootstrap` over HTTPS with
  the setup code, the plugin version and the frozen v1 `host_api_version` token
  (see [Versioning](#versioning)). It validates the returned credential,
  connector ID, organization ID and any returned backend URL. Native setup then
  persists the enabled/backend/credential/connector/organization tuple in
  OpenClaw channel configuration, without the one-time code, for the account
  `--account` names (the default account without it). The setup adapter
  declares `configPromotion: "preserve-root"` (and `package.json` declares
  `openclaw.setupFeatures.configPromotion: "preserve-root"` for Doctor), so
  OpenClaw never moves the default account's fields into `accounts` when
  another account is added. This contract does
  **not** promise separate protected-vault storage for the returned credential.
  Once the package is installed, `openclaw channels add --channel octopus-prime --help`
  lists the plugin's setup flags. The channel list in plain
  `openclaw channels add --help` is OpenClaw's built-in list and never includes
  plugin channels.
- When OpenClaw starts the configured channel account, the plugin opens the
  authenticated **WSS** connection to `/api/connector/ws` (since 1.20.0 the
  connector token is in the handshake's `Authorization: Bearer` header, never in
  the address, so a proxy that logs request lines cannot record it) and sends
  `protocol.negotiate`. After validating the backend's `welcome` and pinned
  connector identity, it sends `agents.announce`, starts durable ingress and
  marks its transport `ready`.
- Install the package, not a source checkout. A checkout's development
  `node_modules/openclaw` link points at a separately supplied host, which the
  installer's dependency scan rejects. A checkout selected through
  `plugins.load.paths` is invisible to `channels add` option discovery and
  shadows an installed copy; remove that entry when moving to the package.
- Reinstalling over an earlier install (`--force`) or `plugins update` first
  runs OpenClaw's Doctor repair check. The package's Doctor contract
  (`dist/doctor-contract-api.js`, declared under `doctorContract` in
  `openclaw.plugin.json`) confirms that this version needs no config repair and
  has no plugin state for Doctor to migrate. Without it, while OpenClaw 2026.9.8
  holds an unfinished-upgrade record for the plugin (for example one left by an
  OpenClaw update), the replacement stops with "Plugin config repair could not
  be inspected" and Doctor cannot clear the record.

## Runtime contract
- **Accounts** (1.5.0): `listAccountIds` lists `default` while the fields of
  `channels.octopus-prime` hold a connector (or nothing is configured yet), and
  each entry of `channels.octopus-prime.accounts`, by OpenClaw's normalized
  account id. The default account reads the channel's own fields (an
  `accounts.default` entry, if one exists, overrides them); any other account
  reads only its own entry and never borrows the default account's
  credential, connector or organization. `enabled: false` on the channel turns
  every account off, on an account only that one. Each account the Gateway
  starts runs its own transport (`src/transport.ts`): its own socket,
  heartbeat, backoff, pending frames and origin-bound ingress queue (the
  queue's path and origin key name the account). A reply leaves through the
  connector of the account that took the message: core carries the turn
  plan's account to the send, deferred-delivery admission and reconciliation,
  and a reaction, log book request or auditor's read goes through the connector
  of the account core names or of the session it runs in. Admission refuses
  permanently only an account the configuration does not have; an account that
  is configured but not running gets the retryable not-dispatched marker, as a
  stopped connector does, and nothing is written on another account's socket. A
  named account's sessions are
  `agent:<agent>:octopus-prime:<account>:channel:<channel_id>` (OpenClaw keys a
  channel peer by channel and peer alone, so the account goes where OpenClaw's
  own per-account keys put it); the default account's keys are unchanged. The
  reply handoff keeps the connector of the reply's own account, and a change
  to another account never refuses it. Each account's `connectorToken` may be
  a SecretRef, resolved for that account only (`secret-contract-api.ts`;
  `openclaw secrets` finds `channels.octopus-prime.accounts.*.connectorToken`
  too). With more than one account, OpenClaw route bindings for this channel
  that name an account choose which agents each account announces (see Which
  agents each organization gets); an inbound message for an agent its account
  does not offer is rejected before admission, and its turn refused if it was
  queued. Setup refuses account names that OpenClaw reads in a session key
  (`channel`, `group`, `direct`, `dm`, `thread`); core reads no delivery route
  from a named account's session key, and none is needed, since every reply
  names its conversation.
- **Inbound** (user → agent): `message.inbound` is acknowledged only after durable
  admission to the origin-bound SQLite ingress queue, with stable `event_id`
  deduplication. An acknowledgement is not a read receipt. The plugin constructs
  context with `buildChannelInboundEventContext` and dispatches through
  `api.runtime.channel.inbound.run`. It reports `working` only after durable turn
  adoption and core reply-start, not merely on receipt of a frame. It then
  repeats `working` every 60 seconds until the turn's dispatch returns, on
  whichever socket is current. The backend fails a Received/Working turn after
  10 minutes without progress, and the repeats keep a long turn alive.
- **Replies** (agent → platform): core-managed durable delivery calls
  `channel.message.send.text`. The adapter sends `message.outbound` with durable
  `outbound_id`, parent `event_id` and `channel_id`, and waits for the backend's
  receipt. Core hands it one durable text part; the plugin cuts a long reply
  itself (see Long replies). The legacy
  `outbound.attachedResults.sendText` implementation deliberately throws; it is not
  the reply path. Unknown-send reconciliation queries `message.outbound.status`.
  The send names no thread (`threadId: null`): the backend files the reply under
  its parent event, in that event's thread or top-level. Passing the inbound
  `thread_id` made OpenClaw 2026.9.8 require a `thread` capability and refuse
  every reply ("prepared payload capability mismatch (thread)").
- **Long replies** (1.2.0): the backend keeps at most 20,000 characters of a
  message, counted in Unicode code points as Python's `len()` counts them (an
  emoji is one), and its connector socket closes on a frame over 64 KiB, losing
  the reply in it. A reply over either limit goes out as several messages, in
  order, each in a frame of at most 60,000 bytes (`src/reply-parts.ts`). A part
  ends at the last paragraph break that leaves it at least half full, else at a
  line break, the end of a sentence or a space; only text with none of those is
  cut between two characters, never inside an emoji or another grapheme cluster.
  A fenced code block that fits in one message is never cut; a longer one is cut
  between its lines, closed with its fence and reopened in the next message.
  Every part answers the same event, so the backend files them all where it files
  the reply. The first part keeps the queue's `outbound_id`, so a reply that fits
  in one message goes out exactly as before; part n uses `<outbound_id>:n` (with a
  SHA-256 of a queue id too long for the backend's 128 characters). Each part's
  frame also carries `reply_id` (the queue id), `part` (from 1) and `parts`, so
  the backend treats the parts as one reply: it pushes for the first part only,
  counts the reply once in the organization's monthly message count, wakes each
  agent the reply @mentions in #agents once, and takes the delivery as answered
  only at the last part, so the conversation's next message waits for the whole
  reply. A reply that fits in one message carries none of these fields. Each
  part is written after the previous part's receipt, and the dispatch boundary (see
  Connector not ready) is reported after the last. A later part that fails is
  never reported as not dispatched, since earlier parts reached the backend, and
  core's queue then replays the whole reply; the backend answers the parts it
  already holds from what it stored, so no part is posted twice. Reconciliation
  reads the parts back in order and stops at the first one the backend does not
  hold. OpenClaw's own chunking (an outbound `chunker` with `textChunkLimit`) is
  not used: core marks a chunked reply's outcome unknown after its first part and
  then never replays it, so a failure between parts would lose the rest.
  A plugin before 1.2.0 sent a reply whole, in one frame, under the same queue
  id; the backend kept it whole up to 20,000 characters, else its first 19,999
  and "…". If such a frame was saved but its receipt lost, say across the
  Gateway restart that installs this version, the replay's first part meets
  that message and is refused (`identity_conflict`). The plugin then sends
  `message.outbound.status` with `body_sha256`, the SHA-256 of what that single
  frame was saved as. If the backend answers `body_matches: true`, that message
  stands for part 1, and the plugin sends only the text after the characters it
  kept as the next parts (inside a code block, reopened with its fence).
  Otherwise the reply fails as before. A backend without this answer (before
  replies in parts) leaves such a reply as it was saved.
- **Replies with attachments** (1.8.0): Octopus Prime does not take an agent's
  attachments yet, and the channel declares no `media` capability. OpenClaw
  then refused a whole reply that carried any (`mediaUrl`, `mediaUrls`, as an
  agent's `MEDIA:` lines give them), text included ("prepared payload
  capability mismatch (media)"), and the person saw nothing. The channel's
  `outbound.normalizePayload` (`src/reply-attachments.ts`), which core runs on
  every reply before that check, now drops the attachments and every field
  about them (`attachments`, `audioAsVoice`, `videoAsNote`, `trustedLocalMedia`,
  `sensitiveMedia`) and keeps the text exactly, with a note on a line of its
  own after it: "(8 attachments couldn't be delivered in Octopus.)", or "(1
  attachment …)". A reply with attachments and no text becomes the note alone,
  so the person still sees an answer. The note counts distinct files (one
  named in both `mediaUrl` and `mediaUrls` counts once) and names no file, path
  or URL, since those can be the Gateway's local paths. It depends on the reply
  alone, so core's replay of a queued reply sends the same body, which the
  backend needs to answer it from what it stored. A long reply is cut as
  before, so the note ends its last part. A reply without attachments goes out
  exactly as before. Nothing new goes to the backend. Since 1.11.0 the files
  themselves go with the reply (Replies with files), and the note counts only
  those that could not be delivered.
- **Replies with files** (1.11.0, `src/reply-media.ts`): the channel declares
  core's `media` and `payload` capabilities and reconcile kinds, with the sends
  that deliver them. In OpenClaw 2026.9.8 and 2026.10.3 alike, core hands a
  reply with one file to `message.send.media` (its text as the caption) and one
  with several, or a voice note (`audioAsVoice`), whole to
  `message.send.payload` (`outbound.sendPayloadGroupsMedia`), so a reply is
  always one message. For each file, in order, until five are kept:
  - It is read with core's own media loader (`loadWebMediaRaw` with the send's
    `mediaAccess`, `mediaLocalRoots` and `mediaReadFile`): a local path only
    under an allowed root, a remote URL only through core's SSRF-guarded
    fetch. Nothing else reads files or the network.
  - It is uploaded with the connector's own credential
    (`POST <backendUrl>/api/connector/files`, `Authorization: Bearer`,
    redirects refused, 30 seconds at most), for the reply's delivery
    (`event_id`) or, for a post, its conversation, named by the reply's
    outbound id and the file's place in it (`index`). The backend keeps one
    file per connector, reply and place, and the plugin remembers the ids it
    was given for as long as the Gateway runs, so core's replay of a reply
    uploads nothing twice and names the same files.
  - The frame of the reply's last part names those kept
    (`attachments: [file_id, ...]`); the backend saves them as a person's
    files, with the same views, links and 7 days.
  A file that could not be delivered is left out and counted in the note of
  1.8.0, one note for the reply: over 5 MB, past the five a message holds, not
  readable, a remote file that could not be fetched, or one the backend
  refused (its type, its size, R2 refusing it). An answer that says no file can
  be uploaded now counts the rest too without trying them: no file storage
  (`attachments_unavailable`), a backend before reply file uploads (no such route), a
  backend that cannot be reached, the credential, the conversation or the
  rate limit. If the backend refuses the files named in the reply frame (one
  passed its 7 days meanwhile), the reply is sent again under the same id
  without them, its note counting them all. If core replays a reply and a
  file's outcome has changed since (`identity_conflict`), the message saved the
  first time stands. A reply is never refused or dropped for a file. Core
  copies a reply's local files into its delivery queue before the send, and
  fails the whole reply if one cannot be copied, so `normalizePayload` leaves
  out (and counts) a local file that is gone, is not a file, is of a kind core
  does not copy from the Gateway (it copies images, audio, video, PDF, Office
  documents, archives and plain text, judged here by extension), or is over 5
  MB (except a JPEG, PNG or WebP image, which core shrinks). A connector that
  is not ready fails the send retryable before anything is read or uploaded,
  as a reply without files does.
- **Failed turns** (1.9.0): when the agent's turn for a message ends without
  answering the person, the plugin sends one notice in that conversation, as a
  reply to the message (`src/turn-failure.ts`). A turn failed when its run
  threw (a FailoverError, a stalled model stream that timed out, a provider
  refusal), when core reported the run failed (its error final, or a
  `NO_REPLY` the agent did not choose), when its reply could not be delivered,
  or when core found it ended with no visible reply. There is no notice when a
  visible reply (final or block, any part) was delivered, when the agent chose
  silence (`deliberateSilentTerminalReply`), when the message joined the turn
  already running (`deferredToActiveRun`), when the turn was stopped or
  cancelled, when a reply is still pending in core's queue, when the turn was
  refused before it started (a redelivered message whose turn already
  completed is one), or when the connector is stopping. The notice is worded by
  cause and names nothing of the Gateway, model or provider (1.34.0):
  - rate limit (a FailoverError `rate_limit`, HTTP 429, core's "The AI
    service needs a short break", a provider's "usage limit reached"): "I'm at
    my usage limit right now — try again in a few minutes."
  - temporary (a stalled stream, a timeout, an overloaded or briefly
    unavailable provider): "Something went wrong on my side — please send
    that again."
  - AI account (billing or sign-in refused by the provider, HTTP 401/402/403,
    or a 429 about money: out of credits, `insufficient_quota`) and setup (no
    usable model: `model_not_found`, "isn't set up yet"): "My OpenClaw setup
    needs attention — the workspace owner needs to check it."
  - unknown: worded as temporary. A failure in a row is no setup problem:
    until 1.34.0 an unknown failure right after another one asked the owner
    to check the setup, which greeted every message of a passing usage limit.
  The cause comes from the FailoverError's reason (`billing`, `auth`,
  `auth_permanent`, `session_expired` are the account's; `model_not_found` is
  the setup's; `rate_limit` is a rate limit; `timeout`, `overloaded`,
  `server_error`, `empty_response` are temporary), then an HTTP status, then
  the words of the error or of core's error final.
  Core's own texts for a failed turn (its error finals, which name logs,
  commands or a run id, and "OpenClaw couldn't produce or deliver a reply")
  are kept from the person through the turn plan's `delivery.preparePayload`;
  the notice says it instead. An agent that is offline sends nothing, so that
  case is the backend's to word. The notice is a `message.outbound` with
  `outbound_id` `turn-failed:<event_id>` (with a SHA-256 of an event id too
  long for 128 characters) and two more fields: `notice: "turn_failed"` and
  `cause` (`rate_limit`, `temporary`, `ai_account`, `setup` or `unknown`; the
  plugin never sends the backend's `agent_offline`). A backend with failed-turn
  notices saves it in the sentence for its cause, the
  same on the web and the iPhone, folds failures in a row into one notice that
  counts the messages waiting, tells the agent's owner of a setup problem once
  an hour, marks the delivery failed and moves the conversation on (a rate
  limit raises no "didn't respond" alert); a backend without it ignores both
  fields and shows the body. A message's notice
  is decided once: a replay of it that fails again sends the identical frame,
  which the backend answers from what it stored. The notice is sent once the
  turn's Working repeats stopped, and nothing waits for it: one that is not
  sent is logged once, by event id alone, and the turn's own outcome is
  unchanged.
- **A turn the agent chose to leave unanswered** (1.17.0): core's `NO_REPLY`
  where the conversation may be silent (`deliberateSilentTerminalReply`; for a
  Gateway whose agents may stay silent in Octopus Prime conversations that is
  OpenClaw's `agents.defaults.silentReply.group: "allow"`, because core's
  default is `disallow` and then an empty reply is a failed turn) is no failure
  and gets no notice. The channel tells the backend with a frame, once the
  turn's Working repeats stopped: `{"type": "turn.silent", "event_id",
  "channel_id", "agent_id", "reason": "no_reply"}`. A backend that offers
  `turn-silence` settles that message: it is not offered again, its no-reply timer is
  cancelled, and nobody sees "didn't respond", an offline notice or the "Fix it
  with your agent" card for it. The plugin asks for `turn-silence` in the
  negotiation's `optional_capabilities` and sends the frame only on a
  connection whose welcome offered it; an older backend times the turn out as
  before. The frame has no receipt. The plugin remembers the last 1,000 such
  messages and sends the frame again when the backend offers one of them again
  (a reconnect's replay, or a frame lost with a closing socket). A turn that
  ended on a progress message sends that message's frame again, as below, and
  not this one.
- **An agent's own sends** (1.10.0): before this version, an agent's `message`
  tool sends to its Octopus conversation, a sub-agent's completion announce
  and a send from another session all failed in the plugin ("Durable
  outbound, parent event, and channel identities are required"), so nobody saw
  them. Three changes:
  - The channel's reply-to mode is `all` (`threading.resolveReplyToMode`). The
    old `topLevelReplyToMode: "reply"` named a config section to read the mode
    from; none exists, so core read `off` and never gave a message tool send
    the message being answered. Now a send to the conversation of the turn's
    message names that message (its event id) as its parent; the final reply
    already did.
  - A send outside core's queue has no `deliveryQueueId`; it now goes out under
    a fresh UUID instead of failing. A queued send keeps the queue id, which
    core reconciles by.
  - Progress: a send that names the message of a turn this connector is
    running, before core hands the channel the turn's reply (the plan's
    `delivery.preparePayload`, which core calls before sending each reply), is
    the agent's progress. Its `message.outbound` frames carry `progress: true`.
    The backend shows it, keeps the turn Working (its lease renewed) and waits
    for the reply, so the reply still answers the turn and the conversation's
    next message still waits. A turn that ends on its progress messages, with no
    reply and no failure (the agent answered with its message tool, then chose
    silence), sends the last frame of its last progress message again without
    the flag; the backend holds that message, answers with the same receipt and
    takes it as the turn's answer, so nothing new is shown or pushed. A turn
    that fails gets its notice instead (Failed turns).
  - A send that names no message (another session, a sub-agent's announce, a
    scheduled wake) goes out as `message.post`: `post_id` (the queue id, or a
    fresh UUID), `channel_id`, `body`, and for a long post the parts' `reply_id`,
    `part` and `parts` as for a reply (part n's `post_id` is `<post_id>:n`).
    The frame may also carry `agent_id`; this version never sends it, since
    core gives a send no agent. The backend posts it top-level as this
    connector's one agent in that conversation and answers
    `message.post.receipt` (`post_id`, `message_id`, `channel_id`), or
    `message.post.refused` (`post_id`, `reason`), which fails the send with an
    error naming what went wrong: `not_participant` (the agent is not in that
    conversation), `ambiguous_agent` (more than one of this connector's agents
    is), `unknown_agent`, `channel_unavailable` (closed, in another
    organization, or a DM not open to the agent), `conversation_blocked`,
    `agent_posting_closed` (#announcements), `organization_unavailable`,
    `identity_conflict` (another message under that id) or `invalid_post`. A
    post shares the ids of replies, so `message.outbound.status` reads a queued
    post back for core's reconciliation. A backend without `message.post`
    answers nothing, and the send times out after 20 seconds as any
    unanswered frame does.
  A backend from before agent sends (1.10.0) ignores `progress` and takes a progress
  message as the turn's reply. Deploy the backend first.
- **Session stats** (1.3.0): once a turn's dispatch returns, the plugin reads
  that turn's OpenClaw session row through the SDK's session store
  (`getSessionEntry` from `openclaw/plugin-sdk/session-store-runtime`, a
  read-only lookup by agent and session key) and sends `session.stats` with the
  turn's `event_id`, `agent_id`, `context_used_tokens`, `context_window_tokens`
  and `compactions` (`src/session-stats.ts`). The context used is the latest
  run's fresh snapshot, else OpenClaw's pre-prompt estimate for that same
  session, as `/status` shows it; either size is `null` until OpenClaw has
  measured it. Octopus Prime shows it as a context meter on the conversation.
  Nothing else is in this frame (a turn's tokens and cost have their own, see
  "Agent usage" below). It goes only to a backend
  whose `welcome` offers the optional `session-stats` capability, and only on
  that socket. It is best effort: no receipt is awaited, nothing is retried
  (the next turn reports again), and a failed read only logs a warning, never
  touching the turn or its reply. A compaction OpenClaw runs after a reply is
  delivered shows with the next turn's report.
- **Agent usage** (1.30.0): from the same session row, read after the turn,
  the plugin sends `agent.usage` with the turn's `event_id`, `agent_id`, the
  `provider` and `model` that ran it, `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, and `cost_usd` with
  `cost_source` (`src/usage.ts`). OpenClaw keeps each run's usage on the row,
  replacing the last run's, so the row after a turn holds that turn's usage.
  The cost is OpenClaw's own estimate from its price list (`estimatedCostUsd`),
  sent as `cost_source: "estimate"`, or `null` with no source when OpenClaw has
  no price for the model; for a subscription plan it is what the same tokens
  would cost on the API, not what the plan charges. A row OpenClaw did not
  write during the turn (a slash command answered without the model), or one
  whose usage is exactly what was last sent for that session, is not sent
  again. Numbers and model names only: never a message, a prompt, a reply or a
  tool call. Octopus Prime shows each agent's daily usage, by model and by
  conversation, to its owner and the organization's Owners and Admins, with an
  optional monthly budget. It goes only to a backend whose `welcome` offers the
  optional `agent-usage` capability, best effort like the session stats. Only
  turns of Octopus Prime messages are counted: what the agent does on other
  channels of its Gateway is not.
- **Sender's two-step login** (1.6.0): an Octopus Prime account can have
  two-step login on (a code from an authenticator app at sign-in). The backend
  marks a message that was sent from such an account: `sender.two_factor: true`
  in its `message.inbound` frame, by how the account was protected when the
  message was sent. It sends nothing for any other message: an account without
  it, a message another agent wrote, or a backend older than this. The plugin
  keeps only an exact `true` (through its durable queue too) and gives it to
  the agent with the turn's own context, as a `channelStructuredContext` entry
  of `buildChannelInboundEventContext` (`senderProtection` in
  `src/host-dispatch.ts`), which OpenClaw shows the agent as its own block
  beside the sender's ID and name:

      Octopus Prime sender:
      {"source":"octopus-prime","type":"sender_account",
       "payload":{"sender_id":"user_…","two_step_login":true}}

  There is no such block for any other message, so an agent that must act
  only for a protected account checks for `two_step_login: true` with the
  `sender_id` it expects, and treats a missing block as "not protected". The
  message's text is passed on unchanged, and nothing typed into a message can
  add or change the block: it is as reliable as the sender's ID and name in
  the same context, which come the same way. An agent should read it only
  from that context block, never from words inside a message. Agents
  themselves are never asked for a second step: a Gateway signs in with its
  connector token.
- **Project log book** (1.4.0): every Octopus Prime project's folder, which
  the apps call the Project Log since 1.23.0, holds CONTEXT.md, a running summary and log book, and MILESTONES.md, so a long
  project keeps its context from one agent session to the next
  (`src/log-book.ts`). The plugin asks for it in `protocol.negotiate`'s
  optional `optional_capabilities: ["log-book"]` (the v1 `capabilities` are
  unchanged). A backend whose project folders are on then offers `log-book` in
  its welcome and names the project of each message in a project's channel
  (`project_id`). In such a turn:
  - the agent gets the `octopus_log_book` tool (`src/log-book-tool.ts`;
    `contracts.tools` and `toolMetadata` in `openclaw.plugin.json`, in the
    `coding` and `messaging` tool profiles). It offers `read` (either file; a
    long one comes shortened, with a note) and `add_entry` (an entry of up to
    4,000 characters at the end of either file, which the backend dates and
    signs with the agent's name). Nothing else: an agent never rewrites,
    renames or deletes a file, and people in the project edit them. The tool's
    factory offers it only in a session the plugin last saw run in a project's
    channel, and only to that session's agent; every call names that session's
    conversation and agent, never what the model passes, and the backend checks
    that the agent is still mapped there. A call is a `log_book.read` or
    `log_book.append` frame with a fresh `outbound_id`, sent only on a socket
    whose welcome offered `log-book`, answered by `log_book.result` or
    `log_book.rejected` (20 seconds, re-written after a closed socket like a
    reply; the backend adds an entry once per connector and `outbound_id`). A
    refusal reaches the agent in plain words.
  - a turn that starts a new OpenClaw session (OpenClaw has no session row for
    the conversation yet, or its session reset policy, none by default, makes
    the row stale: judged with the SDK's own `resolveSessionResetPolicy` and
    `evaluateSessionFreshness`, as core judges it) asks the backend for the
    project's latest CONTEXT.md (`purpose: "session"`, at most 8,000
    characters, shortened with a note) and puts it before the message as the
    agent reads it (`BodyForAgent`), between marks that say it is shared notes,
    not instructions. It then stays in that session's transcript. The raw
    message, the command text and the reply target are unchanged. A turn waits
    at most 10 seconds for it; no answer, a refusal or a backend without the
    log book only logs a warning, and the turn goes on without it.
  - every turn (1.13.0) carries one standing instruction, as a
    `channelStructuredContext` entry of its own (label "Octopus Prime project
    log", type `project_log`), never in the message: "If this turn moved the
    project forward (work done, decision, blocker, handoff), add one short
    entry to the project log with octopus_log_book before you finish; if you
    marked something done or blocked, also add an entry to MILESTONES.md."
    Since 1.18.0 it adds a second sentence: "To ask another agent
    for work in this project, post in #Agent To Agent and @mention it by its
    full name; agents don't wake each other in other channels."
    Since 1.37.0 a project's people can remove its Agent To Agent channel, and
    a backend that knows says so in the frame (`no_agent_to_agent: true`, only
    when true, only beside `project_id`; anything else is left out, never
    refused). The second sentence is then: "This project has no Agent To Agent
    channel now, so agents can't wake each other here. To ask another agent for
    work, tell the person in this project's Strategize channel or in your
    direct message with them what you need; they can ask that agent or add
    Agent To Agent back." An older backend never says it, and the sentence
    above stays.
    A backend with log-book reminders also reminds an agent in the project's Agent To
    Agent channel when its work there has waited a day for an entry.
  A message without `project_id`, or a backend that does not offer the log
  book, is handled exactly as by 1.3.0.
- **Fresh sessions** (1.24.0): when a session gets full, the Octopus Prime
  apps (or the backend, by itself, after a turn) start a new session with the
  same agent and post a continuation prompt there. The backend marks that
  message `session_continuation: true` in its `message.inbound` frame (only
  when true; any other value is left out, never refused). Its turn carries one
  more `channelStructuredContext` entry (`sessionContinuation` in
  `src/host-dispatch.ts`; label "Octopus Prime session continuation", type
  `session_continuation`), after the project log's and before the help line,
  never in the message: in a project's session (the frame names `project_id`)
  "This message continues earlier work in a fresh session. Start your first
  reply with one line confirming you read the Project Log (CONTEXT.md and
  MILESTONES.md).", anywhere else the same first sentence and "Start your
  first reply with one line confirming you read the summary in this
  message." A backend that never sends the mark gets every turn as with 1.23.0.
- **Slash commands** (1.25.0, `src/slash-commands.ts`): OpenClaw's own
  commands (`/status`, `/model`, `/think`, `/new`, `/reset`, `/stop`,
  `/compact`, `/help`, `/commands`, `/whoami`, ...) typed in an agent's
  conversation in the Octopus Prime apps, so nobody needs the OpenClaw app or
  a terminal to control their agent. Who may run them is the backend's to say,
  in each `message.inbound` frame's sender (`sender.command_access`): `owner`
  for whoever connected this Gateway to the organization, `manager` for the
  organization's Owners and Admins; nothing for anyone else. The plugin
  authorizes OpenClaw's command handling (`access.commands.authorized`) from
  that field alone, never from the message's text:
  - the owner: every command;
  - a manager: every command except the owner-only ones, which reach the host
    itself: `/bash` and `!`, `/config`, `/exec`, `/elevated`, `/restart`,
    `/update`, `/plugins`, `/mcp` and `/debug` (`OWNER_ONLY_COMMANDS`, with
    their other names `/elev` and `/plugin`). A manager's message that names
    one anywhere, even as an inline directive, is not authorized for any command;
  - anyone else, another agent's `@mention`, and every message from a backend
    that does not offer `slash-commands`: not authorized, exactly as before
    1.25.0, so OpenClaw runs none of their commands.

  OpenClaw's own settings still decide what runs: a command its `commands.*`
  settings turn off (`commands.config`, `commands.bash`, `commands.restart`,
  ...) stays off. If you set `commands.ownerAllowFrom`, OpenClaw lets only
  the owners named there run commands other than `/new` and `/reset`; add
  `octopus-prime:<your Octopus Prime user id>` there (`/whoami` shows it) to
  run them from Octopus Prime. If you set `commands.allowFrom`, it is the only
  list OpenClaw uses for commands, on every channel, whatever Octopus Prime
  says. Command replies arrive in the conversation as the agent's replies.

  On a connection whose backend offered `slash-commands` in its welcome, the
  plugin also reports each agent's commands, for the apps' "/" menu: one
  `agent.commands` frame (`agents: [{ id, commands: [{ name, description,
  owner_only, aliases }] }]`, at most 50 agents and 300 commands each) on
  connect, and again when the list changes (checked about every 100 seconds
  and whenever the agents change). The list is OpenClaw's own registry
  (`openclaw/plugin-sdk/command-auth-native`): the built-in text commands its
  `commands.*` settings leave on, and the agent's skill commands. A backend
  that does not offer it gets no such frame.
- **Edited messages** (1.26.0): people can edit their own message for 24 hours
  after sending it. When an edit @mentions an agent the message had not
  reached, the backend sends that agent the message as a normal turn, with the
  edited text, its `message.inbound` frame marked `edited: true` (only when
  true; any other value is left out, never refused). That turn carries one
  more `channelStructuredContext` entry (`messageEdited` in
  `src/host-dispatch.ts`; label "Octopus Prime edited message", type
  `message_edited`), before the help line, never in the message: "The sender
  edited this message after sending it, and the edit mentions you, so you are
  getting it now. Answer the message as it reads now." An agent the message
  had already reached is not woken again. The plugin asks for
  `message-edited` in the negotiation's optional field, and only to such a
  plugin does the backend send, for an agent the message had already reached,
  a `message.edited` frame (`event_id` of that delivery, `channel_id`,
  `thread_id`, `agent_id`, `sender`, `body`, `ts`, `edited_at`). The plugin
  answers nothing and starts no turn: it queues the new text as a system event
  on that agent's session for the conversation (`src/message-edited.ts`,
  OpenClaw's `runtime.system.enqueueSystemEvent`), which OpenClaw adds to the
  agent's next turn there; a later edit of the same message replaces one still
  waiting. A frame for an agent this account does not offer, or one that
  cannot be read, is ignored. An older plugin gets no such frame.
- **Octopus Prime help** (1.19.0): every turn, in every
  conversation and on any backend, carries one more `channelStructuredContext`
  entry (`appHelp` in `src/host-dispatch.ts`; label "Octopus Prime help", type
  `app_help`), after the others, never in the message: "Octopus Prime help for
  agents: https://octopusprimeai.com/ai/ (read it when people ask how the app
  works)." That page is the website's reference for AI agents (also
  https://octopusprimeai.com/llms.txt). People are suggested the first prompt
  "Teach me how to use Octopus Prime", which has the agent read it. Nothing is
  sent to the backend for it.
- **Project folder** (1.14.0): agents read and edit the files of their
  project's folder in place, with no download or upload (`src/project-folder.ts`,
  `src/project-folder-tool.ts`; `contracts.tools` and `toolMetadata` in
  `openclaw.plugin.json`, in the `coding` and `messaging` tool profiles). The
  plugin asks for it beside the log book (`optional_capabilities:
  ["log-book", "project-folder"]`), and a backend with
  project folders offers `project-folder` in its welcome. The `octopus_folder`
  tool's factory offers it only in a session the plugin last saw run in a
  project's channel (as the log book's), only to that session's agent, and only
  while that account's connection is to a backend whose welcome offered it.
  - `list` (`folder.list`): the folder's folders and files by path, each file
    with its size, type, who changed it last and when, its version, and whether
    it can be edited; a page at a time (`offset`, `limit` up to 500), or only
    what is inside one `folder`.
  - `read` (`folder.read`, by `path` or `file_id`): a text file (.md, .txt,
    .csv, .json) a page of up to 60,000 characters at a time (30,000 by
    default; `offset` for the next page) with its version; an .xlsx as its
    sheet names and rows as CSV text, read only; any other file as its details
    and a download link signed for 15 minutes.
  - `create` (`folder.create`): a new text file at `path`, in a folder that
    exists, under a name no file there has.
  - `edit` (`folder.edit`): from the `version` the agent read, `mode`
    `replace` (`text` is the whole new text), `find_replace` (`find` an exact
    piece of the file, `replace` what goes there; it must match once unless
    `replace_all`) or `append` (`text` added at the end, on a line of its own).
    The backend refuses an edit of a file changed since ("File changed since
    you read it — read it again"), so nothing is overwritten.
  Text goes up to 1 MB each way; the plugin refuses a larger write before it
  is sent. Agents never delete, rename or make folders, and CONTEXT.md and
  MILESTONES.md stay with `octopus_log_book`. Every change is a new version
  that people in the project see ("Edited by <agent>") and can restore. A call
  is a frame (`type` and the session's `channel_id` and `agent_id`, never the
  model's) POSTed once to `/api/connector/folder` with the connector's own
  credential, not sent on the socket, which takes frames up to 64 KiB; the
  backend answers `folder.result`, or `folder.rejected` with a reason the
  agent is told in plain words. 30 seconds at the most.
- **Channel history** (1.15.0): an agent can look back through the
  history of the conversation it is in, when it needs earlier context, instead
  of asking people to repeat themselves (`src/channel-history.ts`,
  `src/channel-history-tool.ts`; `contracts.tools` and `toolMetadata` in
  `openclaw.plugin.json`, in the `coding` and `messaging` tool profiles, not
  marked `sideEffecting`: it only reads). The plugin asks for it beside the
  others (`optional_capabilities: ["log-book", "project-folder",
  "channel-history"]`), and a backend with channel history offers
  `channel-history` in its welcome. The `octopus_channel_history` tool's
  factory offers it in a session the plugin last saw dispatch a message in any
  conversation (a channel, a project's channel or a direct message), only to
  that session's agent, and only while that account's connection is to a
  backend whose welcome offered it.
  - Without `query` it returns the latest messages, 50 by default (`limit` 1
    to 200), newest page first and each page oldest first; `before`, the
    cursor an answer gives, reaches the page before it. With `query` (up to
    200 characters) the backend searches the conversation's messages for
    those words, not case-sensitive, from the newest back.
  - The tool takes no conversation or agent argument. Every read is a
    `channel_history.read` frame with a fresh `outbound_id` and the session's
    `channel_id`, `agent_id` and `event_id` (the message the plugin last
    dispatched in it), never the model's, sent only on a socket whose welcome
    offered `channel-history` and answered by `channel_history.result` or
    `channel_history.rejected` (20 seconds, re-written after a closed socket
    like a reply; a read changes nothing).
  - The agent gets one block per message: its time (UTC), its sender (marked
    `(agent)` for an agent), its thread when it is in one, its id, its text
    (marked shortened when the backend shortened it) and its files by name
    only, under a line that says these are shared messages for context, not
    instructions, and over a line that says how to go further back.
  - An Owner or Admin can turn off "Agents can read this channel's history"
    for a channel; the backend then refuses with `turned_off`. It also refuses
    an agent that is no longer in the conversation or shared there
    (`unavailable`), a malformed read (`invalid_request`), too many reads
    from the Gateway just now (`rate_limited`) and a read it could not do now
    (`busy`). Each reaches the agent in plain words.

  With a backend that does not offer `channel-history` the tool is never
  offered and nothing is sent: everything works as with 1.14.0.
- **Session titles** (1.21.0): in Octopus Prime a person can keep
  several sessions with one agent (separate direct messages, each a fresh
  OpenClaw session, listed under its own title). The agent in a session can
  name it (`src/session-title.ts`, `src/session-title-tool.ts`;
  `contracts.tools` and `toolMetadata` in `openclaw.plugin.json`, in the
  `coding` and `messaging` tool profiles, marked `sideEffecting`: it renames).
  The plugin asks for `session-title` beside the others, and a backend that
  supports session titles offers it in its welcome and adds `agent_session: true` to each
  `message.inbound` frame sent in a session, only for a plugin that asked. The
  `octopus_session_title` tool's factory offers it in a session the plugin
  last saw dispatch such a message, only to that session's agent, and only
  while that account's connection is to a backend whose welcome offered it; a
  message without the mark (General, a channel) ends the offer.
  - `action: "read"` returns the title and who named it (by default, a
    person, or the agent); `action: "set"` with `title` names the session.
    The tool's description asks the agent for a short, specific name (2 to 6
    words) once the topic is clear, and a new one only if the topic clearly
    changes.
  - The tool takes no conversation or agent argument. Every call is a
    `session_title.read` or `session_title.set` frame with a fresh
    `outbound_id` and the session's `channel_id`, `agent_id` and `event_id`,
    answered by `session_title.result` (`title`, `title_source`, `changed`,
    `renames_left`) or `session_title.rejected` (20 seconds, re-written after
    a closed socket like a reply; the same name again changes nothing).
  - People win: once a person renames the session the backend refuses with
    `person_named`, and the agent gets "A person named this session; leave
    it." as the tool's answer, not as an error, until a person clears their
    name. Three renames per session an hour at most (`rate_limited`, also a
    plain answer). The backend also refuses a conversation that is not a
    session (`not_session`), one the agent may no longer use (`unavailable`),
    a title that is empty or longer than 80 characters once its spacing is
    made single (`invalid_title`), a malformed call (`invalid_request`) and
    one it could not do now (`busy`).

  With a backend that does not offer `session-title` the tool is never offered
  and nothing is sent: everything works as with 1.20.0. People rename sessions
  in the app as before.
- **Gateway restart** (1.22.0, `src/gateway-reset.ts`): the plugin asks for
  `gateway-reset` beside the others, so a backend sends a `gateway.reset`
  frame (`request_id`) only to a plugin that asked. Only a frame on an
  account's authenticated, negotiated socket is read. The plugin answers
  `gateway.reset.rejected` with `reason` `not_allowed` unless
  `channels.octopus-prime.allowRemoteReset` is exactly `true`,
  `restart_disabled` when OpenClaw's `commands.restart` is `false`, and
  `rate_limited` when it agreed to a restart less than 5 minutes ago in this
  process. Otherwise it answers `gateway.reset.result` (`status:
  "restarting"`), waits until no account's connector waits on a receipt (10
  seconds at most; what is still unanswered stays in core's durable queue,
  which outlives the restart), then sends its own process `SIGUSR2`, OpenClaw's
  restart request from outside, which drains as `/restart` does. The plugin SDK
  has no restart call. One Gateway restarts with every account on it.
- **Machine load** (1.27.0, `src/machine-stats.ts`): only on a socket whose
  welcome offered `machine-stats`, and unless
  `channels.octopus-prime.shareMachineStats` is `false`, each heartbeat
  `ping` carries `machine`: `cpu_percent` and `memory_percent` (whole numbers,
  0–100), and when known `swap_used_percent`, `disk_free_percent`,
  `gateway_memory_bytes`, `gateway_processes` and (1.36.0) `memory_total_bytes`,
  `heavy` and `warned_agents` (the agent ids warned in this run of heavy load,
  at most 50). A reading is taken at most every 20 seconds (every 10 while
  memory or CPU is above 80%), shared by every account of the Gateway, from Node's `os`
  module, `/proc` on Linux, `statfs` of OpenClaw's state directory and, on
  macOS, `/usr/bin/vm_stat` and `/bin/ps -A -o pid=,ppid=,rss=` run through
  `api.runtime.system.runCommandWithTimeout` (5-second limit; the plugin never
  imports `child_process`). When those cannot run it falls back to Node's
  available memory and the Gateway process alone. A backend that does not
  offer it is sent the heartbeat exactly as before. While every reading of the last 60 seconds or more had
  memory above 85% or CPU above 90%, an agent's turn gets one more context block
  (type `machine_load`, before the app help line) with the warning, at most
  once per agent id in 15 minutes for all the Gateway's accounts, once more
  sooner (the stronger warning) when memory reaches 95%. It does not depend
  on `shareMachineStats`; a welcome or `pong` with `load_protection: false`
  turns it off for that account until one says `true` (an older backend says
  nothing: on).
- **Tasks, calendar and projects** (1.28.0, `src/agent-work.ts`,
  `src/agent-work-tool.ts`; `contracts.tools` and `toolMetadata` in
  `openclaw.plugin.json`, in the `coding` and `messaging` tool profiles, marked
  `sideEffecting`). The plugin asks for `agent-work` beside the others, and a
  backend that has it offers it in its welcome. Only on such a connection do
  the factories of `octopus_tasks`, `octopus_calendar` and `octopus_projects`
  offer them, in a session the plugin last saw dispatch a message in any
  conversation, only to that session's agent; and only then does each turn
  carry one more context block (type `agent_work`, before the app help line):
  "You can create tasks, calendar events and projects in Octopus Prime with
  octopus_tasks / octopus_calendar / octopus_projects when someone asks."
  - Every call is one `work.request` frame with a fresh `outbound_id`, the
    session's `channel_id`, `agent_id` and `event_id` (never the model's),
    `tool` (`tasks`, `calendar`, `projects`), `action` and `args` (the tool's
    own arguments only; any other key the model passes is dropped), answered
    by `work.result` or `work.rejected` (`reason`, and when the backend gives
    them a sentence `detail` and the app's `code`) within 20 seconds, and
    re-written after a closed socket like a reply: the backend makes what a
    request makes under that request's own ID, so nothing is made twice.
  - The backend acts as the person who sent the message of that delivery, through
    the app's own routes, and only where the agent is. Its refusals:
    `invalid_request` (with what was wrong), `unavailable`, `no_person` (an
    agent started the turn), `stale_turn` (the message is older than 12
    hours), `not_allowed` (the person's role), `not_found`, `not_own_event`,
    `no_thread`, `refused` (the app's own refusal and sentence), `rate_limited`
    (30 creates an hour per agent) and `busy`. Each reaches the agent as the
    tool's answer, in plain words, not as an error.

  With a backend that does not offer `agent-work` the tools are never offered,
  no line is added and nothing is sent: everything works as with 1.27.0.
- **Meetings** (1.29.0, `src/meetings.ts`; `octopus_meeting` in
  `contracts.tools` and `toolMetadata`, `sideEffecting`). The plugin asks for
  `meetings` beside the others; only on a connection whose welcome offers it:
  - it sends `meetings.report` on connect and at the first heartbeat after it
    changes: `platforms` (`zoom`, `google_meet`, `teams`, each `ready`, `off`
    or `missing`, from `plugins.entries` of `zoom-meetings`, `google-meet` and
    `teams-meetings`, `plugins.enabled`, `plugins.allow` and `plugins.deny`)
    and `notes` (`transcripts.enabled !== false`);
  - a `message.inbound` frame may carry `meeting` (`meeting_id`, `phase`
    `join` or `notes`, `platform`, `url`, `ends_at`); one that is not right is
    left out. That turn gets a context block of type `meeting` (before the app
    help line) telling the agent which OpenClaw tool joins it (`zoom_meetings`,
    `google_meet`, `teams_meetings`; action `join`, mode `transcribe`), or, for
    `notes`, to read the notes with the `transcripts` tool and post them;
  - `octopus_meeting` (actions `status`: joined, failed or left, with a
    `detail`; and `notes`: `summary`, `decisions`, `action_items`) is a
    `work.request` with `tool: "meetings"`, answered and refused as above;
  - a `join` frame arms a timer (in this process, at most 24 hours) that sends
    `meeting.due` (`meeting_id`, `channel_id`, `agent_id`) at `ends_at`, tried
    again every minute while there is no such socket; the backend then asks
    the agent for the notes in the requester's name, once.

  With a backend that does not offer `meetings`, nothing is reported, the tool
  is never offered and no frame names a meeting: everything works as with
  1.28.0.
- **Rich replies** (1.32.0, `src/presentation.ts`): the plugin asks for
  `rich-presentation` beside the others. The outbound adapter declares
  `presentationCapabilities` (text, context, divider, tables, charts; no
  buttons or selects) and, through `resolvePresentationCapabilities`, tables
  and charts only while the account's current socket's welcome offered
  `rich-presentation`. Its `renderPresentation` returns `null` (core's own
  plain text) unless that welcome offered it and the card passes the
  backend's rules with a 16,000-byte cap; otherwise the payload's `text`
  becomes `renderMessagePresentationFallbackText({ text, presentation:
  sourcePresentation })` and the card, `{ title?, tone?, blocks }` with the
  payload's own words (unless blank or the title) as the first `text` block,
  goes in `channelData["octopus-prime"].presentation`, which routes the reply
  to `message.send.payload`. That send adds `presentation` to the
  `message.outbound` or `message.post` frame only when the reply is one frame
  (no `reply_id`, `part`, `parts`), the frame with it stays within 60,000
  bytes, and the socket's welcome still offers it; `body` is the full
  fallback either way. A frame written again carries the same card. A resend
  the backend refuses as `identity_conflict` is read back by its outbound id,
  as one with files is. A backend that does not offer it gets the reply
  exactly as before. `describeMessageTool` adds `capabilities:
  ["presentation"]`.
- **Tap-to-answer** (1.33.0, `src/questions.ts`): the plugin asks for
  `ask-user` beside the others. While the account's current socket's welcome
  offered it, `resolvePresentationCapabilities` turns `buttons` and `selects`
  on and `agentPrompt.messageToolCapabilities` answers `["inlineButtons"]`.
  `renderPresentation` then turns an `ask_user` prompt (core's
  `channelData.askUser.questionId`) into an `ask` of kind `question`, and an
  agent's `buttons` and `select` blocks into an `ask` of kind `buttons` (a
  `url` or URL-backed `web-app` action keeps its link, a `command` action its
  `/command`, a `callback` or legacy `value` only its label; approvals and
  other actions stay an "Actions:" context line in the card), carried in
  `channelData["octopus-prime"].ask`; the rest of the card goes as in 1.32.0.
  `message.send.payload` reads that `ask`, or builds one for an `ask_user`
  prompt core sent as words. A question's `header`, `text`, `options`
  (`label`, `description`), `multi`, `other` and `expires_at` are read from
  core's process-wide record of the pending question
  (`Symbol.for("openclaw.askUserQuestions")`), else from the one-question
  presentation core builds; a prompt of several questions gets none. The
  `ask` follows the backend's rules (backend/agent_questions.py, shared cases
  in backend/tests/fixtures/agent_question_cases.json; 8,192 bytes) and goes
  on the reply's one frame as `presentation` does (it is kept before the card
  when the frame would not fit both). After a question is sent the plugin
  registers it with `questionGatewayRuntime.registerChannelDelivery`; when it
  ends there it sends `{ type: "question.closed", message_id, question_id,
  status }` (answered, expired or cancelled). A `{ type: "question.answer",
  message_id, question_id, agent_id, channel_id, sender, answer }` frame for
  an announced agent is resolved with `questionGatewayRuntime.resolveOption`
  (`optionValue: answer`, `senderId: "octopus-prime:<sender.id>"`) without
  holding up the socket's other frames, and answered `{ type:
  "question.answer.result", message_id, question_id, status }`: `answered`,
  `closed` (the question had already ended) or `failed`. A backend that does
  not offer it gets the reply exactly as before.
- **Pictures people send** (1.35.0, `src/inbound-media.ts`): the plugin asks
  for `inbound-media` beside the others. A backend that offers it adds
  `files: [{ id, name, content_type, size }]` to a `message.inbound` frame for
  each picture of the message (JPEG, PNG, WebP, GIF, HEIC/HEIF), never a link;
  the plugin keeps at most five well-formed entries (through its durable queue
  too) and drops anything else, never the message. While the account's
  current socket's welcome offered it, the turn downloads each picture of at
  most 25 MB, in order, from `GET <backendUrl>/api/connector/files/<id>
  ?event_id=<event>` with the connector's credential (`redirect: "error"`, 30
  seconds each), keeps it only when the answer is a picture of at most 25 MB,
  saves it with the host's `runtime.channel.media.saveMediaBuffer` (subdir
  `inbound`) and passes the saved files as `media` to
  `buildChannelInboundEventContext` (`kind: "image"`), so core hands them to
  the model as the turn's images and keeps them with the session. A picture
  it could not get (too large, refused, not a picture, cut short) is named
  after the message in `BodyForAgent` only ("… isn't shown to you as an
  image: "x.png". Read it from the link above."); the message's own text
  keeps the backend's links. Logs name the picture's place and why, never an
  address or a credential. A backend that does not offer it, or a frame
  without `files`, changes nothing.
- **Audited workspaces** (1.7.0): while an organization's Owner has Audited
  workspace on (see Audited workspaces above), the backend adds
  `audited: true`, at the top level, to every `message.inbound` frame of that
  organization, and sends every other frame exactly as before. The plugin
  keeps only an exact `true` (through its durable queue too) and gives it to
  the agent with the turn's own context, as a `channelStructuredContext` entry
  of `buildChannelInboundEventContext` (`workspaceAudit` in
  `src/host-dispatch.ts`), after the sender's two-step login entry when a
  message has both. OpenClaw shows the agent a block of its own:

      Octopus Prime workspace:
      {"source":"octopus-prime","type":"audited_workspace",
       "payload":{"audited":true,
        "notice":"This workspace is audited: the owner and auditors can read all conversations."}}

  The message's text is passed on unchanged, nothing typed into a message can
  add the block, and the plugin sends the backend nothing for it: agents
  acknowledge nothing. In such a turn the agent also gets the `octopus_audit`
  tool (`src/audited-workspace.ts`, `src/audited-workspace-tool.ts`;
  `contracts.tools` and `toolMetadata` in `openclaw.plugin.json`, in the
  `coding` and `messaging` tool profiles, where a Gateway's own tool allow and
  deny lists still decide). The tool's factory offers it only in a session
  whose last message frame carried the flag, and only to that session's
  agent; a later message without the flag withdraws it. The plugin cannot
  know whom the Owner made an auditor, so every agent of such a turn is
  offered the tool, and the backend decides at each call.
  - `conversations` sends `audit.conversations`. `history` sends
    `audit.history` with `channel_id` and, when given, `limit` (1 to 100; the
    backend returns 50 without it) and `before` with `before_id` (the
    `created_at` and `message_id` of the oldest message already read, for the
    page before it). Each frame carries a fresh `outbound_id` and the
    session's `agent_id`, never one the model passes, and goes out through the
    connector of the session's account. A call whose arguments cannot make a
    request is refused before anything is sent.
  - The backend answers `audit.result` with that `outbound_id`, or
    `audit.rejected` with `unavailable` (the agent is not on the Owner's list,
    the workspace is not audited, or it has no such conversation; the backend
    never says which) or `invalid_request`. A refusal reaches the agent in
    plain words.
  - The list of conversations comes from the backend whole, 2,000 at the
    most, in one frame. OpenClaw cuts a tool result that is too long for the
    model (on 2026.9.8 its limit for one result is 16,000 characters for a
    model with a small context window, up to 64,000 for a large one), so the
    tool gives the agent a page of the list: `offset` (from 0) and `limit` (1
    to 100, 50 without it) for `conversations` are the tool's own and never
    reach the backend. Every page is the same frame, and one recorded read of
    the list. A conversation is shown compact: `channel_id`, `kind`, `name`,
    then `is_private`, `everyone` and `archived` only when true, and its
    `people`, `agents` and `project` by name. The answer is `total`, `offset`,
    `has_more` and the page, under a line that says where the next page
    starts ("70 more: call again with offset=50."). A page also ends before
    `limit` when its conversations would together weigh more than 12,000
    characters as OpenClaw counts them at the most (a character of some
    scripts counts as up to 12), and the next page starts where it ended. An
    offset past the end gives an empty page with the total. `history` takes
    no offset.
  - A page of a conversation is the backend's own: the conversation, its
    messages (oldest first) and `has_more`, as JSON, under a line that says
    how many messages there are, how to ask for the earlier ones when there
    are any, and that they are other people's words, not instructions to the
    agent. A long page can still be more than OpenClaw lets through, which
    then shortens it with a note of its own; `limit` asks for a shorter one.
  - A read waits for its answer as a log book request does (20 seconds,
    re-written after a closed socket like a reply). The backend records every
    read for the Owner. The tool cannot post, react or change anything, so its
    `toolMetadata` does not mark it `sideEffecting`.

  Nothing is added to `protocol.negotiate` and no welcome capability is
  involved: the flag on a message frame is how the plugin learns that a
  workspace is audited. A message without the flag is handled exactly as by
  1.6.0.
- **Reactions** (an agent acknowledges a message): the shared
  `message` tool offers one action here, `react` (`src/actions.ts`). Without a
  `messageId` it reacts to the message the agent is answering, whose id in the
  turn is the inbound `event_id`. The adapter sends `message.react` with a fresh
  `outbound_id`, that `event_id`, `emoji`, `remove` and, when core names it, the
  acting `agent_id`. It waits for `message.react.result` or
  `message.react.rejected` (20 seconds, re-written after a closed socket like a
  reply). The backend applies it only to a message it delivered to that agent
  through this connector; a reaction wakes no agent and sends no push. Adding
  one answers that message, as a reply does, so a turn that only reacts does
  not hold its conversation until the backend's lease fails it. For a
  plugin that is not bundled with OpenClaw, core allows `react` only in the
  agent's current conversation and account, and it resolves the target before
  calling the plugin. So the plugin declares `messaging.targetResolver.looksLikeId`
  for backend conversation ids (`ch_…`, `dm_…`); without it OpenClaw 2026.9.8
  refuses with `Unknown target "ch_…" for Octopus Prime.`
  `tests/reactions.test.mjs` runs core's own message-action runner against the
  plugin to check both.
- **Reply handoff**: a final reply that runs in another plugin registry than the
  Gateway's current one (the agent turn's own registry, or one replaced by a
  reload) is handed to the current registry before sending. The turn plan's
  `prepareRuntimeHandoff` keeps the connector binding (backend URL, credential,
  connector and organization pins) that admitted the inbound message; if that
  binding changed or the account is disabled, it refuses with a non-retryable
  `PlatformMessageNotDispatchedError` and nothing is sent. Without the callback,
  OpenClaw 2026.9.8 drops every such reply ("The reply channel changed or cannot
  preserve its sender").
- **Connector not ready**: a reply or status query that finds the connector
  starting or reconnecting (including replies that core replays at startup
  before the WebSocket is up) waits for it, at most 30 seconds per outage counted
  from when the connector stopped being ready. If it is still not ready, nothing
  was written: the send throws the SDK's retryable
  `PlatformMessageNotDispatchedError` and reconciliation returns `unresolved`
  (retryable), so core's queue keeps the reply and retries it. If the socket
  closes or is found dead (see Reliability) after a frame was written, the
  adapter writes the identical frame again on the next connection (at most 3
  writes per attempt); the backend keeps one message per connector and
  `outbound_id` and answers with its receipt. When that cannot finish, or a
  receipt times out after 20 seconds, the error stays
  unresolved (never the not-dispatched marker) and core retries the reply. The
  adapter reports the SDK's internal dispatch boundary only after the backend's
  receipt (for a long reply, its last part's), which lets core settle the queued
  reply (without that, OpenClaw
  2026.9.8 fails it with "Delivery platform claim was lost"). Before the receipt
  it reports nothing, so core replays an interrupted send instead of retiring it.
  Stopping the transport releases
  waiting replies at once as retryable. Core's retry budget still applies (on
  2026.9.8: 5 attempts, 5 seconds to 10 minutes apart), and the public SDK has no
  call to retry queued replies on reconnect, so a reply that outlives a longer
  outage waits for core's next scheduled retry and is dropped once the budget is
  spent.
- **Reliability**: the plugin uses OpenClaw's standard raw-event ingress monitor
  with its own SQLite queue, per-conversation lane keys, and pending/claimed/
  completed/failed records. It sends heartbeat `ping` frames every 25 seconds,
  which the backend answers with `pong`. Each ping carries `openclaw_version`,
  the running OpenClaw version (`api.runtime.version`), when the host provides
  one; the backend records it per heartbeat so that gateway drops after an
  OpenClaw update can be counted by version. It reconnects closed sockets with
  exponential backoff capped at 15 seconds while the transport has not stopped,
  whatever the close code (1006 when the connection drops, 1012 when the backend
  restarts on a redeploy). A connection attempt that cannot even be created
  is retried the same way. Each reconnect logs a warning with the close code
  and the delay, never the URL, because the URL carries the credential.
  A socket that delivers no frame at all for 50 seconds (two heartbeat
  intervals) is dead even if it still looks open, as after a network change; a
  connection attempt that hears nothing back for 50 seconds is given up the same
  way. The plugin logs a warning, terminates the socket and reconnects with the
  same backoff. Each new connection negotiates again and re-announces the
  agents, so the backend re-admits them and replays their unanswered messages.
  The ingress dedupes a replayed event by `event_id` and acknowledges it again
  without running a second turn. A turn that ended without a saved reply
  is failed by the backend once its lease runs out, so it no longer holds its
  conversation.
  Detection can take up to 50 seconds after the last frame: a reply written into
  a dead socket more than 20 seconds before that times out as unresolved and
  core retries it later, while one still waiting for its receipt is written
  again on the new connection. Outbound readiness checks
  fail closed on a stale binding; changing the active binding requires an account
  restart before delivery can resume.
- **Plugin status**: transport lifecycle values are `stopped`, `starting`, `ready`,
  `restart-required` and `error`; account inspection can additionally report
  `unconfigured`. These are plugin lifecycle values, not a claim about every
  status label in the hosted app.

## Changes

Every release's notes are in [CHANGELOG.md](CHANGELOG.md), newest first, which
ships with the package. Each entry says which Octopus Prime backend the
release needs and whether it goes live only after a Gateway restart.

## Versioning
Two version axes are independent:

- **OpenClaw host.** OpenClaw decides whether it may load the plugin from
  `openclaw.compat.pluginApi` in `package.json`, currently the floor `>=2026.9.8`.
  `peerDependencies.openclaw` repeats the floor for npm only. The floor is 2026.9.8
  because a connector that is still not ready after its wait admits the reply and
  then throws the SDK's retryable `PlatformMessageNotDispatchedError`
  (`openclaw/plugin-sdk/error-runtime`), so core keeps and retries the queued
  reply instead of dropping it; reconciliation while not ready returns
  `unresolved` (retryable). OpenClaw 2026.9.7 and earlier are not supported by
  1.1.0 or later. The compiled tests check that the linked host meets the floor.
- **Backend wire protocol.** Protocol `octopus-immutable-intents-v1`. Bootstrap
  sends `host_api_version: "2026.9.7"` and WebSocket negotiation sends
  `host: "2026.9.7"`. In v1 that value is a frozen contract token
  (`CONNECTOR_PROTOCOL_HOST` in `src/protocol.ts`), not the running OpenClaw
  version; deployed backends compare it exactly. Negotiation requires that
  protocol and token, `compatible: true`, a connector identity, and both
  `outbound-receipt` and `durable-ingress` capabilities in the welcome. The
  plugin rejects a mismatched welcome or application data arriving before
  negotiation. The welcome may also offer the optional `session-stats`
  capability (1.3.0), which the plugin then uses on that socket; it never
  requires it and never asks for it in `protocol.negotiate`. The plugin asks
  for the optional `log-book` (1.4.0) in a separate optional field,
  `optional_capabilities`, which a backend without the log book ignores (every
  backend takes extra fields, and checks only that the v1 capabilities are
  among `capabilities`); it uses the log book only on a socket whose welcome
  offers `log-book`; likewise `project-folder` (1.14.0), `channel-history`
  (1.15.0), `agent-work` (1.28.0), `meetings` (1.29.0) and `rich-presentation` (1.32.0) in the same field. Audited workspaces (1.7.0) add nothing to the
  negotiation, either way: the plugin learns that a workspace is audited from
  `audited: true` on a message frame, and only a turn that carried it can send
  `audit.conversations` or `audit.history`. Since 1.12.0 the negotiation
  also carries `plugin_version` (this package's version, as setup sends it) and,
  when the host provides one, `openclaw_version` (`api.runtime.version`, as the
  heartbeat sends it). Both are optional fields that an older backend ignores; a
  backend that reads them keeps them on the connector and shows Owners and
  Admins when the plugin or OpenClaw is older than it supports (see If your
  connection breaks). The welcome is unchanged.

## Compatibility policy
Customers' OpenClaw installs update on their own schedule and the hosted backend
updates on ours; neither may strand the other.

**OpenClaw host range**
- Declare a `>=` floor in `openclaw.compat.pluginApi`, repeated in
  `peerDependencies.openclaw`. Never pin one exact host.
- The floor admits newer OpenClaw releases without a plugin release. When one
  ships, review its plugin SDK types and changelog for every
  `openclaw/plugin-sdk/*` entry point and runtime call this plugin uses, then run
  `npm test` against it; fix the plugin if anything broke.
- A host upgrade never changes the wire protocol.

**Backend wire protocol**
- v1 is identified by the protocol id, the `2026.9.7` token and the two required
  capabilities. Neither side changes them within v1.
- Backend: keep accepting v1 bootstrap and negotiation from released plugins,
  echo the v1 values in `welcome`, and keep the v1 bootstrap response fields
  (`connector_token`, `connector_id`, `org_id`; a `backend_url`, if returned,
  must equal the URL the plugin called). Ignore unknown request and frame
  fields. Never require a new field or capability from a v1 plugin, and never
  send a new value in an existing v1 field (released plugins close the socket
  on, for example, an unknown outbound status). Released plugins ignore unknown
  frame types after `welcome`, so a new frame type must not carry anything v1
  behavior needs. The backend's tests send literal v1 frames to guard this.
- Plugin: keep sending the v1 values exactly. Tolerate unknown fields, unknown
  frame types and extra capabilities from a newer backend, and use an optional
  capability only when `welcome` advertises it. New request fields must be
  optional; older backends ignore them.
- Offer a future v2 additively: keep the v1 fields for older backends and offer
  v2 in a new optional field. A backend that supports v2 selects it in
  `welcome`; otherwise both sides stay on v1. Retire v1 only when no supported
  plugin release depends on it.

## Building from source

Use Node 24.19.0 and npm 11.17.0 with an OpenClaw 2026.9.8 or later host
package. The host is supplied separately, never bundled or fetched by this
source build. `package-lock.json` pins the build dependencies and the one
runtime dependency, `ws@8.18.0`, which `package.json` pins exactly too.

```sh
npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
# Link an OpenClaw package for the SDK; do not point it at a Gateway in use.
ln -s /absolute/path/to/openclaw node_modules/openclaw
npm test         # clean strict tsc -> dist/, then focused tests of the compiled entries
npm pack --dry-run
```

Add `--offline` to `npm ci` when its locked build dependencies are already cached.
`--legacy-peer-deps` deliberately avoids downloading a host. `npm run build`
deletes `dist/` before compiling, so a package never carries stale output.
`prepack` rebuilds and runs the tests before `npm pack` or `npm publish`; never
bypass it. The package ships only the compiled JavaScript, the plugin manifest,
the icon (`assets/icon.png`, OpenClaw's fixed path for a plugin's icon, which
ClawHub shows too), this README, the CHANGELOG, the license and the NOTICE file (the `files`
list in `package.json`); never TypeScript sources, tests, scripts,
dependencies or the host runtime. npm installs `ws` next to the package.
`tests/public-package.test.mjs` runs `npm pack --dry-run --json` offline and
checks that list against what tsc compiles.

### Releasing

The same package goes to npm and to ClawHub, under one name and version.
ClawHub's listing comes from the package itself: the name, version and
description in `package.json`, `openclaw.compat` (`pluginApi` and
`minGatewayVersion`, which OpenClaw checks before installing),
`openclaw.build` (the OpenClaw release it is built and tested on), the
manifest's name, description and category (`channels`), and the icon.

1. Raise the version in `package.json` and `package-lock.json`
   (`npm version <x.y.z> --no-git-tag-version`), in `PLUGIN_VERSION`
   (`src/protocol.ts`) and in this README's first lines, and add the release's
   entry at the top of [CHANGELOG.md](CHANGELOG.md).
2. Run the release check. It runs the tests, then checks that the version is
   the same everywhere, the ClawHub metadata and icon, and what npm would pack;
   it lists the packed files and prints the publish commands. It never
   publishes.

   ```sh
   npm run release:check
   ```

3. Publishing is done by hand, by someone signed in to the npm organization
   and to the ClawHub publisher, with the commands the check prints:
   `npm publish --access public`, then `clawhub package publish`, each after
   its dry run.

The tests also keep people's names, customer names and internal task numbers
out of every file of the plugin (`tests/public-names.test.mjs`), so a release
needs no separate search for them.

The focused tests import the compiled entries against the linked host's real SDK, check
registration modes without runtime activation, exercise authenticated setup with
synthetic responses, and check fail-closed identity/protocol/admission boundaries.
`tests/outbound-readiness.test.mjs` drives the compiled transport through a fake
socket and ingress with mocked timers to cover replies during startup, reconnect
and outages, and sockets that go silent without closing.
`tests/reconnect-redelivery.test.mjs` covers reconnects after 1006 and 1012
closes with backoff and a socket that cannot be created, and the repeated
`working` status. Through the real SQLite ingress it also covers a re-offered
event that is not run again, and a backlog whose turns start in order with each
reply posted once.
`tests/reply-handoff.test.mjs` runs a final reply from the plugin's
turn plan through the linked host's real durable-delivery registry handoff.
`tests/reply-dispatch.test.mjs` sends final replies to backend-shaped frames
(with `thread_id`) through the linked host's real durable send and SQLite queue
to a fake connector socket, and replays an interrupted send through the host's
queue drain, also a long reply cut off between its parts.
`tests/long-replies.test.mjs` sends long replies through the compiled transport
to a fake backend that answers as `backend/server.py` does: every frame within
both limits, cuts at paragraph, line, sentence and space boundaries, emoji and
code blocks kept whole, the same part ids, fields and texts on a resend, the
dispatch boundary after the last part, every part found again by
reconciliation, and a reply an older version left saved finished with only the
rest. `backend/tests/test_reply_parts.py` covers the backend's side.
`tests/session-stats.test.mjs` reads a session row written with the linked
host's own SDK, and drives the compiled transport to check that a completed
turn reports its session's stats only to a backend that offers them.
`tests/log-book.test.mjs` checks the new-session rule against the host's own
reset policy functions, the tool's schema with core's own argument validator,
and, through the compiled transport and a fake backend, that a project turn
that starts a session gets CONTEXT.md before its message while any other turn
is unchanged, that the tool speaks only for its session's conversation and
agent, and that a backend without the log book is never sent a request.
`backend/tests/test_project_log_book.py` covers the backend's side.
`tests/channel-history.test.mjs` checks the channel history tool's schema with
core's own argument validator, the frame (always the session's conversation,
agent and delivery, whatever the model passes), each refusal's words and the
text the agent reads, and, through the compiled transport and a fake backend,
that the tool is offered after a turn in any conversation only to its agent,
never on a connection whose welcome did not offer `channel-history`, and that
a read is written again after a closed socket.
`tests/agent-work.test.mjs` checks the three tools' schemas with core's own
argument validator, the frame (always the session's conversation, agent and
delivery, the tool's own arguments only, whatever the model passes), each
refusal's words and the text the agent reads, the `agent_work` context line,
and, through the compiled transport and a fake backend, that the tools are
offered after a turn in any conversation only to its agent, never on a
connection whose welcome did not offer `agent-work`, and that a request is
written again after a closed socket under the same `outbound_id`.
`backend/tests/test_agent_work.py` covers the backend's side.
`tests/audited-workspace.test.mjs` takes the plugin's tools from the compiled
entry as core takes them and checks that a message without `audited` gives
its turn the context 1.6.0 gave it (rebuilt with the SDK's own context
builder), the same tools and nothing more sent, while an audited one adds the
notice and offers `octopus_audit`. It asks the host's own prompt code what the
agent is then shown, runs the flag through the real SQLite queue and a
replayed turn, and the tool through the compiled transport and a fake backend:
both requests' frames, the answers and refusals, an answer under another
`outbound_id`, a second account's own socket, a closed socket and a timeout.
It pages a long list of conversations (the default, a middle and the last
page, an offset past the end) with the frame unchanged, and gives each page of
conversations with many people, in three scripts, to the host's own cut of a
tool result at its smallest limit, which must leave it whole; and it checks
every character's weight against the host's own count.
It loads the package with the host's own plugin loader and checks the tool's
schema with core's own argument validator. It does not run core's assembly of
a live turn's tools: as for the log book's tool, the factory is called the way
core calls it, in the plugin instance that ran the turn.
`backend/tests/test_audited_workspace_flow.py` covers the backend's side.
`tests/channel-turn-reply.test.mjs` takes such frames the way the Gateway does:
through the linked host's real channel turn (`api.runtime.channel.inbound.run`)
and reply dispatch, with only the model replaced. The reply is queued naming no
thread and completes on the backend receipt.
`tests/install-setup.test.mjs` runs the linked host's own Doctor checks that
`plugins install --force` and `plugins update` apply before a replacement
activates, and checks that the package's setup-flag metadata matches the runtime
setup contract.
`tests/multi-account.test.mjs` reads single-organization and multi-account
configurations, runs two accounts' transports side by side on fake sockets
(replies, status queries, reactions and log book requests each on their own
account's socket; one account reconnecting or stopped without the other),
and checks session keys, bindings, each account's reply handoff, setup and its
refusals, per-account SecretRefs, and both accounts started through the
gateway adapter. `tests/multi-account-turn.test.mjs` takes both accounts'
messages through the linked host's real channel turn, reply delivery and
queue, and a reaction through core's message-action runner, each to its own
account's socket. `tests/multi-account-setup.test.mjs` runs the linked host's
own `channels add --account` command against a throwaway configuration file.
`backend/tests/test_connector_two_orgs.py` covers the backend's side: one
Gateway's connectors in two organizations reach nothing of each other's. The
tests do not start a Gateway, contact a backend, prove a native installation, or
replace end-to-end testing.

## License

Apache License 2.0 (`Apache-2.0`), for this plugin package only (see the
LICENSE file; the NOTICE file ships with it). Copyright 2026 Neogenesis
Research & Technologies LLC. Its one dependency, `ws`, is MIT licensed and
installs with its own license file. The Octopus Prime AI service and apps are
not covered by this license. "Octopus Prime" and the octopus logo
(`assets/icon.png`), which identify the plugin, are trademarks of Neogenesis
Research & Technologies LLC and are not licensed under Apache-2.0 (section 6
of the license); the NOTICE file says so. Versions before 1.20.0 were
published under the MIT license.
