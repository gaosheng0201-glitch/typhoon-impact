/* 台风追踪 MVP — observed track + multi-agency forecast comparison */

const INTENSITY_COLORS = {
  "热带低压": "#52c41a",
  "热带风暴": "#1677ff",
  "强热带风暴": "#fadb14",
  "台风": "#fa8c16",
  "强台风": "#eb2f96",
  "超强台风": "#f5222d",
};
const INTENSITY_FALLBACK = "#8c8c8c";

const AGENCY_COLORS = {
  "中国": "#f5222d",
  "日本": "#a855f7",
  "美国": "#4c8dff",
  "中国台湾": "#13c2c2",
  "中国香港": "#fa8c16",
};
const AGENCY_FALLBACK = "#d9d9d9";

const REFRESH_MS = 5 * 60 * 1000;

const state = {
  index: null,
  selected: null,       // tfid
  storm: null,          // loaded typhoon detail
  hiddenAgencies: new Set(),
};

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO | 数据：温州台风网",
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
  },
  center: [124, 24],
  zoom: 4,
});

/* 数据加载不等地图：底图瓦片慢或被墙时，列表/面板照常可用 */
map.on("load", () => {
  addLayers();
  if (state.storm) {
    draw();
    fitToStorm();
  }
});

ImpactPanel.init();
refresh();
setInterval(refresh, REFRESH_MS);

/* ---------- 左侧面板收缩 ---------- */

const panelEl = document.getElementById("panel");
document.getElementById("panel-head").onclick = () => panelEl.classList.toggle("collapsed");
if (window.innerWidth <= 680) panelEl.classList.add("collapsed"); // 手机默认收起

/* ---------- 风圈脉冲动画：静态的圆不像危险，扩散的环才像 ---------- */

let pulseT = 0;
function animatePulse() {
  if (document.hidden || !state.storm || !map.getSource("pulse")) return;
  const last = state.storm.track[state.storm.track.length - 1];
  const rp = radiusForDisplay(state.storm.track);
  const rMax = rp ? Math.max(...rp.r7) : null;
  if (!rMax || !last) return;
  pulseT = (pulseT + 0.018) % 1;
  const r = rMax * (0.15 + 0.85 * pulseT);
  const ring = [];
  for (let ang = 0; ang <= 360; ang += 10) ring.push(destination(last.lat, last.lng, r, ang));
  map.getSource("pulse").setData({
    type: "FeatureCollection",
    features: [feature("LineString", ring, {})],
  });
  map.setPaintProperty("pulse", "line-opacity", 0.55 * (1 - pulseT));
  // 风圈呼吸；估算圈整体更淡，与真实半径在视觉上区分
  if (map.getLayer("wind-circles")) {
    const v = 0.15 + 0.06 * Math.sin(Date.now() / 600);
    map.setPaintProperty("wind-circles", "fill-opacity",
      ["case", ["get", "est"], v * 0.55, v]);
  }
}
setInterval(animatePulse, 80); // setInterval 比 rAF 更抗节流，~12fps 对扩散环足够

function addLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  for (const id of ["wind-circles", "pulse", "track-lines", "track-points", "fc-lines", "fc-points"]) {
    map.addSource(id, { type: "geojson", data: empty });
  }

  map.addLayer({
    id: "wind-circles", type: "fill", source: "wind-circles",
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.18,
      "fill-outline-color": ["get", "color"],
    },
  });
  map.addLayer({
    id: "pulse", type: "line", source: "pulse",
    paint: { "line-color": "#ea8640", "line-width": 2, "line-opacity": 0.5 },
  });
  map.addLayer({
    id: "track-lines", type: "line", source: "track-lines",
    paint: { "line-color": ["get", "color"], "line-width": 2.5 },
  });
  map.addLayer({
    id: "fc-lines", type: "line", source: "fc-lines",
    paint: {
      "line-color": ["get", "color"],
      "line-width": 2,
      "line-dasharray": [2, 2],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "fc-points", type: "circle", source: "fc-points",
    paint: {
      "circle-radius": 3.5,
      "circle-color": ["get", "color"],
      "circle-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "track-points", type: "circle", source: "track-points",
    paint: {
      "circle-radius": ["case", ["get", "latest"], 7, 4],
      "circle-color": ["get", "color"],
      "circle-stroke-width": ["case", ["get", "latest"], 2, 0.5],
      "circle-stroke-color": "#ffffff",
    },
  });

  for (const layer of ["track-points", "fc-points"]) {
    map.on("click", layer, (e) => showPopup(e.features[0], e.lngLat));
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
}

async function refresh() {
  refreshRadar(); // 降水实况独立刷新，不受台风数据成败影响
  refreshWind();
  try {
    state.index = await TyphoonData.loadIndex();
  } catch (e) {
    document.getElementById("meta").textContent = "数据加载失败：" + e.message;
    return;
  }
  renderStormList();
  const storms = state.index.typhoons;
  if (!storms.length) {
    document.getElementById("meta").textContent = "当前无活跃台风";
    return;
  }
  if (!state.selected || !storms.some((s) => s.tfid === state.selected)) {
    state.selected = storms[0].tfid;
  }
  // 全部台风详情（活跃+残涡）交给影响面板做全局评估；地图仍只画选中的
  const all = (await Promise.all(storms.map((t) =>
    TyphoonData.loadStorm(t.tfid, state.index.live).catch(() => null)
  ))).filter(Boolean);
  state.allStorms = Object.fromEntries(all.map((s) => [s.tfid, s]));
  ImpactPanel.updateAll(all);
  await loadStorm(state.selected, /*fit=*/ !state.storm);
}

async function loadStorm(tfid, fit = true) {
  state.selected = tfid;
  state.storm = (state.allStorms && state.allStorms[tfid]) ||
    await TyphoonData.loadStorm(tfid, state.index.live);
  renderStormList();
  renderAgencyToggles();
  renderLegend();
  renderMeta();
  draw();
  if (fit && map.getSource("track-lines")) fitToStorm();
}

/* ---------- drawing ---------- */

function draw() {
  const s = state.storm;
  if (!s || !map.getSource("track-lines")) return; // 地图未就绪时跳过，load 回调里会补画

  const trackLines = [];
  for (let i = 1; i < s.track.length; i++) {
    const a = s.track[i - 1], b = s.track[i];
    trackLines.push(feature("LineString", [[a.lng, a.lat], [b.lng, b.lat]], {
      color: intensityColor(b.strong),
    }));
  }

  const trackPoints = s.track.map((p, i) => feature("Point", [p.lng, p.lat], {
    color: intensityColor(p.strong),
    latest: i === s.track.length - 1,
    title: `${s.name} ${s.enName}`,
    time: p.time,
    strong: p.strong,
    power: p.power,
    speed: p.speed,
    pressure: p.pressure,
    kind: "obs",
  }));

  const fcLines = [], fcPoints = [];
  for (const [agency, fc] of Object.entries(s.forecasts)) {
    if (state.hiddenAgencies.has(agency)) continue;
    const color = AGENCY_COLORS[agency] || AGENCY_FALLBACK;
    const coords = fc.points.map((p) => [p.lng, p.lat]);
    if (coords.length > 1) fcLines.push(feature("LineString", coords, { color }));
    for (const p of fc.points.slice(1)) {
      fcPoints.push(feature("Point", [p.lng, p.lat], {
        color,
        title: `${agency}预报`,
        time: p.time,
        strong: p.strong,
        power: p.power,
        speed: p.speed,
        pressure: p.pressure,
        kind: "fc",
      }));
    }
  }

  // 上游常在台风减弱后停发风圈半径——先回退最近带半径的点，再降级为按强度估算
  const last = s.track[s.track.length - 1];
  const rp = radiusForDisplay(s.track);
  const windCircles = last && rp
    ? windQuadrants({ ...rp, lat: last.lat, lng: last.lng })
    : [];

  setData("track-lines", trackLines);
  setData("track-points", trackPoints);
  setData("fc-lines", fcLines);
  setData("fc-points", fcPoints);
  setData("wind-circles", windCircles);
}

/* 最近 5 个实况点内最后一个带 7 级风圈数据的点 */
function lastWithRadius(track) {
  for (let i = track.length - 1; i >= Math.max(0, track.length - 5); i--) {
    if (track[i].r7) return track[i];
  }
  return null;
}

/* 风圈展示数据：优先真实半径；停发时返回按强度估算的均匀圈（est 标记）。
   估算表在 data.js estGaleRadius——与影响评估/分享卡同源，避免两处维护 */
function radiusForDisplay(track) {
  const rp = lastWithRadius(track);
  if (rp) return { ...rp, est: false };
  const last = track[track.length - 1];
  if (!last || !last.power) return null;
  const r = TyphoonData.estGaleRadius(last.power);
  return { r7: [r, r, r, r], r10: null, r12: null, est: true };
}

/* Quadrant wind-radius polygons for the latest fix. Radii order: NE SE SW NW. */
function windQuadrants(p) {
  const rings = [
    { radii: p.r7, color: "#c9a961" },
    { radii: p.r10, color: "#ea8640" },
    { radii: p.r12, color: "#d0442c" },
  ];
  const feats = [];
  // Quadrant start bearings (deg from north, clockwise): NE=0, SE=90, SW=180, NW=270
  for (const { radii, color } of rings) {
    if (!radii) continue;
    const coords = [];
    for (let q = 0; q < 4; q++) {
      const r = radii[q];
      for (let a = q * 90; a <= q * 90 + 90; a += 10) {
        coords.push(destination(p.lat, p.lng, r, a));
      }
    }
    coords.push(coords[0]);
    feats.push(feature("Polygon", [coords], { color, est: !!p.est }));
  }
  return feats;
}

function destination(lat, lng, km, bearingDeg) {
  const dLat = (km * Math.cos((bearingDeg * Math.PI) / 180)) / 111.32;
  const dLng = (km * Math.sin((bearingDeg * Math.PI) / 180)) /
    (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lng + dLng, lat + dLat];
}

function fitToStorm() {
  const s = state.storm;
  const bounds = new maplibregl.LngLatBounds();
  for (const p of s.track) bounds.extend([p.lng, p.lat]);
  for (const fc of Object.values(s.forecasts)) {
    for (const p of fc.points) bounds.extend([p.lng, p.lat]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80 });
}

function showPopup(f, lngLat) {
  const p = f.properties;
  const rows = [
    `<div class="popup-title">${p.title}</div>`,
    `${p.time}`,
    `强度：${p.strong || "—"}${p.power ? `（${p.power}级）` : ""}`,
    p.speed ? `风速：${p.speed} m/s` : "",
    p.pressure ? `气压：${p.pressure} hPa` : "",
  ].filter(Boolean);
  new maplibregl.Popup({ closeButton: false, maxWidth: "260px" })
    .setLngLat(lngLat)
    .setHTML(rows.join("<br>"))
    .addTo(map);
}

/* ---------- panel ---------- */

function renderStormList() {
  const el = document.getElementById("storm-list");
  el.innerHTML = "";
  for (const t of state.index.typhoons) {
    const div = document.createElement("div");
    div.className = "storm-item" + (t.tfid === state.selected ? " selected" : "");
    const residual = t.status === "residual"
      ? `<span class="residual-tag">残余环流</span> ` : "";
    div.innerHTML = `
      <div class="name">${t.name} ${t.enName} <small>#${t.tfid}</small></div>
      <div class="sub">${residual}${t.strong || ""}${t.power ? ` ${t.power}级` : ""} · ${t.lastTime || ""}</div>`;
    div.onclick = () => loadStorm(t.tfid, true);
    el.appendChild(div);
  }
}

function renderAgencyToggles() {
  const el = document.getElementById("agency-toggles");
  el.innerHTML = "";
  for (const agency of Object.keys(state.storm.forecasts)) {
    const color = AGENCY_COLORS[agency] || AGENCY_FALLBACK;
    const label = document.createElement("label");
    label.className = "toggle-row";
    label.innerHTML = `
      <input type="checkbox" ${state.hiddenAgencies.has(agency) ? "" : "checked"}>
      <span class="swatch" style="background:${color}"></span>${agency}`;
    label.querySelector("input").onchange = (e) => {
      e.target.checked ? state.hiddenAgencies.delete(agency) : state.hiddenAgencies.add(agency);
      draw();
    };
    el.appendChild(label);
  }
}

function renderLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = Object.entries(INTENSITY_COLORS)
    .map(([name, color]) =>
      `<div class="legend-row"><span class="dot" style="background:${color}"></span>${name}</div>`)
    .join("");
}

function renderMeta() {
  const s = state.storm;
  const last = s.track[s.track.length - 1];
  const rp = radiusForDisplay(s.track);
  document.getElementById("meta").innerHTML = [
    `实况截至 ${last ? last.time : "—"}`,
    s.live ? `实时数据 · 温州台风网 · 每 5 分钟自动刷新` : `快照数据 · ${s.updatedAt}`,
    `预报虚线为各机构最新预报路径`,
    ...(rp && rp.est ? [`风圈半径官方已停发（系统减弱），图中为按当前强度的估算圈`] : []),
  ].join("<br>");
}

/* ---------- 降水实况图层（RainViewer 免费雷达观测） ----------
   实况观测（非预报），每 10 分钟更新、与真实台风自动对齐；实测覆盖大陆真实回波。
   免费免 key，条款要求署名。tilecache.rainviewer.com 大陆可达性待实测，失败则静默无图。 */
const rv = { on: false, host: null, path: null, time: null };

async function loadRainviewerMeta() {
  const d = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
  const past = d.radar && d.radar.past;
  if (!past || !past.length) throw new Error("no radar frames");
  rv.host = d.host;
  rv.path = past[past.length - 1].path;
  rv.time = past[past.length - 1].time;
}

/* 配色方案 1（绿→黄→红，强度直观）；smooth=1 snow=1；512px 更清晰。
   RainViewer 雷达瓦片最高只到 z=7（再高返回「zoom level not supported」占位图），
   故源设 RV_MAXZOOM，超过后 MapLibre 自动拉伸最后一级、不再请求占位层。 */
const RV_MAXZOOM = 7;
function rvTileUrl() { return `${rv.host}${rv.path}/512/{z}/{x}/{y}/1/1_1.png`; }

function ensureRadarLayer() {
  if (map.getSource("rv-radar")) return true;
  // wind-circles 由 addLayers() 在 map 'load' 时创建——它存在＝样式就绪、可安全加层
  // （比 isStyleLoaded() 可靠：后者要求 sprite/所有源都就绪，底图慢时会长期为 false）
  if (!map.getLayer("wind-circles")) return false;
  map.addSource("rv-radar", { type: "raster", tiles: [rvTileUrl()], tileSize: 512, maxzoom: RV_MAXZOOM });
  // 置于台风图层之下、底图之上——降水不遮挡路径/风圈
  const before = map.getLayer("wind-circles") ? "wind-circles" : undefined;
  map.addLayer({
    id: "rv-radar", type: "raster", source: "rv-radar",
    paint: { "raster-opacity": 0.6 }, layout: { visibility: "none" },
  }, before);
  return true;
}

function radarTimeLabel() {
  if (!rv.time) return "";
  const d = new Date(rv.time * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `观测于 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function toggleRadar(on) {
  rv.on = on;
  document.getElementById("layer-radar").classList.toggle("on", on);
  document.getElementById("radar-legend").hidden = !on;
  if (!on) {
    if (map.getLayer("rv-radar")) map.setLayoutProperty("rv-radar", "visibility", "none");
    return;
  }
  try {
    if (!rv.host) await loadRainviewerMeta();
  } catch (e) {
    document.getElementById("radar-time").textContent = "暂无降水数据";
    return;
  }
  if (!ensureRadarLayer()) { map.once("load", () => rv.on && toggleRadar(true)); return; }
  map.getSource("rv-radar").setTiles([rvTileUrl()]);
  // 若时间轴正停在未来帧，雷达（实况）不显示
  const future = wind.on && wind.idx > 0;
  map.setLayoutProperty("rv-radar", "visibility", future ? "none" : "visible");
  document.getElementById("radar-time").textContent = future ? "雷达仅实况 · 拖回「现在」可见" : radarTimeLabel();
}

async function refreshRadar() {
  if (!rv.on) return;
  try {
    await loadRainviewerMeta();
    if (map.getSource("rv-radar")) {
      map.getSource("rv-radar").setTiles([rvTileUrl()]);
      document.getElementById("radar-time").textContent = radarTimeLabel();
    }
  } catch (e) { /* 保留上一帧 */ }
}

document.getElementById("layer-radar").onclick = () => toggleRadar(!rv.on);

/* ---------- 风场图层（风羽箭头，数据 Open-Meteo 网格快照，零额外依赖） ----------
   箭头指向"风的去向"（风向是来向，故 +180）；靠 icon-allow-overlap:false 自动稀释密度，
   放大才显更多箭头。按风速着色/微调大小。置于台风图层之下。 */
const wind = { on: false, updatedAt: null, times: [], grid: [], frames: [], stepH: 3, idx: 0 };
const WIND_LAYERS = ["wind-arrows"];
// 风速(km/h)→颜色：微风→强风，与图例一致；绿→石灰→沙金→橙→焦红。箭头本身按此上色。
const WIND_COLOR = ["interpolate", ["linear"], ["get", "spd"],
  2, "#5a9e7a", 20, "#aaa69f", 40, "#c9a961", 62, "#ea8640", 90, "#d0442c"];

/* SDF 箭头图标：一根杆 + 三角头，指向正北；由 icon-color 上色 */
function makeArrowImage() {
  const s = 34, c = document.createElement("canvas"); c.width = c.height = s;
  const x = c.getContext("2d");
  x.strokeStyle = "#fff"; x.fillStyle = "#fff"; x.lineWidth = 3; x.lineCap = "round";
  x.beginPath(); x.moveTo(17, 28); x.lineTo(17, 11); x.stroke();
  x.beginPath(); x.moveTo(17, 5); x.lineTo(11, 15); x.lineTo(23, 15); x.closePath(); x.fill();
  return x.getImageData(0, 0, s, s);
}

async function loadWind() {
  const d = await fetchJSON(`data/wind.json?t=${Date.now()}`);
  wind.updatedAt = d.updatedAt;
  wind.times = d.times || [];
  wind.grid = d.grid || [];
  wind.frames = d.frames || [];
  wind.stepH = d.stepH || 3;
  if (wind.idx >= wind.times.length) wind.idx = 0;
}

/* 某一帧 → 箭头 GeoJSON */
function windFrameFC(idx) {
  const fr = wind.frames[idx] || [];
  const feats = wind.grid.map(([lat, lon], i) => {
    const p = fr[i] || [0, 0];
    return feature("Point", [lon, lat], { spd: p[0], dir: p[1] });
  });
  return { type: "FeatureCollection", features: feats };
}

/* 风：箭头（羽毛图）——指向风的去向、按风速上色，方向与大小都在箭头上。
   靠 icon-allow-overlap:false 自动稀释密度，放大才显更多。纯 MapLibre、零依赖。 */
function ensureWindLayer(fc) {
  if (map.getSource("wind-src")) { map.getSource("wind-src").setData(fc); return true; }
  if (!map.getLayer("wind-circles")) return false;
  if (!map.hasImage("wind-arrow")) map.addImage("wind-arrow", makeArrowImage(), { sdf: true });
  map.addSource("wind-src", { type: "geojson", data: fc });
  map.addLayer({
    id: "wind-arrows", type: "symbol", source: "wind-src",
    layout: {
      "icon-image": "wind-arrow",
      "icon-rotate": ["+", ["get", "dir"], 180],   // 指向风的去向（风向是来向）
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": false, "icon-padding": 6,
      "icon-size": ["interpolate", ["linear"], ["get", "spd"], 0, 0.5, 60, 1.0],
      "visibility": "none",
    },
    paint: { "icon-color": WIND_COLOR, "icon-opacity": 0.92 },
  }, "wind-circles");
  return true;
}

async function toggleWind(on) {
  wind.on = on;
  document.getElementById("layer-wind").classList.toggle("on", on);
  document.getElementById("wind-legend").hidden = !on;
  document.getElementById("time-slider").hidden = !on;
  if (!on) {
    stopPlay();
    for (const id of WIND_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    if (map.getLayer("storm-at-time")) map.setLayoutProperty("storm-at-time", "visibility", "none");
    // 关风力时把被时间轴隐掉的雷达恢复到「现在」
    if (rv.on && map.getLayer("rv-radar")) {
      map.setLayoutProperty("rv-radar", "visibility", "visible");
      document.getElementById("radar-time").textContent = radarTimeLabel();
    }
    return;
  }
  try { await loadWind(); }
  catch (e) { document.getElementById("wind-time").textContent = "暂无风力数据"; return; }
  if (!ensureWindLayer(windFrameFC(wind.idx))) { map.once("load", () => wind.on && toggleWind(true)); return; }
  ensureStormMarker();
  for (const id of WIND_LAYERS) map.setLayoutProperty(id, "visibility", "visible");
  const range = document.getElementById("time-range");
  range.max = String(Math.max(0, wind.times.length - 1));
  range.value = String(Math.min(wind.idx, wind.times.length - 1));
  applyFrame(+range.value);
  document.getElementById("wind-time").textContent = wind.updatedAt ? `更新于 ${wind.updatedAt}` : "";
}

/* 应用某一帧：风场箭头 + 台风该时刻位置标记 + 时间标签 + 雷达联动 */
function applyFrame(idx) {
  wind.idx = idx;
  if (map.getSource("wind-src")) map.getSource("wind-src").setData(windFrameFC(idx));
  updateStormMarker(idx);
  // 雷达是实况观测，无法表示未来——拖离「现在」时自动隐藏并提示
  if (rv.on && map.getLayer("rv-radar")) {
    map.setLayoutProperty("rv-radar", "visibility", idx === 0 ? "visible" : "none");
    document.getElementById("radar-time").textContent = idx === 0
      ? radarTimeLabel() : "雷达仅实况 · 拖回「现在」可见";
  }
  const lead = idx * wind.stepH;
  const t = wind.times[idx] ? new Date(new Date(wind.times[idx].replace("Z", "+00:00")).getTime() + 8 * 3.6e6) : null;
  const when = t ? `${t.getUTCDate()}日${String(t.getUTCHours()).padStart(2, "0")}时` : "";
  document.getElementById("time-label").innerHTML = lead === 0
    ? `现在 · ${when}（北京时）`
    : `<span class="lead">+${lead}h</span> · ${when}（北京时，预报）`;
}

/* 时间轴自动播放 */
let playTimer = null;
function stopPlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  document.getElementById("time-play").textContent = "▶";
}
function togglePlay() {
  const rng = document.getElementById("time-range");
  if (playTimer) { stopPlay(); return; }
  document.getElementById("time-play").textContent = "⏸";
  playTimer = setInterval(() => {
    const n = (wind.idx + 1) % Math.max(1, wind.times.length);
    rng.value = String(n);
    applyFrame(n);
  }, 750);
}

/* 台风时刻标记：把选中台风的实况+中国预报轨迹插值到该帧时刻，画一个空心环 */
function stormTimeline() {
  const s = state.storm;
  if (!s) return [];
  const bjEp = (str) => new Date(str.replace(" ", "T") + "+08:00").getTime();
  const tl = s.track.map((p) => [bjEp(p.time), p.lat, p.lng]);
  const fc = s.forecasts["中国"] || Object.values(s.forecasts)[0];
  if (fc) for (const p of fc.points) tl.push([bjEp(p.time), p.lat, p.lng]);
  tl.sort((a, b) => a[0] - b[0]);
  return tl;
}
function interpAt(tl, ep) {
  if (!tl.length) return null;
  if (ep <= tl[0][0]) return [tl[0][1], tl[0][2]];
  if (ep >= tl[tl.length - 1][0]) return [tl[tl.length - 1][1], tl[tl.length - 1][2]];
  for (let i = 1; i < tl.length; i++) {
    if (tl[i][0] >= ep) {
      const [e0, la0, lo0] = tl[i - 1], [e1, la1, lo1] = tl[i];
      const f = e1 > e0 ? (ep - e0) / (e1 - e0) : 0;
      return [la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f];
    }
  }
  return null;
}
function ensureStormMarker() {
  if (map.getSource("storm-at-time") || !map.getLayer("wind-circles")) return;
  map.addSource("storm-at-time", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "storm-at-time", type: "circle", source: "storm-at-time",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 11, "circle-color": "rgba(234,134,64,0.15)",
      "circle-stroke-width": 2.5, "circle-stroke-color": "#ea8640",
    },
  }); // 顶层，标记盖在最上
}
function updateStormMarker(idx) {
  if (!map.getLayer("storm-at-time")) return;
  const ep = wind.times[idx] ? new Date(wind.times[idx].replace("Z", "+00:00")).getTime() : null;
  const pos = ep ? interpAt(stormTimeline(), ep) : null;
  map.setLayoutProperty("storm-at-time", "visibility", wind.on ? "visible" : "none");
  map.getSource("storm-at-time").setData({
    type: "FeatureCollection",
    features: pos ? [feature("Point", [pos[1], pos[0]], {})] : [],
  });
}

async function refreshWind() {
  if (!wind.on) return;
  try {
    await loadWind();
    if (map.getSource("wind-src")) applyFrame(Math.min(wind.idx, Math.max(0, wind.times.length - 1)));
    document.getElementById("wind-time").textContent = wind.updatedAt ? `更新于 ${wind.updatedAt}` : "";
  } catch (e) { /* 保留上一帧 */ }
}

document.getElementById("layer-wind").onclick = () => toggleWind(!wind.on);
document.getElementById("time-range").oninput = (e) => { if (wind.on) { stopPlay(); applyFrame(+e.target.value); } };
document.getElementById("time-play").onclick = () => { if (wind.on) togglePlay(); };

/* 「你」的位置标记：面板选点/浏览器定位后，在大图上标出用户位置，
   一眼看清自己和台风的关系。用 HTML Marker（本站底图无 glyphs，符号文字用不了）。 */
let userMarker = null;
window.onUserLoc = (lat, lng, label) => {
  // Marker 创建后随时可放，无需等 style load——不能用 map.loaded()/once("load") 门控：
  // loaded() 在加载图层/瓦片时会瞬时为 false，而 load 事件只触发一次，会丢失更新。
  if (!window.map || lat == null || lng == null) return;
  if (!userMarker) {
    const el = document.createElement("div");
    el.className = "user-marker";
    el.innerHTML = '<span class="um-dot"></span><span class="um-label"></span>';
    userMarker = new maplibregl.Marker({ element: el, anchor: "bottom" });
  }
  userMarker.getElement().querySelector(".um-label").textContent = label || "你";
  userMarker.setLngLat([lng, lat]).addTo(map);
};

/* ---------- helpers ---------- */

function feature(type, coordinates, properties) {
  return { type: "Feature", geometry: { type, coordinates }, properties };
}

function setData(id, features) {
  map.getSource(id).setData({ type: "FeatureCollection", features });
}

function intensityColor(strong) {
  return INTENSITY_COLORS[strong] || INTENSITY_FALLBACK;
}

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
