const jwt = require("jsonwebtoken");
const { setUserOnline, setUserOffline, setTyping } = require("./redis");

function attachSocketHandlers(io, db) {
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication required"));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", async socket => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    await setUserOnline(userId);

    // Client emits conversation:join with a conversation ID. Membership is verified server-side.
    socket.on("conversation:join", async conversationId => {
      try {
        const r = await db.query(
          "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2",
          [conversationId, userId]
        );
        if (r.rows.length) socket.join(`conversation:${conversationId}`);
        else socket.emit("error:forbidden", { message: "Not a conversation member" });
      } catch {
        socket.emit("error:server", { message: "Unable to join conversation" });
      }
    });

    socket.on("conversation:leave", conversationId => socket.leave(`conversation:${conversationId}`));

    socket.on("typing:start", async conversationId => {
      await setTyping(conversationId, userId, true);
      socket.to(`conversation:${conversationId}`).emit("typing:started", { userId, conversationId });
    });

    socket.on("typing:stop", async conversationId => {
      await setTyping(conversationId, userId, false);
      socket.to(`conversation:${conversationId}`).emit("typing:stopped", { userId, conversationId });
    });

    socket.on("disconnect", async () => {
      await setUserOffline(userId);
    });
  });
}
module.exports = { attachSocketHandlers };
