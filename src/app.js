/* PlayPop portal runtime: search, play, fullscreen, recently played, GPT ads. Kept tiny on purpose.
   On a page Chrome is prerendering (the game finder preloads the match page while the rewarded video plays) the runtime
   waits until the visitor actually sees the page; GPT itself also holds ad requests until then. */
(function (run) {
  if (document.prerendering) document.addEventListener("prerenderingchange", run, { once: true }); else run();
})(function () {
  "use strict";
  var CFG = window.__SITE__ || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------- Analytics: GA4 events (no-op when the site has no GA4 id) ---------- */
  var track = function (name, p) { try { if (window.gtag) window.gtag("event", name, p || {}); } catch (e) {} };
  var view = function () { return window.matchMedia("(max-width:869px)").matches ? "mobile" : "desktop"; };
  // Where on the page a click happened, so we can see which modules send people onward.
  var PLACES = [[".search", "search"], [".mm", "game_finder"], [".mm-banner", "match_banner"], [".vrev", "top_reviewed"], [".gp-strip", "similar_games"], [".gp-trend", "trending"], [".gp-launch", "launch_card"], [".vhero", "home_hero"],
    [".vquick", "quick_picks"], [".vpick", "list_pick"], [".vplay", "list_sidebar_games"], [".vmore", "more_lists"], [".vlists", "lists"], [".vwall", "mobile_wall"],
    [".vmosaic", "game_grid"], [".vapps", "apps_grid"], [".vcats,.vcats2", "category_pills"], [".gp-crumbs", "breadcrumb"], [".info,.gp-about,.prose", "article"],
    [".vh", "header"], [".vf,footer", "footer"]];
  var placeOf = function (el) { for (var i = 0; i < PLACES.length; i++) if (el.closest(PLACES[i][0])) return PLACES[i][1]; return "other"; };
  var pageType = (function (p) { return p === "/" ? "home" : /^\/game\//.test(p) ? "game" : /^\/category\//.test(p) ? "category" : /^\/best\/.+/.test(p) ? "list" : /^\/best\/?$/.test(p) ? "lists_index" : /^\/topgames\/.+/.test(p) ? "app" : /^\/topgames\/?$/.test(p) ? "apps_index" : /^\/blog\//.test(p) ? "blog" : "other"; })(location.pathname);
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var h = a.getAttribute("href"), place = placeOf(a), m;
    if (/play\.google\.com/.test(h)) {
      var pick = a.closest(".vpick");
      track("store_click", { app_name: a.getAttribute("data-app") || (pick && pick.querySelector("h2") || document.querySelector("h1") || {}).textContent || "", placement: place, page_type: pageType,
        list_position: pick ? Number((pick.id.match(/\d+/) || [0])[0]) : undefined, outbound: true });
    } else if ((m = h.match(/^\/game\/([^/]+)/))) {
      track("game_click", { game: m[1], placement: place, page_type: pageType });
      if (place === "search" && input && input.value.trim()) track("search", { search_term: input.value.trim() });
    } else if ((m = h.match(/^\/best\/([^/#]+)/))) track("list_click", { list: m[1], placement: place, page_type: pageType });
    else if ((m = h.match(/^\/topgames\/([^/#?]+)/))) track("app_click", { app: decodeURIComponent(m[1]), placement: place, page_type: pageType });
    else if ((m = h.match(/^\/category\/([^/]+)/))) track("category_click", { category: m[1], placement: place, page_type: pageType });
  }, true);
  if (pageType === "list") track("list_view", { list: location.pathname.split("/")[2] });
  // ad_shown: Google Ads conversion for sites connected to a Google Ads account (CFG.googleAds, from site.json
  // analytics.googleAds). For now it fires on page load, once per browser session; sendTo also reports it to the
  // Google Ads conversion action directly (otherwise Ads imports it from GA4 as a key event).
  if (CFG.googleAds) (function (g) {
    var ss = (function () { try { return sessionStorage; } catch (e) { return null; } })();
    if (ss && ss.getItem("ad_shown_sent")) return;
    if (ss) try { ss.setItem("ad_shown_sent", "1"); } catch (e) {}
    track("ad_shown", { page_type: pageType, view: view(), trigger: "page_load" });
    if (g.sendTo) track("conversion", { send_to: g.sendTo });
  })(CFG.googleAds);

  /* ---------- Price Optimiser rewarded bridge (shared by the Play gate and the game finder) ----------
     Price Optimiser owns GPT and the "rewarded" slot; we never define slots. We only call its window.PublisherExperience
     bridge (same name on the dedicated per-site scripts and the generic SDK): init() → { loaded }, preloadRewarded, showRewarded.
     PO.run(cb) shows one rewarded ad and calls cb(result, status): "granted" (onGranted fired and the ad closed),
     "stopped" (the visitor closed or declined it) or "fallback" (no API / no fill / error / timeout). */
  // rewarded_watched: one per rewarded video that counts as watched (completed, or in the game finder closed after
  // minWatch seconds). Never sent when no ad was shown. Google Ads conversion for campaigns that optimise on watches.
  var rewardedWatched = function (source, how, app, watched) {
    track("rewarded_watched", { source: source, via: how, app: app || undefined, watched: watched || undefined, page_type: pageType, view: view() });
  };
  var PO = (function () {
    // wanted: preload() was called before init() resolved (the SDK is deferred); init fires it once it is ready.
    var ready = false, warm = null, wanted = false;
    var api = function () { var px = window.PublisherExperience; return ready && px && typeof px.showRewarded === "function" ? px : null; };
    var init = function () {
      var px = window.PublisherExperience;
      if (!px || typeof px.init !== "function") return;
      Promise.resolve(px.init()).then(function (st) {
        // Dedicated scripts return { loaded }; the generic SDK returns { runtime, adapter }. Either way the site's
        // runtime config must have an enabled "rewarded" slot, otherwise we would only ever fall back.
        var slots = st && st.runtime && st.runtime.slots, rw = slots && slots.rewarded;
        ready = !!st && st.loaded !== false && st.status !== "error" && (!slots || (!!rw && rw.enabled !== false));
        if (ready && wanted) preload();
      }, function () { ready = false; });
    };
    if (window.PublisherExperience) init(); else window.addEventListener("load", init);
    var preload = function () {
      var a = api();
      if (!a) { wanted = true; return; }
      wanted = false;
      if (!warm && a.preloadRewarded) { try { warm = Promise.resolve(a.preloadRewarded("rewarded", { onFallback: function () { warm = null; } })).catch(function () { warm = null; }); } catch (e) {} }
    };
    // onStart (optional): called once when the ad is actually on screen (onReady), not on no-fill or error.
    var run = function (cb, onStart) {
      var a = api(), granted = false, closed = false, fallback = null, t0 = Date.now(), t1 = 0;
      var fin = function () {
        warm = null;
        var watched = Math.round(((t1 || Date.now()) - t0) / 1000); // seconds the ad was up (from onReady when it fires)
        if (granted && closed) return cb("granted", "granted", watched);
        var status = fallback || (closed ? "closed" : "unavailable");
        cb(/declin|dismiss|clos|cancel|skip/i.test(status) || (closed && !fallback) ? "stopped" : "fallback", status, watched);
      };
      if (!a) return fin();
      Promise.resolve().then(function () {
        return a.showRewarded("rewarded", {
          onReady: function () { t0 = Date.now(); if (onStart) { try { onStart(); } catch (e) {} onStart = null; } },
          onGranted: function () { granted = true; },
          onVideoCompleted: function () { granted = true; },
          onClosed: function () { closed = true; t1 = Date.now(); },
          onFallback: function (r) { fallback = fallback || String((r && r.status) || "unavailable"); }
        });
      }).then(function (res) {
        if (granted && !closed) closed = true; // settled after a grant = terminal outcome
        if (!granted && !fallback && !closed) fallback = String((res && res.status) || "unavailable");
      }, function (err) { fallback = fallback || String((err && err.status) || "error"); }).then(fin);
    };
    return { api: api, preload: preload, run: run };
  })();
  var SS = (function () { try { return sessionStorage; } catch (e) { return null; } })();
  // Remember a Play Store link as already unlocked so the Play gate doesn't ask for a second ad (site.json playGate.frequency).
  var unlockPlay = function (url) {
    var PGc = CFG.playGate; if (!SS || !PGc || !url) return;
    try { SS.setItem("pg_unlocked", PGc.frequency === "session" ? "1" : (SS.getItem("pg_unlocked") || "").split("\n").filter(Boolean).concat(url).slice(-50).join("\n")); } catch (e) {}
  };

  /* ---------- Play gate: rewarded ad before leaving for Google Play (same rules as the jobsthe.world apply gate; site.json playGate) ----------
     - the rewarded ad is shown only after the visitor opts in ("Watch") and is preloaded when the dialog opens;
     - the link unlocks only on a real grant (onGranted fired and the ad closed), never on onReady or a closed ad;
     - no API / no fill / error / timeout → the link still opens (never trapped);
     - closed early → "Try again" once; a second attempt without a reward opens the link anyway. */
  var PG = CFG.playGate, dlg = PG && document.getElementById("play-gate");
  if (dlg) {
    var poAds = PO.api;
    var ss = (function () { try { return sessionStorage; } catch (e) { return null; } })();
    var unlocked = function (url) {
      if (PG.frequency === "always" || !ss) return false;
      var v = ss.getItem("pg_unlocked") || "";
      return PG.frequency === "session" ? v !== "" : v.split("\n").indexOf(url) > -1;
    };
    var remember = function (url) { if (ss) ss.setItem("pg_unlocked", PG.frequency === "session" ? "1" : (ss.getItem("pg_unlocked") || "").split("\n").filter(Boolean).concat(url).slice(-50).join("\n")); };
    var views = dlg.querySelectorAll("[data-view]");
    var show = function (v) { for (var i = 0; i < views.length; i++) views[i].hidden = views[i].getAttribute("data-view") !== v; };
    var watchBtns = dlg.querySelectorAll("[data-pg-watch]");
    var setBusy = function (b) { for (var i = 0; i < watchBtns.length; i++) watchBtns[i].disabled = b; };
    var cur = null, misses = 0, opened = false, watching = false, preload = PO.preload;
    var openApp = function (how) {
      if (!cur || opened) return;
      opened = true; remember(cur.url);
      var w = window.open(cur.url, "_blank");
      if (w) { try { w.opener = null; } catch (e) {} }
      track("play_gate_reveal", { via: how, app_name: cur.app, auto_opened: !!w, page_type: pageType });
      $(".pg-ready", dlg).textContent = w ? cur.app + " opened on Google Play in a new tab." : "Your Google Play link for " + cur.app + " is ready.";
      $("[data-pg-open]", dlg).textContent = w ? "Open it again" : "Open " + cur.app + " on Google Play";
      show("ready");
    };
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href*="play.google.com"]');
      if (!a || dlg.contains(a) || !poAds() || unlocked(a.href)) return; // no ad API (yet) or already unlocked → normal link
      e.preventDefault();
      var pick = a.closest(".vpick");
      var app = a.getAttribute("data-app") || ((pick && pick.querySelector("h2")) || document.querySelector("h1") || {}).textContent || "This game";
      app = app.replace(/ review$/, "");
      var icon = (a.closest(".apphead,.vpick,section") || document).querySelector("img");
      cur = { url: a.href, app: app }; misses = 0; opened = false;
      $(".pg-app", dlg).textContent = app;
      $(".pg-msg", dlg).textContent = PG.message.replace(/\{app\}/g, app).replace(/\{site\}/g, PG.site);
      var img = $(".pg-icon", dlg);
      img.hidden = !icon; if (icon) img.src = icon.currentSrc || icon.src;
      var links = dlg.querySelectorAll("[data-pg-open],[data-pg-skip]");
      for (var i = 0; i < links.length; i++) links[i].href = cur.url;
      setBusy(false); show("ask"); dlg.showModal(); preload();
      track("play_gate_open", { app_name: app, page_type: pageType });
    }, true);
    for (var wi = 0; wi < watchBtns.length; wi++) watchBtns[wi].addEventListener("click", function () {
      if (watching) return;
      watching = true; setBusy(true);
      // GPT shows the rewarded ad in its own full-screen overlay; a modal <dialog> sits above everything in the
      // top layer, so close ours while the ad is up and reopen it for the result.
      dlg.close();
      PO.run(function (res, status) {
        watching = false; setBusy(false); dlg.showModal();
        if (res === "granted") { track("play_gate_granted", { app_name: cur.app }); rewardedWatched("play_gate", "granted", cur.app); return openApp("granted"); }
        if (res === "fallback") { track("play_gate_fallback", { status: status }); return openApp("fallback-" + status); }
        if (++misses >= 2) { track("play_gate_retry_access", { status: status }); return openApp("retry-" + status); }
        track("play_gate_incomplete", { status: status });
        show("incomplete");
      });
    });
    var skips = dlg.querySelectorAll("[data-pg-skip]");
    for (var si = 0; si < skips.length; si++) skips[si].addEventListener("click", function () { if (cur) remember(cur.url); track("play_gate_skip", { app_name: cur && cur.app }); dlg.close(); });
    $("[data-pg-open]", dlg).addEventListener("click", function () { setTimeout(function () { dlg.close(); }, 50); });
    $("[data-pg-close]", dlg).addEventListener("click", function () { track("play_gate_dismiss", { app_name: cur && cur.app }); dlg.close(); });
    dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  }

  /* ---------- Game finder popup on /best/ (#match), like jobguidematch.com: opens on landing over the blurred page,
     no close button, 4 This-or-That questions → one Play Store game. "See my game" (labelled "A short sponsored video
     plays first") shows a rewarded video via PO.run (same rules as the Play gate): granted or no ad available → open the
     match's /topgames/ page with ?match=1; closed early → "Try again" once, then open anyway. The match's Play link is
     then unlocked, so the Play gate doesn't ask again. */
  var mm = document.getElementById("match"), mmData = document.getElementById("mm-data");
  if (mm && mmData) (function () {
    var D; try { D = JSON.parse(mmData.textContent); } catch (e) { return; }
    var views = mm.querySelectorAll("[data-mm-view]");
    var show = function (v) { for (var i = 0; i < views.length; i++) views[i].hidden = views[i].getAttribute("data-mm-view") !== v; };
    var MIN_WATCH = CFG.matchMinWatch || 5; // seconds of the rewarded video before its Close/Skip opens the match
    var picks = [], labels = [], round = 0, match = null, runners = [], fit = 0, misses = 0, busy = false;
    // Drop-off: where the visitor was when they left without unlocking the match (sent once, on pagehide).
    var stage = "q1", t0 = Date.now(), done = false, adStarted = false;
    var el = function (tag, cls, txt) { var x = document.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x; };
    var dots = function (box) { box.innerHTML = ""; for (var i = 0; i < D.rounds.length; i++) box.appendChild(el("i", i < round ? "on" : i === round ? "cur" : "")); };
    var renderRound = function () {
      var r = D.rounds[round];
      $(".mm-step", mm).textContent = "Question " + (round + 1) + " of " + D.rounds.length;
      dots($("[data-mm-view=round] .mm-dots", mm));
      $(".mm-q", mm).textContent = r.q;
      var pair = $(".mm-pair", mm); pair.innerHTML = "";
      r.o.forEach(function (o, k) {
        var b = el("button", "mm-opt"); b.type = "button";
        if (o.img) { var im = el("img"); im.alt = ""; im.src = o.img; b.appendChild(im); } else b.appendChild(el("span", "mm-noimg", k ? "⚡" : "🌿"));
        b.appendChild(el("b", "", o.label));
        b.addEventListener("click", function () {
          if (busy) return; busy = true; b.classList.add("pick");
          picks.push(o.tag); labels.push(o.label);
          if (round === 0) PO.preload(); // backup for the call on open (no-op if already loading or loaded)
          track("match_round", { round: round + 1, choice: o.tag });
          track("quiz_q" + (round + 1), { question_no: round + 1, choice: o.tag, view: view() }); // quiz_q1 … quiz_q4
          setTimeout(function () { busy = false; round++; if (round < D.rounds.length) { stage = "q" + (round + 1); renderRound(); } else finish(); }, 420);
        });
        pair.appendChild(b);
      });
      if (round + 1 < D.rounds.length) D.rounds[round + 1].o.forEach(function (o) { if (o.img) (new Image()).src = o.img; });
      show("round");
    };
    var finish = function () {
      stage = "matching"; show("think");
      // Answers decide; quality (our score, Editor's Choice, Play rating) only breaks ties. A game with the opposite
      // trait of an answer (e.g. solo-only when "With friends" was picked) loses points.
      var OPP = { chill: "thrill", thrill: "chill", think: "reflex", reflex: "think", quick: "deep", deep: "quick", solo: "together", together: "solo" };
      var has = function (a, t) { return a.t.indexOf(t) > -1; };
      var hits = function (a) { var n = 0; for (var i = 0; i < picks.length; i++) if (has(a, picks[i])) n++; return n; };
      var miss = function (a) { var n = 0; for (var i = 0; i < picks.length; i++) if (!has(a, picks[i]) && has(a, OPP[picks[i]])) n++; return n; };
      var ranked = D.apps.map(function (a) { var h = hits(a); return { a: a, h: h, sc: h * 10 - miss(a) * 6 + (a.s || a.r * 0.9) + a.e * 1.5 + a.r * 0.5 + Math.random() * 3 }; })
        .sort(function (x, y) { return y.sc - x.sc; });
      match = ranked[0].a; runners = ranked.slice(1, 3).map(function (x) { return x.a; });
      fit = Math.min(99, 80 + ranked[0].h * 4 + Math.floor(Math.random() * 4));
      track("match_complete", { picks: picks.join(","), app: match.n, fit: fit });
      (new Image()).src = match.i; PO.preload();
      setTimeout(reveal, 1500);
    };
    // Save the match and have Chrome prerender its page right away, so it opens instantly after the video. GPT delays the
    // prerendered page's ad requests until it is shown, so its native/anchor ads load the moment it opens and nothing
    // is counted while it is hidden. Browsers without speculation rules just prefetch the HTML.
    var save = function () { try { if (SS) SS.setItem("mm_match", JSON.stringify({ u: match.u, n: match.n, w: match.w, fit: fit, labels: labels, gp: match.gp, runners: runners.map(function (x) { return { u: x.u, n: x.n, i: x.i }; }) })); } catch (e) {} };
    var preloaded = "";
    var preloadMatch = function () {
      var url = match.u + "?match=1";
      if (preloaded === url) return; preloaded = url;
      try {
        if (HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")) {
          var sr = document.createElement("script"); sr.type = "speculationrules";
          sr.textContent = JSON.stringify({ prerender: [{ source: "list", urls: [url], eagerness: "immediate" }] });
          document.head.appendChild(sr);
        } else { var l = document.createElement("link"); l.rel = "prefetch"; l.href = url; document.head.appendChild(l); }
      } catch (e) {}
    };
    var reveal = function () {
      misses = 0; save(); preloadMatch();
      $(".mm-blur img", mm).src = match.i;
      $(".mm-fit", mm).textContent = fit + "% fit";
      $(".mm-sum", mm).textContent = (match.g ? (/^[aeiou]/i.test(match.g) ? "An " : "A ") + match.g.toLowerCase() + " " : "A ") + "game for players who picked " + labels.map(function (l) { return l.toLowerCase(); }).join(", ") + ".";
      stage = "reveal"; show("reveal");
      track("match_reveal_open", { app: match.n });
    };
    var go = function (how) {
      done = true;
      track("match_unlock", { via: how, app: match.n, fit: fit });
      save();
      unlockPlay(match.gp);
      show("go");
      location.href = match.u + "?match=1";
    };
    var watchBtns = mm.querySelectorAll("[data-mm-watch]");
    for (var i = 0; i < watchBtns.length; i++) watchBtns[i].addEventListener("click", function () {
      if (busy || !match) return; busy = true;
      stage = "ad"; track("match_ad_start", { app: match.n });
      PO.run(function (res, status, watched) {
        busy = false;
        if (res === "granted") { rewardedWatched("game_finder", "granted", match.n, watched); return go("granted"); }
        if (res === "fallback") return go("fallback-" + status);
        // The visitor used the ad's own Close/Skip. After MIN_WATCH seconds that counts as watched; earlier closes get
        // one "Try again", then the match opens anyway.
        if (watched >= MIN_WATCH) { rewardedWatched("game_finder", "skipped_after_min", match.n, watched); return go("skipped-after-" + watched + "s"); }
        if (++misses >= 2) return go("retry-" + status);
        track("match_ad_incomplete", { status: status, watched: watched });
        stage = "ad_incomplete"; show("incomplete");
      }, function () {
        // quiz_ad_start: the rewarded video is actually on screen (not sent on no fill / error).
        if (!adStarted) { adStarted = true; track("quiz_ad_start", { app: match.n, view: view() }); }
      });
    });
    // Opens on landing as a popup over the blurred page; question 1 is already in the HTML, bind it (same content, no flash).
    document.documentElement.classList.add("mm-open");
    renderRound(); track("match_start", { auto: true }); track("quiz_start", { view: view() });
    // Start the rewarded waterfall now, not after question 4, so the video is ready by "See my game".
    PO.preload();
    window.addEventListener("pagehide", function () {
      if (done || !window.gtag) return; done = true;
      window.gtag("event", "match_drop", { stage: stage, answered: picks.length, seconds_on_finder: Math.round((Date.now() - t0) / 1000),
        app: match ? match.n : undefined, view: view(), transport_type: "beacon" });
      // quiz_drop: left the finder without getting the match through an ad (stage: q1…q4, matching, reveal, ad, ad_incomplete).
      window.gtag("event", "quiz_drop", { stage: stage, answered: picks.length, ad_started: adStarted,
        seconds_on_finder: Math.round((Date.now() - t0) / 1000), view: view(), transport_type: "beacon" });
    });
  })();

  /* ---------- "Your match" banner on the matched /topgames/ page ---------- */
  if (/[?&]match=1\b/.test(location.search)) (function () {
    var m = null; try { m = JSON.parse((SS && SS.getItem("mm_match")) || "null"); } catch (e) {}
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    if (!m || decodeURIComponent(m.u) !== decodeURIComponent(location.pathname)) return;
    var mk = function (tag, cls, txt) { var x = document.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x; };
    var b = mk("section", "mm-banner"); b.setAttribute("aria-label", "Your match");
    b.appendChild(mk("span", "mm-b-ico", "🎯"));
    var t = mk("div", "mm-b-t");
    t.appendChild(mk("strong", "", "Your match: " + m.n + " · " + m.fit + "% fit"));
    t.appendChild(mk("p", "", "You picked " + (m.labels || []).join(" · ") + "."));
    if (m.w) t.appendChild(mk("p", "mm-b-why", m.w));
    b.appendChild(t);
    var more = mk("div", "mm-b-more");
    if (m.runners && m.runners.length) {
      more.appendChild(mk("small", "", "Also a great fit"));
      m.runners.forEach(function (r) { var a = mk("a"); a.href = r.u; var im = mk("img"); im.src = r.i; im.alt = ""; im.width = 36; im.height = 36; a.appendChild(im); a.appendChild(mk("span", "", r.n)); more.appendChild(a); });
    }
    var again = mk("a", "mm-b-again", "Play the game finder again →"); again.href = "/best/#match"; more.appendChild(again);
    b.appendChild(more);
    var main = $("main"), first = $("main article") || (main && main.firstElementChild);
    if (first) first.parentNode.insertBefore(b, first); else if (main) main.insertBefore(b, main.firstChild);
    track("match_view", { app: m.n, fit: m.fit });
  })();

  /* ---------- Search ---------- */
  var overlay = $(".search"), input = overlay && $("input", overlay), res = overlay && $(".res", overlay), index = null;
  function openSearch() {
    if (!overlay) return;
    overlay.classList.add("open");
    input.focus();
    track("search_open", { page_type: pageType });
    if (!index) {
      fetch("/search.json").then(function (r) { return r.json(); }).then(function (j) { index = j; render(); });
    }
  }
  function closeSearch() { overlay && overlay.classList.remove("open"); }
  function render() {
    if (!index) return;
    var q = input.value.trim().toLowerCase();
    var list = index.filter(function (g) { return !q || (g.t + " " + g.c).toLowerCase().indexOf(q) > -1; }).slice(0, 48);
    res.innerHTML = list.length ? list.map(function (g) {
      return '<a href="/game/' + g.s + '/"><img src="/media/' + g.s + '/icon-192.webp" width="96" height="96" alt="" loading="lazy">' + g.t + "</a>";
    }).join("") : '<div class="empty">No games found. Try "puzzle" or "casino".</div>';
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-search]")) { e.preventDefault(); openSearch(); }
    else if (overlay && e.target === overlay) closeSearch();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeSearch(); exitImmersive(); }
    if (e.key === "/" && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
  });
  input && input.addEventListener("input", render);

  /* ---------- Player ---------- */
  var player = $(".player");
  var mobile = function () { return window.matchMedia("(max-width:869px)").matches; };
  var playStart = 0, playTimer = null, playSlug = player && player.getAttribute("data-slug");
  var secs = function () { return playStart ? Math.round((Date.now() - playStart) / 1000) : 0; };
  function stopPlay(reason) {
    if (!playStart) return;
    track("game_exit", { game: playSlug, seconds_played: secs(), reason: reason, view: view() });
    clearInterval(playTimer); playStart = 0;
  }
  function exitImmersive() {
    if (!document.body.classList.contains("immersive")) return;
    stopPlay("close_button");
    document.body.classList.remove("immersive");
    var f = player && $("iframe", player);
    if (f) f.remove();
    var c = player && $(".cover", player);
    if (c) c.hidden = false;
  }
  if (player) {
    var slug = player.getAttribute("data-slug");
    var stage = $(".stage", player);
    var start = function (e) {
      if ($("iframe", stage)) return;
      var src = e && e.currentTarget && e.currentTarget.hasAttribute && e.currentTarget.hasAttribute("data-play") ? "mobile_launch" : e === "fs" ? "fullscreen_button" : "play_button";
      playStart = Date.now();
      track("game_start", { game: slug, view: view(), source: src });
      // Heartbeat while the game is open and the tab is visible: real play time per game.
      var beats = 0;
      playTimer = setInterval(function () { if (document.visibilityState === "visible") { beats++; track("game_time", { game: slug, minutes_played: beats, view: view() }); } }, 60000);
      var f = document.createElement("iframe");
      f.src = "/play/" + slug + "/";
      f.title = player.getAttribute("data-title") || "Game";
      f.allow = "autoplay; fullscreen; gamepad; clipboard-write";
      f.setAttribute("allowfullscreen", "");
      stage.appendChild(f);
      $(".cover", player).hidden = true;
      if (mobile()) document.body.classList.add("immersive");
      f.focus();
      var recent = (store.get("recent") || []).filter(function (s) { return s !== slug; });
      recent.unshift(slug);
      store.set("recent", recent.slice(0, 12));
    };
    $(".play", player).addEventListener("click", start);
    // Mobile launch card (vibrant game page): Play opens the game full screen.
    document.querySelectorAll("[data-play]").forEach(function (b) { b.addEventListener("click", start); });
    var fs = $("[data-fullscreen]", player);
    fs && fs.addEventListener("click", function () {
      if (document.fullscreenElement) return document.exitFullscreen();
      start("fs");
      track("game_fullscreen", { game: slug, view: view() });
      (player.requestFullscreen || player.webkitRequestFullscreen || function () {}).call(player);
    });
    var ex = $("[data-exit]", player);
    ex && ex.addEventListener("click", exitImmersive);
    // Warm the connection to the game files while the visitor reads the page.
    $(".play", player).addEventListener("pointerenter", function () {
      if (document.getElementById("pf")) return;
      var l = document.createElement("link");
      l.id = "pf"; l.rel = "prefetch"; l.href = "/play/" + slug + "/";
      document.head.appendChild(l);
    }, { once: true });
  }

  // Leaving the page with a game open: send total time (beacon transport survives unload).
  window.addEventListener("pagehide", function () { if (playStart && window.gtag) window.gtag("event", "game_exit", { game: playSlug, seconds_played: secs(), reason: "left_page", view: view(), transport_type: "beacon" }); playStart = 0; });

  /* ---------- Ad fill per slot (works with GPT loaded by us or by an external ad script) ---------- */
  window.googletag = window.googletag || { cmd: [] };
  googletag.cmd.push(function () {
    googletag.pubads().addEventListener("slotRenderEnded", function (ev) {
      var id = ev.slot.getSlotElementId();
      if (/^gpt_unit_/.test(id)) return; // out-of-page formats (interstitial/rewarded)
      track(ev.isEmpty ? "ad_empty" : "ad_filled", { ad_slot: id, ad_size: ev.size ? ev.size.join("x") : "", page_type: pageType, view: view(), non_interaction: true });
    });
  });

  /* ---------- Recently played row (home) ---------- */
  var recentBox = document.getElementById("recent");
  if (recentBox) {
    var r = (store.get("recent") || []).filter(function (s) { return CFG.games && CFG.games[s]; }).slice(0, 6);
    if (r.length) {
      recentBox.outerHTML = '<h2 class="h">Continue playing</h2>' + r.map(function (s) {
        return '<a class="tile" href="/game/' + s + '/"><img src="/media/' + s + '/icon-192.webp" width="94" height="94" alt="' + CFG.games[s] + '"><span class="t">' + CFG.games[s] + "</span></a>";
      }).join("");
    } else recentBox.remove();
  }

  /* ---------- GPT display ads (loaded after the page is interactive) ---------- */
  var slots = document.querySelectorAll(".ad[data-unit]");
  if (slots.length) {
    var loadAds = function () {
      window.googletag = window.googletag || { cmd: [] };
      var s = document.createElement("script");
      s.async = true; s.src = "https://securepubads.g.doubleclick.net/tag/js/gpt.js"; s.crossOrigin = "anonymous";
      document.head.appendChild(s);
      googletag.cmd.push(function () {
        slots.forEach(function (el, i) {
          if (el.offsetParent === null) return; // hidden on this breakpoint
          var id = el.id || (el.id = "ad-" + i);
          var sizes = JSON.parse(el.getAttribute("data-sizes"));
          googletag.defineSlot(el.getAttribute("data-unit"), sizes, id).addService(googletag.pubads());
        });
        googletag.pubads().enableLazyLoad({ fetchMarginPercent: 200, renderMarginPercent: 100, mobileScaling: 2 });
        googletag.pubads().collapseEmptyDivs();
        googletag.enableServices();
        slots.forEach(function (el) { if (el.offsetParent !== null) googletag.display(el.id); });
      });
    };
    var idle = window.requestIdleCallback || function (cb) { setTimeout(cb, 1200); };
    if (document.readyState === "complete") idle(loadAds);
    else window.addEventListener("load", function () { idle(loadAds); });
  }
});
