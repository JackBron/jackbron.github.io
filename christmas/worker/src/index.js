import { Party } from "./party.js";

export { Party };

// The whole party lives in one Durable Object, so every write sees the latest
// state (two guests can't both grab the last pie). This wrapper only does CORS.
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = origin && (allowed.includes(origin) || allowed.includes("*"))
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (!new URL(request.url).pathname.startsWith("/api/")) {
      return new Response("Christmas party API. The page lives on the static site.", { status: 404, headers: cors });
    }

    const res = await env.PARTY.get(env.PARTY.idFromName("party")).fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
