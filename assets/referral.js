/* Referral code popup — Evan B Etchen
 *
 * Two kinds of buy targets:
 *
 * 1. Buttons with data-piece="<catalog id>" (the normal site flow):
 *    the popup asks for a referral code (or N/A), then POSTs
 *    { piece_id, referral_code } to /api/checkout, which creates a Stripe
 *    Checkout Session server-side. The browser redirects to the returned
 *    Stripe URL. The code rides along as the session's client_reference_id,
 *    so it shows on the order in Stripe's dashboard.
 *
 * 2. Legacy links straight to a Stripe Payment Link (buy.stripe.com):
 *    kept as a fallback — the code is appended as ?client_reference_id=CODE.
 *
 * Demo hook: if window.__DEMO_CHECKOUT__ is a function (set by the demo
 * page only), it is called as __DEMO_CHECKOUT__(pieceId, referralCode)
 * instead of hitting /api/checkout. Never set on real pages.
 */
(function () {
  "use strict";

  function isStripeCheckout(url) {
    return /buy\.stripe\.com/i.test(url || "");
  }

  /* ---------- modal markup (injected once) ---------- */
  var overlay = document.createElement("div");
  overlay.id = "refOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Referral code");
  overlay.style.cssText =
    "display:none;position:fixed;inset:0;z-index:9999;" +
    "background:rgba(10,4,14,.78);backdrop-filter:blur(3px);" +
    "align-items:center;justify-content:center;padding:20px;";

  overlay.innerHTML =
    '<div id="refBox" style="background:#1a0b1e;border:1px solid rgba(207,76,255,.45);' +
    'border-radius:16px;max-width:380px;width:100%;padding:26px 24px;position:relative;' +
    'color:#f4f0f7;font-family:inherit;text-align:left;">' +
    '<button id="refClose" aria-label="Close" style="position:absolute;top:10px;right:14px;' +
    'background:none;border:none;color:#9a8fa3;font-size:22px;cursor:pointer;line-height:1;">&times;</button>' +
    '<h3 style="margin:0 0 8px;font-size:19px;letter-spacing:.02em;">Got a referral code?</h3>' +
    '<p style="margin:0 0 16px;font-size:14px;color:#b9aec2;line-height:1.5;">' +
    'If someone sent you here, enter their code so they get credit for the sale.</p>' +
    '<input id="refInput" type="text" placeholder="Enter code" autocomplete="off" ' +
    'autocapitalize="characters" spellcheck="false" style="width:100%;box-sizing:border-box;' +
    'background:#0d0612;border:1px solid rgba(207,76,255,.35);border-radius:10px;color:#f4f0f7;' +
    'font-size:16px;letter-spacing:.08em;padding:12px 14px;margin-bottom:12px;text-transform:uppercase;">' +
    '<label style="display:flex;align-items:center;gap:9px;font-size:14px;color:#b9aec2;' +
    'cursor:pointer;margin-bottom:6px;user-select:none;">' +
    '<input id="refNA" type="checkbox" style="width:17px;height:17px;accent-color:#cf4cff;cursor:pointer;"> ' +
    "N/A &mdash; I don&apos;t have a code</label>" +
    '<div id="refHint" style="min-height:20px;font-size:13px;color:#ff9d9d;margin:4px 0 8px;"></div>' +
    '<button id="refGo" style="width:100%;background:#cf4cff;border:none;border-radius:10px;' +
    'color:#14081c;font-weight:700;font-size:15px;padding:13px;cursor:pointer;letter-spacing:.03em;">' +
    "Continue to checkout</button>" +
    "</div>";

  document.body.appendChild(overlay);

  var input = overlay.querySelector("#refInput");
  var naBox = overlay.querySelector("#refNA");
  var hint = overlay.querySelector("#refHint");
  var goBtn = overlay.querySelector("#refGo");
  var closeBtn = overlay.querySelector("#refClose");
  var GO_LABEL = "Continue to checkout";
  var pending = null; // { kind:"api", pieceId } or { kind:"link", url, target }

  function open(spec) {
    pending = spec;
    input.value = "";
    input.disabled = false;
    naBox.checked = false;
    hint.textContent = "";
    goBtn.disabled = false;
    goBtn.textContent = GO_LABEL;
    overlay.style.display = "flex";
    setTimeout(function () { input.focus(); }, 50);
    document.body.style.overflow = "hidden";
  }

  function close() {
    overlay.style.display = "none";
    document.body.style.overflow = "";
    pending = null;
  }

  function fail(msg) {
    hint.textContent = msg || "Something went wrong. Please try again.";
    goBtn.disabled = false;
    goBtn.textContent = GO_LABEL;
  }

  function legacyRedirect() {
    // Fallback for plain Stripe Payment Link hrefs: the code travels as a
    // URL parameter, which Stripe records on the checkout session.
    var url = pending.url;
    var ref = pending.code;
    if (ref) {
      url += (url.indexOf("?") === -1 ? "?" : "&") +
        "client_reference_id=" + encodeURIComponent(ref);
    }
    var target = pending.target;
    close();
    if (target === "_blank") {
      window.open(url, "_blank", "noopener");
    } else {
      window.location.href = url;
    }
  }

  function apiCheckout() {
    var ref = pending.code;
    var pieceId = pending.pieceId;

    // Demo pages (demo-checkout.html only) can simulate the backend.
    if (typeof window.__DEMO_CHECKOUT__ === "function") {
      close();
      window.__DEMO_CHECKOUT__(pieceId, ref);
      return;
    }

    goBtn.disabled = true;
    goBtn.textContent = "Taking you to checkout\u2026";
    hint.textContent = "";

    // Sheet pieces (from Evan's upload form) are named, not catalog IDs;
    // the server validates name + price against the live Sheet.
    var payload = pending.sheetPiece
      ? { sheet_piece: pending.sheetPiece, referral_code: ref }
      : { piece_id: pieceId, referral_code: ref };

    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          return { ok: resp.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.data.url) {
          fail((result.data && result.data.error) || undefined);
          return;
        }
        window.location.href = result.data.url;
      })
      .catch(function () {
        fail("Could not reach checkout. Check your connection and try again.");
      });
  }

  function go() {
    if (!pending) return;
    var useNA = naBox.checked;
    var code = input.value.trim().toUpperCase();
    if (!useNA && !code) {
      hint.textContent = "Enter a code, or check N/A if you don't have one.";
      input.focus();
      return;
    }
    pending.code = code; // "" when N/A
    if (pending.kind === "link") {
      legacyRedirect();
    } else {
      apiCheckout();
    }
  }

  naBox.addEventListener("change", function () {
    if (naBox.checked) {
      input.value = "";
      input.disabled = true;
      hint.textContent = "";
    } else {
      input.disabled = false;
      input.focus();
    }
  });
  goBtn.addEventListener("click", go);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", function (e) {
    if (overlay.style.display !== "flex") return;
    if (e.key === "Escape") close();
    if (e.key === "Enter" && document.activeElement === input) go();
  });

  /* ---------- intercept buy targets ---------- */
  document.addEventListener("click", function (e) {
    // Ignore clicks inside the popup itself.
    if (overlay.style.display === "flex" && overlay.contains(e.target)) return;
    var el = e.target.closest ? e.target.closest("[data-piece],[data-sheet-piece],a[href]") : null;
    if (!el) return;
    var sheetPiece = el.getAttribute("data-sheet-piece");
    if (sheetPiece) {
      e.preventDefault();
      open({ kind: "api", sheetPiece: sheetPiece });
      return;
    }
    var piece = el.getAttribute("data-piece");
    if (piece) {
      e.preventDefault();
      open({ kind: "api", pieceId: piece });
      return;
    }
    if (el.tagName === "A" && isStripeCheckout(el.getAttribute("href"))) {
      e.preventDefault();
      open({ kind: "link", url: el.getAttribute("href"), target: el.getAttribute("target") });
    }
  });
})();
