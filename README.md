# OpenMuse Standalone

**OpenMuse that runs entirely on your own server. No third-party chat cloud.**

[OpenMuse](https://github.com/CopilotKit/openmuse) is a personal agent with a browser, a cloud desktop, files and background work. Upstream, its chat layer stores every conversation in CopilotKit Intelligence, a hosted service: when that service is down, you cannot talk to your agent, and your conversation text lives on someone else's servers.

This fork keeps everything OpenMuse does and moves the chat layer in-house:

- Conversations, thread lists and the main chat are stored in your own Postgres.
- The agent streams replies straight from your server to your browser (SSE), with no relay through a hosted gateway.
- The model call, the cloud desktop (E2B), mail, calendar and files already ran on your own keys upstream; they are unchanged.
- Everything else tracks upstream OpenMuse.

## Status

Planning. The design is done and the work is scoped (a persistent thread runner for the CopilotKit runtime's SSE mode, plus thread routes served locally). Code lands here as it is written. Until then, this repository is the place to watch, open issues and discuss.

## Why not just patch the config

The upstream runtime has no local fallback: without the hosted service, opening the chat fails with "Main conversation is unavailable" and every message fails with "Failed to initialize thread". Switching the runtime to SSE mode requires a thread store of its own, which is what this fork adds.

## Relationship to upstream

MIT, like upstream. Changes are kept small and marked, so the fork can keep merging upstream. If upstream adds a first-party local thread store, this fork will adopt it.

---

## 中文

**OpenMuse 独立版：整套跑在自己的服务器上，不依赖第三方聊天云。**

上游 OpenMuse 的聊天层把所有对话存在 CopilotKit Intelligence 托管服务里：它一挂，你就没法和 agent 说话；对话文本也在别人的服务器上。本分支把聊天层收回自己手里（Postgres 存线程、服务端直接流式回浏览器），其余功能与上游一致，持续跟进上游。

现状：规划中，设计已定，代码会陆续提交到这里。
