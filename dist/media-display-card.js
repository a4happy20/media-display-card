/*
 * Media Display Card — a Home Assistant Lovelace card for displaying/playing sensor data.
 * Copyright (C) 2026  a4happy20 https://github.com/a4happy20
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Jellyfin Media — spotlight card
 *
 * Reads a template sensor whose `episodes` attribute is a list of:
 *   { id, series, season, episode, title, overview, library, episode_art, series_art }
 *
 * Config:
 *   type: custom:media-display-card
 *   entity: sensor.jellyfin_recent_card_data
 *   attribute: episodes
 *   play_script: script.jellyfin_play_episode_custom_card
 *   id_field: episode_id
 *   title: Recently Added
 *   api_key: "..."
 *   rotate_seconds: 8
 *   height: 300
 *   art_mode: poster                 # poster | episode  (default per item)
 *   art_overrides: { youtube: episode }
 *   sort_mode: interleaved            # interleaved (newest across libs) | grouped (by library)
 *   transition: slide                # slide | coverflow | fade  (page change effect)
 *   poster_ratio: "183/274"          # frame ratio when showing poster art
 *   episode_ratio: "16/9"            # frame ratio when showing episode art
 *   layout: full                     # full | half (half = poster-only tile, spans 6/12 grid cols) | grid
 */

/* ============================================================
 * Cross-card rotation sync. Every instance of this card shares
 * this module scope, so cards that set the same `sync_group`
 * advance together off ONE shared clock. Hovering any member
 * pauses the whole group; a dot/swipe/wheel on any member moves
 * the whole group. Members mod by their own list length, so a
 * group stays in step even if the lists differ in size.
 * ============================================================ */
const JFSync = (() => {
  const groups = new Map();
  const grp = (name) => {
    let g = groups.get(name);
    if (!g) { g = { index: 0, seconds: 0, timer: null, members: new Set(), hovered: new Set() }; groups.set(name, g); }
    return g;
  };
  const arm = (g) => {
    if (g.timer || g.seconds <= 0) return;
    g.timer = setInterval(() => {
      if (g.hovered.size || !g.members.size) return;   // paused while any member is hovered
      g.index += 1;
      g.members.forEach((m) => m._syncApply(g.index, true));
    }, g.seconds * 1000);
  };
  const rearm = (g) => {                                // restart the countdown after a manual move
    if (g.timer) { clearInterval(g.timer); g.timer = null; }
    arm(g);
  };
  return {
    join(name, card, seconds) {
      const g = grp(name);
      g.members.add(card);
      if (seconds > 0 && seconds !== g.seconds) {        // (re)set the group cadence
        g.seconds = seconds;
        if (g.timer) { clearInterval(g.timer); g.timer = null; }
      }
      arm(g);
      card._syncApply(g.index, false);                   // snap newcomer to current frame
    },
    leave(name, card) {
      const g = groups.get(name);
      if (!g) return;
      g.members.delete(card);
      g.hovered.delete(card);
      if (!g.members.size && g.timer) { clearInterval(g.timer); g.timer = null; }
    },
    setIndex(name, i) { const g = grp(name); g.index = i;   rearm(g); g.members.forEach((m) => m._syncApply(g.index, true)); },
    step(name, dir)   { const g = grp(name); g.index += dir; rearm(g); g.members.forEach((m) => m._syncApply(g.index, true)); },
    pause(name, card)  { grp(name).hovered.add(card); },
    resume(name, card) { grp(name).hovered.delete(card); },
  };
})();

class MediaDisplayCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) throw new Error("Define 'entity' (the template sensor).");
    this._config = {
      attribute: "episodes",
      play_script: "",
      id_field: "episode_id",
      options_entity: "",      // more-info opens for this entity via the options button
      hide_epline: "false",
      title: "",
      badge_field: "",
      rotate_seconds: 8,
      sync_group: "",
      art_mode: "poster",
      art_overrides: {},
      sort_mode: "interleaved",
      transition: "slide",
      poster_ratio: "183/274",
      episode_ratio: "16/9",
      layout: "full",
      grid_columns: 0,        // grid: fixed column count; 0 = auto from width
      grid_max_columns: 8,
      grid_min_tile: 120,
      font_scale: 1.0,
      accent_color: "",
      title_color: "",
      header_color: "",
      episode_color: "",
      counter_color: "",
      description_color: "",
      show_progress: false,    // resume progress bar on the poster
      progress_color: "",      // blank = fall back to accent color
      background_type: "art",  // art | custom | theme
      background_custom: "",   // custom: any CSS 'background' value; {episode_art} = art
      background_blur: 0,       // custom: layer blur in px
      background_opacity: 100,  // custom: layer opacity 0-100
      ...config,
    };
    this._index = 0;
    this._prevIndex = 0;
    this._built = false;
    this._sig = "";
  }

  // ----- UI editor support -----
  static getConfigElement() {
    return document.createElement("media-display-card-editor");
  }

  static getStubConfig() {
    return {
      entity: "sensor.jellyfin_recent_card_data",
      title: "",
      play_script: "",
      id_field: "episode_id",
      rotate_seconds: 8,
      art_mode: "poster",
      transition: "slide",
      sort_mode: "interleaved",
      layout: "full",
      badge_field: "",
      hide_epline: "false",
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  getCardSize() { return 4; }

  // Sections-view sizing. Rows are ~56px tall with 8px gaps (~64px pitch).
  getGridOptions() {
    const rowPitch = 64;   // 56px cell + 8px gap
    const h = Number(this._config.height) || 375;  // seed only; real size from Layout tab
    const isMobile = window.matchMedia("(max-width:520px)").matches;
    // Mobile renders taller (stacked layout uses h * 1.29).
    const effH = isMobile ? Math.round(h * 1.29) : h;

    if (this._config && this._config.layout === "grid") {
      // grid: full width, height-driven (like 'full'). Real rows (1-3) are
      // measured at runtime; this only reserves the seeded pixel height.
      const rows = Math.max(2, Math.ceil((effH + 8) / rowPitch));
      return { columns: "full", rows: rows, min_rows: 2 };
    }

    if (this._config && this._config.layout === "half") {
      // half stays 6 of 12 columns on all viewports (two side by side).
      const cols = 6;
      if (isMobile) {
        // mobile: default to 4 rows (matches the phone poster proportions)
        return { columns: cols, rows: 4, min_rows: 3, min_columns: 3 };
      }
      // desktop: reserve ratio-correct rows (poster at column width + chrome)
      const widthPx = cols * 30 + (cols - 1) * 8;
      const ratio = String(this._config.poster_ratio || "183/274").split("/");
      const rW = Number(ratio[0]) || 183;
      const rH = Number(ratio[1]) || 274;
      const posterH = widthPx * (rH / rW);
      const chrome = 14 + 24 + 12 + 14 + 14;        // padding + header + gap + dots + padding
      const rows = Math.max(3, Math.round((posterH + chrome + 8) / rowPitch));
      return { columns: cols, rows: rows, min_rows: 3, min_columns: 3 };
    }

    // full (any viewport): full width; reserve the actual rendered pixel height.
    const rows = Math.max(2, Math.ceil((effH + 8) / rowPitch));
    return { columns: "full", rows: rows, min_rows: 2 };
  }

  disconnectedCallback() {
    this._stopRotate();
    const g = this._config && this._config.sync_group;
    if (g) JFSync.leave(g, this);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  _episodes() {
    const st = this._hass && this._hass.states ? this._hass.states[this._config.entity] : null;
    const list = st && st.attributes ? st.attributes[this._config.attribute] : null;
    let arr = Array.isArray(list) ? list.slice() : [];
    const mode = this._config.sort_mode || "interleaved";
    if (mode === "interleaved") {
      arr.sort((a, b) => String(b.added || "").localeCompare(String(a.added || "")));
    } else if (mode === "grouped") {
      const order = {};
      let i = 0;
      arr.forEach((e) => { if (!(e.library in order)) order[e.library] = i++; });
      arr.sort((a, b) => {
        const g = (order[a.library] == null ? 99 : order[a.library]) -
                  (order[b.library] == null ? 99 : order[b.library]);
        return g !== 0 ? g : String(b.added || "").localeCompare(String(a.added || ""));
      });
    }
    return arr;
  }

  _mode(ep) {
    if (!ep) return this._config.art_mode || "poster";
    const overrides = this._config.art_overrides || {};
    return overrides[ep.library] || this._config.art_mode || "poster";
  }

  _artUrl(ep) {
    if (!ep) return "";
    const mode = this._mode(ep);
    let url = mode === "episode"
      ? (ep.episode_art || ep.series_art || "")
      : (ep.series_art || ep.episode_art || "");
    if (this._config.api_key && url && url.indexOf("api_key=") === -1) {
      url += (url.indexOf("?") !== -1 ? "&" : "?") + "api_key=" + this._config.api_key;
    }
    return url;
  }

  _isGrid() {
    return this._config.layout === "grid";
  }

  // grid: derive columns (from width) and rows (from height, clamped 1-3)
  // from the actual rendered card size.
  _gridDims() {
    const card = this.shadowRoot && this.shadowRoot.querySelector("ha-card");
    const w = (card && card.clientWidth)  || 600;
    const h = (card && card.clientHeight) || 375;

    const padW = 28;                          // .content.grid left+right padding
    const chromeH = 14 + 24 + 10 + 14 + 14;   // pad + header + gap + dots + pad
    const availW = Math.max(1, w - padW);
    const availH = Math.max(1, h - chromeH);
    const gap = 10;

    // columns:
    //   grid_columns > 0    -> hard fixed count (ignores width)
    //   else auto: fit tiles of ~grid_min_tile px, capped by grid_max_columns
    const fixed   = Number(this._config.grid_columns) || 0;
    const minTile = Number(this._config.grid_min_tile) || 120;
    const maxCols = Number(this._config.grid_max_columns) || 8;
    let cols = fixed > 0
      ? fixed
      : Math.max(1, Math.round(availW / minTile));
    cols = Math.min(cols, maxCols);

    // rows: driven purely by available HEIGHT so it grows 1 -> 3 as the card is
    // sized up in the layout tab. Tiles then stretch to fill each row (see the
    // .content.grid CSS), so this is a height budget, not a poster fit.
    const targetRowH = 120;   // px per row; lower this to reach 2/3 rows sooner
    const rows = Math.max(1, Math.min(3,
      Math.floor((availH + gap) / (targetRowH + gap))));

    return { cols, rows };
  }

  _perPage() {
    if (!this._isGrid()) return 1;
    const d = this._gridDims();
    return Math.max(1, d.cols * d.rows);
  }

  // navigable positions: pages in grid mode, items otherwise.
  _slots() {
    const len = this._episodes().length;
    if (!this._isGrid()) return len;
    return Math.max(1, Math.ceil(len / this._perPage()));
  }

  _sxe(ep) {
    return "S" + String(ep.season == null ? 0 : ep.season).padStart(2, "0") +
           "E" + String(ep.episode == null ? 0 : ep.episode).padStart(2, "0");
  }

  _canPlay() {
    const s = this._config.play_script;
    return typeof s === "string" && s.trim() !== "";
  }

  _play(ep, wrapEl) {
    if (!ep || !this._canPlay()) return;
    const parts = this._config.play_script.split(".");
    const data = {};
    data[this._config.id_field] = ep.id;
    if (ep.type != null) data.media_type = ep.type;
    if (ep.resume_seconds != null) data.resume_seconds = ep.resume_seconds;
    this._hass.callService(parts[0], parts[1], data);
    const poster = wrapEl || this.shadowRoot.querySelector(".poster-wrap");
    if (poster) {
      poster.classList.add("playing");
      setTimeout(() => poster.classList.remove("playing"), 900);
    }
  }

  _startRotate() {
    this._stopRotate();
    const s = Number(this._config.rotate_seconds) || 0;
    if (s <= 0) return;
    this._timer = setInterval(() => {
      const slots = this._slots();
      if (slots <= 1) return;
      this._go((this._index + 1) % slots);
    }, s * 1000);
  }

  _stopRotate() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ---- rotation sync: these route to the shared clock when sync_group is set,
  //      and fall back to the original per-card behavior when it is not. ----
  _syncStart() {
    const g = this._config.sync_group;
    if (g) JFSync.join(g, this, Number(this._config.rotate_seconds) || 0);
    else this._startRotate();
  }

  // Receive end of the shared clock: paint a group index (mod our own length).
  // No local timer, no re-broadcast.
  _syncApply(absIndex, animate) {
    if (!this.shadowRoot) return;
    const len = this._slots() || 1;
    this._prevIndex = this._index;
    this._index = ((absIndex % len) + len) % len;
    if (this._built) this._paint(!!animate);
  }

  _navTo(i) {                      // absolute jump (dots)
    const g = this._config.sync_group;
    if (g) { JFSync.setIndex(g, i); return; }
    this._go(i); this._startRotate();
  }

  _navStep(dir) {                  // relative step (swipe / wheel)
    const slots = this._slots();
    if (slots <= 1) return;
    const g = this._config.sync_group;
    if (g) { JFSync.step(g, dir); return; }
    this._go((this._index + dir + slots) % slots);
    this._startRotate();
  }

  _hoverPause(on) {
    const g = this._config.sync_group;
    if (g) { on ? JFSync.pause(g, this) : JFSync.resume(g, this); return; }
    on ? this._stopRotate() : this._startRotate();
  }

  _go(newIndex) {
    this._prevIndex = this._index;
    this._index = newIndex;
    this._paint(true);
  }

  _update() {
    if (!this._hass) return;
    const eps = this._episodes();
    if (!this._built) { this._build(); this._built = true; }
    const sig = eps.map((e) => e.id).join(",");
    if (sig !== this._sig) {
      this._sig = sig;
      if (this._index >= this._slots()) this._index = 0;
      this._buildDots(this._slots());
      this._paint(false);
      this._syncStart();
    }
  }

  _buildDots(n) {
    const dots = this.shadowRoot.querySelector(".dots");
    dots.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("button");
      d.className = "dot";
      d.addEventListener("click", (e) => {
        e.stopPropagation();
        this._navTo(i);
      });
      dots.appendChild(d);
    }
  }

  _paint(animate) {
    const eps = this._episodes();
    const root = this.shadowRoot;
    if (this._isGrid()) { this._paintGrid(animate); return; }
    const ep = eps[this._index];
    if (!ep) return;
    const art = this._artUrl(ep);
    const mode = this._mode(ep);

    // background crossfade
    const a = root.querySelector(".bg-art");
    const b = root.querySelector(".bg-art-next");
    const showB = a.classList.contains("shown");
    const target = showB ? a : b;
    const other = showB ? b : a;
    target.style.backgroundImage = art ? 'url("' + art + '")' : "none";
    target.classList.add("active", "shown");
    other.classList.remove("active", "shown");

    // custom background token support: the field's contents become the CSS
    // `background` value. {episode_art} / {series_art} resolve to this item's
    // art and update as the displayed episode changes (all sensors/layouts).
    const bgCustom = root.querySelector(".bg-custom");
    if (bgCustom && this.classList.contains("custom-bg")) {
      const tpl = (this._config.background_custom || "").trim();
      if (tpl && tpl.indexOf("{") !== -1) {
        bgCustom.style.background = tpl
          .split("{episode_art}").join(ep.episode_art || "")
          .split("{series_art}").join(ep.series_art || "");
      }
    }

    // frame sizing depends on art type + viewport:
    //  desktop: height-driven (poster fills row; episode height-capped)
    //  mobile:  width-driven (stacked layout has no fixed row height)
    const wrap = root.querySelector(".poster-wrap");
    const img = root.querySelector(".poster");
    // Half layout (all viewports): poster fills the tile WIDTH; height follows
    // the aspect ratio so it scales up. Episode art contained, poster covers.
    const isHalfLayout = this._config.layout === "half";
    if (isHalfLayout) {
      // All half sizing is handled in CSS (identical on desktop and mobile).
      // Only set art-mode-dependent bits here.
      wrap.style.aspectRatio = (mode === "episode")
        ? this._config.episode_ratio
        : this._config.poster_ratio;
      img.style.objectFit = (mode === "episode") ? "contain" : "cover";
    } else {
    // Column (stacked) mobile layout applies only to full/small tiers.
    // compact/tiny use the horizontal ROW layout, so they take desktop sizing.
    const contentEl = root.querySelector(".content");
    const rowTier = contentEl && (contentEl.classList.contains("compact") ||
                                  contentEl.classList.contains("tiny"));
    const isMobile = window.matchMedia("(max-width:520px)").matches && !rowTier;
    if (mode === "episode") {
      wrap.style.aspectRatio = this._config.episode_ratio;
      wrap.style.height = "auto";
      wrap.style.width = isMobile ? "80%" : "auto";
      wrap.style.maxHeight = isMobile ? "55%" : "50%";
      wrap.style.maxWidth = isMobile ? "none" : "50%";
      wrap.style.alignSelf = "center";
    } else {
      wrap.style.aspectRatio = this._config.poster_ratio;
      wrap.style.height = isMobile ? "auto" : "100%";
      wrap.style.width = isMobile ? "auto" : "auto";
      wrap.style.maxHeight = isMobile ? "55%" : "none";
      wrap.style.maxWidth = isMobile ? "45%" : "50%";
      wrap.style.alignSelf = "center";
    }
    img.style.objectFit = "cover";
    }

    // page-change animation on the stage
    const stage = root.querySelector(".stage");
    if (animate && this._config.transition && this._config.transition !== "none") {
      const dir = this._index >= this._prevIndex ? "fwd" : "rev";
      const cls = "anim-" + this._config.transition + "-" + dir;
      stage.classList.remove(
        "anim-slide-fwd","anim-slide-rev",
        "anim-coverflow-fwd","anim-coverflow-rev",
        "anim-fade-fwd","anim-fade-rev"
      );
      // force reflow so the animation restarts even on rapid changes
      void stage.offsetWidth;
      stage.classList.add(cls);
    }

    root.querySelector(".poster").src = art || "";
    root.querySelector(".series").textContent = ep.series || "";
    root.querySelector(".epline").textContent =
      this._sxe(ep) + (ep.title ? " \u00b7 " + ep.title : "");
    root.querySelector(".summary").textContent = ep.overview || "";

    const badgeEl = root.querySelector(".badge");
    if (badgeEl) {
      const bf = this._config.badge_field;
      const dateBadge = this._config.layout === "upcoming";
      badgeEl.textContent =
        bf ? (ep[bf] || "")
        : dateBadge ? (ep.overview || "Upcoming")
        : "Episode";
    }


    root.querySelectorAll(".dot").forEach((d, i) =>
      d.classList.toggle("active", i === this._index)
    );
    const counter = root.querySelector(".counter");
    if (counter) counter.textContent = (this._index + 1) + " / " + eps.length;

    const prog = root.querySelector(".progress-fill");
    if (prog) {
      const pct = Number(ep.resume_pct);
      if (this._config.show_progress && isFinite(pct) && pct > 0) {
        prog.style.width = Math.min(100, pct) + "%";
        prog.parentElement.style.display = "block";
      } else {
        prog.parentElement.style.display = "none";
      }
    }
  }

  _paintGrid(animate) {
    const root = this.shadowRoot;
    const eps = this._episodes();
    const perPage = this._perPage();
    const slots = this._slots();
    const stage = root.querySelector(".stage");

    if (this._index >= slots) this._index = slots - 1;
    if (this._index < 0) this._index = 0;

    const start = this._index * perPage;
    const items = eps.slice(start, start + perPage);

    // (re)build tiles only when the count changes
    let tiles = stage.querySelectorAll(".poster-wrap");
    if (tiles.length !== perPage) {
      stage.innerHTML = "";
      for (let i = 0; i < perPage; i++) {
        const wrap = document.createElement("div");
        wrap.className = "poster-wrap";
        wrap.innerHTML =
          '<img class="poster" src="" alt="">' +
          '<div class="hint"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>' +
          (this._config.show_progress
            ? '<div class="progress"><div class="progress-fill"></div></div>' : '');
        wrap.addEventListener("click", () => {
          const idx = Number(wrap.dataset.epIndex);
          const list = this._episodes();
          if (isFinite(idx) && list[idx]) this._play(list[idx], wrap);
        });
        stage.appendChild(wrap);
      }
      tiles = stage.querySelectorAll(".poster-wrap");
    }

    // fill each tile (trailing empties on the last page are hidden)
    tiles.forEach((wrap, i) => {
      const ep = items[i];
      const img = wrap.querySelector(".poster");
      if (!ep) {
        wrap.style.visibility = "hidden";
        wrap.dataset.epIndex = "";
        img.src = "";
        return;
      }
      wrap.style.visibility = "visible";
      wrap.dataset.epIndex = String(start + i);
      const mode = this._mode(ep);
      wrap.style.aspectRatio = (mode === "episode")
        ? this._config.episode_ratio : this._config.poster_ratio;
      img.style.objectFit = (mode === "episode") ? "contain" : "cover";
      img.src = this._artUrl(ep) || "";

      const prog = wrap.querySelector(".progress-fill");
      if (prog) {
        const pct = Number(ep.resume_pct);
        if (this._config.show_progress && isFinite(pct) && pct > 0) {
          prog.style.width = Math.min(100, pct) + "%";
          prog.parentElement.style.display = "block";
        } else {
          prog.parentElement.style.display = "none";
        }
      }
    });

    // blurred backdrop from the first item on the page
    const first = items[0];
    const a = root.querySelector(".bg-art");
    const b = root.querySelector(".bg-art-next");
    const showB = a.classList.contains("shown");
    const target = showB ? a : b;
    const other  = showB ? b : a;
    const bgArt = first ? this._artUrl(first) : "";
    target.style.backgroundImage = bgArt ? 'url("' + bgArt + '")' : "none";
    target.classList.add("active", "shown");
    other.classList.remove("active", "shown");

    // custom background token support (grid): no single "current" item here, so
    // pick a random episode and resolve {episode_art}/{series_art} against it.
    // Cache the pick per page so resizes don't reshuffle the image every frame.
    const bgCustom = root.querySelector(".bg-custom");
    if (bgCustom && this.classList.contains("custom-bg")) {
      const tpl = (this._config.background_custom || "").trim();
      if (tpl && tpl.indexOf("{") !== -1 && eps.length) {
        if (this._bgRandPage !== this._index) {
          this._bgRandPage = this._index;
          this._bgRandEp = eps[Math.floor(Math.random() * eps.length)];
        }
        const r = this._bgRandEp || first || {};
        bgCustom.style.background = tpl
          .split("{episode_art}").join(r.episode_art || "")
          .split("{series_art}").join(r.series_art || "");
      }
    }

    // page-change animation on the stage
    if (animate && this._config.transition && this._config.transition !== "none") {
      const dir = this._index >= this._prevIndex ? "fwd" : "rev";
      stage.classList.remove(
        "anim-slide-fwd","anim-slide-rev",
        "anim-coverflow-fwd","anim-coverflow-rev",
        "anim-fade-fwd","anim-fade-rev"
      );
      void stage.offsetWidth;
      stage.classList.add("anim-" + this._config.transition + "-" + dir);
    }

    // dots + counter (page-based)
    root.querySelectorAll(".dot").forEach((d, i) =>
      d.classList.toggle("active", i === this._index)
    );
    const counter = root.querySelector(".counter");
    if (counter) counter.textContent = (this._index + 1) + " / " + slots;
  }

  _build() {
    const h = Number(this._config.height) || 375;  // seed only; real size from Layout tab
    const tier = h < 300 ? "tiny" : (h < 375 ? "small" : "full");
    const isHalf = this._config.layout === "half";
    const isUpcoming = this._config.layout === "upcoming";
    const isGrid = this._config.layout === "grid";
    const fs = Number(this._config.font_scale) || 1;
    const c = this._config;
    const col = (v, d) => {
      if (v == null) return d;
      if (Array.isArray(v)) return v.length > 3 ? `rgba(${v.join(",")})` : `rgb(${v.join(",")})`;
      const s = String(v).trim();
      if (!s || /^___.*___$/.test(s)) return d;                   // empty or HA placeholder
      if (s === "primary") return "var(--primary-color)";
      if (/^(#|rgb|hsl)/i.test(s)) return s;
      if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s)) return "#" + s;  // bare hex
      if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/.test(s)) return `rgb(${s})`;
      return `var(--${s}-color, ${d})`;                            // named theme color
    };
    
    const accent = col(c.accent_color, "#7aa2ff");
    const cTitle = col(c.title_color, "var(--primary-text-color,#f0f1f4)");
    const cHead  = col(c.header_color, "#9aa0ab");
    const cEp    = col(c.episode_color, "#9aa0ab");
    const cCount = col(c.counter_color, "#6b7078");
    const cDesc  = col(c.description_color, "#6b7078");
    const cProg  = col(c.progress_color, accent);
    const bt = c.background_type || "art";
    const bg = "var(--ha-card-background, var(--card-background-color,#14161b))";
    const bgCustomVal = (c.background_custom || "").trim();
    const bgCustomHasToken = bgCustomVal.indexOf("{") !== -1;
    let bgBlur = Number(c.background_blur);
    if (!isFinite(bgBlur) || bgBlur < 0) bgBlur = 0;
    let bgOpacity = Number(c.background_opacity);
    if (!isFinite(bgOpacity)) bgOpacity = 100;
    bgOpacity = Math.max(0, Math.min(100, bgOpacity)) / 100;
    const showHeader = this._config.title !== "" && this._config.title != null;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --accent:${accent};
          --bg:${bg};
          --fs:${fs};
          --c-title:${cTitle};
          --c-head:${cHead};
          --c-ep:${cEp};
          --c-count:${cCount};
          --c-desc:${cDesc};
          display:block;
          height:100%;
        }
        :host(.half-host) { height:100%; }

        :host(.no-hero) .bg-art,
        :host(.no-hero) .bg-art-next,
        :host(.no-hero) .overlay {
          display:none;
        }
        ha-card {
          position:relative; height:100%; min-height:0; overflow:hidden;
          border-radius: var(--ha-card-border-radius,14px);
          background:var(--bg); border:1px solid rgba(255,255,255,.06);
        }
        .bg-art,.bg-art-next {
          position:absolute; inset:0; background-size:cover; background-position:center;
          filter: blur(22px) brightness(.32); transform:scale(1.12);
          opacity:0; transition:opacity .8s ease;
        }
        .bg-art.active,.bg-art-next.active { opacity:1; }
        .overlay {
          position:absolute; inset:0;
          background:linear-gradient(135deg,rgba(0,0,0,.72),rgba(0,0,0,.42) 50%,rgba(0,0,0,.72));
        }
        .bg-custom {
          position:absolute; inset:0; display:none;
          background:transparent;
        }
        :host(.custom-bg) .bg-custom { display:block; }
        .content {
          position:absolute; inset:0; z-index:1; padding:20px;
          display:flex; flex-direction:column;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        }
        .content.hide-epline .epline { display:none; }
        .header { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
        .htitle { flex:1; font-size:calc(14px * var(--fs)); font-weight:700; letter-spacing:.09em;
          text-transform:uppercase; color:var(--c-head); }
        .counter { font-size:13px; color:var(--c-count); font-variant-numeric:tabular-nums; }
        .main { display:flex; gap:20px; flex:1; min-height:0; }
        .stage { display:flex; gap:20px; flex:1; min-height:0; width:100%; }
        /* ---- non-playable (no play_script): drop the play cues ---- */
        .content.no-play .poster-wrap { cursor:default; }
        .content.no-play .poster-wrap .hint { display:none; }
        .content.no-play .poster-wrap:hover {
          transform:none; box-shadow:0 8px 26px rgba(0,0,0,.5);
        }
        .poster-wrap {
          flex-shrink:0; aspect-ratio:183/274; height:100%;
          border-radius:8px; overflow:hidden; background:#0e0f13;
          box-shadow:0 8px 26px rgba(0,0,0,.5); cursor:pointer;
          transition:transform .2s ease, box-shadow .2s ease; position:relative;
        }
        .poster-wrap:hover { transform:translateY(-3px) scale(1.015); box-shadow:0 14px 34px rgba(0,0,0,.6); }
        .poster { width:100%; height:100%; object-fit:cover; display:block; }
        .poster-wrap .hint {
          position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          opacity:0; transition:opacity .2s ease; background:rgba(10,11,14,.35);
        }
        .poster-wrap:hover .hint { opacity:1; }
        .hint svg { width:46px; height:46px; fill:#fff; filter:drop-shadow(0 2px 6px rgba(0,0,0,.6)); }
        .poster-wrap.playing { animation:pulse .9s ease; }
        .poster-wrap .progress {
          position:absolute; left:0; right:0; bottom:0; height:4px;
          background:rgba(0,0,0,.55); z-index:2; display:none;
        }
        .poster-wrap .progress-fill {
          height:100%; width:0%; background:${cProg};
          transition:width .3s ease;
        }
        @keyframes pulse {
          0% { box-shadow:0 0 0 0 rgba(122,162,255,.7); }
          100% { box-shadow:0 0 0 20px rgba(122,162,255,0); }
        }
        .info { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:8px; }
        .badge {
          width:fit-content; font-size:calc(12px * var(--fs)); font-weight:700; letter-spacing:.1em;
          text-transform:uppercase; padding:4px 11px; border-radius:4px;
          background:rgba(122,162,255,.15); color:var(--accent);
        }
        .series {
          font-size:calc(27px * var(--fs)); font-weight:800; color:var(--c-title); line-height:1.50;
          overflow:hidden; text-overflow:ellipsis;
          display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
        }
        .epline { font-size:calc(16px * var(--fs)); color:var(--c-ep); line-height:1.3;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .summary {
          font-size:calc(15px * var(--fs)); color:var(--c-desc); line-height:1.5; margin-top:2px;
          overflow:hidden; text-overflow:ellipsis;
          display:-webkit-box; -webkit-line-clamp:5; -webkit-box-orient:vertical;
        }

        /* ---- desktop height-tier clamps ('full' is the base, untouched) ---- */
        .content.small .series, .content.compact .series { -webkit-line-clamp:1; }
        .content.small .summary, .content.compact .summary { -webkit-line-clamp:2; }
        .content.tiny .series { -webkit-line-clamp:1; }
        .content.tiny .summary { display:none; }
        .content.tiny .info { transform:scale(0.9); gap:3px; }

        /* ---- half layout: title + centered poster (ratio-sized) + dots below ---- */
        .content.half { padding:14px; }
        .content.half .header { flex-shrink:0; margin-bottom:10px; }
        .content.half .footer { margin-top:12px; }
        .content.half .main { flex:1 1 auto; min-height:0; }
        .content.half .info { display:none; }
        .content.half .stage {
          gap:0; align-items:center; justify-content:center;
        }
        .content.half .poster-wrap {
          height:100%; width:auto; max-width:100%;
          align-self:center;
        }
        ha-card.half-card { height:100%; min-height:0; }

        /* ---- grid layout: half-style poster tiles in a responsive grid ---- */
        .content.grid { padding:14px; }
        .content.grid .header { flex-shrink:0; margin-bottom:10px; }
        .content.grid .footer { margin-top:12px; }
        .content.grid .main { flex:1 1 auto; min-height:0; }
        .content.grid .info { display:none; }
        .content.grid .stage {
          display:grid;
          grid-template-columns:repeat(var(--cols,1), 1fr);
          grid-template-rows:repeat(var(--rows,1), 1fr);
          gap:10px; height:100%; min-height:0;
          justify-items:center;
        }
        .content.grid .poster-wrap {
          height:100%; width:auto; max-width:100%;
          aspect-ratio:183/274;   /* overridden per-tile inline from art mode */
        }
        ha-card.grid-card { height:100%; min-height:0; }
        :host(.grid-host) { height:100%; }

        /* ---- upcoming layout: date-pill badge, no synopsis, non-playable ----
           Sizing is deliberately NOT set here — series clamps, info gap, poster
           sizing, and every mobile rule are inherited from the 'full' tiers so
           .content.small / .tiny / .compact and the @media block all still win. */
        .content.upcoming .info .summary { display:none; }   /* extra class = higher specificity so tier rules can't un-hide it */
        .content.upcoming .badge {
          text-transform:none; font-weight:800; letter-spacing:.02em;
          padding:6px 14px; border-radius:999px;
          background:rgba(122,162,255,.18); color:var(--accent);
        }

        .footer {
          display:flex; align-items:center; justify-content:center;
          margin-top:14px; flex-shrink:0; position:relative;
        }
        .opts {
          position:absolute; right:0; top:0; bottom:0;
          margin-top:auto; margin-bottom:auto;
          width:26px; height:26px;
          display:flex; align-items:center; justify-content:center;
          background:none; border:none; padding:0; cursor:pointer;
          color:var(--c-count); border-radius:7px;
          transform:rotate(90deg);
          transition:color .2s ease, background .2s ease;
        }
        .opts:hover { color:var(--c-count); background:rgba(255,255,255,.12); }
        .opts svg { width:18px; height:18px; fill:currentColor; }
        .dots { display:flex; justify-content:center; gap:6px; flex-shrink:0; }
        .dot {
          width:6px; height:6px; border-radius:50%; border:none; padding:0; cursor:pointer;
          background:rgba(255,255,255,.18); transition:all .3s ease;
        }
        .dot.active { width:18px; border-radius:3px; background:var(--accent);
          box-shadow:0 0 6px rgba(122,162,255,.45); }

        /* ---- page transition animations ---- */
        .anim-slide-fwd { animation: slideFwd .38s ease; }
        .anim-slide-rev { animation: slideRev .38s ease; }
        @keyframes slideFwd { from { opacity:.2; transform: translateX(24px); } to { opacity:1; transform:none; } }
        @keyframes slideRev { from { opacity:.2; transform: translateX(-24px); } to { opacity:1; transform:none; } }
        .anim-fade-fwd, .anim-fade-rev { animation: fadeIn .45s ease; }
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        .anim-coverflow-fwd { animation: coverFwd .5s cubic-bezier(.2,.7,.2,1); transform-origin:left center; }
        .anim-coverflow-rev { animation: coverRev .5s cubic-bezier(.2,.7,.2,1); transform-origin:right center; }
        @keyframes coverFwd {
          from { opacity:.15; transform: perspective(900px) rotateY(18deg) translateX(40px) scale(.94); }
          to   { opacity:1;  transform: perspective(900px) rotateY(0) translateX(0) scale(1); }
        }
        @keyframes coverRev {
          from { opacity:.15; transform: perspective(900px) rotateY(-18deg) translateX(-40px) scale(.94); }
          to   { opacity:1;  transform: perspective(900px) rotateY(0) translateX(0) scale(1); }
        }

        /* ---- mobile ---- */
        @media (max-width:520px) {
          .content {
            position:absolute; inset:0;         /* fill the grid-driven card height */
          }
          .main, .stage {
            flex-direction:column;
            align-items:stretch;
            gap:12px;
            min-height:0;                        /* allow children to shrink, not overflow */
          }
          .stage > .poster-wrap {
            flex:0 1 auto; min-height:0;         /* poster shrinks with the card */
          }
          .info {
            width:100%; min-width:0;
            align-items:flex-start; text-align:left;
            flex:1; min-height:0;                /* take remaining space, clamp within */
          }
          .badge { margin:0; align-self:flex-start; flex-shrink:0; }
          .series {
            font-size:calc(19px * var(--fs));
            line-height:1.3;
            height:calc(1.3em * 2);              /* reserve exactly 2 lines always */
            -webkit-line-clamp:2;
            display:-webkit-box; -webkit-box-orient:vertical;
            overflow:hidden; text-overflow:ellipsis;
            flex-shrink:0;
          }
          .epline {
            font-size:calc(13px * var(--fs)); white-space:nowrap;
            overflow:hidden; text-overflow:ellipsis; max-width:100%;
            flex-shrink:0;
          }
          .summary {
            font-size:calc(13px * var(--fs));
            line-height:1.4;
            -webkit-line-clamp:6;
            display:-webkit-box; -webkit-box-orient:vertical;
            overflow:hidden; text-overflow:ellipsis;
            flex:1 1 0; min-height:0;
            max-height:calc(1.4em * 6);          /* hard cap at 6 lines */
          }
          .footer { margin-top:15px; }

          /* small (mobile, ~6 rows): stack layout (like full), clamp 1, no summary */
          .content.small .summary { display:none; }
          .content.small .series {
            height:auto;
            -webkit-line-clamp:1;
          }
          .content.small .epline { white-space:nowrap; }
          .content.small .poster-wrap { transform:scale(1.1) translateY(4%); }
          .content.small .footer { margin-top: 15px;}

          /* compact + tiny (mobile): desktop-style ROW layout (image left, text right) */
          .content.compact .main, .content.compact .stage,
          .content.tiny .main, .content.tiny .stage {
            flex-direction:row;
            align-items:stretch;
          }
          .content.compact .info,
          .content.tiny .info {
            width:auto; align-items:flex-start; text-align:left;
            justify-content:center;
            transform:scale(0.9);
            gap:8px;
          }
          .content.compact .series,
          .content.tiny .series {
            font-size:calc(19px * var(--fs)); line-height:1.3;
            height:auto;
            -webkit-line-clamp:1;
          }
          .content.compact .epline,
          .content.tiny .epline {
            white-space:nowrap;
          }
          /* compact (~4-5 rows): summary visible, clamp 2 */
          .content.compact .summary {
            display:-webkit-box; -webkit-line-clamp:2;
          }
          /* tiny (<4 rows): no summary */
          .content.tiny .summary { display:none; }

          /* half stays the compact title + centered-poster + dots tile on mobile */
          .content.half { padding:14px; }
          .content.half .info { display:none; }
          .content.half .main {
            flex-direction:column;
            align-items:stretch;
            flex:1; min-height:0;
          }
          .content.half .stage {
            flex-direction:row;
            align-items:center; justify-content:center;
            flex:1; min-height:0;
          }
          .content.half .poster-wrap {
            height:100%; width:auto; max-width:100%;
            align-self:center; transform:none;
          }
          .content.half .series, .content.half .epline { }
        }
        @media (prefers-reduced-motion: reduce) {
          .bg-art,.bg-art-next,.poster-wrap { transition:none; }
          .poster-wrap.playing,
          .anim-slide-fwd,.anim-slide-rev,
          .anim-fade-fwd,.anim-fade-rev,
          .anim-coverflow-fwd,.anim-coverflow-rev { animation:none; }
        }
      </style>
      <ha-card>
        <div class="bg-art"></div>
        <div class="bg-art-next"></div>
        <div class="overlay"></div>
        <div class="bg-custom"></div>
        <div class="content ${tier}${isHalf ? ' half' : ''}${isUpcoming ? ' upcoming' : ''}${isGrid ? ' grid' : ''}${(this._config.hide_epline === true || this._config.hide_epline === "true") ? ' hide-epline' : ''}${this._canPlay() ? '' : ' no-play'}">
          ${showHeader ? `
          <div class="header">
            <span class="htitle">${this._config.title}</span>
            <span class="counter"></span>
          </div>` : ``}
          <div class="main">
            <div class="stage">
              <div class="poster-wrap">
                <img class="poster" src="" alt="">
                <div class="hint"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
                ${c.show_progress ? '<div class="progress"><div class="progress-fill"></div></div>' : ''}
              </div>
              <div class="info">
                <span class="badge">Episode</span>
                <div class="series">Loading\u2026</div>
                <div class="epline"></div>
                <div class="summary"></div>
              </div>
            </div>
          </div>
          <div class="footer">
            <div class="dots"></div>
            ${c.options_entity
              ? `<button class="opts" title="Options" aria-label="Options"><svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>`
              : ``}
          </div>
        </div>
      </ha-card>
    `;

    if (isHalf) {
      this.classList.add("half-host");
      this.shadowRoot.querySelector("ha-card").classList.add("half-card");
    } else if (isGrid) {
      this.classList.add("grid-host");
      const card = this.shadowRoot.querySelector("ha-card");
      card.classList.add("grid-card");
      const content = this.shadowRoot.querySelector(".content");
      this._applyGrid = () => {
        const d = this._gridDims();
        content.style.setProperty("--cols", d.cols);
        content.style.setProperty("--rows", d.rows);
        const perPage = Math.max(1, d.cols * d.rows);
        if (perPage !== this._perPageCur) {
          this._perPageCur = perPage;
          const slots = this._slots();
          if (this._index >= slots) this._index = slots - 1;
          this._buildDots(slots);
        }
        this._paint(false);
      };
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this._applyGrid());
        this._ro.observe(card);
      }
      this._applyGrid();
    } else {
      // Full layout: tier follows the ACTUAL rendered height (grid-driven),
      // so section resizing re-tiers the card live.
      const content = this.shadowRoot.querySelector(".content");
      const card = this.shadowRoot.querySelector("ha-card");
      this._applyTier = () => {
        const ph = card.clientHeight || h;
        const mobile = window.matchMedia("(max-width:520px)").matches;
        let t;
        if (mobile) {
          // Mobile (stacked needs more height): 4 tiers by row count (~64px pitch)
          //  full >= ~430px (7-8 rows), small >= ~360px (6 rows),
          //  compact >= ~240px (4-5 rows), tiny < ~240px (<=3 rows)
          t = ph < 240 ? "tiny"
            : (ph < 360 ? "compact"
            : (ph < 430 ? "small" : "full"));
        } else {
          // Desktop (side-by-side, less height needed): full at 6+ rows.
          //  full >= ~372px, small >= ~297px, tiny < ~297px
          t = ph < 297 ? "tiny" : (ph < 372 ? "small" : "full");
        }
        if (content.classList.contains(t)) return;
        content.classList.remove("tiny", "small", "compact", "full");
        content.classList.add(t);
        // re-run sizing so the poster frame matches the new tier
        this._paint(false);
      };
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this._applyTier());
        this._ro.observe(card);
      }
      this._applyTier();
    }

    if (!isGrid) {
      this.shadowRoot.querySelector(".poster-wrap").addEventListener("click", () => {
        const eps = this._episodes();
        this._play(eps[this._index]);
      });
    }

    const optsBtn = this.shadowRoot.querySelector(".opts");
    if (optsBtn) {
      optsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const entityId = this._config.options_entity;
        if (!entityId) return;
        const ev = new Event("hass-more-info", { bubbles: true, composed: true });
        ev.detail = { entityId };
        this.dispatchEvent(ev);
      });
    }

    const card = this.shadowRoot.querySelector("ha-card");
    card.addEventListener("mouseenter", () => this._hoverPause(true));
    card.addEventListener("mouseleave", () => this._hoverPause(false));

    // touch swipe navigation
    const swipeZone = this.shadowRoot.querySelector(".content");
    let sx = 0, sy = 0;
    swipeZone.addEventListener("touchstart", (e) => {
      sx = e.changedTouches[0].screenX;
      sy = e.changedTouches[0].screenY;
    }, { passive: true });
    swipeZone.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].screenX - sx;
      const dy = e.changedTouches[0].screenY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        this._navStep(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    // mouse wheel / trackpad horizontal navigation
    let wheelAccum = 0, wheelLock = false;
    swipeZone.addEventListener("wheel", (e) => {
      const eps = this._episodes();
      if (eps.length < 2) return;
      // horizontal intent only: trackpad deltaX, or Shift+wheel on a plain mouse
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        ? e.deltaX
        : (e.shiftKey ? e.deltaY : 0);
      if (!dx) return;              // vertical scroll → let the page handle it
      e.preventDefault();          // we're navigating; don't scroll the page
      if (wheelLock) return;
      wheelAccum += dx;
      if (Math.abs(wheelAccum) >= 40) {
        this._navStep(wheelAccum > 0 ? 1 : -1);
        wheelAccum = 0;
        wheelLock = true;
        setTimeout(() => { wheelLock = false; }, 350);
      }
    }, { passive: false });

    this.classList.toggle("no-hero", bt !== "art");
    this.classList.toggle("custom-bg", bt === "custom");
    if (bt === "custom") {
      const el = this.shadowRoot.querySelector(".bg-custom");
      if (el) {
        if (!bgCustomHasToken) el.style.background = bgCustomVal || "transparent";
        el.style.filter = bgBlur > 0 ? "blur(" + bgBlur + "px)" : "none";
        // over-scale when blurred so blurred edges don't reveal transparent gaps
        el.style.transform = bgBlur > 0 ? "scale(1.12)" : "none";
        el.style.opacity = String(bgOpacity);
      }
    }
  }
}

customElements.define("media-display-card", MediaDisplayCard);

/* ============================================================
 * Config editor — renders ha-form. Reads the selected sensor's
 * `episodes` attribute to discover libraries for art_overrides.
 * ============================================================ */
class MediaDisplayCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
    this._renderOverrides();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._refreshLibrarySuggestions();
  }

  // distinct library keys present in the selected sensor's episodes
  _libraries() {
    try {
      const ent = this._config.entity;
      const attr = this._config.attribute || "episodes";
      const list = this._hass && ent && this._hass.states[ent]
        ? this._hass.states[ent].attributes[attr] : null;
      if (!Array.isArray(list)) return [];
      const seen = [];
      // 'nextup' is a synthetic tag (NextUp is cross-library, no per-item library),
      // so it isn't a meaningful art-override target — skip it.
      const skip = ["nextup"];
      for (const e of list) {
        if (e && e.library && skip.indexOf(e.library) === -1 &&
            seen.indexOf(e.library) === -1) seen.push(e.library);
      }
      return seen;
    } catch (e) {
      return [];
    }
  }

  _artOptions() {
    return [
      { value: "poster", label: "Poster" },
      { value: "episode", label: "Episode" },
    ];
  }

  _schema() {
    const art = this._artOptions();
    return [
      { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
      { name: "title", selector: { text: {} } },
      { name: "play_script", selector: { entity: { domain: "script" } } },
      { name: "id_field", selector: { text: {} } },
      { name: "options_entity", selector: { entity: {} } },
      {
        type: "grid", name: "", schema: [
          { name: "art_mode", selector: { select: { mode: "dropdown", options: art } } },
          { name: "layout", selector: { select: { mode: "dropdown", options: [
            { value: "full", label: "Full" }, { value: "half", label: "Half" },
            { value: "upcoming", label: "Upcoming" }, { value: "grid", label: "Grid" },
          ] } } },
          { name: "badge_field", selector: { text: {} } },
          { name: "hide_epline", selector: { select: {mode: "dropdown", options: [
            { value: "true", label: "True" },
            { value: "false", label: "False" },
          ] } } },
          { name: "transition", selector: { select: { mode: "dropdown", options: [
            { value: "slide", label: "Slide" },
            { value: "coverflow", label: "Coverflow (page turn)" },
            { value: "fade", label: "Fade" },
          ] } } },
          { name: "sort_mode", selector: { select: { mode: "dropdown", options: [
            { value: "interleaved", label: "Interleaved (newest across libraries)" },
            { value: "grouped", label: "Grouped (by library)" },
          ] } } },
        ],
      },
      ...(this._config.layout === "grid" ? [{
        type: "grid", name: "", schema: [
          { name: "grid_columns",     selector: { number: { min: 0, max: 12, step: 1, mode: "box" } } },
          { name: "grid_max_columns", selector: { number: { min: 1, max: 12, step: 1, mode: "box" } } },
          { name: "grid_min_tile",    selector: { number: { min: 60, max: 400, step: 5, mode: "box", unit_of_measurement: "px" } } },
        ],
      }] : []),
      {
        type: "grid", name: "", schema: [
          { name: "rotate_seconds", selector: { number: { min: 0, max: 120, step: 1, mode: "box", unit_of_measurement: "s" } } },
          { name: "font_scale", selector: { number: { min: 0.5, max: 2, step: 0.05, mode: "box" } } },
        ],
      },
      { name: "show_progress", selector: { boolean: {} } },
      {
        type: "grid", name: "", schema: [
          { name: "accent_color",      selector: { text: {} } },
          { name: "title_color",       selector: { text: {} } },
          { name: "header_color",      selector: { text: {} } },
          { name: "episode_color",     selector: { text: {} } },
          { name: "counter_color",     selector: { text: {} } },
          { name: "description_color", selector: { text: {} } },
          { name: "progress_color",    selector: { text: {} } },
          { name: "background_type", selector: { select: { mode: "dropdown", options: [
            { value: "art",    label: "Blurred artwork" },
            { value: "custom", label: "Custom (CSS background)" },
            { value: "theme",  label: "Theme default" },
          ] } } },
        ],
      },
      { name: "background_custom", selector: { text: {} } },
      {
        type: "grid", name: "", schema: [
          { name: "background_blur", selector: { number: { min: 0, max: 50, step: 1, mode: "box", unit_of_measurement: "px" } } },
          { name: "background_opacity", selector: { number: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "%" } } },
        ],
      },
      { name: "sync_group", selector: { text: {} } },
    ];
  }

  _label(s) {
    const m = {
      entity: "Entity (episodes sensor)", title: "Title",
      play_script: "Play script", id_field: "ID field",
      options_entity: "Options button entity (opens more-info)",
      art_mode: "Art mode", layout: "Layout", transition: "Transition",
      badge_field: "Badge type from sensor. (Example: library)", hide_epline: "Hide the episode line",
      sort_mode: "Sort mode", rotate_seconds: "Rotate seconds",
      grid_columns: "Grid columns (0 = auto)",
      grid_max_columns: "Grid max columns (auto cap)",
      grid_min_tile: "Grid min tile width",
      font_scale: "Font scale",
      accent_color: "Accent color", title_color: "Title color",
      header_color: "Header color", episode_color: "Episode text color",
      counter_color: "Counter color", description_color: "Description color",
      show_progress: "Show resume progress bar", progress_color: "Progress bar color",
      background_type: "Background type",
      background_custom: 'background: url("{episode_art}")',
      background_blur: "Background blur", background_opacity: "Background opacity",
      sync_group: "Sync group (match on cards to link rotation)",
    };
    return m[s.name] || s.name;
  }

  _emit(cfg) {
    this._config = cfg;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: cfg }, bubbles: true, composed: true,
    }));
    this._renderOverrides();
  }

  // ---- art_overrides custom UI (text library + poster/episode dropdown + add/remove) ----
  _renderOverrides() {
    if (!this._ovWrap) return;
    const ov = this._config.art_overrides || {};
    const libs = this._libraries();               // suggestions from the sensor
    const rows = Object.keys(ov);

    const prevLibEl = this._ovWrap.querySelector(".jf-add-lib");
    const prevModeEl = this._ovWrap.querySelector(".jf-add-mode");
    const prevName = prevLibEl ? prevLibEl.value : "";
    const prevMode = prevModeEl ? prevModeEl.value : "poster";

    this._ovWrap.innerHTML = "";

    const heading = document.createElement("div");
    heading.textContent = "Art overrides (per library)";
    heading.style.cssText = "font-weight:600;margin:14px 0 6px;font-size:14px;";
    this._ovWrap.appendChild(heading);

    rows.forEach((lib) => {
      this._ovWrap.appendChild(this._overrideRow(lib, ov[lib], libs));
    });

    // add control
    const addBar = document.createElement("div");
    addBar.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";
    const newLib = document.createElement("input");
    newLib.type = "text";
    newLib.className = "jf-add-lib";
    newLib.placeholder = "library name (e.g. youtube)";
    newLib.setAttribute("list", "jf-lib-suggestions");
    newLib.style.cssText = "flex:1;padding:8px;border-radius:6px;border:1px solid var(--divider-color,#444);background:var(--card-background-color,#1c1c1c);color:var(--primary-text-color,#eee);";
    newLib.value = prevName;
    const dl = document.createElement("datalist");
    dl.id = "jf-lib-suggestions";
    libs.forEach((l) => { const o = document.createElement("option"); o.value = l; dl.appendChild(o); });
    const newMode = document.createElement("select");
    newMode.className = "jf-add-mode";
    ["poster", "episode"].forEach((v) => {
      const o = document.createElement("option"); o.value = v; o.textContent = v; newMode.appendChild(o);
    });
    newMode.value = prevMode;
    newMode.style.cssText = "padding:8px;border-radius:6px;border:1px solid var(--divider-color,#444);background:var(--card-background-color,#1c1c1c);color:var(--primary-text-color,#eee);";
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    addBtn.style.cssText = "padding:8px 14px;border-radius:6px;border:none;cursor:pointer;background:var(--primary-color,#3391ff);color:#fff;font-weight:600;";
    addBtn.addEventListener("click", () => {
      const name = (newLib.value || "").trim();
      if (!name) return;
      const next = { ...(this._config.art_overrides || {}) };
      next[name] = newMode.value;
      newLib.value = "";
      newMode.value = "poster";
      this._emit({ ...this._config, art_overrides: next });
    });
    addBar.appendChild(newLib);
    addBar.appendChild(dl);
    addBar.appendChild(newMode);
    addBar.appendChild(addBtn);
    this._ovWrap.appendChild(addBar);
  }

  _overrideRow(lib, mode, libs) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;";
    const name = document.createElement("input");
    name.type = "text";
    name.value = lib;
    name.style.cssText = "flex:1;padding:8px;border-radius:6px;border:1px solid var(--divider-color,#444);background:var(--card-background-color,#1c1c1c);color:var(--primary-text-color,#eee);";
    const sel = document.createElement("select");
    ["poster", "episode"].forEach((v) => {
      const o = document.createElement("option"); o.value = v; o.textContent = v;
      if (v === mode) o.selected = true; sel.appendChild(o);
    });
    sel.style.cssText = "padding:8px;border-radius:6px;border:1px solid var(--divider-color,#444);background:var(--card-background-color,#1c1c1c);color:var(--primary-text-color,#eee);";
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Remove";
    del.style.cssText = "padding:8px 10px;border-radius:6px;border:none;cursor:pointer;background:var(--error-color,#c0392b);color:#fff;";

    const commit = (newName, newMode, remove) => {
      const next = { ...(this._config.art_overrides || {}) };
      delete next[lib];
      if (!remove) {
        const key = (newName || "").trim() || lib;
        next[key] = newMode;
      }
      this._emit({ ...this._config, art_overrides: next });
    };
    name.addEventListener("change", () => commit(name.value, sel.value, false));
    sel.addEventListener("change", () => commit(name.value, sel.value, false));
    del.addEventListener("click", () => commit(lib, sel.value, true));

    row.appendChild(name);
    row.appendChild(sel);
    row.appendChild(del);
    return row;
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        // merge ha-form fields with our custom art_overrides (ha-form doesn't own it)
        const merged = { ...ev.detail.value };
        for (const k in merged) if (/^___.*___$/.test(String(merged[k]))) delete merged[k];   // drop placeholders
        if (this._config.art_overrides) merged.art_overrides = this._config.art_overrides;
        this._emit(merged);
      });
      this.appendChild(this._form);
      this._ovWrap = document.createElement("div");
      this.appendChild(this._ovWrap);
      this._renderOverrides();
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = this._schema();
    this._form.computeLabel = (s) => this._label(s);
  }

  _refreshLibrarySuggestions() {
    if (!this._ovWrap) return;
    const dl = this._ovWrap.querySelector("#jf-lib-suggestions");
    if (!dl) return;
    dl.innerHTML = "";
    this._libraries().forEach((l) => {
      const o = document.createElement("option");
      o.value = l;
      dl.appendChild(o);
    });
  }
}
customElements.define("media-display-card-editor", MediaDisplayCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "media-display-card",
  name: "Media Display Card",
  description: "Spotlight of sensor data with tap-to-play.",
  preview: true,
  documentationURL: "https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card",
});