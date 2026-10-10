import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
if (!config.databaseUrl)
  throw new Error(
    "A separate task worker requires DATABASE_URL. Embedded PGlite runs inside the API process.",
  );
const db = await createStore({ databaseUrl: config.databaseUrl });
const { agent, chat } = await createApp(db, config);
agent.start();
console.log("OpenMuse task worker running");
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await agent.stop();
  await chat?.close(); // Standalone: stop local chat timers before closing the database.
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void stop().catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  void stop().catch(() => process.exit(1));
});
