/* ImpactPanel — 底部「我会不会受灾」分步向导。
   步骤：地区 → 人群 → 环境 → 结果；已设置过的用户折叠为迷你摘要条。
   评估是全局的：我的位置 × 所有台风/残涡，取最危险系统定档。 */
const ImpactPanel = (() => {
  const SLOW_KMH = 18;
  const WET_SOIL_MM = 150;

  const LEVELS = {
    1: { name: "关注", tip: "留意后续预报即可" },
    2: { name: "准备", tip: "今天完成物资检查" },
    3: { name: "戒备", tip: "减少外出，防内涝停电" },
    4: { name: "高危", tip: "听从官方转移安排" },
  };
  const LV_STYLE = {
    1: { color: "#aaa69f", headline: "预报路径不经过你所在区域", sub: "不必被「超强台风」的标题吓到" },
    2: { color: "#c9a961", headline: "外围风雨会来，备点吃喝更安心", sub: "影响有限，做基础准备即可" },
    3: { color: "#ea8640", headline: "影响明显，今天完成防台准备", sub: "重点防内涝和停电" },
    4: { color: "#d0442c", headline: "可能严重受灾，紧盯官方通知", sub: "涉及转移请听从政府安排" },
  };

  const P = {
    storms: [],
    focusTfid: null,
    regions: null,
    checklists: null,
    analogs: null,
    loc: { province: "浙江省", city: "温州市", district: "鹿城区", lat: 28.0034, lng: 120.6742 },
    persona: "urban",
    situations: new Set(),
    antecedent: {},
    setupDone: false,
    open: false,
    step: "region",
  };

  /* ---------- init ---------- */

  async function init() {
    [P.regions, P.checklists, P.analogs, P.history] = await Promise.all([
      fetchJSON2("data/regions.json"),
      fetchJSON2("data/checklists.json"),
      fetchJSON2(`data/analogs.json?t=${Date.now()}`),
      fetchJSON2("data/history.json").catch(() => null), // 历史档案缺失时降级
    ]);
    restore();
    buildLocSelects();
    buildPersonaChips();
    bindShare();
    document.getElementById("btn-geo").onclick = useMyLocation;
    document.getElementById("dock-bar").onclick = () => setOpen(!P.open);
    document.querySelectorAll(".wiz-next, .wiz-back").forEach((b) => {
      b.onclick = () => gotoStep(b.dataset.to);
    });
    loadAntecedent();
    if (P.setupDone) P.step = "result";
    showStep(P.step);
    renderBar();
  }

  function updateAll(storms) {
    P.storms = (storms || []).filter((s) => s && s.track && s.track.length);
    renderBar();
    renderResult();
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem("ti_loc"));
      if (saved && P.regions[saved.province]) P.loc = saved;
      const persona = localStorage.getItem("ti_persona");
      if (persona) P.persona = persona;
      P.situations = new Set(JSON.parse(localStorage.getItem("ti_sits") || "[]"));
      P.setupDone = localStorage.getItem("ti_setup") === "1";
    } catch (e) { /* 忽略损坏的本地存储 */ }
  }

  function persist() {
    localStorage.setItem("ti_loc", JSON.stringify(P.loc));
    localStorage.setItem("ti_persona", P.persona);
    localStorage.setItem("ti_sits", JSON.stringify([...P.situations]));
    if (P.setupDone) localStorage.setItem("ti_setup", "1");
  }

  /* ---------- 向导流转 ---------- */

  function setOpen(open) {
    P.open = open;
    document.getElementById("impact-dock").classList.toggle("open", open);
    document.getElementById("dock-body").hidden = !open;
    if (open) showStep(P.step);
    renderBar();
  }

  function gotoStep(step) {
    // 人群无环境可选时跳过第 3 步
    if (step === "sit") {
      const cur = P.checklists.personas.find((p) => p.id === P.persona);
      if (!cur || !cur.situations || !cur.situations.length) step = "result";
    }
    if (step === "result") { P.setupDone = true; persist(); }
    P.step = step;
    showStep(step);
  }

  function showStep(step) {
    for (const s of ["region", "persona", "sit", "result"]) {
      document.getElementById(`step-${s}`).hidden = s !== step;
    }
    if (step === "result") renderResult();
  }

  function renderBar() {
    const bar = document.getElementById("dock-bar");
    if (!bar) return;
    if (P.open) {
      bar.innerHTML = `<span>我会不会受灾</span><span class="bar-right">收起</span>`;
      return;
    }
    if (!P.setupDone || !P.regions) {
      bar.innerHTML = `<span>我会不会受灾？</span><span class="bar-right" style="color:#ea8640">30 秒告诉你 →</span>`;
      return;
    }
    if (!P.storms.length) {
      bar.innerHTML = `<span>${locLabel()}</span><span class="bar-right">当前无活跃台风</span>`;
      return;
    }
    const { results } = assessAll();
    const top = results[0];
    const lv = LEVELS[top.a.level];
    const color = LV_STYLE[top.a.level].color;
    const brief = top.a.endPoint ? ` · ${fmtTime(top.a.endPoint.time)}结束` : "";
    bar.innerHTML = `
      <span>${locLabel()} · <span class="mini-lv" style="color:${color}">${lv.name}</span></span>
      <span class="bar-right">${top.s.name}${results.length > 1 ? ` 等${results.length}系统` : ""}${brief}</span>`;
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
    if (P.loc.district && cityNode && cityNode.districts[P.loc.district]) {
      [P.loc.lat, P.loc.lng] = cityNode.districts[P.loc.district];
    } else if (cityNode) {
      P.loc.lat = cityNode.lat; P.loc.lng = cityNode.lng;
    } else {
      P.loc.lat = prov.lat; P.loc.lng = prov.lng;
    }
    persist();
    loadAntecedent();
    renderBar();
    renderResult();
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    const btn = document.getElementById("btn-geo");
    btn.textContent = "…";
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
      btn.textContent = "定位";
      if (best && bestD < 300) {
        P.loc = best;
        buildLocSelects();
      }
    }, () => { btn.textContent = "定位"; });
  }

  function locLabel() {
    return P.loc.district || P.loc.city || P.loc.province;
  }

  /* ---------- 人群与环境 ---------- */

  function buildPersonaChips() {
    const el = document.getElementById("persona-row");
    el.innerHTML = P.checklists.personas.map((p) =>
      `<button class="chip ${p.id === P.persona ? "on" : ""}" data-p="${p.id}">${p.name}</button>`
    ).join("");
    el.querySelectorAll(".chip").forEach((b) => {
      b.onclick = () => { P.persona = b.dataset.p; P.situations.clear(); persist(); buildPersonaChips(); };
    });
    buildSituationRow();
  }

  function buildSituationRow() {
    const cur = P.checklists.personas.find((p) => p.id === P.persona);
    const sits = (cur && cur.situations) || [];
    const sitEl = document.getElementById("situation-row");
    sitEl.innerHTML = sits.length
      ? sits.map((s) =>
        `<label class="sit"><input type="checkbox" data-s="${s.id}" ${P.situations.has(s.id) ? "checked" : ""}>${s.name}</label>`
      ).join("")
      : `<span class="sit-none">该人群无需额外选择，直接查看结果即可</span>`;
    sitEl.querySelectorAll("input").forEach((i) => {
      i.onchange = () => { i.checked ? P.situations.add(i.dataset.s) : P.situations.delete(i.dataset.s); persist(); };
    });
  }

  function checklistItems(level) {
    const lists = P.checklists.items;
    const pick = (obj) => { for (let l = level; l >= 1; l--) if (obj && obj[l]) return obj[l]; return []; };
    let items = pick(lists[P.persona]).slice();
    if (P.persona === "urban") for (const s of P.situations) items = items.concat(pick(lists[s]));
    return items;
  }

  /* ---------- 评估 ---------- */

  function assess(s) {
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

  function assessAll() {
    const results = P.storms.map((s) => ({ s, a: assess(s) }));
    results.sort((x, y) => y.a.level - x.a.level || x.a.closest.dist - y.a.closest.dist);
    const focus = results.find((r) => r.s.tfid === P.focusTfid) || results[0];
    return { results, focus };
  }

  /* 对照严格同城优先：城市自己的历史才编码了它的排水、地形与基建。
     没有本地案例时只做「量级参考」，不做量化对比（异地不可比）。 */
  function findAnalog(rain) {
    const cityShort = (P.loc.city || "").replace(/(市|地区|自治州|盟)$/, "");
    const local = P.analogs.events.filter((e) => e.region.city === cityShort);
    if (local.length) {
      local.sort((a, b) => Math.abs(a.hazard.rainTotalMm - rain) - Math.abs(b.hazard.rainTotalMm - rain));
      return { analog: local[0], local: true };
    }
    const provShort = (P.loc.province || "").replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, "");
    const rest = P.analogs.events.slice().sort((a, b) =>
      ((a.region.province.startsWith(provShort) ? 0 : 1) * 10000 + Math.abs(a.hazard.rainTotalMm - rain)) -
      ((b.region.province.startsWith(provShort) ? 0 : 1) * 10000 + Math.abs(b.hazard.rainTotalMm - rain)));
    return { analog: rest[0] || null, local: false };
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
      renderResult();
    } catch (e) { P.antecedent[key] = undefined; }
  }

  /* ---------- 结果渲染 ---------- */

  function renderResult() {
    const box = document.getElementById("impact-summary");
    if (!box || P.step !== "result" || !P.regions) return;
    if (!P.storms.length) {
      box.innerHTML = `<div class="lv-badge lv-1"><b>无风</b>当前无活跃台风</div>
        <div class="timebrief">有台风生成时，这里会给出 ${locLabel()} 的风险参考</div>`;
      for (const id of ["d-timeline", "d-analog", "d-checklist"]) {
        document.querySelector(`#${id} > div`).innerHTML = "";
      }
      return;
    }

    const { results, focus } = assessAll();
    const s = focus.s, a = focus.a;
    const globalLevel = results[0].a.level;
    const lv = LEVELS[globalLevel];
    const last = s.track[s.track.length - 1];

    const multiRow = results.length > 1
      ? `<div class="storm-chips">${results.map((r) => `
          <button class="chip storm-chip ${r.s.tfid === s.tfid ? "on" : ""}" data-tf="${r.s.tfid}">
            ${r.s.name}${r.s.active === false ? "·残余" : ""}
            <b style="color:${LV_STYLE[r.a.level].color}">${LEVELS[r.a.level].name}</b>
          </button>`).join("")}</div>`
      : "";

    const timeBrief = a.inRange.length
      ? `${fmtTime(a.inRange[0].time)}起风雨${a.endPoint ? `，${fmtTime(a.endPoint.time)}结束` : a.stillInRangeAtEnd ? "，预报期内持续" : ""}`
      : `距你最近约 ${Math.round(a.closest.dist)} km，以外围影响为主`;
    box.innerHTML = `
      <div class="lv-badge lv-${globalLevel}"><b>${lv.name}</b>风险参考 · ${locLabel()}</div>
      ${results.length > 1 ? `<div class="timebrief" style="margin-top:3px">综合 ${results.length} 个台风/残涡系统的最高风险</div>` : ""}
      ${multiRow}
      <div class="headline">${results.length > 1 ? `${s.name}：` : ""}${LV_STYLE[a.level].headline}</div>
      <div class="timebrief">${timeBrief} · 距 ${Math.round(haversine(P.loc.lat, P.loc.lng, last.lat, last.lng))} km</div>
      ${s.active === false ? `<div class="slow-badge"><b>残余环流</b> —— 已停编，但残涡仍可能强降雨，雨的风险未结束</div>` : ""}
      ${a.slowMover ? `<div class="slow-badge"><b>停留型台风</b> —— 移速仅约 ${Math.round(a.moveKmh)} km/h，危险在雨不在风</div>` : ""}`;
    box.querySelectorAll(".storm-chip").forEach((b) => {
      b.onclick = () => { P.focusTfid = b.dataset.tf; renderResult(); };
    });

    // 时间线
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
        ? `过去两周已降 <b>${ante} mm</b> —— 雨将落在湿透的土地上，建议按上一档准备`
        : `<span class="muted">过去两周已降 ${ante} mm（前期偏干）</span>`]);
    }
    document.querySelector("#d-timeline > div").innerHTML =
      tl.map(([t, x]) => `<div class="tl-row">${t ? `<span class="t">${t}</span>` : ""}<span>${x}</span></div>`).join("");

    // 本地历史档案（IBTrACS 客观统计——你正在经历的是常态还是异常）
    let histHTML = "";
    const hist = P.history &&
      (P.history.d[`${P.loc.province}|${P.loc.city}|${P.loc.district || ""}`] ||
       P.history.d[`${P.loc.province}|${P.loc.city}|`]);
    if (hist) {
      const m = P.history.meta;
      const [c100, c300, month, top] = hist;
      const freq = c100 > 0 ? `，约每 ${Math.max(1, Math.round(m.years / c100))} 年一次` : "";
      histHTML = `
        <div style="margin-bottom:8px">
          本地档案 <span class="muted">（${m.source}，${m.since} 年以来）</span><br>
          台风中心 ${m.near_km}km 内经过 <b>${c100}</b> 次${freq}；${m.wide_km}km 内 ${c300} 次，${month} 月最高发<br>
          <span class="muted">最强过境：${top.map((t) => `${t[1]} ${t[0]}·距${t[2]}km`).join(" ／ ")}</span>
        </div>
        <div style="border-top:1px solid var(--hairline);padding-top:8px"></div>`;
    }

    // 历史对照：同城才做量化对比；异地只做量级参考并明说局限
    const { analog, local } = findAnalog(a.rain);
    let analogHTML = "";
    if (analog && local) {
      const ratio = a.rain / analog.hazard.rainTotalMm;
      const compare = ratio > 1.3 ? "已超过" : ratio >= 0.7 ? "接近" : `约为其 ${Math.round(ratio * 100)}%，远小于`;
      analogHTML = `
        预计雨量 ${a.rain}mm ${compare}
        <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>时本地的 ${analog.hazard.rainTotalMm}mm
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog) {
      analogHTML = `
        <span class="muted">本地（${P.loc.city}）暂无历史对照案例——异地案例无法体现本地排水与地形，
        不作量化对比。以下仅供感受同量级降雨的可能后果：</span>
        <div class="quote">${analog.narrative}</div>
        <span class="muted">欢迎依据《气象灾害年鉴》为本地补充案例（见仓库 CONTRIBUTING）。</span>`;
    }
    document.querySelector("#d-analog > div").innerHTML = histHTML + analogHTML;

    // 清单
    const items = checklistItems(a.level);
    document.querySelector("#d-checklist > div").innerHTML =
      items.map((item) => `
        <label class="check-row"><input type="checkbox"><span>${item}</span></label>`).join("") +
      `<div class="muted" style="margin-top:6px">依据气象部门防御指引与历史灾害经验整理 · 非官方预警</div>`;
    document.querySelectorAll("#d-checklist .check-row input").forEach((el2) => {
      el2.onchange = () => el2.closest(".check-row").classList.toggle("done", el2.checked);
    });

    renderBar();
  }

  /* ---------- 分享卡（现代版：示意图 + 数据宫格 + 行动建议） ---------- */

  function bindShare() {
    document.getElementById("share-btn").onclick = drawShareCard;
    document.getElementById("share-close").onclick = () =>
      (document.getElementById("share-modal").style.display = "none");
    document.getElementById("share-save").onclick = () => {
      const { focus } = assessAll();
      const link = document.createElement("a");
      link.download = `台风${focus ? focus.s.name : ""}-${locLabel()}影响卡.png`;
      link.href = document.getElementById("share-canvas").toDataURL("image/png");
      link.click();
    };
  }

  function drawShareCard() {
    if (!P.storms.length) return;
    const { focus } = assessAll();
    const a = focus.a, s = focus.s;
    const last = s.track[s.track.length - 1];
    const accent = LV_STYLE[a.level].color;
    const dist = haversine(P.loc.lat, P.loc.lng, last.lat, last.lng);

    const W = 750, H = 1120, SCALE = 2;
    const canvas = document.getElementById("share-canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    const F = (w, px) => `${w} ${px}px Georgia, "Songti SC", "STSong", "SimSun", serif`;

    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#25231f");
    bg.addColorStop(1, "#1a1916");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 顶栏
    ctx.fillStyle = "#76726a";
    ctx.font = F(600, 21);
    ctx.fillText("台风影响 · TYPHOON IMPACT", 36, 52);
    ctx.textAlign = "right";
    ctx.fillText(last.time.slice(5, 16), W - 36, 52);
    ctx.textAlign = "left";

    /* ---- 示意图 hero：你和台风的空间关系 ---- */
    const hx = 36, hy = 76, hw = W - 72, hh = 400;
    ctx.fillStyle = "#191814";
    roundRect(ctx, hx, hy, hw, hh, 18);
    ctx.fill();
    ctx.save();
    roundRect(ctx, hx, hy, hw, hh, 18);
    ctx.clip();

    // 经纬网底纹
    ctx.strokeStyle = "rgba(238,236,230,0.05)";
    ctx.lineWidth = 1;
    for (let gx = hx; gx < hx + hw; gx += 56) {
      ctx.beginPath(); ctx.moveTo(gx, hy); ctx.lineTo(gx, hy + hh); ctx.stroke();
    }
    for (let gy = hy; gy < hy + hh; gy += 56) {
      ctx.beginPath(); ctx.moveTo(hx, gy); ctx.lineTo(hx + hw, gy); ctx.stroke();
    }

    // 布局比例：让台风+风圈+用户都装进 hero
    const rMax = maxRadius(last) || 300;
    const span = Math.max(dist + rMax * 0.4, rMax * 2.1, 250);
    const scalePx = (hw - 190) / span;
    const cy = hy + hh / 2 + 14;
    const stormX = hx + 96 + rMax * scalePx * 0.25;
    const userX = Math.min(stormX + Math.max(dist, 40) * scalePx, hx + hw - 80);

    // 风圈（7/10/12 级）
    const rings = [
      { r: last.r7 ? Math.max(...last.r7) : null, c: "170, 166, 159", label: "7级风圈" },
      { r: last.r10 ? Math.max(...last.r10) : null, c: "201, 169, 97", label: "10级" },
      { r: last.r12 ? Math.max(...last.r12) : null, c: "234, 134, 64", label: "12级" },
    ];
    for (const ring of rings) {
      if (!ring.r) continue;
      const rp = ring.r * scalePx;
      ctx.fillStyle = `rgba(${ring.c}, 0.10)`;
      ctx.beginPath(); ctx.arc(stormX, cy, rp, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(${ring.c}, 0.55)`;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.arc(stormX, cy, rp, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 7级风圈标注（限制在画框内）
    if (rings[0].r) {
      ctx.fillStyle = "rgba(170,166,159,0.9)";
      ctx.font = F(400, 19);
      const lx = Math.max(hx + 16, stormX - rings[0].r * scalePx * 0.72);
      const ly = Math.max(hy + 30, cy - rings[0].r * scalePx * 0.72);
      ctx.fillText(`7级风圈 ${Math.round(rings[0].r)}km`, lx, ly);
    }

    // 台风本体：旋涡
    const core = ctx.createRadialGradient(stormX, cy, 2, stormX, cy, 30);
    core.addColorStop(0, "#ffffff");
    core.addColorStop(0.25, "#ea8640");
    core.addColorStop(1, "rgba(208,68,44,0)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(stormX, cy, 30, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(238,236,230,0.8)";
    ctx.lineWidth = 2.5;
    for (const off of [0, Math.PI]) {
      ctx.beginPath();
      for (let t = 0; t < 1.9; t += 0.08) {
        const rr = 8 + t * 13, ang = off + t * 2.4;
        const px2 = stormX + rr * Math.cos(ang), py2 = cy + rr * Math.sin(ang);
        t === 0 ? ctx.moveTo(px2, py2) : ctx.lineTo(px2, py2);
      }
      ctx.stroke();
    }
    // 距离近时标签错行，避免与用户标签重叠
    const labelsClose = userX - stormX < 170;
    ctx.lineWidth = 1;
    ctx.fillStyle = "#eeece6";
    ctx.font = F(700, 22);
    ctx.textAlign = "center";
    ctx.fillText(`${s.name} ${last.power}级`, stormX, labelsClose ? cy - 44 : cy + 56);
    ctx.textAlign = "left";

    // 连线 + 距离
    ctx.strokeStyle = "rgba(238,236,230,0.5)";
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(stormX + 34, cy); ctx.lineTo(userX - 20, cy); ctx.stroke();
    ctx.setLineDash([]);
    const midX = (stormX + userX) / 2;
    ctx.fillStyle = "#25231f";
    roundRect(ctx, midX - 62, cy - 42, 124, 34, 17);
    ctx.fill();
    ctx.strokeStyle = "#3a3733";
    roundRect(ctx, midX - 62, cy - 42, 124, 34, 17);
    ctx.stroke();
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 22);
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(dist)} km`, midX, cy - 18);
    ctx.textAlign = "left";

    // 用户位置
    ctx.fillStyle = "rgba(238,236,230,0.16)";
    ctx.beginPath(); ctx.arc(userX, cy, 17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#eeece6";
    ctx.beginPath(); ctx.arc(userX, cy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1a1916";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(userX, cy, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#eeece6";
    ctx.font = F(700, 22);
    ctx.textAlign = "center";
    ctx.fillText(`你 · ${locLabel()}`, Math.min(userX, hx + hw - 90), cy + 56);
    ctx.textAlign = "left";

    // hero 角标
    ctx.fillStyle = "rgba(238,236,230,0.35)";
    ctx.font = F(400, 17);
    ctx.fillText("示意图 · 非精确比例", hx + 16, hy + hh - 14);
    ctx.restore();

    // 等级徽章（hero 右上角，压边）
    const pillText = `${LEVELS[a.level].name} ${"●".repeat(a.level)}${"○".repeat(4 - a.level)}`;
    ctx.font = F(800, 24);
    const pw = ctx.measureText(pillText).width + 44;
    ctx.fillStyle = "#1a1916";
    roundRect(ctx, W - 36 - pw, hy + 14, pw, 46, 23);
    ctx.fill();
    ctx.fillStyle = accent + "33";
    roundRect(ctx, W - 36 - pw, hy + 14, pw, 46, 23);
    ctx.fill();
    ctx.strokeStyle = accent;
    roundRect(ctx, W - 36 - pw, hy + 14, pw, 46, 23);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillText(pillText, W - 36 - pw + 22, hy + 46);

    /* ---- 结论 ---- */
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 40);
    wrapText(ctx, LV_STYLE[a.level].headline, 36, 540, W - 72, 52);
    ctx.fillStyle = "#aaa69f";
    ctx.font = F(400, 22);
    ctx.fillText(a.slowMover ? "停留型台风：移速慢、下得久，危险在雨不在风"
      : "台风强度 ≠ 你受影响的程度，距离和路径才是关键", 36, 596);

    /* ---- 数据宫格 ---- */
    const stats = [
      { v: `${Math.round(dist)}`, u: "km", k: "当前距离" },
      { v: `${last.power}`, u: "级", k: "台风强度" },
      { v: `${a.rain}`, u: "mm", k: "预计雨量*" },
      { v: a.endPoint ? fmtTime(a.endPoint.time) : "—", u: "", k: "预计结束" },
    ];
    const gw = (W - 72 - 3 * 12) / 4;
    stats.forEach((st2, i) => {
      const gx = 36 + i * (gw + 12), gy = 628;
      ctx.fillStyle = "#26241e";
      roundRect(ctx, gx, gy, gw, 108, 14);
      ctx.fill();
      ctx.fillStyle = "#eeece6";
      ctx.font = F(800, st2.v.length > 5 ? 26 : 36);
      ctx.fillText(st2.v, gx + 16, gy + 52);
      if (st2.u) {
        ctx.fillStyle = "#aaa69f";
        ctx.font = F(600, 20);
        ctx.fillText(st2.u, gx + 18 + ctx.measureText(st2.v).width * (st2.v.length > 5 ? 1.35 : 1.85), gy + 52);
      }
      ctx.fillStyle = "#76726a";
      ctx.font = F(400, 20);
      ctx.fillText(st2.k, gx + 16, gy + 86);
    });

    /* ---- 行动建议 ---- */
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 26);
    ctx.fillText("现在该做的", 36, 796);
    const items = checklistItems(a.level).slice(0, 3);
    items.forEach((item, i) => {
      const iy = 830 + i * 74;
      ctx.fillStyle = "#26241e";
      roundRect(ctx, 36, iy, W - 72, 60, 12);
      ctx.fill();
      ctx.fillStyle = accent;
      roundRect(ctx, 52, iy + 19, 22, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#c9c5bc";
      ctx.font = F(400, 23);
      const text = item.length > 26 ? item.slice(0, 25) + "…" : item;
      ctx.fillText(text, 90, iy + 39);
    });

    // 底部
    ctx.fillStyle = "#76726a";
    ctx.font = F(400, 18);
    ctx.textAlign = "center";
    ctx.fillText("非官方预警 · 以气象部门发布为准 · *雨量为演示估算 · 数据：温州台风网", W / 2, H - 22);
    ctx.textAlign = "left";

    document.getElementById("share-modal").style.display = "flex";
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
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

  return { init, updateAll };
})();
