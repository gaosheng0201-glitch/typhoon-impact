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
  const rMax = last && last.r7 ? Math.max(...last.r7) : null;
  if (!rMax) return;
  pulseT = (pulseT + 0.018) % 1;
  const r = rMax * (0.15 + 0.85 * pulseT);
  const ring = [];
  for (let ang = 0; ang <= 360; ang += 10) ring.push(destination(last.lat, last.lng, r, ang));
  map.getSource("pulse").setData({
    type: "FeatureCollection",
    features: [feature("LineString", ring, {})],
  });
  map.setPaintProperty("pulse", "line-opacity", 0.55 * (1 - pulseT));
  // 风圈呼吸
  if (map.getLayer("wind-circles")) {
    map.setPaintProperty("wind-circles", "fill-opacity", 0.15 + 0.06 * Math.sin(Date.now() / 600));
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
    paint: { "line-color": "#fadb14", "line-width": 2, "line-opacity": 0.5 },
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

  const last = s.track[s.track.length - 1];
  const windCircles = last ? windQuadrants(last) : [];

  setData("track-lines", trackLines);
  setData("track-points", trackPoints);
  setData("fc-lines", fcLines);
  setData("fc-points", fcPoints);
  setData("wind-circles", windCircles);
}

/* Quadrant wind-radius polygons for the latest fix. Radii order: NE SE SW NW. */
function windQuadrants(p) {
  const rings = [
    { radii: p.r7, color: "#fadb14" },
    { radii: p.r10, color: "#fa8c16" },
    { radii: p.r12, color: "#f5222d" },
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
    feats.push(feature("Polygon", [coords], { color }));
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
  document.getElementById("meta").innerHTML = [
    `实况截至 ${last ? last.time : "—"}`,
    s.live ? `🟢 实时直连温州台风网（每 5 分钟自动刷新）` : `⚪ 仓库快照数据 ${s.updatedAt}`,
    `预报虚线为各机构最新预报路径`,
  ].join("<br>");
}

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
