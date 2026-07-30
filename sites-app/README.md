# WeLink Message Lab on Sites

This directory is the Cloudflare Worker-compatible Sites build of the WeLink
Message Lab web service. It keeps the web console, task queue, and evidence
storage in the cloud while the Codex SDK worker, Computer Use, and WeLink login
remain on the local Mac.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Runtime shape

- D1 stores administrator sessions, task state, worker presence, and audit
  events.
- R2 stores screenshot evidence privately.
- The authenticated local worker claims one task at a time and never retries an
  uncertain submission automatically.
- Production credentials are managed through Sites runtime variables and never
  stored in this directory.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: build the deployable Worker bundle
- `npm test`: build and verify the authenticated console and queue safeguards
- `npm run db:generate`: generate D1 migrations after schema changes
