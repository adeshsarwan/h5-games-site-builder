/*! po-ads.js — standard ad controller for Site Builder H5 game sites.
 *
 * Price Optimiser (publisher-sdk.js) owns GPT, ad units, DIV ids, sizes, variant/control
 * split, prices, refresh and rendering — all from the site's backend config. Nothing of that
 * is set or overwritten here. This file only decides WHEN the ads on the page are called:
 *   - natives load when their position comes near the viewport and has width; anchors on page load
 *   - one interstitial is requested per full page load (GPT decides when it shows), at Price Optimiser's
 *     session-ladder price: top price first, next price on the next page after an empty response
 *   - links that must never trigger an interstitial are marked
 *
 * Which positions exist, and whether each is a native or an anchor, comes from the runtime
 * config: a position is only used if its data-po-div matches an enabled backend DIV id.
 *
 * Markup (rendered by Site Builder; the inner div has NO id — this file adds it when loading):
 *   <div id="{DIV id}-wrapper" class="po-ad"><div data-po-div="{DIV id from the backend}"></div></div>
 *
 * Load order (both deferred, in this order, once per page):
 *   <script defer src="https://serve.thebesads.com/sdk/publisher-sdk.js" data-po-site="SITE"
 *     data-po-runtime-config-url="https://serve.thebesads.com/runtime/config" data-auto-init="false"></script>
 *   <script defer src="/assets/po-ads.js"></script>
 *
 * Per-site options: window.__PO_ADS__ = { ... } before this file (see DEFAULTS).
 */
(function () {
  "use strict";
  if (window.__poAdsStarted) return;
  window.__poAdsStarted = true;

  var DEFAULTS = {
    interstitial: true,          // one request per full page load, never retried
    // Interstitial price per session (Price Optimiser's own session ladder; prices come from the backend ladder):
    // first page = top price; a confirmed empty response -> next price on the next page; a fill keeps that price for
    // the session; timeout/no response doesn't move it; control traffic stays unpriced. No waterfall on one page.
    sessionLadder: true,
    interstitialTriggers: { navBar: true, unhideWindow: true, inactivity: true, endOfArticle: true },
    lazyMarginMobile: 6,         // viewport heights ahead of a native position (<768px)
    lazyMarginDesktop: 3,        // viewport heights (>=768px)
    // Pages whose main action is a rewarded ad (e.g. Torunex "/best/" funnel). The SDK holds one
    // full-screen lock while the page-load interstitial is pending (until GPT renders it or the
    // backend interstitial timeout), so showRewarded() would return "busy" there.
    skipInterstitialPaths: null, // RegExp, e.g. /^\/best(\/|$)/
    excludePaths: /(^|\/)(privacy|privacy-policy|terms|terms-and-conditions|terms-of-use|contact|contact-us|about-us|support|help|login|logout|register|signup|account|profile|settings|refund|cancellation)(\/|$)/i
  };
  var CFG = Object.assign({}, DEFAULTS, window.__PO_ADS__ || {});
  if (typeof CFG.skipInterstitialPaths === "string") { try { CFG.skipInterstitialPaths = new RegExp(CFG.skipInterstitialPaths); } catch (e) { CFG.skipInterstitialPaths = null; } }
  var log = function () { try { if (/po_debug=1/.test(location.search)) console.log.apply(console, ["[po-ads]"].concat([].slice.call(arguments))); } catch (e) {} };
  var warn = function (e) { try { console.warn("[po-ads]", e && e.message ? e.message : e); } catch (x) {} };
  var mobile = function () { return (window.innerWidth || 0) < 768; };

  /* ---------- 1. Links that must not trigger a GPT interstitial ---------- */
  var marked = new WeakSet();
  function excluded(a) {
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || a.hasAttribute("data-no-interstitial") || a.hasAttribute("download")) return true;
    if ((a.getAttribute("target") || "").toLowerCase() === "_blank") return true;
    try {
      var u = new URL(href, location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return true;
      if (u.origin !== location.origin) return true;
      if (CFG.excludePaths.test(u.pathname)) return true;
      if (u.pathname === location.pathname && u.search === location.search && u.hash) return true;
    } catch (e) { return true; }
    return false;
  }
  function markLink(a) {
    if (excluded(a)) {
      if (a.getAttribute("data-google-interstitial") !== "false") { marked.add(a); a.setAttribute("data-google-interstitial", "false"); }
    } else if (marked.has(a)) { marked.delete(a); a.removeAttribute("data-google-interstitial"); }
  }
  function markTree(n) {
    if (!n || n.nodeType !== 1) return;
    if (n.matches && n.matches("a[href]")) markLink(n);
    if (n.querySelectorAll) n.querySelectorAll("a[href]").forEach(markLink);
  }
  function startLinkMarking() {
    markTree(document.documentElement);
    if (window.MutationObserver) {
      new MutationObserver(function (list) {
        list.forEach(function (m) { if (m.type === "attributes") markTree(m.target); else m.addedNodes.forEach(markTree); });
      }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "target", "download", "data-no-interstitial"] });
    }
    document.addEventListener("click", function (ev) { var a = ev.target && ev.target.closest && ev.target.closest("a[href]"); if (a) markLink(a); }, true);
  }

  /* ---------- 2. GPT interstitial trigger settings (applied to Price Optimiser's own slot) ----------
     We never define slots. When Price Optimiser defines its INTERSTITIAL slot, we add the trigger
     config to that slot before it is requested. */
  function gptReady() {
    return new Promise(function (resolve) {
      var gt = window.googletag = window.googletag || { cmd: [] };
      gt.cmd = gt.cmd || [];
      gt.cmd.push(function () { resolve(window.googletag); });
    });
  }
  function hookInterstitialTriggers(g) {
    if (!g || g.__poAdsHooked || typeof g.defineOutOfPageSlot !== "function") return;
    g.__poAdsHooked = true;
    var orig = g.defineOutOfPageSlot;
    g.defineOutOfPageSlot = function (path, format) {
      var slot = orig.apply(this, arguments);
      try {
        var inter = g.enums && g.enums.OutOfPageFormat && g.enums.OutOfPageFormat.INTERSTITIAL;
        if (slot && format === inter && slot.setConfig) {
          slot.setConfig({ interstitial: { requireStorageAccess: false, triggers: CFG.interstitialTriggers } });
          log("interstitial triggers set", CFG.interstitialTriggers);
        }
      } catch (e) { warn(e); }
      return slot;
    };
  }

  /* ---------- 3. Display placements ---------- */
  var PE = null, slots = {};
  function wrapperOf(id) { return document.getElementById(id + "-wrapper"); }
  function busy(id, on) { var w = wrapperOf(id); if (w) w.setAttribute("aria-busy", on ? "true" : "false"); }

  function watchState(id, el) {
    // Price Optimiser marks the div: reserved | requesting | filled | empty. The site's CSS decides
    // what an empty slot looks like (the SDK itself also sets `hidden` on an empty div).
    var apply = function () {
      var st = el.getAttribute("data-po-slot-state");
      busy(id, st === "reserved" || st === "requesting");
    };
    if (window.MutationObserver) new MutationObserver(apply).observe(el, { attributes: true, attributeFilter: ["data-po-slot-state"] });
    apply();
  }

  function load(id) {
    var s = slots[id];
    if (!s || s.loaded) return;
    s.loaded = true;
    s.el.id = id;                      // the SDK only ever sees the div once we decide to load it
    watchState(id, s.el);
    busy(id, true);
    // preload + reveal = exactly one initial request through Price Optimiser
    PE.preloadSlots([id])
      .then(function () { return PE.revealSlots([id]); })
      .then(function (r) { log("loaded", id, r && r.results && r.results[0] && r.results[0].status); })
      .catch(warn);
  }

  function setupLazy(id) {
    var s = slots[id];
    var vh = window.innerHeight || 800;
    var margin = Math.round(vh * (mobile() ? CFG.lazyMarginMobile : CFG.lazyMarginDesktop));
    if (!window.IntersectionObserver) { waitForWidth(id); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting || e.intersectionRatio > 0) { io.disconnect(); waitForWidth(id); } });
    }, { root: null, rootMargin: margin + "px 0px " + margin + "px 0px", threshold: 0 });
    io.observe(s.el);
  }

  function waitForWidth(id) {
    var s = slots[id];
    if (s.el.getBoundingClientRect().width > 0) { load(id); return; }
    if (!window.ResizeObserver) { setTimeout(function () { waitForWidth(id); }, 500); return; }
    var ro = new ResizeObserver(function () { if (s.el.getBoundingClientRect().width > 0) { ro.disconnect(); load(id); } });
    ro.observe(s.el);
  }

  /* ---------- 4. Start ---------- */
  function start() {
    PE = window.PublisherExperience;
    if (!PE || typeof PE.init !== "function") { warn("publisher-sdk.js did not load"); return; }
    Promise.resolve(PE.init()).then(function (st) {
      var conf = (st && st.runtime && st.runtime.slots) || {};
      var keys = Object.keys(conf);
      // backend display slots by DIV id -> type (native / anchor / ...)
      var display = {};
      keys.forEach(function (k) {
        var c = conf[k] || {}, type = String(c.adUnitType || "").toLowerCase();
        if (c.enabled === false || !type || type === "interstitial" || type === "rewarded") return;
        var id = c.domId || (typeof c.domSelector === "string" && (c.domSelector.match(/^#([\w-]+)$/) || c.domSelector.match(/^\[id="([\w-]+)"\]$/) || [])[1]);
        if (id) display[id] = type;
      });
      document.querySelectorAll("[data-po-div]").forEach(function (el) {
        var id = el.getAttribute("data-po-div");
        if (!id || slots[id] || document.getElementById(id)) return;   // one per page
        if (!display[id]) { log("no enabled backend slot for", id); return; }
        slots[id] = { id: id, el: el, type: display[id], loaded: false };
        if (display[id] === "anchor") load(id); else setupLazy(id);   // anchor: on page load (its empty div has no width yet)
      });
      var inter = keys.filter(function (k) { var c = conf[k]; return c && c.enabled !== false && String(c.adUnitType || "").toLowerCase() === "interstitial"; })[0];
      var skip = CFG.skipInterstitialPaths && CFG.skipInterstitialPaths.test(location.pathname);
      if (CFG.interstitial && !skip && inter) {
        // Price Optimiser's session ladder is a switch on its runtime slot; the ladder itself is the backend's.
        if (CFG.sessionLadder) conf[inter].interstitialSessionLadder = true;
        // Hook GPT before Price Optimiser defines its slot, so the trigger settings are on it before the request.
        window.poAds.interstitial = gptReady().then(function (g) { hookInterstitialTriggers(g); return PE.showInterstitial(inter); })
          .then(function (r) { log("interstitial", r && r.status); return r; })
          .catch(function (e) { warn(e); return { status: "error" }; });
      }
    }).catch(warn);
  }

  // Settles when the page-load interstitial request is finished (lock released). A rewarded flow
  // that may start early can wait on it: await window.poAds.interstitial
  window.poAds = { interstitial: Promise.resolve({ status: "not_requested" }) };

  startLinkMarking();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
