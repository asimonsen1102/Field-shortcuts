// GET /.netlify/functions/portal — the buttons employees see. No login needed.
import { readData, publicView, json } from "../lib/store.mjs";

export default async () => {
  try {
    const { data } = await readData();
    return json({ ok: true, data: publicView(data) });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "Couldn't load the portal." }, 500);
  }
};
