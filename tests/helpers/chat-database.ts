// Standalone: the database for the local chat tests (tests/standalone-*.test.ts). Embedded PGlite
// by default. Set OPENMUSE_TEST_DATABASE_URL to a Postgres server on which the tests may create
// databases to run them through a pg Pool, as DATABASE_URL does in production: each test file
// then gets a new database, dropped when its store closes. A separate variable keeps a
// DATABASE_URL in the environment from ever pointing the tests at real data.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createStore, type Store } from "../../apps/server/src/db.ts";

export const testDatabaseUrl = process.env.OPENMUSE_TEST_DATABASE_URL?.trim() || undefined;

async function admin<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A store on a fresh database: embedded PGlite, or Postgres when OPENMUSE_TEST_DATABASE_URL is set. */
export async function createChatTestStore(): Promise<Store> {
  const url = testDatabaseUrl;
  if (!url) return createStore();
  const name = `openmuse_test_${randomUUID().replaceAll("-", "")}`;
  await admin(url, (client) => client.query(`CREATE DATABASE ${name}`));
  const target = new URL(url);
  target.pathname = `/${name}`;
  const store = await createStore({ databaseUrl: target.toString() });
  const close = store.close.bind(store);
  store.close = async () => {
    await close();
    await admin(url, (client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  };
  return store;
}
