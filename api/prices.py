// Vercel serverless function: /api/prices
//
// Thin, honest proxy in front of the Travelpayouts Data API. It does NOT
// invent live multi-airline fares — it fetches Travelpayouts' cached
// ticket data (from real user searches on their network, refreshed
// continuously but not guaranteed fresh for every route) and reshapes it
// into "best price per airline seen in cache" + "price by date" so the
// frontend can render something close to a search-results dashboard.
//
// Env var required (set in Vercel project settings, NOT committed):
//   TRAVELPAYOUTS_TOKEN
//
// Query params:
//   origin        (required) IATA code, e.g. SIN
//   destination   (required) IATA code, e.g. NRT
//   month         (required) YYYY-MM — Travelpayouts caches at month grain
//   return_month  (optional) YYYY-MM
//   currency      (optional) default "sgd"

const AIRLINE_NAMES = {
  SQ: "Singapore Airlines", TR: "Scoot", "3K": "Jetstar Asia",
  MH: "Malaysia Airlines", AK: "AirAsia", D7: "AirAsia X", FD: "Thai AirAsia",
  TG: "Thai Airways", VN: "Vietnam Airlines", VJ: "VietJet Air",
  PR: "Philippine Airlines", "5J": "Cebu Pacific", GA: "Garuda Indonesia",
  QZ: "Indonesia AirAsia", JL: "Japan Airlines", NH: "ANA", GK: "Jetstar Japan",
  OZ: "Asiana Airlines", KE: "Korean Air", CX: "Cathay Pacific",
  HX: "Hong Kong Airlines", CI: "China Airlines", BR: "EVA Air",
  QF: "Qantas", JQ: "Jetstar Airways", NZ: "Air New Zealand",
  EK: "Emirates", QR: "Qatar Airways", EY: "Etihad Airways",
  AI: "Air India", UK: "Vistara", "6E": "IndiGo",

  BA: "British Airways", LH: "Lufthansa", AF: "Air France",
  KL: "KLM", EI: "Aer Lingus", TK: "Turkish Airlines",
  UA: "United Airlines", DL: "Delta Air Lines", AA: "American Airlines",
};

function airlineName(code) {
  return AIRLINE_NAMES[code] || code;
}

function flattenEntries(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((v) => flattenEntries(v, out));
  } else if (node && typeof node === "object") {
    if (typeof node.price === "number") {
      out.push(node);
    } else {
      Object.values(node).forEach((v) => flattenEntries(v, out));
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const { origin, destination, month, return_month, currency } = req.query;
  const token = process.env.TRAVELPAYOUTS_TOKEN;

  if (!token) {
    res.status(500).json({ success: false, error: "TRAVELPAYOUTS_TOKEN not configured on the server." });
    return;
  }
  if (!origin || !destination || !month) {
    res.status(400).json({ success: false, error: "origin, destination and month (YYYY-MM) are required." });
    return;
  }

  const params = new URLSearchParams({
    origin: String(origin).toUpperCase(),
    destination: String(destination).toUpperCase(),
    depart_date: month,
    currency: (currency || "sgd").toLowerCase(),
    token,
  });
  if (return_month) params.set("return_date", return_month);

  const url = `https://api.travelpayouts.com/v1/prices/direct?${params.toString()}`;

  let upstream;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    upstream = await r.json();
  } catch (err) {
    res.status(502).json({ success: false, error: "Travelpayouts request failed: " + err.message });
    return;
  }

  if (!upstream || upstream.success === false || !upstream.data) {
    res.status(200).json({
      success: true,
      cached: true,
      bestOverall: null,
      byAirline: [],
      byDate: [],
      note: "No cached fares found for this route/month yet.",
    });
    return;
  }

  const entries = flattenEntries(upstream.data);
  if (entries.length === 0) {
    res.status(200).json({
      success: true,
      cached: true,
      bestOverall: null,
      byAirline: [],
      byDate: [],
      note: "No cached fares found for this route/month yet.",
    });
    return;
  }

  // Best price per airline
  const byAirlineMap = new Map();
  entries.forEach((e) => {
    const code = e.airline || "??";
    const existing = byAirlineMap.get(code);
    if (!existing || e.price < existing.price) byAirlineMap.set(code, e);
  });
  const byAirline = Array.from(byAirlineMap.values())
    .sort((a, b) => a.price - b.price)
    .slice(0, 6)
    .map((e) => ({
      airlineCode: e.airline || null,
      airlineName: e.airline ? airlineName(e.airline) : "Unlisted carrier",
      price: e.price,
      departureAt: e.departure_at || null,
      returnAt: e.return_at || null,
      transfers: typeof e.transfers === "number" ? e.transfers : null,
      foundAt: e.found_at || null,
    }));

  // Cheapest per calendar date, for a trend line
  const byDateMap = new Map();
  entries.forEach((e) => {
    if (!e.departure_at) return;
    const day = String(e.departure_at).slice(0, 10);
    const existing = byDateMap.get(day);
    if (!existing || e.price < existing) byDateMap.set(day, e.price);
  });
  const byDate = Array.from(byDateMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, price]) => ({ date, price }));

  const bestOverall = byAirline.length ? byAirline[0] : null;

  res.status(200).json({
    success: true,
    cached: true,
    bestOverall,
    byAirline,
    byDate,
    note: "Prices are cached from Travelpayouts' search network, not a live quote. Confirm on the booking site before paying.",
  });
}
