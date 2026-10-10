# Release verification

September 16, 2026 · Capybara and distinct mobile/web demos, following the agent browser release · local fictional workspace. This records exercised behavior and its limits; it does not establish that every planned capability is complete.

## Automated checks

- **154 tests pass**, with no failures or skipped tests, across the API, task engine, integrations, computer lifecycle, Docker runner, conversation queue, browser address handling, domain, and native date handling. Five new checks cover email search/read ownership, disconnected mail, evidence-based demo replies, and exhibit extraction without navigation noise.
- Biome formatting/lint, server/mobile/browser-worker TypeScript checks, and the server build pass.
- Expo exports web, iOS Hermes, and Android Hermes bundles. These exports do not produce signed native binaries.
- The **real Chromium lifecycle test passes**: public page navigation/read, failed profile cleanup, same-UUID reopen, text truncation, and localStorage/profile persistence after restart.
- The **real Docker computer smoke test passes** against the isolated `colima-openmuse` context: local image build, nonroot commands, read-only system files, disabled network, capped output, text editing, symlink rejection, PDF byte-preserving import/export, stop/start file persistence, and interruption of an actually running command. Its disposable container and volume are removed after the test.
- CI now includes a separate computer-container build/smoke job. Its YAML parses with unique keys and valid workflow triggers. The existing browser-container CI job was not rerun locally for this release; remote CI results remain separate from these local checks.

## Agent browser verification

- September 16: fresh native iPhone capture exercised Hacker News → CopilotKit → takeover and scrolling. A separate desktop capture exercised actual mailbox search/read → full email viewer → Monterey Bay Aquarium research → takeover. Browser results came from real Chromium; email came from the isolated fictional mailbox. The web capture reported no page errors. Live model and Google-account acceptance remain outside this recording.
- September 16: the new capybara bundles on web, iOS and Android. Both final recordings and covers were visually inspected, and MP4/GIF dimensions, durations, and decoding were checked. All 154 tests, lint, typecheck, server build, and three platform exports pass locally. Worker/container implementation is unchanged; the earlier smoke-test evidence below is historical.

- Actual CopilotKit BuiltInAgent streams `browse_web` calls and results. Tests cover successive reads, honest worker failures, cancellation, owner isolation, concurrent navigation/read pairing, and persistent per-thread profile reuse.
- Native iPhone acceptance: ask for Hacker News highlights → fully terminate and relaunch the app → summarize CopilotKit → open **Take control**. Both page reads returned the same session ID, and the console displayed the live CopilotKit page. Local chat now has a stable routed CopilotKit thread identity across app launches.
- Inline cards show reading progress, the source title, a real browser preview, and takeover. A historical source does not display a different page after that browser moves on. Pending calls show paused status after a stopped run; takeover waits until the active chat run finishes.
- The [AI Mock runner](DEMO.md#run-the-agent-browser-demo) drives the actual model/tool loop against a separate real Chromium worker. Its three tests verify prompt routing, current-turn tool results, failures, and model-protocol execution. Recorded responses are scripted page excerpts, not live-model reasoning.
- Full formatting/lint, server/mobile/worker types, all 149 tests, server build, all three Expo exports, frozen lockfile validation, and the real Chromium lifecycle test passed for this change. The Docker implementation and runtime dependencies did not change; its prior smoke evidence remains below.

## Feature acceptance matrix

| Area | Evidence | Boundary |
| --- | --- | --- |
| CopilotKit chat | Real runtime streams AG-UI events; actual BuiltInAgent/TanStack AI run against a local model-protocol fixture, call server tools including a computer command, persist its receipt, save a plan, prepare an event, wait for approval, and resume from the receipt. | Live model quality and provider-account acceptance are pending. |
| Durable work | Real PGlite restart, two-worker lease races, expired-lease recovery, cancellation, pause/resume, missing inputs, approval fairness, and saved outcomes are tested. | The server host must remain running. PGlite cannot be shared across processes; use PostgreSQL for a separate worker. |
| Document job | Background import → field input → new PDF → action review → sample sent receipt is tested without a client. The iPhone viewer displays the saved names and checkbox on a real two-page PDF. | Supported AcroForms only. OCR/scanned forms and some field types are not supported. |
| Reviews | Ownership/hash/version binding, expiry, account changes, disconnects, concurrent decisions, uncertain writes, and cancellation are tested. | An already dispatched provider request may finish after cancellation. |
| Gmail / Calendar | Real adapter code with controlled HTTP fixtures covers OAuth state races, scopes, complete MIME/threads/attachments, CRLF sends, calendar discovery, event CRUD, ETags, time zones, DST gaps, and unsupported recurrence. | No live Google credentials were supplied. A real-account acceptance run remains required. |
| Browser | Actual Chromium screenshots and console displayed on iPhone and web. Hacker News and CopilotKit navigation were exercised through both clients and updated the worker's page. Ownership, authorization, URL/DNS/egress checks, failed downloads, and recovery have automated coverage. | A separate Chromium worker; no automatic booking/payment or hostile-tenant isolation. |
| Linux computer | Native Terminal created `today.md`; Files read/save and PDF import/export/view were exercised. The real Docker smoke verifies isolation and persistence. Regressions cover owner binding, literal host argv, output caps, timeout/stop failures, stale-executor restart fencing, retryable Stop, and interrupted recovery without replay. | One owner, noninteractive commands, no terminal network, graphical desktop, or full VM. Persistent volumes have no portable per-volume disk quota. |
| Ideas | Evidence/accept/edit/dismiss and acceptance races are tested. Regression coverage retires completed document suggestions and excludes sent replies while preserving unfinished incoming requests. | Rules-based suggestions; broader model-derived personalization remains future work. |
| Goals / Tracking | Milestone validation, goal/task pausing, sample observation baseline/change/deduplication, failure backoff, and automatic pause are tested. A real public-page watch previously saved actual text. | Device push and adaptive long-term planning are not implemented. |
| Finance | CSV parsing, exact cents, invalid/ambiguous input, and persisted artifacts are tested. A new task delegated from the iPhone menu produced income 4,200.00, spending 110.99, and remaining 4,089.01 from four sample transactions. | Imported CSV only; no bank connection. |
| Identity / memory | Edit, persist, and forget paths are tested through the authenticated API. | Single owner per deployment. |
| Rich Threads | Tests through the real CopilotKit runtime cover authenticated owner scoping, main-thread provisioning/recovery, pagination, rename, archive, rich tool history, provider failures, and server-only key handling. A real CopilotKit Core failure verifies that queued messages pause when the SDK emits an error but resolves its promise. Without a key ([local mode](STANDALONE-THREADS.md)), the real runtime in SSE mode, the persistent runner on PGlite and the app's CopilotKit Core client over HTTP cover runs, replay after a reload, restart and crash recovery, the busy-thread 409, owner isolation and the thread menu, with no Intelligence calls. | Intelligence boundary is mocked in tests. Live WebSocket persistence/replay and cross-device acceptance need a project key. In local mode a reply resumes live only from the API process that runs it, and other devices' thread lists refresh when the menu opens. |
| OpenBot | Disabled adapter has protocol and identity contract tests against a pinned public revision, including computer gateway, takeover, refusal, and uncertain outcomes. | No live identity, routine, or computer backend bridge yet. |
| Native / web UI | iPhone simulator and web preview have been exercised. Native acceptance covers actual task/results navigation, PDF pages, browser navigation, Linux Terminal and Files, finance, and goals. | Android is bundle-validated, not installed on a device/emulator. |

## Release fixes and interface polish

- The composer remains available during replies. Send changes to Stop in the same input pill, with a visible follow-up queue, retained drafts while navigating, and a control for returning to the latest message.
- The composer browser acceptance check verified the shared button position, enabled Stop with an empty draft, draft retention after stopping, immediate sending afterward with no held follow-ups, and reset to Send on natural completion. It reported no runtime errors. The iPhone simulator recording also shows the inline stop control. All seven [CI jobs for this change](https://github.com/CopilotKit/openmuse/actions/runs/35021854345) passed.
- The refreshed [mobile and web demos](DEMO.md) run 38 and 42 seconds at 1920 × 1080, with matching animated previews. Both feature the capybara; the web story combines email and aquarium research. The removed model/browser footer captions and web headline remain absent.
- The avatar opens activity and approvals. Name, tone, avatar color, and background-update preferences persist. Sheets adapt to narrow screens; icon targets, text contrast, and message spacing are refined.
- Computer separates Browser, Terminal, and Files. Command receipts remain visible, **New command** reopens the input, and an explicit straight-quote correction handles pasted smart quotes. Command and file drafts persist across sheet navigation; late file responses cannot overwrite a newer editor.
- Browser takeover uses a light console with live connection state, keyboard controls, retained text after errors, and visibility-aware previews. Regression tests verify edited-address reopen, signed-link renewal after 16 minutes, and owner boundaries. The console was inspected on web and the iPhone simulator.

- Ideas no longer proposes processing a sent reply or repeating a completed matching document task. The reproduction failed before the fix; both regression checks now pass.
- Guided chat delegation now emits actual AG-UI tool-call results linked to persisted task IDs. The runtime regression test verifies the task reference and original source email.
- Refined the composer focus state, spacing, send/attachment targets, and removable attachment chips. Older results expand on demand. Repeated “sample” labels were removed from product copy; Apps retains explicit local-data status and reviews explain local actions.
- The menu now retains **Delegate task** after chat has history. Creating a new finance task from this entry was exercised on iPhone and produced its saved artifact.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm --dir apps/worker typecheck
pnpm test
pnpm build:server
pnpm --dir apps/mobile exec expo export --platform all --output-dir dist/release
pnpm --dir apps/worker exec playwright install chromium
pnpm test:browser
# Requires a responsive Docker daemon; use DOCKER_CONTEXT if needed:
docker build -t openmuse-computer:local apps/computer
pnpm test:computer
# Separate browser-container acceptance (not run locally for this release):
pnpm --dir apps/worker test:docker
```

The [demo guide](DEMO.md) describes the native walkthrough. The CI workflow defines these validation categories for a fresh Linux environment. See [GitHub Actions](https://github.com/CopilotKit/OpenMuse/actions/workflows/ci.yml) for remote CI results. No real mail was sent, purchase made, or private Google account connected during release verification.

## Still outside this release

Health, bank, social, and WhatsApp connectors; a managed generated-tool registry; voice/media generation; automatic purchases/reservations; mobile push; multi-tenant identity; and full desktop VM isolation. See the [roadmap](../ROADMAP.md).
