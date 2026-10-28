# Chat App Backend (Node.js + SQLite/PostgreSQL + Docker)

REST API and real-time messaging backend using Express, Socket.IO, JWT authentication, SQLite for local development, and PostgreSQL for Docker/production-style deployment.

## Features
- Register/login with bcrypt password hashing and JWT bearer tokens
- User lookup and current-user endpoint
- Create conversations with members; list conversations and members
- Send, paginate, edit, and soft-delete messages
- Socket.IO events for new conversations and real-time message changes
- SQLite or PostgreSQL selected by `DB_CLIENT`
- Docker Compose with PostgreSQL and persistent volumes
- Request validation, basic security headers, CORS configuration

## Run locally with SQLite

Requires Node.js 20+.

```bash
cp .env.example .env
```

Set `JWT_SECRET` in `.env` to a long random value, then:

```bash
npm install
npm run dev
```

API: `http://localhost:3000`, health check: `GET /health`.

SQLite data is stored at `./data/chat.sqlite`.

## Run with Docker + PostgreSQL

Copy `.env.example` to `.env`, set a strong `JWT_SECRET`, then run:

```bash
docker compose up --build -d
docker compose logs -f api
```

API: `http://localhost:3000`; PostgreSQL is available on port 5432. The Compose defaults are for local development only—change the database password and JWT secret before deployment.

To use SQLite in Docker instead, set `DB_CLIENT=sqlite` in `.env`. The API container still starts the PostgreSQL service because Compose defines it; this is harmless but unnecessary. For a SQLite-only container, run `docker build -t chat-api .` then `docker run --env-file .env -p 3000:3000 -v chat_data:/app/data chat-api`.

## Authentication

Register and then login. Send the returned token in requests:

`Authorization: Bearer YOUR_JWT_TOKEN`

### Register
```http
POST /api/auth/register
Content-Type: application/json

{"username":"amina","email":"amina@example.com","password":"a-strong-password"}
```

### Login
```http
POST /api/auth/login
Content-Type: application/json

{"email":"amina@example.com","password":"a-strong-password"}
```

### Get current user
`GET /api/users/me`

### Search users
`GET /api/users?q=amin`

### Create a conversation
`POST /api/conversations`

```json
{"memberIds":[2],"title":"Amina and Brian","isGroup":false}
```

The authenticated user is automatically included. For a group, supply multiple member IDs and optionally set `isGroup: true`.

### List conversations
`GET /api/conversations`

### Get conversation members
`GET /api/conversations/1/members`

### List messages
`GET /api/conversations/1/messages?limit=50`
Use `before=<messageId>` to fetch an older page.

### Send a message
`POST /api/conversations/1/messages`

```json
{"body":"Hello!"}
```

### Edit / delete your own message
- `PATCH /api/messages/1` with `{"body":"Corrected message"}`
- `DELETE /api/messages/1` (soft delete)

## Socket.IO client

Install `socket.io-client` in your frontend. Connect with the token:

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  auth: { token: accessToken }
});

socket.emit("conversation:join", conversationId);
socket.on("message:new", message => console.log(message));
socket.on("message:updated", message => console.log(message));
socket.on("message:deleted", event => console.log(event));
socket.on("conversation:new", conversation => console.log(conversation));
```

To send messages, use the authenticated REST endpoint; this keeps validation and membership checks centralized.

## API summary

| Method | Path | Auth | Purpose |
|---|---|---:|---|
| GET | `/health` | No | Health check |
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Login / JWT |
| GET | `/api/users/me` | Yes | Current user |
| GET | `/api/users?q=` | Yes | Search users |
| POST | `/api/conversations` | Yes | Create conversation |
| GET | `/api/conversations` | Yes | List conversations |
| GET | `/api/conversations/:id/members` | Yes | List members |
| GET | `/api/conversations/:id/messages` | Yes | Paginated messages |
| POST | `/api/conversations/:id/messages` | Yes | Send message |
| PATCH | `/api/messages/:id` | Yes | Edit own message |
| DELETE | `/api/messages/:id` | Yes | Soft-delete own message |

## Important production notes
- Use HTTPS and a strong secret manager for `JWT_SECRET`.
- Replace Compose's example database credentials.
- Add rate limiting, email verification/password reset, structured logging, backups, and automated tests before public launch.
- This starter does not yet implement read receipts, typing indicators, file uploads, push notifications, end-to-end encryption, or message delivery guarantees.
- SQLite and PostgreSQL use different ID types; treat IDs as opaque values in clients.
