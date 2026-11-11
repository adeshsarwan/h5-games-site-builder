/* PlayPop portal runtime: search, play, fullscreen, recently played, GPT ads. Kept tiny on purpose. */
(function () {
  "use strict";
  var CFG = window.__SITE__ || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------- Search ---------- */
  var overlay = $(".search"), input = overlay && $("input", overlay), res = overlay && $(".res", overlay), index = null;
  function openSearch() {
    if (!overlay) return;
    overlay.classList.add("open");
    input.focus();
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
  function exitImmersive() {
    if (!document.body.classList.contains("immersive")) return;
    document.body.classList.remove("immersive");
    var f = player && $("iframe", player);
    if (f) f.remove();
    var c = player && $(".cover", player);
    if (c) c.hidden = false;
  }
  if (player) {
    var slug = player.getAttribute("data-slug");
    var stage = $(".stage", player);
    var start = function () {
      if ($("iframe", stage)) return;
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
      start();
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
