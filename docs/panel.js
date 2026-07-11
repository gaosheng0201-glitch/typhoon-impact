/* ImpactPanel — 主页内嵌的「我会不会受灾」评估面板。
   位置到区县级（regions.json），清单按人群×等级×情境（checklists.json），
   渐进披露：默认只显示等级+一句话，时间线/对照/清单用 details 折叠。 */
const ImpactPanel = (() => {
  const SLOW_KMH = 18;     // 停留型台风移速阈值
  const WET_SOIL_MM = 150; // 前期降雨“湿透”阈值

  const LEVELS = {
    1: { name: "关注", tip: "留意后续预报即可" },
    2: { name: "准备", tip: "今天完成物资检查" },
    3: { name: "戒备", tip: "减少外出，防内涝停电" },
    4: { name: "高危", tip: "听从官方转移安排" },
  };
  const LV_STYLE = {
    1: { color: "#6fdc8c", headline: "预报路径不经过你所在区域", sub: "不必被「超强台风」的标题吓到" },
    2: { color: "#f0c743", headline: "外围风雨会来，备点吃喝更安心", sub: "影响有限，做基础准备即可" },
    3: { color: "#ff9d4d", headline: "影响明显，今天完成防台准备", sub: "重点防内涝和停电" },
    4: { color: "#ff6470", headline: "可能严重受灾，紧盯官方通知", sub: "涉及转移请听从政府安排" },
  };

  const P = {
    storm: null,
    regions: null,
    checklists: null,
    analogs: null,
    loc: { province: "浙江省", city: "温州市", district: "鹿城区", lat: 28.0034, lng: 120.6742 },
    persona: "urban",
    situations: new Set(),
    antecedent: {},
  };

  /* ---------- init ---------- */

  async function init() {
    [P.regions, P.checklists, P.analogs] = await Promise.all([
      fetchJSON2("data/regions.json"),
      fetchJSON2("data/checklists.json"),
      fetchJSON2(`data/analogs.json?t=${Date.now()}`),
    ]);
    restore();
    buildLocSelects();
    buildPersonaChips();
    bindShare();
    document.getElementById("btn-geo").onclick = useMyLocation;
    loadAntecedent();
    render();
  }

  function update(storm) {
    P.storm = storm;
    render();
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem("ti_loc"));
      if (saved && P.regions[saved.province]) P.loc = saved;
      const persona = localStorage.getItem("ti_persona");
      if (persona) P.persona = persona;
      P.situations = new Set(JSON.parse(localStorage.getItem("ti_sits") || "[]"));
    } catch (e) { /* 忽略损坏的本地存储 */ }
  }

  function persist() {
    localStorage.setItem("ti_loc", JSON.stringify(P.loc));
    localStorage.setItem("ti_persona", P.persona);
    localStorage.setItem("ti_sits", JSON.stringify([...P.situations]));
  }

  /* ---------- 位置选择 ---------- */

  function buildLocSelects() {
    const sp = document.getElementById("sel-prov");
    sp.innerHTML = Object.keys(P.regions)
      .map((n) => `<option ${n === P.loc.province ? "selected" : ""}>${n}</option>`).join("");
    sp.onchange = () => { P.loc.province = sp.value; P.loc.city = null; P.loc.district = null; syncCitySelect(); };
    syncCitySelect(true);
  }

  function syncCitySelect(keep = false) {
    const cities = P.regions[P.loc.province].cities;
    const names = Object.keys(cities);
    if (!keep || !names.includes(P.loc.city)) P.loc.city = names[0] || null;
    const sc = document.getElementById("sel-city");
    sc.innerHTML = names.map((n) => `<option ${n === P.loc.city ? "selected" : ""}>${n}</option>`).join("");
    sc.onchange = () => { P.loc.city = sc.value; P.loc.district = null; syncDistrictSelect(); };
    syncDistrictSelect(keep);
  }

  function syncDistrictSelect(keep = false) {
    const cityNode = P.regions[P.loc.province].cities[P.loc.city] || { districts: {} };
    const names = Object.keys(cityNode.districts || {});
    const sd = document.getElementById("sel-dist");
    sd.style.display = names.length ? "" : "none";
    if (!keep || !names.includes(P.loc.district)) P.loc.district = names[0] || null;
    sd.innerHTML = names.map((n) => `<option ${n === P.loc.district ? "selected" : ""}>${n}</option>`).join("");
    sd.onchange = () => { P.loc.district = sd.value; applyLoc(); };
    applyLoc();
  }

  function applyLoc() {
    const prov = P.regions[P.loc.province];
    const cityNode = prov.cities[P.loc.city];
    if (P.loc.district && cityNode.districts[P.loc.district]) {
      [P.loc.lat, P.loc.lng] = cityNode.districts[P.loc.district];
    } else if (cityNode) {
      P.loc.lat = cityNode.lat; P.loc.lng = cityNode.lng;
    } else {
      P.loc.lat = prov.lat; P.loc.lng = prov.lng;
    }
    persist();
    loadAntecedent();
    render();
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    const btn = document.getElementById("btn-geo");
    btn.textContent = "⏳";
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      let best = null, bestD = Infinity;
      for (const [pn, prov] of Object.entries(P.regions)) {
        for (const [cn, city] of Object.entries(prov.cities)) {
          const dists = Object.entries(city.districts || {});
          for (const [dn, [dlat, dlng]] of dists) {
            const d = haversine(lat, lng, dlat, dlng);
            if (d < bestD) { bestD = d; best = { province: pn, city: cn, district: dn, lat: dlat, lng: dlng }; }
          }
          if (!dists.length) {
            const d = haversine(lat, lng, city.lat, city.lng);
            if (d < bestD) { bestD = d; best = { province: pn, city: cn, district: null, lat: city.lat, lng: city.lng }; }
          }
        }
      }
      btn.textContent = "📍";
      if (best && bestD < 300) {  // 超过 300km 视为不在数据覆盖范围（海外）
        P.loc = best;
        buildLocSelects();
      }
    }, () => { btn.textContent = "📍"; });
  }

  function locLabel() {
    return P.loc.district || P.loc.city || P.loc.province;
  }

  /* ---------- 人群 ---------- */

  function buildPersonaChips() {
    const el = document.getElementById("persona-row");
    el.innerHTML = P.checklists.personas.map((p) =>
      `<button class="chip ${p.id === P.persona ? "on" : ""}" data-p="${p.id}">${p.icon} ${p.name}</button>`
    ).join("");
    el.querySelectorAll(".chip").forEach((b) => {
      b.onclick = () => { P.persona = b.dataset.p; P.situations.clear(); persist(); buildPersonaChips(); render(); };
    });
    const cur = P.checklists.personas.find((p) => p.id === P.persona);
    const sits = (cur && cur.situations) || [];
    const sitEl = document.getElementById("situation-row");
    sitEl.innerHTML = sits.map((s) =>
      `<label class="sit"><input type="checkbox" data-s="${s.id}" ${P.situations.has(s.id) ? "checked" : ""}>${s.name}</label>`
    ).join("");
    sitEl.querySelectorAll("input").forEach((i) => {
      i.onchange = () => { i.checked ? P.situations.add(i.dataset.s) : P.situations.delete(i.dataset.s); persist(); render(); };
    });
  }

  function checklistItems(level) {
    const lists = P.checklists.items;
    const pick = (obj) => { for (let l = level; l >= 1; l--) if (obj && obj[l]) return obj[l]; return []; };
    let items = pick(lists[P.persona]).slice();
    if (P.persona === "urban") for (const s of P.situations) items = items.concat(pick(lists[s]));
    return items;
  }

  /* ---------- 评估（与原影响页同一逻辑） ---------- */

  function assess() {
    const s = P.storm;
    const fc = s.forecasts["中国"] || Object.values(s.forecasts)[0];
    const path = s.track.slice(-4).concat(fc ? fc.points : [])
      .map((p) => ({ ...p, dist: haversine(P.loc.lat, P.loc.lng, p.lat, p.lng) }));

    const closest = path.reduce((a, b) => (b.dist < a.dist ? b : a));
    const galeR = maxRadius(s.track[s.track.length - 1]) || 350;
    const inRange = path.filter((p) => p.dist < galeR);

    const pts = fc ? fc.points : [];
    let moveKmh = null;
    if (pts.length > 1) {
      let km = 0, h = 0;
      for (let i = 1; i < pts.length; i++) {
        km += haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
        h += (ptime(pts[i]) - ptime(pts[i - 1])) / 3.6e6;
      }
      if (h > 0) moveKmh = km / h;
    }
    const slowMover = moveKmh !== null && moveKmh < SLOW_KMH;

    let durationH = null, endPoint = null, stillInRangeAtEnd = false;
    if (inRange.length) {
      durationH = (ptime(inRange[inRange.length - 1]) - ptime(inRange[0])) / 3.6e6;
      const after = path.filter((p) => ptime(p) > ptime(closest));
      endPoint = after.find((p) => p.dist >= galeR) || null;
      stillInRangeAtEnd = !endPoint && path[path.length - 1].dist < galeR;
    }

    let rain = closest.dist < 80 ? 260 : closest.dist < 150 ? 180
      : closest.dist < 250 ? 100 : closest.dist < 400 ? 50 : 15;
    if (slowMover) rain = Math.round(rain * 1.6);

    const power = parseInt(closest.power) || 0;
    let level = 1;
    if (rain >= 60 || (closest.dist < galeR && power >= 8)) level = 2;
    if (rain >= 150 || (closest.dist < 200 && power >= 10)) level = 3;
    if (rain >= 250 || (closest.dist < 100 && power >= 14)) level = 4;
    if (slowMover && closest.dist < galeR) level = Math.max(level, 3);

    return { closest, galeR, inRange, rain, level, moveKmh, slowMover, durationH, endPoint, stillInRangeAtEnd };
  }

  function findAnalog(rain) {
    const cityShort = (P.loc.city || "").replace(/(市|地区|自治州|盟)$/, "");
    const provShort = (P.loc.province || "").replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, "");
    const score = (e) =>
      (e.region.city === cityShort ? 0 : e.region.province.startsWith(provShort) ? 1 : 2) * 10000 +
      Math.abs(e.hazard.rainTotalMm - rain);
    return P.analogs.events.slice().sort((a, b) => score(a) - score(b))[0];
  }

  /* ---------- 前期降雨 ---------- */

  async function loadAntecedent() {
    const key = `${P.loc.lat},${P.loc.lng}`;
    if (P.antecedent[key] !== undefined) return;
    P.antecedent[key] = null;
    try {
      const d = await fetchJSON2(
        `https://api.open-meteo.com/v1/forecast?latitude=${P.loc.lat}&longitude=${P.loc.lng}` +
        `&daily=precipitation_sum&past_days=14&forecast_days=1&timezone=Asia%2FShanghai`);
      P.antecedent[key] = Math.round((d.daily.precipitation_sum || [])
        .filter((x) => x != null).reduce((a, b) => a + b, 0));
      render();
    } catch (e) { P.antecedent[key] = undefined; }
  }

  /* ---------- render ---------- */

  function render() {
    const box = document.getElementById("impact-summary");
    if (!P.storm || !P.regions) { if (box) box.innerHTML = ""; return; }
    const s = P.storm;
    const a = assess();
    const lv = LEVELS[a.level];
    const st = LV_STYLE[a.level];
    const last = s.track[s.track.length - 1];

    // 摘要：等级 + 一句话 + 时间窗（默认唯一可见的部分）
    const timeBrief = a.inRange.length
      ? `⏱ ${fmtTime(a.inRange[0].time)}起风雨${a.endPoint ? `，${fmtTime(a.endPoint.time)}结束` : a.stillInRangeAtEnd ? "，预报期内持续" : ""}`
      : `距你最近约 ${Math.round(a.closest.dist)} km，以外围影响为主`;
    box.innerHTML = `
      <div class="lv-badge lv-${a.level}">风险参考：${lv.name} ${"●".repeat(a.level)}${"○".repeat(4 - a.level)}</div>
      <div class="headline">${st.headline}</div>
      <div class="timebrief">${timeBrief} · 距 ${Math.round(haversine(P.loc.lat, P.loc.lng, last.lat, last.lng))} km</div>
      ${s.active === false ? `<div class="slow-badge">⚠️ 已停编，但残余环流仍可能强降雨——雨的风险未结束</div>` : ""}
      ${a.slowMover ? `<div class="slow-badge">🐌 停留型：移速仅约 ${Math.round(a.moveKmh)} km/h，危险在雨不在风</div>` : ""}`;

    // 详情一：时间线
    const tl = [];
    if (a.inRange.length) {
      tl.push([fmtTime(a.inRange[0].time), "风雨开始加强"]);
      tl.push([fmtTime(a.closest.time), `最近约 ${Math.round(a.closest.dist)} km，影响最强`]);
      if (a.endPoint) tl.push([fmtTime(a.endPoint.time), "风雨基本结束"]);
      else if (a.stillInRangeAtEnd) tl.push(["", "<b>⚠️ 预报期内未移出影响范围</b>"]);
      if (a.durationH) tl.push(["", `影响持续约 <b>${Math.round(a.durationH)} 小时</b>${a.slowMover ? "（停留型，明显偏长）" : ""}`]);
    }
    tl.push(["", `<span class="muted">预计雨量约 ${a.rain} mm（演示估算）</span>`]);
    const ante = P.antecedent[`${P.loc.lat},${P.loc.lng}`];
    if (ante != null) {
      tl.push(["", ante >= WET_SOIL_MM
        ? `🌧 过去两周已降 <b>${ante} mm</b>——雨将落在湿透的土地上，建议按上一档准备`
        : `<span class="muted">过去两周已降 ${ante} mm（前期偏干）</span>`]);
    }
    document.querySelector("#d-timeline > div").innerHTML =
      tl.map(([t, x]) => `<div class="tl-row">${t ? `<span class="t">${t}</span>` : ""}<span>${x}</span></div>`).join("");

    // 详情二：历史对照
    const analog = findAnalog(a.rain);
    const cityShort = (P.loc.city || "").replace(/(市|地区|自治州|盟)$/, "");
    const ratio = a.rain / analog.hazard.rainTotalMm;
    const compare = ratio > 1.3 ? "已超过" : ratio >= 0.7 ? "接近" : `约为其 ${Math.round(ratio * 100)}%，远小于`;
    document.querySelector("#d-analog > div").innerHTML = `
      预计雨量 ${a.rain}mm ${compare}
      <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>时${analog.region.city}的 ${analog.hazard.rainTotalMm}mm
      ${analog.region.city !== cityShort ? `<span class="muted">（${analog.region.city}案例，异地参考）</span>` : ""}
      <div class="quote">${analog.narrative}</div>`;

    // 详情三：清单（人群 × 情境）
    const items = checklistItems(a.level);
    document.querySelector("#d-checklist > div").innerHTML =
      items.map((item) => `
        <label class="check-row"><input type="checkbox"><span>${item}</span></label>`).join("") +
      `<div class="muted" style="margin-top:6px">依据气象部门防御指引与历史灾害经验整理 · 非官方预警</div>`;
    document.querySelectorAll("#d-checklist .check-row input").forEach((el2) => {
      el2.onchange = () => el2.closest(".check-row").classList.toggle("done", el2.checked);
    });
  }

  /* ---------- 分享卡 ---------- */

  function bindShare() {
    document.getElementById("share-btn").onclick = drawShareCard;
    document.getElementById("share-close").onclick = () =>
      (document.getElementById("share-modal").style.display = "none");
    document.getElementById("share-save").onclick = () => {
      const link = document.createElement("a");
      link.download = `台风${P.storm.name}-${locLabel()}影响卡.png`;
      link.href = document.getElementById("share-canvas").toDataURL("image/png");
      link.click();
    };
  }

  function drawShareCard() {
    if (!P.storm) return;
    const a = assess();
    const s = P.storm;
    const last = s.track[s.track.length - 1];
    const lv = LV_STYLE[a.level];
    const analog = findAnalog(a.rain);

    const W = 750, H = 1000, SCALE = 2;
    const canvas = document.getElementById("share-canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    const F = (w, px) => `${w} ${px}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#141a2a");
    bg.addColorStop(1, "#0c0f18");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#6b7386";
    ctx.font = F(600, 22);
    ctx.fillText("台风影响 · 分享卡", 48, 64);
    ctx.textAlign = "right";
    ctx.fillText(last.time.slice(0, 16), W - 48, 64);
    ctx.textAlign = "left";

    ctx.fillStyle = "#e8eaf0";
    ctx.font = F(800, 42);
    ctx.fillText(`${s.name} ${s.enName}`, 48, 136);
    ctx.fillStyle = "#9aa3b5";
    ctx.font = F(600, 26);
    ctx.fillText(`${last.strong} ${last.power}级 · 📍 ${P.loc.city || ""}${P.loc.district || ""}（大概位置）`, 48, 180);

    const pillText = `风险参考：${LEVELS[a.level].name} ${"●".repeat(a.level)}${"○".repeat(4 - a.level)}`;
    ctx.font = F(700, 26);
    const pw = ctx.measureText(pillText).width + 48;
    ctx.fillStyle = lv.color + "26";
    ctx.beginPath();
    ctx.roundRect(48, 214, pw, 56, 28);
    ctx.fill();
    ctx.fillStyle = lv.color;
    ctx.fillText(pillText, 72, 251);

    ctx.fillStyle = "#ffffff";
    ctx.font = F(800, 44);
    wrapText(ctx, lv.headline, 48, 356, W - 96, 58);
    ctx.fillStyle = "#9aa3b5";
    ctx.font = F(400, 24);
    ctx.fillText(
      a.slowMover ? "停留型台风：移速慢、下得久，危险在雨不在风"
        : lv.sub + " · 台风强度 ≠ 你受影响的程度", 48, 420);

    ctx.strokeStyle = "#232b42";
    ctx.beginPath();
    ctx.moveTo(48, 456);
    ctx.lineTo(W - 48, 456);
    ctx.stroke();

    ctx.font = F(400, 27);
    const facts = [
      ["当前距离", `约 ${Math.round(haversine(P.loc.lat, P.loc.lng, last.lat, last.lng))} km`],
      ["最强影响", a.inRange.length ? `${fmtTime(a.closest.time)}（最近约 ${Math.round(a.closest.dist)} km）` : "以外围影响为主"],
      a.endPoint
        ? ["预计结束", `${fmtTime(a.endPoint.time)}${a.durationH ? `（持续约 ${Math.round(a.durationH)} 小时）` : ""}`]
        : ["预计雨量", `约 ${a.rain} mm（演示估算）`],
    ];
    facts.forEach(([k, v], i) => {
      const y = 512 + i * 52;
      ctx.fillStyle = "#6b7386";
      ctx.fillText(k, 48, y);
      ctx.fillStyle = "#e8eaf0";
      ctx.fillText(v, 190, y);
    });

    ctx.fillStyle = "#161b29";
    ctx.beginPath();
    ctx.roundRect(48, 668, W - 96, 168, 14);
    ctx.fill();
    ctx.fillStyle = "#8ab0ff";
    ctx.font = F(700, 24);
    ctx.fillText(`历史对照 · ${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}（${analog.region.city}）`, 76, 712);
    ctx.fillStyle = "#c6ccd9";
    ctx.font = F(400, 24);
    wrapText(ctx, analog.narrative, 76, 752, W - 152, 36);

    ctx.fillStyle = "#e8eaf0";
    ctx.font = F(700, 26);
    ctx.fillText("现在该做的", 48, 880);
    ctx.font = F(400, 25);
    checklistItems(a.level).slice(0, 2).forEach((item, i) => {
      ctx.fillStyle = lv.color;
      ctx.fillText("☐", 48, 918 + i * 38);
      ctx.fillStyle = "#c6ccd9";
      wrapText(ctx, item, 84, 918 + i * 38, W - 132, 32);
    });

    ctx.fillStyle = "#565e70";
    ctx.font = F(400, 20);
    ctx.textAlign = "center";
    ctx.fillText("非官方预警 · 数据来源：温州台风网 · 请以气象部门发布为准", W / 2, H - 12);
    ctx.textAlign = "left";

    document.getElementById("share-modal").style.display = "flex";
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    let line = "", cy = y;
    for (const ch of text) {
      if (ctx.measureText(line + ch).width > maxWidth) {
        ctx.fillText(line, x, cy);
        line = ch;
        cy += lineHeight;
      } else {
        line += ch;
      }
    }
    if (line) ctx.fillText(line, x, cy);
  }

  /* ---------- utils ---------- */

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371, d = Math.PI / 180;
    const dLat = (lat2 - lat1) * d, dLng = (lng2 - lng1) * d;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function maxRadius(p) { return p && p.r7 ? Math.max(...p.r7) : null; }
  function ptime(p) { return new Date(p.time.replace(" ", "T")).getTime(); }

  function fmtTime(str) {
    if (!str) return "—";
    const m = str.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2})/);
    return m ? `${+m[3]}日${m[4]}时` : str;
  }

  async function fetchJSON2(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  return { init, update };
})();
