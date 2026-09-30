---
name: planka
description: Read tasks from a self-hosted Planka v1 kanban board. Use when the user mentions Planka, pastes a Planka card or board URL, asks about "my tasks", what's in progress, what's assigned to them, or a card to work on. Read-only.
---

# Planka

Run `node <this skill's dir>/planka.mjs <command>`. Output is markdown; add `--json` for structured data.

| Command | Returns |
|---|---|
| `projects` | Projects and their board ids |
| `board <id\|url> [--list NAME] [--mine] [--label NAME] [--search TEXT]` | Lists in board order, one line per card: id, name, labels, members, task progress, due date |
| `card <id\|url>` | Board, list, labels, members, description, checklist tasks, attachment URLs, all comments |
| `notifications [--all]` | Unread notifications (moves with from/to list, comments) |

- Filters combine. `--mine` means cards where the logged-in user is a member. `--list`/`--label` match exact names, case-insensitive; `--search` is a substring match on card names.
- Board and card ids are 19-digit strings. Take them from `projects` output or pass a `…/boards/<id>` or `…/cards/<id>` URL.
- Before working on a card, read it with `card`. Its description, tasks and comments are the spec.
- Attachment URLs usually need no auth. Download a screenshot with `curl -o /tmp/x.png '<url>'` (URL-encode spaces) and Read it.

## Setup

On first use the script prints `not logged in. In a terminal run: node …/planka.mjs login`. Relay that command to the user. Login is interactive: it asks for the Planka URL, email and a hidden password, then saves the URL and a non-expiring token to `~/.config/planka/config.json` (mode 600). The same prompt appears on any command run from a terminal with no config.

Never ask for the password in chat or put it on a command line yourself. Non-interactive login exists for CI only (`PLANKA_URL`, `PLANKA_EMAIL`, `PLANKA_PASSWORD`); `PLANKA_URL` + `PLANKA_TOKEN` skip the config file.

Requires Node 22+. Works with Planka v1 (Sails.js socket API).

## No writes

The script has no write commands. Do not move cards, comment, or edit through the API. Tell the user what to change in the Planka UI instead.
