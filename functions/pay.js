/* GET /pay — one-off checkout links for custom orders.
 *
 * Evan texts a buyer a link like:
 *   https://evan-b-etchen.pages.dev/pay?token=SECRET&amount_cents=27500&label=Custom+mirror+for+Jess
 * The buyer lands straight on Stripe checkout. No separate shipping line —
 * custom quotes already include shipping in the total.
 *
 * Env vars (set in the Cloudflare Pages project settings):
 *   STRIPE_SECRET_KEY — Stripe restricted secret key (Checkout Sessions: write).
 *   PAY_LINK_TOKEN    — shared secret; only links carrying it work.
 *                       Make it long and random, e.g. `openssl rand -hex 24`.
 */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const amountRaw = url.searchParams.get("amount_cents") || "";
  const label = (url.searchParams.get("label") || "Custom order").slice(0, 120);

  if (!env.PAY_LINK_TOKEN || token !== env.PAY_LINK_TOKEN) {
    return new Response("Bad link.", { status: 400 });
  }

  const amount = Number(amountRaw);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000) {
    return new Response("Bad amount.", { status: 400 });
  }

  if (!env.STRIPE_SECRET_KEY) {
    return new Response("Checkout is not configured yet.", { status: 502 });
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][product_data][name]", label);
  params.set("line_items[0][price_data][unit_amount]", String(amount));
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", "https://evan-b-etchen.pages.dev/thanks.html");
  params.set("cancel_url", "https://evan-b-etchen.pages.dev/gallery.html");
  params.set("shipping_address_collection[allowed_countries][0]", "US");

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
    return new Response("Could not reach the payment service. Please try again.", {
      status: 502,
    });
  }

  let data = {};
  try {
    data = await resp.json();
  } catch (e) {
    data = {};
  }

  if (!resp.ok || !data.url) {
    return new Response("Payment setup failed. Please try again.", { status: 502 });
  }
  return Response.redirect(data.url, 302);
}
