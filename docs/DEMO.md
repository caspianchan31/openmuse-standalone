# Demos

Updated September 16, 2026. Both recordings feature OpenMuse's original capybara mascot and the current composer: the send arrow changes to a stop square inside the input pill while OpenMuse replies, then returns when the run ends. The mobile story explores websites; the desktop story starts with email and continues into related research.

## Mobile

[Watch the 38-second MP4](../assets/demos/2026-09-16/mobile.mp4) · [Animated hero](../assets/demos/2026-09-16/mobile.gif) · [Cover image](../assets/demos/2026-09-16/mobile.png).

**OpenMuse 🪁 — ask it to browse, follow along in chat, and take control when you need to.** The native iPhone recording is framed in a 1920 × 1080 (16:9) canvas, with a cream, blue, and lilac background and captions for sound-off viewing.

The model responses use [CopilotKit AI Mock](https://github.com/CopilotKit/aimock). The app runs its actual CopilotKit agent and `browse_web` tool against a real Chromium worker. The script requests a page, waits for the real tool result, and extracts headlines or overview text from that result. It does not supply browser results or invent page content.

### What the mobile recording shows

| Time | Scene |
| --- | --- |
| 0:00–0:04 | Ask OpenMuse to explore Hacker News |
| 0:04–0:09 | Read highlights from the live page |
| 0:09–0:15 | Ask it to summarize CopilotKit |
| 0:15–0:21 | Follow the inline browser and result, with Stop inside the input pill |
| 0:21–0:31 | Take control of the same live browser |
| 0:31–0:38 | Return to chat and the OpenMuse repository |

- A chat request to find interesting stories on Hacker News.
- A server tool call that opens and reads the page, with a browser card inline in the conversation.
- Highlights extracted from the page the browser just read.
- A second request to summarize CopilotKit, using the same persistent browser session.
- **Take control**, which opens that session's live browser console.
- The open-source repository at [CopilotKit/OpenMuse](https://github.com/CopilotKit/OpenMuse).

Captures are trimmed and paced for readability, including brief slowdowns of the browser card and faster transitions into takeover. This is a reproducible demonstration of the app and tool flow; it is not an evaluation of a live model's reasoning. Site content changes, so your highlights can differ. Personal workspace information is fictional. Live Google, provider quality, Intelligence persistence/replay, and OpenBot require separately configured acceptance runs; see [verification](VERIFICATION.md).

## Desktop web

[Watch the 42-second web MP4](../assets/demos/2026-09-16/web.mp4) · [Animated preview](../assets/demos/2026-09-16/web.gif) · [Cover image](../assets/demos/2026-09-16/web.png).

A separate recording of the actual desktop web app, placed below the mobile demo in the README. Ask **“Check my emails for the school trip”**, open the school's reminder, then ask **“Research Monterey Bay Aquarium and suggest three exhibits”**. The 1440 × 810 browser capture sits inside a 1920 × 1080 canvas with the same cream, blue, and lilac background and OpenMuse 🪁 branding.

| Time | Scene |
| --- | --- |
| 0:00–0:06 | Ask for the school-trip email; the agent searches and reads it |
| 0:06–0:13 | Open the inline email card and full message |
| 0:13–0:17 | Review departure, return, and packing details |
| 0:17–0:23 | Ask for research about Monterey Bay Aquarium |
| 0:23–0:28 | Follow the aquarium website inline |
| 0:28–0:33 | Read three exhibit excerpts and their source |
| 0:33–0:42 | Take control, scroll the same browser, and return to chat |

This recording uses the same AI Mock model and real Chromium tool flow described above, plus the actual `search_mail` and `read_mail_thread` tools against an isolated fictional mailbox. The model selects the thread ID returned by search and quotes its returned details. Opening the card loads the full thread through the app's existing email viewer. The aquarium excerpts come from exhibit entries on its current website. The email says “aquarium”; the second user prompt supplies Monterey Bay Aquarium explicitly.

The production web export captures actual typing, clicks, and scrolling. Cuts, brief holds, and speed changes shorten waiting time. No development overlays or private workspace information appear in the published media. No real email is sent or live Google account connected.

## Composer interaction

The primary button stays in the same place through each reply. Its accessible label changes from **Send message** to **Stop reply** while running. Stopping preserves the current draft. When there are no held follow-ups, sending a new message continues immediately; an existing paused queue resumes through **Send queued messages**.

To check interruption yourself, send a supported prompt, type a follow-up while the agent is replying, and tap the stop square. Confirm the draft remains, then send it once the arrow returns. The recordings show the send/stop state change; this interruption check is a separate acceptance step.

## Run the agent browser demo

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/worker exec playwright install chromium
pnpm dev:demo
```

This starts AI Mock, the normal OpenMuse API on port **8788**, and a separate real browser worker on **8791**. Demo files and profiles stay in ignored `artifacts/demo/`. Without an Intelligence key, the demo API stores its conversations in its own isolated database ([local mode](STANDALONE-THREADS.md)). To record against Intelligence instead, run `npx copilotkit@latest login` and `npx copilotkit@latest project select` first and set `CPK_INTELLIGENCE_API_KEY`; the runner passes only that key to its isolated API process. It does not pass provider or Google credentials. The Linux computer is disabled for this focused browser recording.

Start the app in another terminal:

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm dev:web
```

For the iPhone development build:

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm --dir apps/mobile exec expo start --dev-client --port 8081
```

Use the [native setup](../apps/mobile/README.md) if the development build is not installed. Fully reload the app after changing its API URL. Android emulators use `http://10.0.2.2:8788` for the host API.

For the mobile story, send **“Check out Hacker News for cool stuff”**, then **“Summarize copilotkit.ai”**. For the desktop story, send **“Check my emails for the school trip”**, open the email card, then send **“Research Monterey Bay Aquarium and suggest three exhibits”**. Wait for each reply and choose **Take control** to inspect the browser. The recording model scripts these four requests; use [a configured model](UPSTREAM-README.md#configure-the-agent-and-google) for open-ended requests. Mail and browser tools are the same server implementations in both modes.

`DEMO_MODEL_FIRST_BYTE_DELAY_MS` and `DEMO_MODEL_CHUNK_DELAY_MS` tune model pacing (defaults 1500 and 80 ms). `DEMO_API_PORT` changes the API port. Set `DEMO_WORKER_URL` and `DEMO_WORKER_TOKEN` to use an existing local worker instead of starting one. The built-in demo token is public and scoped to this local demo; it is not a deployment credential. Press Control-C to stop the demo processes. Restart your normal app command without the demo API override to return to your usual workspace.

## Record your own demo

### iPhone

With the app open on a simulator containing fictional personal information:

```sh
xcrun simctl io booted recordVideo --codec=h264 openmuse-recording.mp4
# Interact with the app. Press Control-C to finish the video.
```

Capture at native resolution, trim idle time, and frame the portrait capture inside a 16:9 canvas. Show the chat request and its real tool result. Describe the model setup in the accompanying recording notes. Check the final video for development reload banners and private content before publishing.

### Web

Start the demo runner, then export and serve the web app to avoid development reload banners:

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm --dir apps/mobile exec expo export --platform web --clear --output-dir dist/web
python3 -m http.server 8081 --bind 127.0.0.1 --directory apps/mobile/dist/web
```

Use port 8081 when the development server is stopped. `--clear` ensures the export uses the requested API URL. Open the page in a clean desktop browser and record the two prompts and takeover flow at 1440 × 810 or larger. Describe the model setup in the accompanying recording notes. Scroll to keep the browser card and resulting text readable.

The original [75-second alpha walkthrough](https://github.com/jerelvelarde/openmuse/releases/download/v0.1.0-alpha/openmuse-demo.mp4) remains available as a historical release archive. OpenMuse's [capybara artwork and provenance](../apps/mobile/assets/README.md) are included under the repository's MIT license.
