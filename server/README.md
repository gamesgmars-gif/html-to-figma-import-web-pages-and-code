# Render server

Node.js + Express + Playwright service used by the Figma plugin.

Endpoints:

- `GET /` — simple status page;
- `GET /healthz` — public Render health check;
- `GET /health` — authenticated browser readiness check;
- `POST /render` — authenticated webpage rendering endpoint.

`API_KEY` is generated automatically by `render.yaml` and must be sent in the `X-API-Key` header.
