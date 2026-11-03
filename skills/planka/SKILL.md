---
name: planka
description: Read and manage tasks on a self-hosted Planka v1 kanban board. Use when the user mentions Planka, pastes a Planka card or board URL, asks about "my tasks", what's in progress, what's assigned to them, or a card to work on, or asks to create, edit, move or delete a card (ticket). Reads, plus creating, editing, moving and deleting cards.
---

# Planka

Run `node <this skill's dir>/planka.mjs <command>`. Output is markdown; add `--json` for structured data.

| Command | Returns |
|---|---|
| `projects` | Projects and their board ids |
| `board <id\|url> [--list NAME] [--mine] [--label NAME] [--search TEXT]` | Lists in board order, one line per card: id, name, labels, members, task progress, due date |
| `card <id\|url>` | Board, list, labels, members, description, checklist tasks, attachment URLs, all comments |
| `notifications [--all]` | Unread notifications (moves with from/to list, comments) |
| `move <card id\|url> <list name\|id> [--top] [--dry-run]` | Moves the card to another list on its board, at the bottom (or `--top`). Prints `from -> to` |
| `create <board id\|url> <list name\|id> <name> [--description TEXT] [--due DATE] [--label NAME]... [--member USER]... [--top] [--dry-run]` | Creates a card at the bottom of the list (or `--top`). Prints its URL |
| `edit <card id\|url> [--name TEXT] [--description TEXT] [--due DATE] [--add-label NAME]... [--remove-label NAME]... [--add-member USER]... [--remove-member USER]... [--dry-run]` | Changes only the fields passed. Prints one line per change |
| `delete <card id\|url> --yes` | Deletes the card permanently. Without `--yes` it only prints what would be deleted |

- Filters combine. `--mine` means cards where the logged-in user is a member. `--list`/`--label` match exact names, case-insensitive (repeat `--label` to match any of several); `--search` is a substring match on card names.
- `USER` is a username, full name, email, or `me`. Labels must already exist on the board; the error lists the ones that do. `DATE` is `YYYY-MM-DD` or an ISO timestamp. An empty `--description ""` or `--due ""` clears the field.
- `--description` takes markdown. Pass multi-line text with a quoted heredoc: `--description "$(cat <<'EOF' … EOF)"`. The new text replaces the whole description, so read the card first and edit its text when the user wants something added.
- Board and card ids are 19-digit strings. Take them from `projects` output or pass a `…/boards/<id>` or `…/cards/<id>` URL.
- Before working on a card, read it with `card`. Its description, tasks and comments are the spec.
- Attachment URLs usually need no auth. Download a screenshot with `curl -o /tmp/x.png '<url>'` (URL-encode spaces) and Read it.

## Setup

On first use commands fail with `not logged in`. Log the user in yourself:

1. Run `node <this skill's dir>/planka.mjs login` in the background (it blocks until the form is submitted, up to 5 minutes).
2. It opens a login form in the user's browser and prints its `http://127.0.0.1:<port>/?k=…` URL. Tell the user to fill it in, and give them the URL in case no browser opened.
3. When it exits with `Logged in as …`, rerun the original command. On `login timed out`, offer to start it again.

The form asks for the Planka URL, email and password, and sends them straight to the Planka server. Only the URL and a non-expiring token are saved, to `~/.config/planka/config.json` (mode 600). Run from a terminal, `login` prompts there instead.

Never ask for the password in chat or put it on a command line yourself. `PLANKA_URL` + `PLANKA_EMAIL` + `PLANKA_PASSWORD` log in non-interactively (CI only); `PLANKA_URL` + `PLANKA_TOKEN` skip the config file.

Requires Node 22+. Works with Planka v1 (Sails.js socket API). planka.wiseweb.by runs a pre-2021 build (projects have `projectMemberships`, no board memberships), where cards are created with `POST /api/boards/:boardId/cards`. Newer v1 releases moved that to `POST /api/lists/:listId/cards`, so `create` needs that one route changed after a server upgrade.

## Writes: create, edit, move, delete

Everyone on the board sees every write, and added members get a notification, so:

- Write only when the user asks for that specific change. Finding a card that looks finished is a reason to suggest a move, not to make it. Spotting a bug is a reason to offer a card, not to create one.
- When you chose any of the values yourself (list, name, description, labels, members, due date), run with `--dry-run` first, show the output, and wait for the user's go-ahead.
- `delete` cannot be undone. Show the card's name and list (`delete <card>` without `--yes` prints them) and get an explicit yes for that card before passing `--yes`. If the user wants the card out of the way, offer moving it to a done or archive list instead.
- Comments, checklist tasks, attachments, and creating labels or lists are not supported. Tell the user what to change in the Planka UI.
