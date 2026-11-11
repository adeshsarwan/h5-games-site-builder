/* PlayPop portal runtime: search, play, fullscreen, recently played, GPT ads. Kept tiny on purpose. */
(function () {
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
  var PLACES = [[".search", "search"], [".gp-strip", "similar_games"], [".gp-trend", "trending"], [".gp-launch", "launch_card"], [".vhero", "home_hero"],
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
})();
