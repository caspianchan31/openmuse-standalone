import assert from "node:assert/strict";
import { test } from "node:test";
import { connectThread, lockRefusalAgent } from "../src/local-thread.ts";

function fakeAgent() {
  const calls: string[] = [];
  const agent = {
    setMessages(messages: []) {
      calls.push(`messages:${messages.length}`);
    },
    setState(state: Record<string, never>) {
      calls.push(`state:${Object.keys(state).length}`);
    },
  };
  const copilotkit = {
    async connectAgent(input: { agent: typeof agent }) {
      assert.equal(input.agent, agent);
      calls.push("connect");
      return "connected";
    },
  };
  return { agent, copilotkit, calls };
}

test("local threads clear the agent before every connect; Intelligence threads do not", async () => {
  const local = fakeAgent();
  assert.equal(await connectThread(local.copilotkit, local.agent, true), "connected");
  assert.deepEqual(local.calls, ["messages:0", "state:0", "connect"]);
  const cloud = fakeAgent();
  assert.equal(await connectThread(cloud.copilotkit, cloud.agent, false), "connected");
  assert.deepEqual(cloud.calls, ["connect"]);
});

test("only a queued turn on a local thread claims lock refusals; Intelligence keeps upstream's", () => {
  const agent = { id: "agent" };
  assert.equal(lockRefusalAgent(agent, true, true), agent);
  assert.equal(lockRefusalAgent(agent, true, false), undefined);
  assert.equal(lockRefusalAgent(agent, false, true), undefined);
  assert.equal(lockRefusalAgent(agent, false, false), undefined);
});
