const { createClient } = require("redis");

let redisClient = null;

async function getRedisClient() {
  if (!redisClient && process.env.REDIS_URL) {
    try {
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.on("error", err => console.error("Redis Client Error", err));
      await redisClient.connect();
    } catch (e) {
      console.warn("Redis connection failed, running without Redis cache:", e.message);
      redisClient = null;
    }
  }
  return redisClient;
}

async function setUserOnline(userId) {
  const client = await getRedisClient();
  if (client) {
    await client.set(`user:status:${userId}`, "online", { EX: 60 });
  }
}

async function setUserOffline(userId) {
  const client = await getRedisClient();
  if (client) {
    await client.set(`user:status:${userId}`, "offline");
  }
}

async function getUserStatus(userId) {
  const client = await getRedisClient();
  if (client) {
    return (await client.get(`user:status:${userId}`)) || "offline";
  }
  return "offline";
}

async function setTyping(conversationId, userId, isTyping) {
  const client = await getRedisClient();
  if (client) {
    if (isTyping) {
      await client.set(`typing:${conversationId}:${userId}`, "true", { EX: 5 });
    } else {
      await client.del(`typing:${conversationId}:${userId}`);
    }
  }
}

async function setOtp(email, otpCode) {
  const client = await getRedisClient();
  if (client) {
    await client.set(`otp:${email}`, otpCode, { EX: 300 });
  }
}

async function verifyOtp(email, otpCode) {
  const client = await getRedisClient();
  if (client) {
    const stored = await client.get(`otp:${email}`);
    if (stored === otpCode) {
      await client.del(`otp:${email}`);
      return true;
    }
  }
  return false;
}

module.exports = { getRedisClient, setUserOnline, setUserOffline, getUserStatus, setTyping, setOtp, verifyOtp };
