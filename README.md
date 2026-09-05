# Vibe Recap

Self-hosted appliance for CPA firms: upload a completed tax return package, get a narrated plain-English video summary for the client. Runs entirely on the firm's own hardware. No client data leaves the box.

**Status:** pre-v1, under construction. See [`docs/PHASES.md`](docs/PHASES.md) and [`STATE.md`](STATE.md).

## Quick start

```bash
cp .env.example .env   # set POSTGRES_PASSWORD at minimum
docker compose up --build -d
```

Then open `https://<host>/` and create the first administrator. Full instructions: [`docs/INSTALL.md`](docs/INSTALL.md).

## Development

```bash
npm install                     # TypeScript workspaces: packages/shared, apps/api, apps/web
npm run test:services           # throwaway Postgres + Redis in Docker for tests
npm test                        # vitest across workspaces
cd worker && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]" && .venv/Scripts/pytest
```

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — architecture, locked decisions, schema, UI map
- [`docs/PHASES.md`](docs/PHASES.md) — phased build plan with success criteria
- [`docs/INSTALL.md`](docs/INSTALL.md) — installation
- [`CLAUDE.md`](CLAUDE.md) — operational notes for Claude Code
- [`STATE.md`](STATE.md) — current build status
- [`QUESTIONS.md`](QUESTIONS.md) — open decisions

## License

PolyForm Small Business License 1.0.0. See [`LICENSE`](LICENSE).

Built by [Kisaes LLC](https://kisaes.com).
