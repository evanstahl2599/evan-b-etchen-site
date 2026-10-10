/* POST /api/checkout — create a Stripe Checkout Session for a catalog piece.
 *
 * Env vars (set in the Cloudflare Pages project settings):
 *   STRIPE_SECRET_KEY — Stripe restricted secret key (Checkout Sessions: write).
 *
 * Request body (JSON): { "piece_id": "<catalog id>", "referral_code": "<optional>" }
 * Success: 200 { "url": "<stripe checkout url>" }
 * Errors: 400 unknown piece / bad body, 502 payment service problem.
 */

const CATALOG = {
  "vision-of-fear": { name: "A Vision of Fear", amount: 40000 },
  "too-close-to-the-sun": { name: "For I Flew Too Close to the Sun", amount: 40000 },
  "garden-of-the-damned": { name: "Garden of the Damned", amount: 25000 },
  "danger-hidden-within": { name: "The Danger Hidden Within", amount: 25000 },
  "fatal-attraction": { name: "A Fatal Attraction", amount: 25000 },
  "gothic-decor-1of1": { name: "Hand-Etched 1 of 1 Gothic Decor", amount: 15000 },
};

// TODO (Evan): set the real UPS Ground flat fee in cents after running
// Pirate Ship quotes. 0 = free shipping until you set a real number.
const SHIPPING_STANDARD_CENTS = 0;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid request." }, 400);
  }

  const piece = body && CATALOG[body.piece_id];
  if (!piece) {
    return json({ error: "Unknown piece." }, 400);
  }

  const ref =
    body && typeof body.referral_code === "string"
      ? body.referral_code.trim().toUpperCase()
      : "";

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
  params.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  params.set(
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
    String(SHIPPING_STANDARD_CENTS)
  );
  params.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
  params.set("shipping_options[0][shipping_rate_data][display_name]", "UPS Ground shipping");

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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}
