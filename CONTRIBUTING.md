# Contributing to Roundtable

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/foxtrotcommunications/foxtrotcommunications-roundtable-core.git
cd foxtrotcommunications-roundtable-core
cp .env.example .env
# Edit .env with your DATABASE_URL and SESSION_SECRET
npm install
npm run dev
```

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Make your changes
3. Run `npm test` — all 98+ tests must pass
4. Write tests for new functionality
5. Update documentation if needed
6. Submit a PR against `main`

## Code Style

- **React + TypeScript** — the frontend is in `client/` (Vite + React)
- **CommonJS** — the server uses `require()`, not ESM
- **Tool pattern** — new tools go in `server/tools/` and follow the existing `{ name, description, parameters, execute }` pattern
- **Tests** — go in `tests/` mirroring the `server/` directory structure

## Adding a New AI Tool

1. Create `server/tools/myTool.js` following the existing pattern
2. Register it in `server/tools/index.js`
3. Add tests in `tests/tools/myTool.test.js`
4. Update the README tool table

## Reporting Bugs

Open a GitHub Issue with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Node.js version and deployment environment

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
