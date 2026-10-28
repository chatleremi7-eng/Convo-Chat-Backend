require("dotenv").config();
const http = require("node:http");
const { Server } = require("socket.io");
const { createApp } = require("./app");
const { createDatabase } = require("./db");
const { attachSocketHandlers } = require("./socket");

const PORT = Number(process.env.PORT || 3000);

async function main() {
  const db = await createDatabase();
  await db.init();
  const app = createApp(db);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: (process.env.CORS_ORIGIN || "*").split(",").map(x => x.trim()),
      methods: ["GET", "POST"]
    }
  });
  attachSocketHandlers(io, db);
  app.set("io", io);
  server.listen(PORT, () => console.log(`Chat API listening on port ${PORT} (${db.client})`));
  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch(err => { console.error("Startup failed:", err); process.exit(1); });
