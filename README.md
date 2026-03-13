# Poke Calls

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ilyesm/poke-calls)

A Cloudflare Worker that acts as an MCP server for [Poke](https://poke.interaction.co), enabling AI-powered outbound phone calls via [ElevenLabs Conversational AI](https://elevenlabs.io).

The agent introduces itself as your personal assistant, makes calls on your behalf, and can transfer callers to you when needed.

## Prerequisites

- A [Cloudflare](https://cloudflare.com) account
- An [ElevenLabs](https://elevenlabs.io) account with Conversational AI access
- A Twilio phone number linked to your ElevenLabs account
- [Node.js](https://nodejs.org) installed locally

## Setup

### 1. Clone and install

```bash
git clone https://github.com/ilyesm/poke-calls.git
cd poke-calls
npm install
```

### 2. Configure environment variables

Edit `wrangler.jsonc` and fill in the `vars`:

| Variable | Description |
|---|---|
| `ELEVENLABS_AGENT_ID` | Your ElevenLabs Conversational AI agent ID |
| `ELEVENLABS_PHONE_NUMBER_ID` | The Twilio phone number ID linked in ElevenLabs |
| `TRANSFER_NUMBER` | Your phone number in E.164 format (e.g. `+971501234567`) — calls transfer here when the caller asks for a human |
| `USER_NAME` | Your name — the agent introduces itself as "[name]'s assistant" |

### 3. Set secrets

```bash
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put MCP_AUTH_TOKEN
```

- **`ELEVENLABS_API_KEY`** — Your ElevenLabs API key (from Profile > API Keys)
- **`MCP_AUTH_TOKEN`** — A shared secret to authenticate Poke. Generate one with `openssl rand -hex 32`

### 4. ElevenLabs agent setup

In your ElevenLabs Conversational AI agent, add these two tools:

- **`end_call`** — Ends the call
- **`transfer_to_human`** (or `transfer_to_number`) — Transfers the call to a phone number

The worker overrides the agent's system prompt and greeting at call time, so the agent's default prompt in ElevenLabs doesn't matter much.

### 5. Deploy

```bash
npm run deploy
```

Your worker will be live at `https://poke-calls.<your-subdomain>.workers.dev`.

### 6. Connect to Poke

Add a custom MCP integration in Poke:

- **URL:** `https://poke-calls.<your-subdomain>.workers.dev/mcp`
- **Auth token:** The same `MCP_AUTH_TOKEN` you set above

## MCP Tools

### `make_outbound_call`

Initiates an AI voice call.

| Parameter | Required | Description |
|---|---|---|
| `to_number` | Yes | Phone number in E.164 format |
| `contact_name` | Yes | Name of the person being called |
| `objective` | Yes | What the call should achieve |
| `context` | No | Background on this contact or situation |
| `language` | No | Call language (defaults to English) |
| `first_message` | No | Custom greeting to open the call with |

### `get_call_outcome`

Retrieves the result of a completed call.

| Parameter | Required | Description |
|---|---|---|
| `conversation_id` | Yes | The ID returned by `make_outbound_call` |

Returns one of: `SUCCESS`, `FAILURE`, `TRANSFER`, or `PENDING`.

## Local development

```bash
npm run dev
```

## Routes

| Route | Method | Description |
|---|---|---|
| `/mcp` or `/` | `POST` | MCP JSON-RPC endpoint |
| `/health` | `GET` | Health check |
