# planka-skill

Agent skill for reading a self-hosted [Planka](https://github.com/plankanban/planka) v1 kanban: projects, boards, cards with checklists and comments, and notifications. Read-only.

```
npx skills add miklisanton/planka-skill -g
```

On first use, ask your agent to log you in to Planka. It opens a login form in your browser for the Planka URL, email and password, and saves only a token to `~/.config/planka/config.json`. From a terminal, `node ~/.claude/skills/planka/planka.mjs login` prompts there instead.

Needs Node 22+. No dependencies.
