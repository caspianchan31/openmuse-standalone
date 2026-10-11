# Security policy

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** form for private reports. Include the affected commit, reproduction steps using fictional data, and the observed impact. Do not open a public issue containing credentials or a working exploit against someone else's deployment. This alpha has no guaranteed response time.

## Deployment boundary

OpenMuse currently supports one owner per deployment. Live mode uses a shared access key; it is not multi-tenant account authentication. Sample mode binds to loopback and contains fictional data. Use HTTPS and restricted network access for a remote live deployment.

The API holds provider credentials. Google tokens are encrypted at rest; short-lived signed URLs grant file and browser-console access. Protect `.env`, `.openmuse`, database backups, and browser profiles as private data. A signed URL is a credential until it expires.

The browser worker must remain private and require its own random token. It runs persistent Chromium with application-enforced public-network checks. Playwright disables Chromium's internal sandbox by default; this is not a full desktop VM or a security boundary for hostile tenants. The browser Docker image reduces host access but does not establish kernel-enforced network isolation. See [worker boundaries](apps/worker/README.md).

## Linux computer boundary

The optional computer service runs a **single-owner Docker Linux container**, separate from Chromium. It is disabled by default. The API launches only the fixed Docker CLI with argument arrays; user commands are passed to bash inside the container. It never falls back to a host shell. The API and its Docker connection are trusted infrastructure: protect them from other users and use an image you control.

The container runs as UID/GID 1000 with a read-only root filesystem, all capabilities dropped, no added privileges, and Docker networking set to `none`. It receives no host directory mounts, Docker socket, model keys, Google tokens, or API access key. Limits are 512 MB RAM with no swap, one CPU, 128 processes, and 64 MB of temporary storage. Existing containers and volumes must match this deployment's ownership labels and isolation settings before the service attaches.

A named volume persists `/workspace`. Commands may create, change, or delete its files. The file API stays inside `/workspace`, rejects symlink traversal and special files, and uses atomic text replacement. Text reads/writes are limited to 256 KB; PDF import/export is limited to 10 MB and checks ownership in OpenMuse. File contents and command output remain untrusted input for the agent.

Commands have a 30-second container timeout, a 2-second kill grace, a 35-second Docker-client timeout, and a combined 128 KB output cap. The server records output, status, and exit codes. Stop prevents restart until both Docker stop and the original execution are acknowledged. Failed cleanup retains a safety lock and permits an explicit Stop retry. Interrupted work is recorded with an uncertain outcome and is never automatically replayed.

Docker shares its host kernel and does not provide a full VM or a hostile-tenant guarantee. The persistent volume has no portable per-volume disk quota; provision and monitor Docker storage separately. The browser's public-web checks do not enable networking in the Linux computer. See [computer setup](docs/COMPUTER.md).

### E2B desktop provider (opt-in)

With `COMPUTER_PROVIDER=e2b-desktop`, each owner's computer is a dedicated E2B Desktop VM instead of a Docker container, and the paragraphs above about Docker networking, the read-only root filesystem, capabilities and limits do not apply. Outbound internet access is enabled, the in-VM `user` account has passwordless sudo, and `/workspace` is stored with E2B. Internet access is an egress path that OpenMuse does not review: approval gating covers only the app's own email and calendar tools, so a prompt-injected agent could send data from the computer or submit forms in its browser. The live desktop stream is reachable from the internet and protected only by the VNC password in its URL (8 effective characters); treat that URL as a bearer secret. All listening VM ports are publicly reachable at `https://<port>-<sandboxId>.e2b.app` without application authentication; public traffic is enabled to allow the direct desktop iframe. The sandbox ID appears in the stream hostname and is not an access control. For example, `python3 -m http.server 8000` in `/workspace` exposes workspace files to the internet. Do not leave servers running or put sensitive files in an unauthenticated service. The iframe is sandboxed to block forms, popups and top-level navigation, but VM-controlled content can still display misleading prompts. The E2B API key stays on the API host and is never passed into the VM or to the client. A unique `COMPUTER_DEPLOYMENT_ID` is required, because sandboxes are matched by metadata across the whole E2B team. See [the E2B desktop section](docs/COMPUTER.md#run-the-computer-on-an-e2b-desktop-optional).

## External actions

A proposal is bound to the account, reviewed content, and applicable provider version. The server requires a recorded approval before dispatching a send or calendar change. An uncertain network outcome is retained for reconciliation. Cancellation stops later task steps; a provider request already in flight may still finish.

The sample walkthrough needs no CopilotKit Intelligence key: without one, conversations are stored in the API's own database ([local mode](docs/STANDALONE-THREADS.md)). CI uses synthetic keys and mocked Intelligence boundaries. No provider keys, personal data, or third-party logins are needed for CI. CopilotKit Intelligence and any configured model/provider operate under their own terms and data policies. Optional live Jev (`JEV_MODE=live`) sends the user's latest message, agent-written context, and candidate choices to TypeSafe; see [what live mode sends](docs/demos/jev-generative-ui.md#what-live-mode-sends-to-typesafe).
