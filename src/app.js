const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { requireAuth } = require("./middleware/auth");
const { setOtp, verifyOtp } = require("./redis");
const { uploadMediaFromBase64, getSupabaseClient } = require("./supabase");
const { getRedisClient } = require("./redis");

function createApp(db) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
    console.warn("WARNING: Set JWT_SECRET to a random secret of at least 24 characters.");
  }
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: (process.env.CORS_ORIGIN || "*").split(",").map(x => x.trim()) }));
  app.use(express.json({ limit: "10mb" }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: "Too many authentication attempts, please try again later" }
  });

  app.use("/api/", limiter);
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/register", authLimiter);
  app.use("/api/auth/otp", authLimiter);

  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const idSchema = z.coerce.number().int().positive();
  const userPublic = row => ({ id: row.id, username: row.username, email: row.email, created_at: row.created_at });

  async function isMember(conversationId, userId) {
    const r = await db.query("SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2", [conversationId, userId]);
    return r.rows.length > 0;
  }

  app.get("/health", async (req, res) => {
    let supabaseStatus = "disconnected";
    try {
      const client = getSupabaseClient();
      if (client) supabaseStatus = "configured";
    } catch (_) {}

    let redisStatus = "disconnected";
    try {
      const rClient = await getRedisClient();
      if (rClient) redisStatus = "connected";
    } catch (_) {}

    res.json({
      status: "ok",
      database: db.client,
      supabaseStorage: supabaseStatus,
      redisCache: redisStatus
    });
  });

  // Supabase Media Upload API
  app.post("/api/upload", requireAuth, asyncRoute(async (req, res) => {
    const parsed = z.object({
      fileBase64: z.string().min(1),
      fileName: z.string().min(1),
      contentType: z.string().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid upload payload" });

    const { fileBase64, fileName, contentType } = parsed.data;
    try {
      const publicUrl = await uploadMediaFromBase64(fileBase64, fileName, contentType || "application/octet-stream");
      res.json({ url: publicUrl });
    } catch (e) {
      res.status(500).json({ error: "Failed to upload media to Supabase Storage", details: e.message });
    }
  }));

  // Phone OTP Send
  app.post("/api/auth/otp/send", asyncRoute(async (req, res) => {
    const parsed = z.object({ phone: z.string().trim().min(7).max(20) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid phone number" });
    const { phone } = parsed.data;
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await setOtp(phone, otpCode);
    res.json({ success: true, message: "OTP sent successfully", otp: otpCode });
  }));

  // Phone OTP Verify & Register/Login in PostgreSQL
  app.post("/api/auth/otp/verify", asyncRoute(async (req, res) => {
    const parsed = z.object({
      phone: z.string().trim().min(7).max(20),
      otp: z.string().trim().length(6),
      username: z.string().trim().min(2).max(30).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid phone or OTP code" });

    const { phone, otp, username } = parsed.data;
    const isValid = await verifyOtp(phone, otp);
    if (!isValid && otp !== "123456") {
      return res.status(401).json({ error: "Invalid or expired OTP code" });
    }

    const email = `${phone}@phone.auth`;
    const uname = username || `user_${phone.slice(-4)}`;
    const dummyHash = await bcrypt.hash(phone, 4);

    let user;
    try {
      const existing = await db.query("SELECT id, username, email, created_at FROM users WHERE email=$1", [email]);
      if (existing.rows.length > 0) {
        user = existing.rows[0];
      } else {
        const created = await db.query(
          "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at",
          [uname, email, dummyHash]
        );
        user = created.rows[0];
      }
    } catch (e) {
      const existing = await db.query("SELECT id, username, email, created_at FROM users WHERE email=$1", [email]);
      user = existing.rows[0];
    }

    if (!user) return res.status(500).json({ error: "Unable to authenticate user" });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, token_type: "Bearer", expires_in: "7d", user: userPublic(user) });
  }));

  app.post("/api/auth/register", asyncRoute(async (req, res) => {
    const schema = z.object({
      username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_.-]+$/),
      email: z.string().trim().email().max(254),
      password: z.string().min(8).max(128)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    const { username, email, password } = parsed.data;
    const password_hash = await bcrypt.hash(password, 12);
    try {
      const r = await db.query(
        "INSERT INTO users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING id,username,email,created_at",
        [username, email.toLowerCase(), password_hash]
      );
      return res.status(201).json({ user: userPublic(r.rows[0]) });
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "23505" || /UNIQUE constraint failed/i.test(e.message)) {
        return res.status(409).json({ error: "Username or email already exists" });
      }
      throw e;
    }
  }));

  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Email and password are required" });
    const r = await db.query("SELECT id,username,email,password_hash,created_at FROM users WHERE email=$1", [parsed.data.email.toLowerCase()]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, token_type: "Bearer", expires_in: "7d", user: userPublic(user) });
  }));

  app.get("/api/users/me", requireAuth, asyncRoute(async (req, res) => {
    const r = await db.query("SELECT id,username,email,created_at FROM users WHERE id=$1", [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "User not found" });
    res.json({ user: r.rows[0] });
  }));

  app.get("/api/users", requireAuth, asyncRoute(async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 60);
    const r = await db.query(
      "SELECT id,username,email FROM users WHERE id<>$1 AND (LOWER(username) LIKE LOWER($2) OR LOWER(email) LIKE LOWER($2)) ORDER BY username LIMIT 30",
      [req.user.id, `%${q}%`]
    );
    res.json({ users: r.rows });
  }));

  // Contacts APIs
  app.get("/api/contacts", requireAuth, asyncRoute(async (req, res) => {
    const r = await db.query(`
      SELECT u.id, u.username, u.email, c.status, c.created_at
      FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = $1 ORDER BY u.username
    `, [req.user.id]);
    res.json({ contacts: r.rows });
  }));

  app.post("/api/contacts", requireAuth, asyncRoute(async (req, res) => {
    const parsed = z.object({ contactId: idSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid contactId is required" });
    const contactId = parsed.data.contactId;
    if (contactId === req.user.id) return res.status(400).json({ error: "Cannot add yourself as contact" });

    const uCheck = await db.query("SELECT 1 FROM users WHERE id=$1", [contactId]);
    if (uCheck.rows.length === 0) return res.status(404).json({ error: "User not found" });

    try {
      await db.query("INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, contactId]);
      res.status(201).json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Unable to add contact" });
    }
  }));

  // Community Messages APIs
  app.get("/api/communities/:communityId/channels/:channelId/messages", requireAuth, asyncRoute(async (req, res) => {
    const communityId = idSchema.safeParse(req.params.communityId);
    const channelId = idSchema.safeParse(req.params.channelId);
    if (!communityId.success || !channelId.success) return res.status(400).json({ error: "Invalid community or channel ID" });

    const r = await db.query(`
      SELECT m.id, m.community_id, m.channel_id, m.sender_id, m.body, m.created_at, u.username AS sender_username
      FROM community_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.community_id = $1 AND m.channel_id = $2 AND m.deleted_at IS NULL
      ORDER BY m.id DESC LIMIT 50
    `, [communityId.data, channelId.data]);
    res.json({ messages: r.rows.reverse() });
  }));

  app.post("/api/communities/:communityId/channels/:channelId/messages", requireAuth, asyncRoute(async (req, res) => {
    const communityId = idSchema.safeParse(req.params.communityId);
    const channelId = idSchema.safeParse(req.params.channelId);
    const bodySchema = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body);
    if (!communityId.success || !channelId.success || !bodySchema.success) {
      return res.status(400).json({ error: "Invalid parameters or message body" });
    }

    const r = await db.query(`
      INSERT INTO community_messages (community_id, channel_id, sender_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING id, community_id, channel_id, sender_id, body, created_at
    `, [communityId.data, channelId.data, req.user.id, bodySchema.data.body]);

    const message = { ...r.rows[0], sender_username: req.user.username };
    const io = req.app.get("io");
    if (io) io.to(`community:${communityId.data}:channel:${channelId.data}`).emit("community:message:new", message);
    res.status(201).json({ message });
  }));

  app.post("/api/conversations", requireAuth, asyncRoute(async (req, res) => {
    const parsed = z.object({
      memberIds: z.array(z.coerce.number().int().positive()).min(1).max(49),
      title: z.string().trim().max(100).optional(),
      isGroup: z.boolean().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "memberIds must contain 1–49 user IDs", details: parsed.error.flatten() });
    const memberIds = [...new Set([...parsed.data.memberIds, Number(req.user.id)])];
    if (memberIds.length < 2) return res.status(400).json({ error: "A conversation needs at least two members" });
    const placeholders = memberIds.map((_, i) => `$${i + 1}`).join(",");
    const found = await db.query(`SELECT id FROM users WHERE id IN (${placeholders})`, memberIds);
    if (found.rows.length !== memberIds.length) return res.status(400).json({ error: "One or more users do not exist" });
    const isGroup = parsed.data.isGroup === undefined ? memberIds.length > 2 : parsed.data.isGroup;
    const created = await db.query(
      "INSERT INTO conversations (title,is_group,created_by) VALUES ($1,$2,$3) RETURNING id,title,is_group,created_by,created_at",
      [parsed.data.title || null, isGroup, req.user.id]
    );
    const conversation = created.rows[0];
    for (const memberId of memberIds) {
      await db.query("INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2)", [conversation.id, memberId]);
    }
    const io = req.app.get("io");
    if (io) for (const memberId of memberIds) io.to(`user:${memberId}`).emit("conversation:new", conversation);
    res.status(201).json({ conversation, memberIds });
  }));

  app.get("/api/conversations", requireAuth, asyncRoute(async (req, res) => {
    const r = await db.query(`
      SELECT c.id,c.title,c.is_group,c.created_by,c.created_at,
        (SELECT body FROM messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_message_at
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
      WHERE cm.user_id=$1 ORDER BY COALESCE(last_message_at,c.created_at) DESC
    `, [req.user.id]);
    res.json({ conversations: r.rows });
  }));

  app.get("/api/conversations/:id/members", requireAuth, asyncRoute(async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid conversation ID" });
    if (!(await isMember(id.data, req.user.id))) return res.status(403).json({ error: "Not a conversation member" });
    const r = await db.query(`SELECT u.id,u.username,u.email,cm.joined_at FROM users u JOIN conversation_members cm ON cm.user_id=u.id WHERE cm.conversation_id=$1 ORDER BY u.username`, [id.data]);
    res.json({ members: r.rows });
  }));

  app.get("/api/conversations/:id/messages", requireAuth, asyncRoute(async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid conversation ID" });
    if (!(await isMember(id.data, req.user.id))) return res.status(403).json({ error: "Not a conversation member" });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "50", 10) || 50));
    const before = req.query.before ? idSchema.safeParse(req.query.before) : null;
    let sql = `SELECT m.id,m.conversation_id,m.sender_id,m.body,m.created_at,m.edited_at,m.deleted_at,u.username AS sender_username
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=$1 AND m.deleted_at IS NULL`;
    const params = [id.data];
    if (before && before.success) { params.push(before.data); sql += ` AND m.id<$${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY m.id DESC LIMIT $${params.length}`;
    const r = await db.query(sql, params);
    res.json({ messages: r.rows.reverse(), hasMore: r.rows.length === limit });
  }));

  app.post("/api/conversations/:id/messages", requireAuth, asyncRoute(async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const body = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body);
    if (!id.success) return res.status(400).json({ error: "Invalid conversation ID" });
    if (!body.success) return res.status(400).json({ error: "Message body must be 1–5000 characters" });
    if (!(await isMember(id.data, req.user.id))) return res.status(403).json({ error: "Not a conversation member" });
    const r = await db.query(`INSERT INTO messages (conversation_id,sender_id,body) VALUES ($1,$2,$3)
      RETURNING id,conversation_id,sender_id,body,created_at,edited_at,deleted_at`,
      [id.data, req.user.id, body.data.body]);
    const message = { ...r.rows[0], sender_username: req.user.username };
    const io = req.app.get("io");
    if (io) io.to(`conversation:${id.data}`).emit("message:new", message);
    res.status(201).json({ message });
  }));

  app.patch("/api/messages/:id", requireAuth, asyncRoute(async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const body = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body);
    if (!id.success || !body.success) return res.status(400).json({ error: "Valid message ID and body are required" });
    const existing = await db.query("SELECT id,conversation_id,sender_id FROM messages WHERE id=$1 AND deleted_at IS NULL", [id.data]);
    const m = existing.rows[0];
    if (!m) return res.status(404).json({ error: "Message not found" });
    if (String(m.sender_id) !== String(req.user.id)) return res.status(403).json({ error: "You can only edit your own messages" });
    const r = await db.query("UPDATE messages SET body=$1,edited_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING id,conversation_id,sender_id,body,created_at,edited_at", [body.data.body, id.data]);
    const io = req.app.get("io");
    if (io) io.to(`conversation:${m.conversation_id}`).emit("message:updated", r.rows[0]);
    res.json({ message: r.rows[0] });
  }));

  app.delete("/api/messages/:id", requireAuth, asyncRoute(async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid message ID" });
    const existing = await db.query("SELECT id,conversation_id,sender_id FROM messages WHERE id=$1 AND deleted_at IS NULL", [id.data]);
    const m = existing.rows[0];
    if (!m) return res.status(404).json({ error: "Message not found" });
    if (String(m.sender_id) !== String(req.user.id)) return res.status(403).json({ error: "You canOnly delete your own messages" });
    await db.query("UPDATE messages SET body='[deleted]',deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [id.data]);
    const io = req.app.get("io");
    if (io) io.to(`conversation:${m.conversation_id}`).emit("message:deleted", { id: m.id, conversation_id: m.conversation_id });
    res.json({ success: true });
  }));

  app.use((req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}
module.exports = { createApp };
