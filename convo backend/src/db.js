const path = require("node:path");
const fs = require("node:fs");

function memorySqliteAdapter() {
  const store = {
    users: [],
    contacts: [],
    conversations: [],
    conversation_members: [],
    messages: [],
    community_messages: []
  };
  let userIdCounter = 1;
  let contactIdCounter = 1;
  let convIdCounter = 1;
  let msgIdCounter = 1;
  let commMsgIdCounter = 1;

  return {
    client: "sqlite-memory",
    async query(sql, params = []) {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith("CREATE TABLE") || trimmed.startsWith("CREATE INDEX")) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("INSERT INTO USERS")) {
        const [username, email, password_hash] = params;
        const user = { id: userIdCounter++, username, email, password_hash, status: "offline", last_seen: new Date().toISOString(), created_at: new Date().toISOString() };
        store.users.push(user);
        return { rows: [{ id: user.id, username: user.username, email: user.email, created_at: user.created_at }], rowCount: 1, insertId: user.id };
      }
      if (trimmed.includes("FROM USERS WHERE EMAIL=")) {
        const email = params[0];
        const user = store.users.find(u => u.email === email);
        return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      }
      if (trimmed.includes("FROM USERS WHERE ID=")) {
        const id = params[0];
        const user = store.users.find(u => u.id === id);
        return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      }
      if (trimmed.includes("SELECT ID FROM USERS WHERE ID IN")) {
        const matchedUsers = store.users.filter(u => params.includes(u.id));
        return { rows: matchedUsers.map(u => ({ id: u.id })), rowCount: matchedUsers.length };
      }
      if (trimmed.includes("FROM USERS WHERE ID<>") || trimmed.includes("LIKE")) {
        const currentUserId = params[0];
        const q = (params[1] || "").replace(/%/g, "").toLowerCase();
        const users = store.users.filter(u => u.id !== currentUserId && (u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
        return { rows: users.map(u => ({ id: u.id, username: u.username, email: u.email })), rowCount: users.length };
      }
      if (trimmed.includes("SELECT 1 FROM CONVERSATION_MEMBERS")) {
        const [convId, userId] = params;
        const found = store.conversation_members.some(cm => cm.conversation_id === convId && cm.user_id === userId);
        return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
      }
      if (trimmed.startsWith("INSERT INTO CONVERSATIONS")) {
        const [title, is_group, created_by] = params;
        const conv = { id: convIdCounter++, title, is_group: Boolean(is_group), created_by, created_at: new Date().toISOString() };
        store.conversations.push(conv);
        return { rows: [conv], rowCount: 1, insertId: conv.id };
      }
      if (trimmed.startsWith("INSERT INTO CONVERSATION_MEMBERS")) {
        const [conversation_id, user_id] = params;
        store.conversation_members.push({ conversation_id, user_id, joined_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.includes("FROM CONVERSATIONS C JOIN CONVERSATION_MEMBERS CM")) {
        const userId = params[0];
        const userConvs = store.conversation_members
          .filter(cm => cm.user_id === userId)
          .map(cm => store.conversations.find(c => c.id === cm.conversation_id))
          .filter(Boolean);
        const resultRows = userConvs.map(c => {
          const msgs = store.messages.filter(m => m.conversation_id === c.id && !m.deleted_at);
          const lastMsg = msgs[msgs.length - 1];
          return {
            ...c,
            last_message: lastMsg ? lastMsg.body : null,
            last_message_at: lastMsg ? lastMsg.created_at : null
          };
        }).sort((a, b) => new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at));
        return { rows: resultRows, rowCount: resultRows.length };
      }
      if (trimmed.includes("FROM USERS U JOIN CONVERSATION_MEMBERS CM")) {
        const convId = params[0];
        const members = store.conversation_members
          .filter(cm => cm.conversation_id === convId)
          .map(cm => {
            const u = store.users.find(user => user.id === cm.user_id);
            return u ? { id: u.id, username: u.username, email: u.email, joined_at: cm.joined_at } : null;
          })
          .filter(Boolean);
        return { rows: members, rowCount: members.length };
      }
      if (trimmed.includes("FROM MESSAGES M JOIN USERS U")) {
        const convId = params[0];
        const msgs = store.messages.filter(m => m.conversation_id === convId && !m.deleted_at);
        const mapped = msgs.map(m => {
          const u = store.users.find(user => user.id === m.sender_id);
          return { ...m, sender_username: u ? u.username : "unknown" };
        });
        return { rows: mapped, rowCount: mapped.length };
      }
      if (trimmed.startsWith("INSERT INTO MESSAGES")) {
        const [conversation_id, sender_id, body] = params;
        const msg = { id: msgIdCounter++, conversation_id, sender_id, body, created_at: new Date().toISOString(), edited_at: null, deleted_at: null };
        store.messages.push(msg);
        return { rows: [msg], rowCount: 1, insertId: msg.id };
      }
      if (trimmed.startsWith("UPDATE MESSAGES SET BODY=")) {
        const [body, id] = params;
        const msg = store.messages.find(m => m.id === id);
        if (msg) {
          msg.body = body;
          msg.edited_at = new Date().toISOString();
          return { rows: [msg], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("UPDATE MESSAGES SET BODY='[DELETED]'")) {
        const id = params[0];
        const msg = store.messages.find(m => m.id === id);
        if (msg) {
          msg.body = "[deleted]";
          msg.deleted_at = new Date().toISOString();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.includes("FROM MESSAGES")) {
        const id = params[0];
        const msg = store.messages.find(m => m.id === id && !m.deleted_at);
        return { rows: msg ? [msg] : [], rowCount: msg ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async init() {},
    async close() {}
  };
}

function sqliteAdapter() {
  try {
    const Database = require("better-sqlite3");
    const filename = process.env.SQLITE_PATH || "./data/chat.sqlite";
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    const raw = new Database(filename);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    return {
      client: "sqlite",
      async query(sql, params = []) {
        let i = 0;
        const statement = sql.replace(/\$(\d+)/g, (_, n) => {
          i = Number(n);
          return "?";
        });
        const stmt = raw.prepare(statement);
        if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
          const rows = stmt.all(...params);
          return { rows, rowCount: rows.length };
        }
        const result = stmt.run(...params);
        return { rows: [], rowCount: result.changes, insertId: result.lastInsertRowid };
      },
      async init() {
        raw.exec(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
            status TEXT DEFAULT 'offline', last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'accepted', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, contact_id)
          );
          CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT,
            is_group INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS conversation_members (
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(conversation_id, user_id)
          );
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sender_id INTEGER NOT NULL REFERENCES users(id),
            body TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            edited_at TEXT, deleted_at TEXT
          );
          CREATE TABLE IF NOT EXISTS community_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            community_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL REFERENCES users(id),
            body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            deleted_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
          CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
          CREATE INDEX IF NOT EXISTS idx_community_messages ON community_messages(community_id, channel_id, id);
          CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
        `);
      },
      async close() { raw.close(); }
    };
  } catch (e) {
    console.warn("better-sqlite3 native module not available or failed to load, falling back to in-memory SQLite adapter.");
    return memorySqliteAdapter();
  }
}

function postgresAdapter() {
  const { Pool } = require("pg");
  const connectionString = process.env.DATABASE_URL || "postgres://chatuser:chatpassword@localhost:5432/chatdb";
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
  });
  return {
    client: "postgres",
    async query(sql, params = []) { return pool.query(sql, params); },
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          status TEXT DEFAULT 'offline',
          last_seen TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS contacts (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          contact_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT DEFAULT 'accepted',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(user_id, contact_id)
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id BIGSERIAL PRIMARY KEY,
          title TEXT,
          is_group BOOLEAN NOT NULL DEFAULT FALSE,
          created_by BIGINT NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS conversation_members (
          conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(conversation_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id BIGSERIAL PRIMARY KEY,
          conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id BIGINT NOT NULL REFERENCES users(id),
          body TEXT NOT NULL,
          reply_to BIGINT REFERENCES messages(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          edited_at TIMESTAMPTZ,
          deleted_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS community_messages (
          id BIGSERIAL PRIMARY KEY,
          community_id BIGINT NOT NULL,
          channel_id BIGINT NOT NULL,
          sender_id BIGINT NOT NULL REFERENCES users(id),
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
        CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_community_messages ON community_messages(community_id, channel_id, id);
        CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
      `);
    },
    async close() { await pool.end(); }
  };
}

async function createDatabase() {
  const client = (process.env.DB_CLIENT || "sqlite").toLowerCase();
  if (client === "postgres" || client === "postgresql") return postgresAdapter();
  if (client === "sqlite") return sqliteAdapter();
  throw new Error("DB_CLIENT must be sqlite or postgres");
}
module.exports = { createDatabase };
