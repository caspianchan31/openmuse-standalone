# Contributing to OpenMuse

OpenMuse is an MIT-licensed alpha. Contributions should make delegated work reliable and visible, with honest connector status and useful native interactions.

## Local development

1. Fork and clone the repository. Use Node 24 LTS and pnpm 11.19.0.
2. Run `pnpm install --frozen-lockfile` and copy `.env.example` to `.env`. Without an Intelligence key, conversations are stored in the API's own database ([local mode](docs/STANDALONE-THREADS.md)). To work on Intelligence mode, use `npx copilotkit@latest login` then `npx copilotkit@latest project select` to set `CPK_INTELLIGENCE_API_KEY`.
3. Run `pnpm dev` and, in another terminal, `pnpm dev:web`.
4. Use the fictional sample workspace for development and recordings. See [native setup](apps/mobile/README.md) for simulator/emulator builds.

Never commit `.env`, `.openmuse`, browser profiles, credentials, or personal documents. Live provider testing is optional for ordinary contributions; state exactly which paths you tested.

## Checks before a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build:server
pnpm build:web
pnpm build:ios
pnpm build:android
pnpm --dir apps/worker typecheck
```

For browser changes:

```sh
pnpm --dir apps/worker exec playwright install chromium
pnpm test:browser
# With Docker available:
pnpm --dir apps/worker test:docker
```

Both browser suites use controlled HTTP fixtures through the real worker and proxy URL checks, with disposable profiles instead of your saved sessions. The container runner builds the normal worker image and mounts its test entrypoint read-only. Building the image and installing dependencies require registry access; fixture navigation and downloads do not need external DNS or websites. CI runs lint, types, tests, platform exports, Chromium lifecycle, and the disposable browser-container suite.

## Change guidelines

- Keep CopilotKit/AG-UI transport, the native UI, and server-owned task execution separate.
- Show the real tool result or failure. Do not replace a failed connector with sample success.
- Treat website, mail, and PDF text as data. It cannot grant tool permissions or approve a write.
- Keep sends and calendar mutations behind persisted, versioned action reviews. Preserve uncertain provider outcomes; do not retry a possibly completed write.
- Add regression coverage for behavior changes. Test outcomes such as a task surviving restart, not just function calls.
- Check iOS/Android layout when changing shared React Native components. Platform exports validate bundles; they do not prove a native binary works.
- Document required credentials and unsupported capabilities when adding a connector.

## Pull requests and issues

Open an issue for substantial architecture or connector changes so contributors can agree on scope. Small fixes can go directly to a pull request.

Describe the problem, resulting behavior, and verification. Include a screenshot or short recording for UI changes and note any untested provider/platform path. Do not paste private account data or tokens in logs. Security reports follow [SECURITY.md](SECURITY.md).

Contributions are accepted under the [MIT license](LICENSE).
