# Discord-Shiro

Private-test prototype for a mention/reply-only Discord AI companion.

## Setup
- Node.js 22 or newer; run npm install, then npm start.
- Copy .env.example to .env locally, or set environment variables in your hosting service. Never commit real keys.
- Enable Message Content Intent in Discord Developer Portal.
- Invite the bot with View Channels, Read Message History and Send Messages (and Send Messages in Threads if needed).
- Set ALLOWED_GUILD_IDS and ALLOWED_CHANNEL_IDS to explicit test IDs. Threads require their own channel IDs.
- Disclose to test participants that recent channel messages may be sent to the configured AI provider. Only use approved opt-in channels.
- NVIDIA hosted evaluation endpoints are for prototyping; check applicable terms before public deployment.

## Implemented
Direct textual bot mention or reply to its message, bounded recent Discord history, configurable Qwen chat model, temporary personality, typing indicator, no outgoing pings, per-user cooldown, single in-flight request, in-memory daily request cap (resets on restart).

## Planned
GPT-OSS backread route (environment placeholders only), persistent Discord memory, optional vision/document processing, durable rate limits, automated tests and deployment verification. No Notion or database dependency.

The bot is not deployed or live-tested yet. No credentials belong in this repository.
