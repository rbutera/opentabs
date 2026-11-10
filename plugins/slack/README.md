# Slack

OpenTabs plugin for Slack (standard workspaces). For Enterprise Grid, use slack-enterprise. — gives AI agents access to Slack through your authenticated browser session.

## Install

```bash
opentabs plugin install slack
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-slack
```

## Setup

1. Open [slack.com](https://app.slack.com) in Chrome and log in
2. Open the OpenTabs side panel — the Slack plugin should appear as **ready**

## Tools (24)

### Messages (6)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a message to a channel or thread | Write |
| `edit_message` | Edit an existing message | Write |
| `delete_message` | Delete a message from a channel | Write |
| `read_messages` | Read recent messages from a channel | Read |
| `read_thread` | Read replies in a thread | Read |
| `search_messages` | Search messages across channels | Read |

### Channels (5)

| Tool | Description | Type |
|---|---|---|
| `list_channels` | List workspace channels | Read |
| `get_channel_info` | Get detailed information about a channel | Read |
| `create_channel` | Create a new channel | Write |
| `set_channel_topic` | Set the topic of a channel | Write |
| `set_channel_purpose` | Set the purpose of a channel | Write |

### Users (4)

| Tool | Description | Type |
|---|---|---|
| `invite_to_channel` | Invite a user to a channel | Write |
| `list_members` | List members of a channel | Read |
| `get_user_profile` | Get a user's profile information | Read |
| `list_users` | List workspace users | Read |

### DMs (1)

| Tool | Description | Type |
|---|---|---|
| `open_dm` | Open a direct message conversation | Write |

### Files (4)

| Tool | Description | Type |
|---|---|---|
| `upload_file` | Upload a file to a channel or thread | Write |
| `stage_upload_chunk` | Stage a chunk of a large file for upload_file | Write |
| `list_files` | List files in a channel or workspace | Read |
| `delete_file` | Delete a file | Write |

`upload_file` uses Slack's current flow (`files.getUploadURLExternal`, a POST of the bytes to the returned
upload URL, then `files.completeUploadExternal`); the legacy `files.upload` it used before returns
`method_deprecated`. It accepts `thread_ts` to post into a thread. The OpenTabs server caps one tool-call
request at 10 MiB, so files over about 7 MB go in chunks: call `stage_upload_chunk` for each base64 chunk with
one `upload_id`, then `upload_file` with `staged_upload_id`.

### Reactions (4)

| Tool | Description | Type |
|---|---|---|
| `add_reaction` | Add an emoji reaction to a message | Write |
| `remove_reaction` | Remove an emoji reaction from a message | Write |
| `pin_message` | Pin a message to a channel | Write |
| `unpin_message` | Unpin a message from a channel | Write |

## How It Works

This plugin runs inside your Slack tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
