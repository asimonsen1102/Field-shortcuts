// Shared storage + auth helpers for the portal's Netlify Functions.
// Portal content (settings, roles, buttons) is one JSON document in Netlify Blobs.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "micrologic-portal";
const DATA_KEY = "portal-data";
const FAILS_KEY = "login-fails";

export const ICONS = ["clipboard", "search", "wrench", "box", "map", "grid", "truck", "users", "chart",
  "idcard", "gear", "file", "folder", "calendar", "camera", "phone", "link", "person"];

const PRODUCT_URL = "https://script.google.com/a/macros/micrologic.net/s/AKfycbzj9CN73CZliysBJuxk-fIuNDG8LXBtXKCQG-Q8BvjmuqknKxOaU24_o0JGEEmgDKc/exec";
const TOOLBOX_URL = "https://script.google.com/a/macros/micrologic.net/s/AKfycbw6DN9yHzlnjX7AFThCwuHp8AK3ABQ2q0Ua1H4ciRKk3WeLItth_K4sBnbiPnGMQmfM/exec";

/** What the portal starts with the first time it runs. After that, the admin screen owns it. */
export const DEFAULT_DATA = {
  settings: {
    CompanyName: "MICROLOGIC",
    PortalTitle: "EMPLOYEE PORTAL",
    Tagline: "Your central hub for field operations and project management.",
    Announcement: "",
    SupportEmail: ""
  },
  roles: [
    { id: "technician", label: "Field Technician", description: "Product and toolbox requests", color: "#4fb39a", order: 1, active: true },
    { id: "pm", label: "Project Manager", description: "Product requests", color: "#74cbc1", order: 2, active: true }
  ],
  links: [
    { id: "seed-tech-product", roles: ["technician"], section: "Field Technician", title: "Product Request", description: "Request parts, products, and supplies.", url: PRODUCT_URL, icon: "clipboard", order: 1, active: true },
    { id: "seed-tech-toolbox", roles: ["technician"], section: "Field Technician", title: "Toolbox Request", description: "Request tools and equipment for your toolbox.", url: TOOLBOX_URL, icon: "box", order: 2, active: true },
    { id: "seed-pm-product", roles: ["pm"], section: "Project Management", title: "Product Request", description: "Request parts, products, and supplies.", url: PRODUCT_URL, icon: "clipboard", order: 10, active: true }
  ],
  updated: null
};

const store = () => getStore({ name: STORE_NAME, consistency: "strong" });
const clone = (o) => JSON.parse(JSON.stringify(o));
const byOrder = (a, b) => (Number(a.order) || 999) - (Number(b.order) || 999);

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/** Returns { data, etag }. etag is null until the first save. */
export async function readData() {
  const res = await store().getWithMetadata(DATA_KEY, { type: "json" });
  if (!res || !res.data) return { data: clone(DEFAULT_DATA), etag: null };
  return { data: res.data, etag: res.etag };
}

/** Saves only if nobody else saved in between; otherwise throws so the admin can reload. */
export async function writeData(data, etag) {
  data.updated = new Date().toISOString();
  const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
  const res = await store().setJSON(DATA_KEY, data, opts);
  if (res && res.modified === false) {
    const err = new Error("Someone else changed the portal at the same time. Reload and try again.");
    err.status = 409;
    throw err;
  }
}

/** What employees get: only active roles and buttons, in order. */
export function publicView(data) {
  const roles = data.roles.filter(r => r.active !== false).sort(byOrder)
    .map(({ id, label, description, color }) => ({ id, label, description, color }));
  const roleIds = new Set(roles.map(r => r.id));
  const links = data.links.filter(l => l.active !== false).sort(byOrder)
    .map(l => ({ ...l, roles: l.roles.filter(id => roleIds.has(id)) }))
    .filter(l => l.roles.length);
  return { settings: data.settings, roles, links, updated: data.updated };
}

export function adminView(data) {
  return { links: [...data.links].sort(byOrder), roles: [...data.roles].sort(byOrder) };
}

/* ------------------------------ Auth ------------------------------ */

export const adminUser = () => (process.env.ADMIN_USER || "micrologic").trim().toLowerCase();
const adminPass = () => process.env.ADMIN_PASS || "mlaboss";
const secret = () => process.env.SESSION_SECRET || ("micrologic-portal:" + adminPass());
const TOKEN_HOURS = 6;
const MAX_FAILS = 8;
const LOCK_MINUTES = 15;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64 = (s) => Buffer.from(s).toString("base64url");
const hmac = (s) => crypto.createHmac("sha256", secret()).update(s).digest("base64url");

export function makeToken() {
  const payload = b64(JSON.stringify({ u: adminUser(), exp: Date.now() + TOKEN_HOURS * 3600e3 }));
  return payload + "." + hmac(payload);
}

export function checkToken(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!sameText(sig, hmac(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return Date.now() < exp;
  } catch { return false; }
}

/** Returns { ok, error }. Locks for 15 minutes after 8 wrong attempts. */
export async function checkLogin(username, password) {
  const s = store();
  const fails = (await s.get(FAILS_KEY, { type: "json" })) || { count: 0, since: 0 };
  const windowOpen = Date.now() - fails.since < LOCK_MINUTES * 60e3;
  if (windowOpen && fails.count >= MAX_FAILS) {
    return { ok: false, error: `Too many attempts. Try again in ${LOCK_MINUTES} minutes.` };
  }
  const good = sameText(String(username || "").trim().toLowerCase(), adminUser()) &&
               sameText(String(password || ""), adminPass());
  if (!good) {
    const next = windowOpen ? { count: fails.count + 1, since: fails.since } : { count: 1, since: Date.now() };
    await s.setJSON(FAILS_KEY, next);
    await new Promise(r => setTimeout(r, 600));
    return { ok: false, error: "Incorrect username or password." };
  }
  if (fails.count) await s.delete(FAILS_KEY);
  return { ok: true };
}

/* --------------------------- Validation --------------------------- */

const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export function cleanLink(input, roles) {
  const title = text(input.title, 60);
  if (!title) throw Object.assign(new Error("Button name is required."), { status: 400 });
  const url = text(input.url, 2000);
  if (url && !/^https:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error("Link must start with https://"), { status: 400 });
  const known = new Set(roles.map(r => r.id));
  const linkRoles = [...new Set((Array.isArray(input.roles) ? input.roles : []).map(String))].filter(id => known.has(id));
  if (!linkRoles.length) throw Object.assign(new Error("Choose at least one role."), { status: 400 });
  const order = input.order === "" || input.order == null || isNaN(Number(input.order)) ? 999 : Number(input.order);
  return {
    roles: linkRoles,
    section: text(input.section, 40) || "General",
    title,
    description: text(input.description, 120),
    url,
    icon: ICONS.includes(input.icon) ? input.icon : "link",
    order,
    active: input.active !== false
  };
}
