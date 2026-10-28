const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

process.env.JWT_SECRET = "test-secret-key-at-least-24-characters-long";

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

async function startTestServer(db) {
  const app = createApp(db);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://localhost:${port}`
  };
}

test("SQLite Database Adapter and REST API Integration Tests", async t => {
  const testDbPath = path.join(__dirname, "../data/test_chat.sqlite");
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  process.env.DB_CLIENT = "sqlite";
  process.env.SQLITE_PATH = testDbPath;

  const db = await createDatabase();
  await db.init();
  assert.ok(db.client === "sqlite" || db.client === "sqlite-memory");

  const { server, baseUrl } = await startTestServer(db);

  let token = "";
  let conversationId = null;

  await t.test("Health check", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, "ok");
    assert.ok(data.database === "sqlite" || data.database === "sqlite-memory");
  });

  await t.test("Register user", async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "testuser1",
        email: "test1@example.com",
        password: "password123"
      })
    });
    const data = await res.json();
    assert.strictEqual(res.status, 201);
    assert.ok(data.user);
    assert.strictEqual(data.user.username, "testuser1");
  });

  await t.test("Login user", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test1@example.com",
        password: "password123"
      })
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(data.token);
    token = data.token;
  });

  await t.test("Get current user (/api/users/me)", async () => {
    const res = await fetch(`${baseUrl}/api/users/me`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.user.email, "test1@example.com");
  });

  await t.test("Register second user and create conversation", async () => {
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "testuser2",
        email: "test2@example.com",
        password: "password123"
      })
    });

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test2@example.com",
        password: "password123"
      })
    });
    const loginData = await loginRes.json();
    const user2Id = loginData.user.id;

    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        memberIds: [user2Id],
        title: "Test Chat"
      })
    });
    const convData = await convRes.json();
    assert.strictEqual(convRes.status, 201);
    assert.ok(convData.conversation);
    conversationId = convData.conversation.id;
  });

  await t.test("Send and list messages", async () => {
    const sendRes = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ body: "Hello from test!" })
    });
    const sendData = await sendRes.json();
    assert.strictEqual(sendRes.status, 201);
    assert.strictEqual(sendData.message.body, "Hello from test!");

    const listRes = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const listData = await listRes.json();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listData.messages.length, 1);
    assert.strictEqual(listData.messages[0].body, "Hello from test!");
  });

  server.close();
  await db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

test("PostgreSQL Adapter Configuration Test", async t => {
  process.env.DB_CLIENT = "postgres";
  process.env.DATABASE_URL = "postgres://invalid:invalid@localhost:5432/invaliddb";
  const db = await createDatabase();
  assert.strictEqual(db.client, "postgres");
  await db.close();
});
