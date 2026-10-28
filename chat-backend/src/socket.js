const jwt = require("jsonwebtoken");

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

  io.on("connection", socket => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);

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
  });
}
module.exports = { attachSocketHandlers };
