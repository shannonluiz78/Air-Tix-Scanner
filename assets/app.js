/* FareBoard — flight search router + timing advisor + alert manager
   No build step, no backend. Pure static JS. */

(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------------------------------------------------------------
     0. Split-flap header effect (signature visual element)
  --------------------------------------------------------------- */
  const FLAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
  function splitFlap(el) {
    const target = el.textContent;
    const words = target.split(" ");
    el.textContent = "";
    const allCells = [];
    let globalIndex = 0;

    words.forEach((word, wi) => {
      const wordSpan = document.createElement("span");
      wordSpan.className = "flap-word";
      word.split("").forEach((ch) => {
        const cell = document.createElement("span");
        cell.className = "flap-cell";
        cell.textContent = ch;
        wordSpan.appendChild(cell);
        allCells.push({ cell, finalChar: ch, index: globalIndex++ });
      });
      el.appendChild(wordSpan);
      if (wi < words.length - 1) globalIndex++; // account for the space
    });

    allCells.forEach(({ cell, finalChar, index }) => {
      let ticks = 6 + Math.floor(Math.random() * 10);
      let count = 0;
      const iv = setInterval(() => {
        cell.textContent = FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)];
        count++;
        if (count >= ticks) {
          clearInterval(iv);
          cell.textContent = finalChar;
        }
      }, 45 + index * 4);
    });
  }
  document.addEventListener("DOMContentLoaded", () => {
    $$("[data-flap]").forEach(splitFlap);
  });

  /* ---------------------------------------------------------------
     1. Autocomplete airport lists
  --------------------------------------------------------------- */
  function populateAirportDatalist() {
    const dl = $("#airport-list");
    if (!dl || typeof AIRPORTS === "undefined") return;
    dl.innerHTML = AIRPORTS.map(
      ([code, name, country]) => `<option value="${code}">${name}, ${country}</option>`
    ).join("");
  }

  /* ---------------------------------------------------------------
     2. Date helpers
  --------------------------------------------------------------- */
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const MS = 1000 * 60 * 60 * 24;
    return Math.round((new Date(b) - new Date(a)) / MS);
  }
  function toYYMMDD(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return y.slice(2) + m + d;
  }
  function weekdayName(iso) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" });
  }
  function monthName(iso) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "long" });
  }

  /* ---------------------------------------------------------------
     3. Deep-link builders (real search engines, real live prices —
        this app never invents its own fares, it routes you to them)
  --------------------------------------------------------------- */
  function buildLinks({ origin, destination, depart, ret, cabin, adults }) {
    origin = (origin || "").toUpperCase().trim();
    destination = (destination || "").toUpperCase().trim();
    adults = adults || 1;
    const cabinMap = {
      economy: { gf: "", sky: "economy", kk: "economy" },
      premium: { gf: "Premium+economy", sky: "premiumeconomy", kk: "premium" },
      business: { gf: "Business", sky: "business", kk: "business" },
      first: { gf: "First", sky: "first", kk: "first" },
    };
    const c = cabinMap[cabin] || cabinMap.economy;

    const links = {};

    // Google Flights — natural-language query redirect
    let gfQ = `Flights to ${destination} from ${origin} on ${depart}`;
    if (ret) gfQ += ` through ${ret}`;
    if (c.gf) gfQ += ` ${c.gf}`;
    links.google = `https://www.google.com/travel/flights?q=${encodeURIComponent(gfQ)}`;

    // Skyscanner — /transport/flights/{origin}/{dest}/{yymmdd}/{yymmdd (optional)}/
    const sDepart = toYYMMDD(depart);
    const sReturn = ret ? toYYMMDD(ret) : "";
    links.skyscanner = `https://www.skyscanner.com/transport/flights/${origin.toLowerCase()}/${destination.toLowerCase()}/${sDepart}/${sReturn}/?adults=${adults}&cabinclass=${c.sky}&rtn=${ret ? 1 : 0}`;

    // Kayak — /flights/{origin}-{dest}/{date}/{date optional}
    const kkPath = ret ? `${origin}-${destination}/${depart}/${ret}` : `${origin}-${destination}/${depart}`;
    links.kayak = `https://www.kayak.com/flights/${kkPath}?sort=bestflight_a&cabin=${c.kk}&adults=${adults}`;

    // Momondo — shares Kayak's search-URL scheme
    links.momondo = `https://www.momondo.com/flight-search/${kkPath}?sort=bestflight_a&cabin=${c.kk}&adults=${adults}`;

    return links;
  }

  /* ---------------------------------------------------------------
     4. Timing recommendation engine
        Grounded in published 2026 fare-pattern research (Going.com
        Goldilocks Window, Google Flights historical fare analysis,
        Expedia 2026 Air Hacks Report, Kayak 2026 booking data).
        This is general guidance from published aggregate data —
        not a live prediction for your specific route.
  --------------------------------------------------------------- */
  const HAUL_PROFILES = {
    regional: { label: "Regional (under ~5hr, e.g. ASEAN)", min: 14, sweetStart: 21, sweetEnd: 60, max: 120 },
    medium: { label: "Medium-haul (~5–8hr, e.g. NE Asia, India, Middle East)", min: 30, sweetStart: 60, sweetEnd: 150, max: 240 },
    long: { label: "Long-haul (8hr+, e.g. Europe, US, Australia/NZ)", min: 45, sweetStart: 90, sweetEnd: 240, max: 330 },
  };
  const CHEAP_MONTHS = [1, 2]; // Jan, Feb
  const GOOD_MONTHS = [9, 10]; // Sep, Oct
  const EXPENSIVE_MONTHS = [7, 12]; // Jul, Dec
  const CHEAP_FLY_DAYS = [2, 3, 6]; // Tue(2), Wed(3), Sat(6) — JS getDay(): Sun=0

  function guessHaul(destCode) {
    if (!destCode || typeof AIRPORTS === "undefined") return "medium";
    const entry = AIRPORTS.find((a) => a[0] === destCode.toUpperCase());
    if (!entry) return "medium";
    const country = entry[2];
    const regionalCountries = [
      "Malaysia", "Thailand", "Indonesia", "Philippines", "Vietnam",
      "Myanmar", "Cambodia", "Laos", "Brunei", "Singapore",
    ];
    const longCountries = [
      "United Kingdom", "France", "Netherlands", "Germany", "Switzerland",
      "Italy", "Spain", "Portugal", "Austria", "Denmark", "Norway", "Sweden",
      "Finland", "Ireland", "Greece", "Czechia", "Poland", "USA", "Canada",
      "Australia", "New Zealand", "Brazil", "South Africa", "Turkey",
    ];
    if (regionalCountries.includes(country)) return "regional";
    if (longCountries.includes(country)) return "long";
    return "medium";
  }

  function timingRecommendation({ destination, depart, haul }) {
    const profile = HAUL_PROFILES[haul] || HAUL_PROFILES.medium;
    const out = { profile, notes: [] };

    if (!depart) {
      out.zone = "unset";
      return out;
    }

    const daysOut = daysBetween(todayISO(), depart);
    out.daysOut = daysOut;

    if (daysOut < 0) {
      out.zone = "past";
    } else if (daysOut > profile.max) {
      out.zone = "too-early";
      out.headline = "Too early to buy";
      out.detail = `Airlines usually haven't released their real pricing this far out. Set an alert now, then plan to buy once you're inside the ${profile.sweetStart}–${profile.sweetEnd}-day window.`;
    } else if (daysOut >= profile.sweetStart && daysOut <= profile.sweetEnd) {
      out.zone = "sweet-spot";
      out.headline = "Sweet spot — good time to buy";
      out.detail = `You're ${daysOut} days out, inside the window (${profile.sweetStart}–${profile.sweetEnd} days) where this route type is historically cheapest. If the price looks fair, it's a reasonable time to book rather than gamble on it dropping further.`;
    } else if (daysOut > profile.sweetEnd) {
      out.zone = "early";
      out.headline = "A bit early";
      out.detail = `You're ${daysOut} days out. Prices for this route type tend to bottom out between ${profile.sweetStart} and ${profile.sweetEnd} days before departure. Worth setting an alert and checking back rather than buying today.`;
    } else if (daysOut < profile.sweetStart && daysOut > 21) {
      out.zone = "late";
      out.headline = "Window is closing";
      out.detail = `You're ${daysOut} days out — past the cheapest zone for this route type. Prices don't reliably keep falling from here. If it's close to your target, buy rather than wait.`;
    } else {
      out.zone = "last-minute";
      out.headline = "Last-minute zone";
      out.detail = `Inside 3 weeks out, fares typically climb rather than drop. Waiting for a discount from here is a weak bet — buy now if the price is workable.`;
    }

    // Month-level seasonality
    const m = new Date(depart + "T00:00:00").getMonth() + 1;
    if (CHEAP_MONTHS.includes(m)) {
      out.notes.push(`${monthName(depart)} is historically one of the cheapest months to fly.`);
    } else if (GOOD_MONTHS.includes(m)) {
      out.notes.push(`${monthName(depart)} is a solid shoulder-season month — usually good value.`);
    } else if (EXPENSIVE_MONTHS.includes(m)) {
      out.notes.push(`${monthName(depart)} is one of the priciest months to fly — book earlier than usual and expect higher fares.`);
    }

    // Day-of-week to fly
    const dow = new Date(depart + "T00:00:00").getDay();
    if (CHEAP_FLY_DAYS.includes(dow)) {
      out.notes.push(`${weekdayName(depart)} departures are typically cheaper than weekend flights — good choice.`);
    } else {
      out.notes.push(`${weekdayName(depart)} departures usually cost more than flying Tue/Wed/Sat. If your dates are flexible, shifting could save 10–15%.`);
    }

    return out;
  }

  /* ---------------------------------------------------------------
     5. Wire up the search form
  --------------------------------------------------------------- */
  function updateResults() {
    const origin = $("#f-origin").value.trim().toUpperCase();
    const destination = $("#f-destination").value.trim().toUpperCase();
    const depart = $("#f-depart").value;
    const ret = $("#f-return").value;
    const cabin = $("#f-cabin").value;
    const adults = parseInt($("#f-adults").value, 10) || 1;
    const haulSelect = $("#f-haul").value;

    const resultsPanel = $("#results-panel");
    const timingPanel = $("#timing-panel");

    if (!origin || origin.length !== 3 || !destination || destination.length !== 3 || !depart) {
      resultsPanel.classList.add("hidden");
      timingPanel.classList.add("hidden");
      return;
    }

    const links = buildLinks({ origin, destination, depart, ret, cabin, adults });
    $("#link-google").href = links.google;
    $("#link-skyscanner").href = links.skyscanner;
    $("#link-kayak").href = links.kayak;
    $("#link-momondo").href = links.momondo;
    resultsPanel.classList.remove("hidden");

    const haul = haulSelect === "auto" ? guessHaul(destination) : haulSelect;
    const rec = timingRecommendation({ destination, depart, haul });
    renderTiming(rec, haul);
    timingPanel.classList.remove("hidden");

    // Keep the alert form in sync
    $("#a-origin").value = origin;
    $("#a-destination").value = destination;
    $("#a-depart").value = depart;
    $("#a-return").value = ret;
    $("#a-cabin").value = cabin;
  }

  function renderTiming(rec, haul) {
    const zoneEl = $("#timing-zone");
    const detailEl = $("#timing-detail");
    const notesEl = $("#timing-notes");
    const gaugeEl = $("#timing-gauge");
    const haulLabel = $("#timing-haul-label");

    zoneEl.textContent = rec.headline || "—";
    zoneEl.className = "timing-headline zone-" + (rec.zone || "unset");
    detailEl.textContent = rec.detail || "";
    haulLabel.textContent = rec.profile.label;

    notesEl.innerHTML = "";
    (rec.notes || []).forEach((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      notesEl.appendChild(li);
    });

    // Gauge: position a marker along min -> max range
    const p = rec.profile;
    const span = Math.max(p.max, rec.daysOut || 0);
    const pct = Math.max(0, Math.min(100, 100 - ((rec.daysOut || 0) / span) * 100));
    gaugeEl.style.setProperty("--marker", pct + "%");
    gaugeEl.dataset.zone = rec.zone || "unset";
  }

  /* ---------------------------------------------------------------
     6. Price alert — deep-link into a prefilled GitHub Issue Form.
        The issue IS the database. The scheduled Action IS the alert.
  --------------------------------------------------------------- */
  function buildAlertIssueUrl() {
    const owner = FAREBOARD_CONFIG.GITHUB_OWNER;
    const repo = FAREBOARD_CONFIG.GITHUB_REPO;
    const origin = $("#a-origin").value.trim().toUpperCase();
    const destination = $("#a-destination").value.trim().toUpperCase();
    const depart = $("#a-depart").value;
    const ret = $("#a-return").value;
    const cabin = $("#a-cabin").value;
    const price = $("#a-price").value.trim();
    const currency = $("#a-currency").value;

    const title = `[watch] ${origin} \u2192 ${destination} under ${price} ${currency}`;
    const params = new URLSearchParams({
      template: "price-watch.yml",
      title,
      origin,
      destination,
      depart_date: depart,
      return_date: ret || "",
      target_price: price,
      currency,
      cabin,
    });
    return `https://github.com/${owner}/${repo}/issues/new?${params.toString()}`;
  }

  function handleCreateAlert(e) {
    e.preventDefault();
    if (FAREBOARD_CONFIG.GITHUB_OWNER === "YOUR_GITHUB_USERNAME") {
      alert("Set GITHUB_OWNER and GITHUB_REPO in assets/config.js first — see README.");
      return;
    }
    const price = $("#a-price").value.trim();
    if (!price || isNaN(Number(price))) {
      alert("Enter a target price (numbers only).");
      return;
    }
    window.open(buildAlertIssueUrl(), "_blank");
  }

  /* ---------------------------------------------------------------
     7. Load active watches from the repo's GitHub Issues
  --------------------------------------------------------------- */
  async function loadWatches() {
    const list = $("#watch-list");
    const owner = FAREBOARD_CONFIG.GITHUB_OWNER;
    const repo = FAREBOARD_CONFIG.GITHUB_REPO;
    if (!list) return;

    if (owner === "YOUR_GITHUB_USERNAME") {
      list.innerHTML = `<li class="watch-empty">Set GITHUB_OWNER / GITHUB_REPO in assets/config.js to see your watches here.</li>`;
      return;
    }

    list.innerHTML = `<li class="watch-empty">Loading your watches\u2026</li>`;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=open&labels=price-watch&per_page=30`,
        { headers: { Accept: "application/vnd.github+json" } }
      );
      if (!res.ok) throw new Error("GitHub API error " + res.status);
      const issues = await res.json();
      if (!Array.isArray(issues) || issues.length === 0) {
        list.innerHTML = `<li class="watch-empty">No active watches yet. Create one above.</li>`;
        return;
      }
      list.innerHTML = "";
      issues.forEach((issue) => {
        const hasDeal = (issue.labels || []).some((l) => (l.name || l) === "deal-found");
        const li = document.createElement("li");
        li.className = "watch-item" + (hasDeal ? " watch-item-deal" : "");
        li.innerHTML = `
          <a href="${issue.html_url}" target="_blank" rel="noopener">${escapeHtml(issue.title)}</a>
          <span class="watch-meta">${hasDeal ? "\ud83d\udd25 deal found — open to view" : "watching\u2026"}</span>
        `;
        list.appendChild(li);
      });
    } catch (err) {
      list.innerHTML = `<li class="watch-empty">Couldn't load watches (${escapeHtml(err.message)}). Check the repo is public and config.js is set.</li>`;
    }
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---------------------------------------------------------------
     8. Init
  --------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    populateAirportDatalist();

    const today = todayISO();
    $("#f-depart").min = today;
    $("#f-return").min = today;
    $("#f-origin").value = FAREBOARD_CONFIG.DEFAULT_ORIGIN || "";
    $("#a-currency").value = FAREBOARD_CONFIG.DEFAULT_CURRENCY || "SGD";

    ["f-origin", "f-destination", "f-depart", "f-return", "f-cabin", "f-adults", "f-haul"].forEach((id) => {
      $("#" + id).addEventListener("input", updateResults);
      $("#" + id).addEventListener("change", updateResults);
    });

    $("#alert-form").addEventListener("submit", handleCreateAlert);

    loadWatches();
  });
})();
