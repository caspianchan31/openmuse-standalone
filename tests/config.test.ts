import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertApiDeploymentConfig,
  browserWorkerUrl,
  type Config,
  chatBackend,
  chatRetentionDays,
  readConfig,
  shadowedEnvKeys,
} from "../apps/server/src/config.ts";

const sampleConfig: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

function liveConfig(intelligenceApiKey?: string): Config {
  return {
    ...sampleConfig,
    mode: "live",
    agentBackend: "model",
    intelligenceApiKey,
  };
}

// Standalone: a missing or blank key selects local chat instead of failing startup.
test("every API mode accepts a missing or blank Intelligence key and selects local chat", () => {
  for (const mode of [sampleConfig, liveConfig()]) {
    for (const key of [undefined, "", " \t\n"]) {
      assert.doesNotThrow(() => assertApiDeploymentConfig({ ...mode, intelligenceApiKey: key }));
      assert.equal(chatBackend({ ...mode, intelligenceApiKey: key }), "local");
    }
  }
});

test("every API mode accepts a non-empty Intelligence key", () => {
  for (const mode of [sampleConfig, liveConfig()]) {
    assert.doesNotThrow(() =>
      assertApiDeploymentConfig({ ...mode, intelligenceApiKey: "test-project-key-never-sent" }),
    );
    // Standalone: a key keeps upstream's Intelligence mode.
    assert.equal(
      chatBackend({ ...mode, intelligenceApiKey: "test-project-key-never-sent" }),
      "intelligence",
    );
  }
});

// Standalone: readConfig no longer requires the key, and treats a blank one as unset.
test("readConfig starts without an Intelligence key and validates chat retention", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.HOST = "127.0.0.1";
  delete process.env.AGENT_BACKEND;
  delete process.env.CHAT_RETENTION_DAYS;
  for (const key of [undefined, "", "  "]) {
    if (key === undefined) delete process.env.CPK_INTELLIGENCE_API_KEY;
    else process.env.CPK_INTELLIGENCE_API_KEY = key;
    const config = readConfig();
    assert.equal(config.intelligenceApiKey, undefined);
    assert.equal(chatBackend(config), "local");
    assert.equal(config.chatRetentionDays, undefined);
  }
  process.env.CPK_INTELLIGENCE_API_KEY = " test-project-key-never-sent ";
  assert.equal(readConfig().intelligenceApiKey, "test-project-key-never-sent");
  assert.equal(chatBackend(readConfig()), "intelligence");
  assert.equal(chatRetentionDays("30"), 30);
  assert.equal(chatRetentionDays(" 7 "), 7);
  assert.equal(chatRetentionDays("  "), undefined);
  for (const value of ["0", "-1", "1.5", "soon", "1e3"])
    assert.throws(() => chatRetentionDays(value), /CHAT_RETENTION_DAYS/);
  delete process.env.CPK_INTELLIGENCE_API_KEY;
  process.env.CHAT_RETENTION_DAYS = "90";
  assert.equal(readConfig().chatRetentionDays, 90);
  process.env.CHAT_RETENTION_DAYS = "0";
  assert.throws(() => readConfig(), /CHAT_RETENTION_DAYS/);
  // Intelligence mode ignores it, so an invalid value does not stop that API from starting.
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  assert.equal(readConfig().chatRetentionDays, undefined);
});

test("web search is enabled by default with an explicit opt-out", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "model";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  delete process.env.WEB_SEARCH_ENABLED;
  assert.equal(readConfig().webSearchEnabled, true);
  for (const value of ["true", "", "1", "TRUE"]) {
    process.env.WEB_SEARCH_ENABLED = value;
    assert.equal(readConfig().webSearchEnabled, true);
  }
  process.env.WEB_SEARCH_ENABLED = "false";
  assert.equal(readConfig().webSearchEnabled, false);
});

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
  };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("browser worker URL keeps an existing scheme and adds http to host:port", () => {
  assert.equal(browserWorkerUrl(undefined), undefined);
  assert.equal(browserWorkerUrl("  "), undefined);
  assert.equal(browserWorkerUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(browserWorkerUrl("https://browser.internal:8790"), "https://browser.internal:8790");
  assert.equal(browserWorkerUrl("openmuse-browser-h4fx:8790"), "http://openmuse-browser-h4fx:8790");
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("computer provider defaults to Docker and e2b-desktop requires a server-side key", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const keys = [
    "COMPUTER_PROVIDER",
    "COMPUTER_ENABLED",
    "E2B_API_KEY",
    "COMPUTER_E2B_TEMPLATE",
    "COMPUTER_DEPLOYMENT_ID",
    "CPK_INTELLIGENCE_API_KEY",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    for (const key of keys.slice(0, 5)) delete process.env[key];
    assert.equal(readConfig().computerProvider, "docker");
    process.env.COMPUTER_PROVIDER = "k8s";
    assert.throws(() => readConfig(), /COMPUTER_PROVIDER/);
    process.env.COMPUTER_PROVIDER = "e2b-desktop";
    process.env.COMPUTER_ENABLED = "true";
    process.env.E2B_API_KEY = " ";
    assert.throws(() => readConfig(), /E2B_API_KEY/);
    process.env.E2B_API_KEY = "fixture-key";
    // A team-wide sandbox namespace needs an explicit, unique deployment id.
    assert.throws(() => readConfig(), /COMPUTER_DEPLOYMENT_ID/);
    process.env.COMPUTER_DEPLOYMENT_ID = "fixture-deployment";
    const config = readConfig();
    assert.equal(config.computerProvider, "e2b-desktop");
    assert.equal(config.computerE2bTemplate, "desktop");
    assert.equal(config.e2bApiKey, "fixture-key");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
