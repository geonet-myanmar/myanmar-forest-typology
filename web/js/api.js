// JSON API client. Errors carry the server's message (shown to the user as is).
import {API_BASE, HOSTED} from "./config.js";

export async function api(path, body, {signal} = {}) {
  const init = body === undefined ? {signal} :
    {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal};
  let r;
  try {
    r = await fetch(`${API_BASE}/api/${path}`, init);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error(HOSTED ? "The analysis server did not answer. Check your connection and try again in a moment."
                           : "The local server is not responding. Is run.py still running?");
  }
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON error page */ }
  if (!r.ok) throw new Error(data?.detail || (r.status === 504 ? "The analysis took longer than 5 minutes. Try a smaller area." : `${r.status} ${r.statusText}`));
  return data;
}
