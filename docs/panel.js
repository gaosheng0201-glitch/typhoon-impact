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
    forecast: {},   // 数值模式逐小时预报（Open-Meteo），按坐标缓存
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
    loadForecast();
    if (P.setupDone) P.step = "result";
    showStep(P.step);
    renderBar();
  }

  function updateAll(storms) {
    P.storms = (storms || []).filter((s) => s && s.track && s.track.length);
    if (P.regions) loadForecast(); // 15 分钟 TTL，保持「此刻」新鲜
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
    const brief = top.a.phase === "during" ? (top.a.easing ? " · 已过峰值，减弱中" : " · 影响进行中")
      : top.a.phase === "after" ? (top.a.postRain24 >= 30 ? " · 已过境，雨未停" : " · 已过境")
      : top.a.win && !top.a.win.open ? ` · ${fmtTime(top.a.win.endTs)}结束`
      : top.a.closing ? " · 靠近中，待观察" : "";
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
    loadForecast();
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

  /* 按阶段选清单：远方靠近=出行与安排，来之前=备灾（人群×等级），
     进行中=避险，过境后=恢复期（含人群补充） */
  function phaseChecklist(a) {
    const ph = P.checklists.phases || {};
    if (a.phase === "during" && ph.during) return ph.during;
    if (a.phase === "after" && ph.after) {
      return ph.after.concat((ph.after_extra || {})[P.persona] || []);
    }
    if (a.phase === "approach" && !a.win && a.closing && ph.watch) {
      return ph.watch.concat((ph.watch_extra || {})[P.persona] || []);
    }
    return checklistItems(a.level);
  }

  /* ---------- 评估 ---------- */

  function assess(s) {
    const fc = s.forecasts["中国"] || Object.values(s.forecasts)[0];
    const path = s.track.slice(-4).concat(fc ? fc.points : [])
      .map((p) => ({ ...p, dist: haversine(P.loc.lat, P.loc.lng, p.lat, p.lng) }));

    const closest = path.reduce((a, b) => (b.dist < a.dist ? b : a));
    let galeR = 350;
    for (let i = s.track.length - 1; i >= Math.max(0, s.track.length - 5); i--) {
      const r = maxRadius(s.track[i]);
      if (r) { galeR = r; break; }
    }
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

    // 本地天气窗口：直接用数值模式逐小时序列判定「风雨何时开始/结束」。
    // 外围雨带常远早于风圈几何（巴威在温州提前8小时）——几何窗口只作模式缺失时的回退。
    const fdata = P.forecast[`${P.loc.lat},${P.loc.lng}`];
    let win = null; // {startT,endT,startTs,endTs,src,open}
    if (inRange.length) {
      const endP = endPoint || inRange[inRange.length - 1];
      win = { startT: ptime(inRange[0]), endT: ptime(endP),
              startTs: inRange[0].time, endTs: endP.time,
              src: "几何", open: !endPoint && stillInRangeAtEnd };
    }
    // 相关性门槛：台风最近距离远超风圈时，本地降雨与台风无关，不建时间窗、不归因
    const relevant = inRange.length > 0 || closest.dist <= galeR * 1.25;
    let rain, rainSrc = "演示估算", peakRain = null, peakGust = null;
    if (fdata && !relevant) {
      rain = 0;
      rainSrc = "模式预报";
      win = null;
    } else if (fdata) {
      // 门槛：≥1.5mm/h 的实质降雨或≥8级阵风才算「台风风雨」；
      // 间断>6小时即分段，只取包含台风最近时刻的那段——把梅雨和事后零星降雨排除在归因外
      const RAIN_ON = 1.5, GUST_ON = 62, GAP_H = 6;
      const anchor = ptime(closest);
      const lo = anchor - 36 * 3.6e6, hi = anchor + 48 * 3.6e6;
      const segs = [];
      let cur = null;
      for (let i = 0; i < fdata.t.length; i++) {
        if (fdata.t[i] < lo || fdata.t[i] > hi) continue;
        if ((fdata.p[i] || 0) >= RAIN_ON || (fdata.g[i] || 0) >= GUST_ON) {
          if (cur && fdata.t[i] - fdata.t[cur.iL] > GAP_H * 3.6e6) { segs.push(cur); cur = null; }
          if (!cur) cur = { iF: i, iL: i };
          else cur.iL = i;
        }
      }
      if (cur) segs.push(cur);
      // 选包含 anchor 的段；都不包含则选离 anchor 最近的
      let seg = segs.find((sg) => fdata.t[sg.iF] <= anchor && anchor <= fdata.t[sg.iL] + GAP_H * 3.6e6);
      if (!seg && segs.length) {
        seg = segs.reduce((a2, b2) =>
          Math.min(Math.abs(fdata.t[a2.iF] - anchor), Math.abs(fdata.t[a2.iL] - anchor)) <
          Math.min(Math.abs(fdata.t[b2.iF] - anchor), Math.abs(fdata.t[b2.iL] - anchor)) ? a2 : b2);
      }
      const iF = seg ? seg.iF : -1, iL = seg ? seg.iL : -1;
      rain = 0;
      if (iF >= 0) {
        win = { startT: fdata.t[iF], endT: fdata.t[iL],
                startTs: fdata.ts[iF].replace("T", " ") + ":00",
                endTs: fdata.ts[iL].replace("T", " ") + ":00",
                src: "模式", open: iL >= fdata.t.length - 2 };
        for (let i = iF; i <= iL; i++) {
          rain += fdata.p[i] || 0;
          if (!peakRain || (fdata.p[i] || 0) > peakRain.v) peakRain = { ts: fdata.ts[i], v: fdata.p[i] || 0 };
          if (!peakGust || (fdata.g[i] || 0) > peakGust.v) peakGust = { ts: fdata.ts[i], v: fdata.g[i] || 0 };
        }
      }
      rain = Math.round(rain);
      rainSrc = "模式预报";
      if (peakRain && peakRain.v < 1) peakRain = null;
      if (peakGust && peakGust.v < 40) peakGust = null;
    } else {
      rain = closest.dist < 80 ? 260 : closest.dist < 150 ? 180
        : closest.dist < 250 ? 100 : closest.dist < 400 ? 50 : 15;
      if (slowMover) rain = Math.round(rain * 1.6);
    }

    const power = parseInt(closest.power) || 0;
    let level = 1;
    if (rain >= 60 || (closest.dist < galeR && power >= 8)) level = 2;
    if (rain >= 150 || (closest.dist < 200 && power >= 10)) level = 3;
    if (rain >= 250 || (closest.dist < 100 && power >= 14)) level = 4;
    if (slowMover && closest.dist < galeR) level = Math.max(level, 3);

    // 阶段：来之前 / 影响进行中 / 已过境。过境 ≠ 结束——残余降雨单独判断（美莎克教训）
    const nowT = Date.now();
    let phase = "approach";
    if (win && nowT >= win.startT) {
      phase = (win.open || nowT <= win.endT) ? "during" : "after";
    }
    if (win) durationH = (win.endT - win.startT) / 3.6e6;

    // 此刻锚点：优先 15 分钟级 current，整点槽仅回退
    let nowWx = null, easing = false;
    if (fdata) {
      if (fdata.cur && fdata.cur.rain != null) {
        nowWx = { rain: fdata.cur.rain, gust: fdata.cur.gust || 0 };
      } else {
        let iNow = -1;
        for (let i = 0; i < fdata.t.length; i++) if (fdata.t[i] <= nowT) iNow = i;
        if (iNow >= 0) nowWx = { rain: fdata.p[iNow] || 0, gust: fdata.g[iNow] || 0 };
      }
      if (nowWx) {
        easing = phase === "during" && ptime(closest) < nowT &&
          nowWx.rain < 1.5 && nowWx.gust < 62;
      }
    }
    // 已过峰值且未来24h雨量有限：档位回落——「正在减弱」与「戒备」不该同屏
    if (easing && postRain24 !== null && postRain24 < 30) level = Math.min(level, 2);
    let postRain24 = null;
    if (fdata) {
      postRain24 = 0;
      for (let i = 0; i < fdata.t.length; i++) {
        if (fdata.t[i] >= nowT && fdata.t[i] <= nowT + 24 * 3.6e6) postRain24 += fdata.p[i] || 0;
      }
      postRain24 = Math.round(postRain24);
    }
    // 已过境且残余降雨有限时，档位自然回落
    if (phase === "after" && postRain24 !== null && postRain24 < 30) level = Math.min(level, 2);

    // 远台风趋势：预报期末距离比当前明显拉近 = 正朝你来。
    // 官方预报只有约5天——「现有预报未覆盖到你」≠「不会来」，绝不能提前安抚
    let closing = false, fcEndTs = null;
    if (!win) {
      const lastFix = s.track[s.track.length - 1];
      const nowDist = haversine(P.loc.lat, P.loc.lng, lastFix.lat, lastFix.lng);
      closing = closest.dist < nowDist - 150;
      if (fc && fc.points.length) fcEndTs = fc.points[fc.points.length - 1].time;
    }

    return { closest, galeR, inRange, win, rain, rainSrc, peakRain, peakGust, phase, postRain24,
             nowWx, easing, closing, fcEndTs,
             level, moveKmh, slowMover, durationH, endPoint, stillInRangeAtEnd };
  }

  /* 此刻天气的人话描述（小时雨强口径：<2.5 小雨 / <8 中雨 / <16 大雨 / ≥16 暴雨强度） */
  function nowWxDesc(w) {
    const r = w.rain < 0.1 ? "基本无雨" : w.rain < 2.5 ? "小雨" : w.rain < 8 ? "中雨"
      : w.rain < 16 ? "大雨" : "暴雨强度";
    const num = w.rain >= 0.1 ? `（约 ${Math.round(w.rain * 10) / 10} mm/h）` : "";
    return `${r}${num} · 阵风约${gustLevel(w.gust)}级`;
  }

  /* 阶段化标题：不同阶段说不同的话 */
  function headlineFor(a) {
    if (a.phase === "during") return a.easing ? "风雨已过峰值，正在减弱" : "风雨影响进行中，减少外出";
    if (a.phase === "after") {
      return a.postRain24 !== null && a.postRain24 >= 30
        ? "台风已过境，但雨还没停——警惕滞后内涝与山洪"
        : "台风已过境，恢复期注意安全";
    }
    if (!a.win && a.closing) return "台风还远，是否影响你尚无法判断";
    return LV_STYLE[a.level].headline;
  }

  function assessAll() {
    const results = P.storms.map((s) => ({ s, a: assess(s) }));
    results.sort((x, y) => y.a.level - x.a.level || x.a.closest.dist - y.a.closest.dist);
    const focus = results.find((r) => r.s.tfid === P.focusTfid) || results[0];
    return { results, focus };
  }

  /* 对照严格同城优先：城市自己的历史才编码了它的排水、地形与基建。
     没有本地案例时只做「量级参考」，不做量化对比（异地不可比）。 */
  /* 行政区名规范化：儋州市→儋州、陵水黎族自治县→陵水、湘西…自治州→湘西、屏东县→屏东。
     与 scripts/validate_analogs.py 的规则保持一致。 */
  function canonCity(x) {
    const m = /^(.*?)(?:(?:黎族|苗族|土家族|侗族|仡佬族|各族)*自治[县州]|市|县|地区|盟)$/.exec(x || "");
    return m && m[1] ? m[1] : (x || "");
  }

  function findAnalog(rain, power = 0) {
    const cityShort = canonCity(P.loc.city);
    const local = P.analogs.events.filter((e) =>
      canonCity(e.region.city) === cityShort || e.region.city === P.loc.city);
    if (local.length) {
      // 最强纪录：风力优先，其次影响等级，再次雨量——天花板锚点，永不隐身
      const strongest = local.slice().sort((a, b) =>
        (b.hazard.peakPower || 0) - (a.hazard.peakPower || 0) ||
        (b.impact.level || 0) - (a.impact.level || 0) ||
        (b.hazard.rainTotalMm || 0) - (a.hazard.rainTotalMm || 0))[0];
      // 最相似：来袭为强风型（≥13级）且本地有风力记录 → 按登陆强度匹配；否则按雨量
      if (power >= 13) {
        const withWind = local.filter((e) => e.hazard.peakPower != null);
        if (withWind.length) {
          withWind.sort((a, b) => Math.abs(a.hazard.peakPower - power) - Math.abs(b.hazard.peakPower - power));
          return { analog: withWind[0], local: true, quant: true, mode: "wind", strongest };
        }
      }
      const withRain = local.filter((e) => e.hazard.rainTotalMm != null);
      if (withRain.length) {
        withRain.sort((a, b) => Math.abs(a.hazard.rainTotalMm - rain) - Math.abs(b.hazard.rainTotalMm - rain));
        return { analog: withRain[0], local: true, quant: true, mode: "rain", strongest };
      }
      local.sort((a, b) => (b.impact.level || 0) - (a.impact.level || 0));
      return { analog: local[0], local: true, quant: false, strongest };
    }
    const provShort = (P.loc.province || "").replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, "");
    const rest = P.analogs.events.filter((e) => e.hazard.rainTotalMm != null).sort((a, b) =>
      ((a.region.province.startsWith(provShort) ? 0 : 1) * 10000 + Math.abs(a.hazard.rainTotalMm - rain)) -
      ((b.region.province.startsWith(provShort) ? 0 : 1) * 10000 + Math.abs(b.hazard.rainTotalMm - rain)));
    return { analog: rest[0] || null, local: false, quant: false };
  }

  /* ---------- 数值模式预报（逐小时降水与阵风） ---------- */

  async function loadForecast() {
    const key = `${P.loc.lat},${P.loc.lng}`;
    const cached = P.forecast[key];
    if (cached === null) return; // 请求进行中
    if (cached && Date.now() - cached.at < 15 * 60e3) return; // 15 分钟内视为新鲜
    P.forecast[key] = null;
    try {
      const d = await fetchJSON2(
        `https://api.open-meteo.com/v1/forecast?latitude=${P.loc.lat}&longitude=${P.loc.lng}` +
        `&hourly=precipitation,wind_gusts_10m&current=precipitation,wind_gusts_10m` +
        `&past_days=2&forecast_days=7&timezone=Asia%2FShanghai`);
      P.forecast[key] = {
        at: Date.now(),
        ts: d.hourly.time, // 北京钟面原文，用于展示
        t: d.hourly.time.map((s) => new Date(s + ":00+08:00").getTime()),
        p: d.hourly.precipitation,
        g: d.hourly.wind_gusts_10m,
        // 15 分钟级当前实况——「此刻」必须用它，整点槽可能滞后近一小时
        cur: d.current ? { rain: d.current.precipitation, gust: d.current.wind_gusts_10m } : null,
      };
      renderBar();
      renderResult();
    } catch (e) { delete P.forecast[key]; }
  }

  /* 阵风 km/h → 蒲福风级（近似） */
  function gustLevel(kmh) {
    const ms = kmh / 3.6;
    const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37, 41.5, 46.2, 51, 56.1];
    let lv = 0;
    while (lv < t.length && ms >= t[lv]) lv++;
    return lv;
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

    let timeBrief;
    if (a.win && a.phase === "during") {
      timeBrief = `${fmtTime(a.win.startTs)}已开始${a.win.open ? "，预报期内持续" : `，预计 ${fmtTime(a.win.endTs)}基本结束`}`;
    } else if (a.win && a.phase === "after") {
      timeBrief = `已于 ${fmtTime(a.win.endTs)} 基本结束` +
        (a.postRain24 !== null && a.postRain24 >= 30 ? `，未来24h仍有约 ${a.postRain24} mm 降雨` : "");
    } else if (a.win) {
      timeBrief = `${fmtTime(a.win.startTs)}起风雨${a.win.open ? "，预报期内持续" : `，${fmtTime(a.win.endTs)}结束`}`;
    } else if (a.closing) {
      timeBrief = `正向你的方向移动，现有预报${a.fcEndTs ? `（至 ${fmtTime(a.fcEndTs)}）` : "（约5天）"}尚未覆盖到你——建议每天回来看一眼`;
    } else {
      timeBrief = `距你最近约 ${Math.round(a.closest.dist)} km，以外围影响为主`;
    }
    box.innerHTML = `
      <div class="lv-badge lv-${globalLevel}"><b>${lv.name}</b>风险参考 · ${locLabel()}</div>
      ${results.length > 1 ? `<div class="timebrief" style="margin-top:3px">综合 ${results.length} 个台风/残涡系统的最高风险</div>` : ""}
      ${multiRow}
      <div class="headline">${results.length > 1 ? `${s.name}：` : ""}${headlineFor(a)}</div>
      <div class="timebrief">${timeBrief} · 距 ${Math.round(haversine(P.loc.lat, P.loc.lng, last.lat, last.lng))} km</div>
      ${a.nowWx ? `<div class="timebrief">此刻本地：${nowWxDesc(a.nowWx)}<span class="muted">（模式实况，以体感为准）</span></div>` : ""}
      ${s.active === false ? `<div class="slow-badge"><b>残余环流</b> —— 已停编，但残涡仍可能强降雨，雨的风险未结束</div>` : ""}
      ${a.slowMover ? `<div class="slow-badge"><b>停留型台风</b> —— 移速仅约 ${Math.round(a.moveKmh)} km/h，危险在雨不在风</div>` : ""}`;
    box.querySelectorAll(".storm-chip").forEach((b) => {
      b.onclick = () => { P.focusTfid = b.dataset.tf; renderResult(); };
    });

    // 时间线（区分已发生/未发生；时间窗来自本地逐时天气序列，几何仅回退）
    const nowT = Date.now();
    const tl = [];
    if (a.win) {
      tl.push([fmtTime(a.win.startTs), a.win.startT < nowT ? "风雨已开始" : "预计风雨开始"]);
      tl.push([fmtTime(a.closest.time), ptime(a.closest) < nowT
        ? `台风最近时刻已过（约 ${Math.round(a.closest.dist)} km）`
        : `台风最近约 ${Math.round(a.closest.dist)} km`]);
      if (a.win.open) tl.push(["", "<b>预报期内未见明显结束信号</b>——警惕累计雨量"]);
      else tl.push([fmtTime(a.win.endTs), a.win.endT < nowT ? "风雨已基本结束" : "预计风雨基本结束"]);
      if (a.phase === "after" && a.postRain24 !== null && a.postRain24 >= 1) {
        tl.push(["", a.postRain24 >= 30
          ? `<b>未来24小时预计仍有约 ${a.postRain24} mm 降雨</b>——过境不等于结束（模式预报）`
          : `<span class="muted">未来24小时残余降雨约 ${a.postRain24} mm（模式预报）</span>`]);
      }
      if (a.durationH && a.phase === "approach") tl.push(["", `影响持续约 <b>${Math.round(a.durationH)} 小时</b>${a.slowMover ? "（停留型，明显偏长）" : ""}`]);
      tl.push(["", `<span class="muted">时间窗来源：${a.win.src === "模式" ? "本地逐时数值预报" : "官方路径几何推算"}</span>`]);
    }
    if (a.win) {
      tl.push(["", `预计过程雨量约 <b>${a.rain} mm</b><span class="muted">（${a.rainSrc === "模式预报" ? "数值模式预报" : "演示估算，模式数据加载中"}）</span>`]);
    } else if (a.closing) {
      tl.push(["", `<b>台风正向你的方向移动</b>，现有预报${a.fcEndTs ? `（至 ${fmtTime(a.fcEndTs)}）` : ""}范围内尚不会影响本地。`]);
      tl.push(["", `<span class="muted">5 天外的路径不确定性很大——预报每 6 小时更新，请每天回来查看，等它进入预报可判断范围。</span>`]);
    } else {
      tl.push(["", `<span class="muted">本台风预计不会给本地带来明显风雨（最近约 ${Math.round(a.closest.dist)} km，远超其风圈）。本地若有降雨，属于正常天气过程，与该台风无关。</span>`]);
    }
    if (a.peakRain) tl.push([fmtTime(a.peakRain.ts.replace("T", " ")), `本地雨强峰值（约 ${Math.round(a.peakRain.v)} mm/h，模式预报）`]);
    if (a.peakGust) tl.push([fmtTime(a.peakGust.ts.replace("T", " ")), `本地阵风最强（约 ${gustLevel(a.peakGust.v)} 级，模式预报）`]);
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
    const inPower = parseInt(a.closest.power) || 0;
    const { analog, local, quant, mode, strongest } = findAnalog(a.rain, inPower);
    let analogHTML = "";
    if (analog && local && quant && mode === "wind") {
      analogHTML = `
        本次为强风型台风（约 ${inPower} 级），本地最接近的记忆：
        <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>（${analog.hazard.peakPower} 级）
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog && local && quant) {
      const ratio = a.rain / analog.hazard.rainTotalMm;
      const compare = ratio > 1.3 ? "已超过" : ratio >= 0.7 ? "接近" : `约为其 ${Math.round(ratio * 100)}%，远小于`;
      analogHTML = `
        预计雨量 ${a.rain}mm ${compare}
        <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>时本地的 ${analog.hazard.rainTotalMm}mm
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog && local) {
      analogHTML = `
        本地案例：<b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>
        <span class="muted">（该案例无雨量记录，不作量化对比）</span>
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog && a.rain >= 50 && analog.hazard.rainTotalMm <= a.rain * 2.5 && analog.hazard.rainTotalMm >= a.rain * 0.4) {
      // 异地量级参考：仅当预计雨量可观且与案例确实同量级时才展示
      analogHTML = `
        <span class="muted">本地（${P.loc.city}）暂无历史对照案例——异地案例无法体现本地排水与地形，
        不作量化对比。以下仅供感受同量级降雨的可能后果：</span>
        <div class="quote">${analog.narrative}</div>
        <span class="muted">欢迎依据《气象灾害年鉴》为本地补充案例（见仓库 CONTRIBUTING）。</span>`;
    } else {
      analogHTML = `
        <span class="muted">本地（${P.loc.city}）暂无历史对照案例${a.rain < 50 ? "，且本次预计雨量有限，无需对照" : "，且现有案例与本次量级差距过大，不作参考"}。
        欢迎依据《气象灾害年鉴》为本地补充案例（见仓库 CONTRIBUTING）。</span>`;
    }
    if (strongest && analog && strongest.eventId !== analog.eventId) {
      const sp2 = strongest.hazard.peakPower ? `（${strongest.hazard.peakPower}级${strongest.hazard.landfall ? "登陆" : ""}）` : "";
      analogHTML += `
        <div style="border-top:1px solid var(--hairline);margin-top:8px;padding-top:8px">
          本地最强纪录：<b>${strongest.typhoon.tfid.slice(0, 4)}年${strongest.typhoon.name}</b>${sp2}
          <div class="quote">${strongest.narrative}</div>
        </div>`;
    }
    document.querySelector("#d-analog > div").innerHTML = histHTML + analogHTML;

    // 清单（按阶段：备灾 / 避险 / 恢复期）
    const items = phaseChecklist(a);
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

    // 整卡圆角（导出 PNG 四角透明）
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.clip();

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

    /* ---- 示意图 hero：固定优雅构图；风圈按比例，保留「是否在圈内」的物理真实 ---- */
    const hx = 36, hy = 76, hw = W - 72, hh = 380;
    ctx.fillStyle = "#191814";
    roundRect(ctx, hx, hy, hw, hh, 16);
    ctx.fill();
    ctx.save();
    roundRect(ctx, hx, hy, hw, hh, 16);
    ctx.clip();

    // 细网格
    ctx.strokeStyle = "rgba(238,236,230,0.04)";
    ctx.lineWidth = 1;
    for (let gx = hx; gx < hx + hw; gx += 56) { ctx.beginPath(); ctx.moveTo(gx, hy); ctx.lineTo(gx, hy + hh); ctx.stroke(); }
    for (let gy = hy; gy < hy + hh; gy += 56) { ctx.beginPath(); ctx.moveTo(hx, gy); ctx.lineTo(hx + hw, gy); ctx.stroke(); }

    const cy = hy + hh * 0.44;
    const stormX = hx + hw * 0.30;
    const RING = 116; // 7级风圈固定显示半径
    const pxKm = RING / a.galeR;
    const userX = stormX + Math.max(46, Math.min(dist * pxKm, hw * 0.56));
    const closeLbl = userX - stormX < 180; // 标签防重叠

    // 风圈三层同心（内实外虚，暖调渐淡）
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(234,134,64,0.30)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(stormX, cy, RING * 0.42, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(234,134,64,0.18)";
    ctx.beginPath(); ctx.arc(stormX, cy, RING * 0.72, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(201,169,97,0.55)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(stormX, cy, RING, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(201,169,97,0.75)";
    ctx.font = F(400, 18);
    ctx.textAlign = "center";
    ctx.fillText(`7级风圈 ${Math.round(a.galeR)} km`, stormX, cy - RING - 12);

    // 台风核心：辉光 + 旋臂
    const core = ctx.createRadialGradient(stormX, cy, 2, stormX, cy, 42);
    core.addColorStop(0, "#fff7ef");
    core.addColorStop(0.3, "#ea8640");
    core.addColorStop(1, "rgba(208,68,44,0)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(stormX, cy, 42, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(29,28,24,0.85)";
    ctx.lineWidth = 3;
    for (const off of [0, Math.PI]) {
      ctx.beginPath();
      let first = true;
      for (let t = 0.15; t < 1.75; t += 0.06) {
        const rr = 4 + t * 14, ang = off + t * 2.6;
        const px2 = stormX + rr * Math.cos(ang), py2 = cy + rr * Math.sin(ang);
        first ? ctx.moveTo(px2, py2) : ctx.lineTo(px2, py2);
        first = false;
      }
      ctx.stroke();
    }

    // 连线（避开两端图形）+ 距离数字
    const lineA = stormX + 50, lineB = userX - 26;
    if (lineB > lineA + 16) {
      ctx.strokeStyle = "rgba(238,236,230,0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 7]);
      ctx.beginPath(); ctx.moveTo(lineA, cy); ctx.lineTo(lineB, cy); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 30);
    ctx.fillText(`${Math.round(dist)} km`, Math.max((stormX + userX) / 2, stormX + 96), cy - 18);

    // 你的位置：光环 + 骨白点
    ctx.fillStyle = "rgba(238,236,230,0.14)";
    ctx.beginPath(); ctx.arc(userX, cy, 19, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#eeece6";
    ctx.beginPath(); ctx.arc(userX, cy, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1d1c18"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(userX, cy, 7.5, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;

    // 标签：固定基线；距离近时用户标签换行避让
    ctx.font = F(700, 23);
    ctx.fillStyle = "#eeb28f";
    ctx.fillText(`${s.name} · ${last.power}级`, stormX, cy + RING + 34);
    ctx.fillStyle = "#eeece6";
    ctx.fillText(`你 · ${locLabel()}`, closeLbl ? userX + 40 : userX, closeLbl ? cy + RING + 64 : cy + RING + 34);
    if (dist <= a.galeR) {
      ctx.fillStyle = "rgba(234,134,64,0.9)";
      ctx.font = F(400, 19);
      ctx.fillText("你在其 7 级风圈范围内", (stormX + userX) / 2, cy + 40);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(238,236,230,0.3)";
    ctx.font = F(400, 16);
    ctx.fillText("示意图 · 风圈与距离同比例", hx + 16, hy + hh - 14);
    ctx.restore();

    /* ---- 结论 ---- */
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 40);
    wrapText(ctx, headlineFor(a), 36, 540, W - 72, 52);
    ctx.fillStyle = "#aaa69f";
    ctx.font = F(400, 22);
    ctx.fillText(a.slowMover ? "停留型台风：移速慢、下得久，危险在雨不在风"
      : "台风强度 ≠ 你受影响的程度，距离和路径才是关键", 36, 596);

    /* ---- 数据宫格 ---- */
    const stats = [
      { v: `${Math.round(dist)}`, u: "km", k: "当前距离" },
      { v: `${last.power}`, u: "级", k: "台风强度" },
      { v: `${a.rain}`, u: "mm", k: a.phase === "approach" ? "预计雨量" : "过程雨量" },
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
    const items = phaseChecklist(a).slice(0, 3);
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
    ctx.fillText("非官方预警 · 以气象部门发布为准 · 公益项目 by 日成Risen · typhoon-impact", W / 2, H - 22);
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
  /* 数据时间均为北京时间：显式按 +08:00 解析，海外浏览器也能与 Date.now() 正确比较 */
  function ptime(p) { return new Date(p.time.replace(" ", "T") + "+08:00").getTime(); }

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
