// POST /.netlify/functions/admin — admin login and button editing.
// Body: { action, ...fields }. Every action except "login" needs "Authorization: Bearer <token>".
import crypto from "node:crypto";
import { readData, writeData, adminView, cleanLink, checkLogin, makeToken, checkToken, json } from "../lib/store.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request" }, 400); }

  try {
    if (body.action === "login") {
      const res = await checkLogin(body.username, body.password);
      if (!res.ok) return json(res, 401);
      return json({ ok: true, token: makeToken() });
    }

    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!checkToken(token)) {
      return json({ ok: false, error: "Session expired. Please log in again.", authError: true }, 401);
    }

    switch (body.action) {
      case "list": {
        const { data } = await readData();
        return json({ ok: true, data: adminView(data) });
      }

      case "saveLink": {
        const { data, etag } = await readData();
        const link = cleanLink(body.link || {}, data.roles);
        if (body.link && body.link.id) {
          const i = data.links.findIndex(l => l.id === body.link.id);
          if (i < 0) return json({ ok: false, error: "That button no longer exists. Reload and try again." }, 404);
          data.links[i] = { id: data.links[i].id, ...link };
        } else {
          data.links.push({ id: crypto.randomUUID(), ...link });
        }
        await writeData(data, etag);
        return json({ ok: true, data: adminView(data) });
      }

      case "deleteLink": {
        const { data, etag } = await readData();
        const before = data.links.length;
        data.links = data.links.filter(l => l.id !== body.id);
        if (data.links.length === before) return json({ ok: false, error: "That button no longer exists. Reload and try again." }, 404);
        await writeData(data, etag);
        return json({ ok: true, data: adminView(data) });
      }

      case "logout":
        return json({ ok: true }); // tokens expire on their own; the page forgets it

      default:
        return json({ ok: false, error: "Unknown action" }, 400);
    }
  } catch (err) {
    if (!err.status) console.error(err);
    return json({ ok: false, error: err.status ? err.message : "Something went wrong. Try again." }, err.status || 500);
  }
};
