# Baileys + Express + Supabase production backend

A production-oriented WhatsApp Web backend using the current Baileys API, Express, Supabase Postgres/Storage, and Socket.IO.

## What is included

- QR login exposed as an HTTP API; after linking, the DB-backed auth state reconnects without another QR scan.
- Custom Supabase/Postgres authentication state; no `useMultiFileAuthState` in production.
- Signal key persistence with `BufferJSON` and `makeCacheableSignalKeyStore`.
- Reconnect/backoff and explicit handling of logout/auth failure.
- Baileys event normalization and persistence for contacts, chats, messages, receipts, reactions, groups, group participants, history sync, presence and connection state.
- Supabase Storage for received media.
- Message lookup through Postgres for `getMessage`, which improves retry delivery and poll processing.
- REST endpoints for status, QR, sending common message types, message actions, chats, groups, privacy, presence, media download, logout.
- Socket.IO events for real-time frontend consumers.
- Helmet, CORS, request logging, graceful shutdown, API error handling.
- SQL schema with RLS enabled and service-role-only server writes.

## Important

This is a WhatsApp Web client integration, not the official WhatsApp Business Cloud API. Use it only in ways allowed by WhatsApp's terms and applicable law. Baileys itself is not affiliated with Meta/WhatsApp.

## Setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Create a `.env` from `.env.example`.
4. `npm install`
5. `npm run dev`
6. Call `POST /api/wa/connect`.
7. Poll `GET /api/wa/qr` or listen for `whatsapp.qr` on Socket.IO.
8. Scan the QR from WhatsApp > Linked devices > Link a device.
9. Once `connection === open`, the auth state is stored in Postgres. Restarting the server should reconnect without a QR.

### Supabase Auth

When `REQUIRE_SUPABASE_AUTH=true`, send:
`Authorization: Bearer <supabase access token>`

The authenticated Supabase user owns the WhatsApp session.

For a simple server-only deployment, set it to false and protect the server with your own gateway/API key. Do not expose the Supabase service-role key to a browser.

## API

### Session
- `POST /api/wa/connect`
- `GET /api/wa/status`
- `GET /api/wa/qr`
- `POST /api/wa/logout`

### Messages
- `POST /api/wa/messages/text`
- `POST /api/wa/messages/media`
- `POST /api/wa/messages/location`
- `POST /api/wa/messages/contact`
- `POST /api/wa/messages/poll`
- `POST /api/wa/messages/reaction`
- `POST /api/wa/messages/read`
- `POST /api/wa/messages/delete`
- `POST /api/wa/messages/edit`
- `POST /api/wa/messages/presence`

### Chats
- `GET /api/wa/chats`
- `POST /api/wa/chats/archive`
- `POST /api/wa/chats/mute`
- `POST /api/wa/chats/read`
- `POST /api/wa/chats/delete`

### Groups
- `GET /api/wa/groups/:jid`
- `POST /api/wa/groups`
- `POST /api/wa/groups/:jid/participants`
- `DELETE /api/wa/groups/:jid/participants`
- `PATCH /api/wa/groups/:jid/subject`
- `PATCH /api/wa/groups/:jid/description`
- `GET /api/wa/groups/:jid/invite`
- `POST /api/wa/groups/:jid/leave`

### Privacy
- `GET /api/wa/privacy`
- `PATCH /api/wa/privacy`

### Data model

The database stores:
- `wa_sessions`: account identity and connection status.
- `wa_auth_creds`: serialized `AuthenticationCreds`.
- `wa_signal_keys`: serialized Signal/App State keys.
- `wa_contacts`, `wa_chats`, `wa_messages`.
- `wa_groups`, `wa_group_participants`.
- `wa_media`: metadata and Supabase Storage object path.
- `wa_events`: optional durable event/audit stream.

Long-lived Signal keys are sensitive. Treat the database containing them like a secrets store.

## Production deployment

Run exactly one active Baileys worker for each WhatsApp account. If you run multiple Node replicas, use a distributed ownership/lease mechanism (or a dedicated worker process) so two sockets never use the same WhatsApp auth state concurrently.

Put media files in private Supabase Storage. Generate signed URLs from a trusted backend when the frontend needs access.

For high-volume deployments, move event persistence to a queue/worker and use Redis for ephemeral caches, but keep Postgres as the source of truth.
