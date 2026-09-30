# planka-skill

Agent skill for reading a self-hosted [Planka](https://github.com/plankanban/planka) v1 kanban: projects, boards, cards with checklists and comments, and notifications. Read-only.

```
npx skills add miklisanton/planka-skill -g
```

On first use, run `node ~/.claude/skills/planka/planka.mjs login` in a terminal. It asks for the Planka URL, email and password, and saves a token to `~/.config/planka/config.json`.

Needs Node 22+. No dependencies.
