// Where the API lives. Under `python run.py` the page and the API share one origin; on GitHub Pages the page is
// static and the API is the Vercel deployment (its CORS allows the Pages origin).
const HOSTED_API = "https://myanmar-forest-typology.vercel.app";

export const API_BASE = location.hostname.endsWith("github.io") ? HOSTED_API : "";
export const HOSTED = API_BASE !== "";
