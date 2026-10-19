/* POST /api/checkout — create a Stripe Checkout Session for a piece.
 *
 * Env vars (set in the Cloudflare Pages project settings):
 *   STRIPE_SECRET_KEY — Stripe restricted secret key (Checkout Sessions: write).
 *
 * Two ways to buy:
 *  1. Catalog pieces: body { "piece_id": "<catalog id>", "referral_code": "…" }
 *     Prices come from the hardcoded CATALOG below.
 *  2. Sheet pieces (added by Evan through his "Add a New Piece" Google Form):
 *     body { "sheet_piece": "<piece name>", "referral_code": "…" }
 *     The piece name + price are validated against the live response Sheet —
 *     the browser's word is never trusted for price. Only rows whose
 *     Available? is not "Sold" can be bought.
 *
 * Success: 200 { "url": "<stripe checkout url>" }
 * Errors: 400 unknown/unavailable piece / bad body, 502 payment service problem.
 */

const CATALOG = {
  "vision-of-fear": { name: "A Vision of Fear", amount: 40000 },
  "too-close-to-the-sun": { name: "For I Flew Too Close to the Sun", amount: 40000 },
  "garden-of-the-damned": { name: "Garden of the Damned", amount: 15000 },
  "danger-hidden-within": { name: "The Danger Hidden Within", amount: 15000 },
  "fatal-attraction": { name: "A Fatal Attraction", amount: 15000 },
  "gothic-decor-1of1": { name: "Hand-Etched 1 of 1 Gothic Decor", amount: 15000 },
  "spiderweb-pocket-mirror": { name: "Spiderweb Pocket Mirror", amount: 1750, freeShipping: true },
};

// Evan's catalog Sheet (responses from his "Add a New Piece" form).
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1OukbMm3cFDeAW0cQXFdU_jtWmTVAEODytRUwuBkB1wg/gviz/tq?tqx=out:csv&sheet=Form%20Responses%201";

// UPS Ground flat fee in cents. Set 2026-10-11 per Evan: customers pay shipping.
const SHIPPING_STANDARD_CENTS = 2500;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid request." }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid request." }, 400);
  }

  const ref =
    typeof body.referral_code === "string"
      ? body.referral_code.trim().toUpperCase()
      : "";

  // --- Path 1: hardcoded catalog piece ---
  if (typeof body.piece_id === "string" && body.piece_id) {
    const piece = CATALOG[body.piece_id];
    if (!piece) {
      return json({ error: "Unknown piece." }, 400);
    }
    return createSession(env, piece, ref);
  }

  // --- Path 2: sheet piece, validated against the live Sheet ---
  if (typeof body.sheet_piece === "string" && body.sheet_piece.trim()) {
    const wanted = body.sheet_piece.trim().toLowerCase();
    let rows;
    try {
      const resp = await fetch(SHEET_CSV_URL);
      if (!resp.ok) throw new Error("sheet " + resp.status);
      rows = parseCSV(await resp.text());
    } catch (e) {
      return json(
        { error: "Could not verify that piece right now. Please try again." },
        502
      );
    }
    // Columns: Timestamp | Piece name | Price | Description | Photo | Category | Available?
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[1] || "").trim();
      if (!name || name.toLowerCase() !== wanted) continue;
      if ((r[6] || "").trim().toLowerCase() === "sold") continue;
      const amount = priceToCents(r[2]);
      if (amount === null) continue;
      const category = (r[5] || "").trim().toLowerCase();
      return createSession(
        env,
        {
          name: name.slice(0, 120),
          amount: amount,
          freeShipping: category === "pocket mirrors",
        },
        ref
      );
    }
    return json({ error: "That piece is not available." }, 400);
  }

  return json({ error: "Unknown piece." }, 400);
}

async function createSession(env, piece, ref) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Checkout is not configured yet." }, 502);
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][product_data][name]", piece.name);
  params.set("line_items[0][price_data][unit_amount]", String(piece.amount));
  params.set("line_items[0][quantity]", "1");
  if (ref) {
    params.set("client_reference_id", ref);
  }
  params.set("success_url", "https://evan-b-etchen.pages.dev/thanks.html");
  params.set("cancel_url", "https://evan-b-etchen.pages.dev/gallery.html");
  params.set("shipping_address_collection[allowed_countries][0]", "US");
  const shippingCents = piece.freeShipping ? 0 : SHIPPING_STANDARD_CENTS;
  params.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  params.set(
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
    String(shippingCents)
  );
  params.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
  params.set(
    "shipping_options[0][shipping_rate_data][display_name]",
    piece.freeShipping ? "Shipping included" : "UPS Ground shipping"
  );

  let resp;
  try {
    resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        // Stripe uses HTTP Basic auth: secret key as username, blank password.
        Authorization: "Basic " + btoa(env.STRIPE_SECRET_KEY + ":"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (e) {
    return json({ error: "Could not reach the payment service. Please try again." }, 502);
  }

  let data = {};
  try {
    data = await resp.json();
  } catch (e) {
    data = {};
  }

  if (!resp.ok) {
    const msg =
      (data && data.error && data.error.message) ||
      "Payment setup failed. Please try again.";
    return json({ error: msg }, 502);
  }
  if (!data.url) {
    return json({ error: "Payment setup failed. Please try again." }, 502);
  }
  return json({ url: data.url }, 200);
}

function priceToCents(raw) {
  const cleaned = String(raw == null ? "" : raw).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (cents < 50 || cents > 1000000) return null; // $0.50 floor, $10,000 cap
  return cents;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else { field += c; }
    } else if (c === '"') { inQ = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}
