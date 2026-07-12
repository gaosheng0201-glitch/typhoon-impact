/* AI 预报复盘（FNV3 / Google DeepMind FGN）
   把历史 AI 台风路径预报与官方实况对齐，展示「提前 N 天预报，实际差多少公里」。
   数据只用 48 小时前的历史部分（CC BY 4.0，见 fetch_fnv3.py 合规说明）。
   复用 app.js 的全局 map / feature / setData 在主图上叠加 AI 预报 vs 实况。 */
const Hindcast = (() => {
  const LEADS = [24, 48, 72, 96, 120];
  const AI = "#ea8640";      // 日升橙：AI 预报
  const OBS = "#eeece6";     // 骨白：官方实况
  const LIVE_LAYERS = ["wind-circles", "pulse", "track-lines", "fc-lines", "fc-points", "track-points"];
  let store = {};            // tfid -> data
  let overlayOn = false;
  let savedMeta = "";

  async function init() {
    let index;
    try {
      index = await fetchJSON2(`data/fnv3/index.json?t=${Date.now()}`);
    } catch (e) { return; } // 无复盘数据时整块隐藏
    if (!index.storms || !index.storms.length) return;
    const st = index.storms[0]; // v1：展示最近一个有复盘的台风
    try {
      store[st.tfid] = await fetchJSON2(`data/fnv3/${st.tfid}.json?t=${Date.now()}`);
    } catch (e) { return; }
    render(st.tfid);
    document.getElementById("hindcast-section").hidden = false;
  }

  /* 选上图的那一期：最晚一期仍有 +120h 验证的预报——提前 5 天正好压到登陆前后，
     最能体现「这么早就说准了」。没有则退而求其次取有最长验证提前量的一期。 */
  function pickForecast(d) {
    const withLong = d.forecasts.filter((f) => f.errorsKm["120"] != null);
    if (withLong.length) return withLong[withLong.length - 1];
    const scored = d.forecasts.map((f) => ({ f, n: Object.keys(f.errorsKm).length }));
    scored.sort((a, b) => b.n - a.n);
    return (scored[0] && scored[0].f) || d.forecasts[0];
  }

  function render(tfid) {
    const d = store[tfid];
    const s = d.summary;
    const el = document.getElementById("hindcast");
    const max = Math.max(...LEADS.map((h) => s[h] || 0), 1);
    const bars = LEADS.filter((h) => s[h] != null).map((h) => {
      const w = Math.round((s[h] / max) * 100);
      return `<div class="hc-row">
        <span class="hc-lead">+${h}h</span>
        <span class="hc-bar"><i style="width:${w}%"></i></span>
        <span class="hc-km">${s[h]} km</span></div>`;
    }).join("");
    const d3 = s["72"], d5 = s["120"];
    const takeaway = `<b>${d.name} ${d.enName}</b>：回算 ${d.forecasts.length} 期历史预报，` +
      `Google AI 提前 3 天（+72h）路径平均只差 <b>${d3} km</b>` +
      (d5 ? `，提前 5 天（+120h）约 <b>${d5} km</b>` : "") + "。";

    el.innerHTML = `
      <div class="hc-model">Google DeepMind · FGN（FNV3）实验性 AI 模型</div>
      <div class="hc-take">${takeaway}</div>
      <div class="hc-chart">${bars}</div>
      <div class="hc-hint">数值＝AI 预报中心与官方实况的距离，越小越准；提前量越长越难。</div>
      <button id="hc-map-btn" class="hc-btn">在地图上看 AI 预报 vs 实况</button>
      <div class="hc-attr">${d.license}
        <a href="${d.terms}" target="_blank" rel="noopener">条款</a></div>`;
    document.getElementById("hc-map-btn").onclick = () => toggleOverlay(tfid);
  }

  /* 在主图叠加：官方实况（实线）+ 一期 AI 预报（虚线），并标注终点偏差 */
  function toggleOverlay(tfid) {
    const btn = document.getElementById("hc-map-btn");
    if (overlayOn) {
      clearOverlay(); showLive(true);
      document.getElementById("meta").innerHTML = savedMeta;
      btn.textContent = "在地图上看 AI 预报 vs 实况"; overlayOn = false; return;
    }
    if (!ensureLayers()) return;
    const d = store[tfid];
    const f = pickForecast(d);
    // 标注用的整提前量：取有验证的最大整数天档（120/96/…），轨迹也画到该点，
    // 让图上终点标记与「偏差 X km」是同一个点——干净、可核对
    const endLead = [120, 96, 72, 48, 24].find((h) => f.errorsKm[String(h)] != null)
      || Math.max(...Object.keys(f.errorsKm).map(Number));
    const err = f.errorsKm[String(endLead)];
    const verifiable = f.track.filter((p) => p[0] <= endLead);
    const aiPts = verifiable.map((p) => [p[3], p[2]]); // [lon,lat]
    const t0 = f.track[0][1], t1 = verifiable[verifiable.length - 1][1];
    const obsPts = d.observed.filter((o) => o[0] >= t0 - 3600 && o[0] <= t1 + 3600)
      .map((o) => [o[2], o[1]]);

    setData("hc-obs", [feature("LineString", obsPts, {})]);
    setData("hc-ai", [feature("LineString", aiPts, {})]);
    // 起点（预报发布时刻）+ 两条末端点，直观看出终点偏差
    const marks = [feature("Point", aiPts[0], { color: OBS })];
    marks.push(feature("Point", aiPts[aiPts.length - 1], { color: AI }));
    if (obsPts.length) marks.push(feature("Point", obsPts[obsPts.length - 1], { color: OBS }));
    setData("hc-ends", marks);

    showLive(false); // 隐去实时台风图层，避免与复盘混淆
    const initDay = f.init.slice(5, 10).replace("-", "月") + "日";
    const days = Math.round(endLead / 24);
    savedMeta = document.getElementById("meta").innerHTML;
    document.getElementById("meta").innerHTML =
      `AI 复盘 · ${d.name}：${initDay} 那期 AI 预报（橙虚线）vs 官方实况（白线）` +
      (err != null ? ` · 提前 ${days} 天（+${endLead}h）预报，终点偏差 ${err} km` : "");

    const all = aiPts.concat(obsPts);
    const lons = all.map((p) => p[0]), lats = all.map((p) => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 70, duration: 600 });
    btn.textContent = "收起 AI 预报对比";
    overlayOn = true;
  }

  function showLive(on) {
    const v = on ? "visible" : "none";
    for (const id of LIVE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }

  function ensureLayers() {
    if (!map || !map.getStyle) return false;
    if (map.getSource("hc-obs")) return true;
    if (!map.isStyleLoaded()) { map.once("idle", () => ensureLayers()); return false; }
    const empty = { type: "FeatureCollection", features: [] };
    map.addSource("hc-obs", { type: "geojson", data: empty });
    map.addSource("hc-ai", { type: "geojson", data: empty });
    map.addSource("hc-ends", { type: "geojson", data: empty });
    map.addLayer({ id: "hc-obs", type: "line", source: "hc-obs",
      paint: { "line-color": OBS, "line-width": 3 } });
    map.addLayer({ id: "hc-ai", type: "line", source: "hc-ai",
      paint: { "line-color": AI, "line-width": 2.5, "line-dasharray": [2, 2] } });
    map.addLayer({ id: "hc-ends", type: "circle", source: "hc-ends",
      paint: { "circle-radius": 5, "circle-color": ["get", "color"],
        "circle-stroke-width": 1.5, "circle-stroke-color": "#14130f" } });
    return true;
  }

  function clearOverlay() {
    for (const id of ["hc-obs", "hc-ai", "hc-ends"]) if (map.getSource(id)) setData(id, []);
  }

  /* 复用 panel.js 的 fetchJSON2 不可跨文件，这里各自实现一份最小版 */
  async function fetchJSON2(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  return { init };
})();

Hindcast.init();
