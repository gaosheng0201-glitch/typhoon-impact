/* 影响卡片原型 — 把台风路径数据翻译成「会不会影响我 / 什么时候 / 该做什么」
   雨量为按距离的演示估算；正式版接 WeatherNext 降水格点。 */

const CITIES = {
  "温州": { lat: 27.99, lng: 120.70, province: "浙江" },
  "台州": { lat: 28.66, lng: 121.42, province: "浙江" },
  "宁波": { lat: 29.87, lng: 121.54, province: "浙江" },
  "上海": { lat: 31.23, lng: 121.47, province: "上海" },
  "杭州": { lat: 30.27, lng: 120.16, province: "浙江" },
};

/* 风险参考分档：本应用不发布预警，仅依据客观数据与官方防御指引做参考提示 */
const LEVELS = {
  1: { name: "关注", tip: "留意后续预报即可" },
  2: { name: "准备", tip: "今天完成物资检查" },
  3: { name: "戒备", tip: "减少外出，防内涝停电" },
  4: { name: "高危", tip: "听从官方转移安排" },
};

const CHECKLISTS = {
  1: ["留意台风路径更新", "检查手电筒、充电宝是否可用"],
  2: ["手机、充电宝全部充满电", "储备 3 天饮用水和方便食品", "收好阳台、窗台易坠物", "检查家中排水口、门窗密封"],
  3: ["车辆从地下车库移至高处", "避免外出，远离广告牌和大树", "浴缸蓄水备用（冲厕等）", "备好应急包（证件、药品、现金）", "关注小区停水停电通知"],
  4: ["随时听从社区/应急部门转移安排", "贵重物品移至高层", "保持手机畅通，告知家人去向", "低洼、山边、危房住户提前投亲靠友"],
};

const state = { storm: null, analogs: null, city: "温州" };

init();

async function init() {
  const [index, analogs] = await Promise.all([
    TyphoonData.loadIndex(),
    fetchJSON(`data/analogs.json?t=${Date.now()}`),
  ]);
  state.analogs = analogs;
  if (!index.typhoons.length) {
    document.getElementById("storm-line").textContent = "当前无活跃台风";
    return;
  }
  state.storm = await TyphoonData.loadStorm(index.typhoons[0].tfid, index.live);

  const sel = document.getElementById("city-select");
  sel.innerHTML = Object.keys(CITIES)
    .map((c) => `<option ${c === state.city ? "selected" : ""}>${c}</option>`)
    .join("");
  sel.onchange = () => { state.city = sel.value; render(); };
  bindShare();
  render();
}

/* ---------- assessment ---------- */

const SLOW_KMH = 18; // 低于此移速视为停留型台风（累计雨量风险主导）

function assess() {
  const s = state.storm;
  const city = CITIES[state.city];
  const fc = s.forecasts["中国"] || Object.values(s.forecasts)[0];

  // path = 最近几个实况点 + 预报点，估算过境时间窗
  const path = s.track.slice(-4).concat(fc ? fc.points : [])
    .map((p) => ({ ...p, dist: haversine(city.lat, city.lng, p.lat, p.lng) }));

  const closest = path.reduce((a, b) => (b.dist < a.dist ? b : a));
  const galeR = maxRadius(s.track[s.track.length - 1]) || 350;
  const inRange = path.filter((p) => p.dist < galeR);

  // 移速：预报路径点间距 ÷ 时间差。移速慢 = 停留久 = 累计雨量大
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

  // 影响时长与结束时刻
  let durationH = null, endPoint = null, stillInRangeAtEnd = false;
  if (inRange.length) {
    durationH = (ptime(inRange[inRange.length - 1]) - ptime(inRange[0])) / 3.6e6;
    const after = path.filter((p) => ptime(p) > ptime(closest));
    endPoint = after.find((p) => p.dist >= galeR) || null;
    stillInRangeAtEnd = !endPoint && path[path.length - 1].dist < galeR;
    if (slowMover && durationH) durationH = Math.round(durationH);
  }

  // 演示雨量估算：随最近距离衰减；停留型按持续时间加成
  // （正式版换 WeatherNext 降水格点的真实累计值）
  let rain = closest.dist < 80 ? 260 : closest.dist < 150 ? 180
    : closest.dist < 250 ? 100 : closest.dist < 400 ? 50 : 15;
  if (slowMover) rain = Math.round(rain * 1.6);

  const power = parseInt(closest.power) || 0;
  let level = 1;
  if (rain >= 60 || (closest.dist < galeR && power >= 8)) level = 2;
  if (rain >= 150 || (closest.dist < 200 && power >= 10)) level = 3;
  if (rain >= 250 || (closest.dist < 100 && power >= 14)) level = 4;
  if (slowMover && closest.dist < galeR) level = Math.max(level, 3);

  return {
    closest, galeR, inRange, rain, level, fc,
    moveKmh, slowMover, durationH, endPoint, stillInRangeAtEnd,
  };
}

function ptime(p) {
  return new Date(p.time.replace(" ", "T")).getTime();
}

function findAnalog(rain) {
  const city = CITIES[state.city];
  const pool = state.analogs.events;
  const score = (e) =>
    (e.region.city === state.city ? 0 : e.region.province === city.province ? 1 : 2) * 10000 +
    Math.abs(e.hazard.rainTotalMm - rain);
  return pool.slice().sort((a, b) => score(a) - score(b))[0];
}

/* ---------- render ---------- */

function render() {
  const s = state.storm;
  const a = assess();
  const lv = LEVELS[a.level];

  const badge = document.getElementById("level-badge");
  badge.className = `lv-${a.level}`;
  badge.innerHTML = `风险参考：${lv.name} ${"●".repeat(a.level)}${"○".repeat(4 - a.level)}<small>${lv.tip}</small>`;

  const last = s.track[s.track.length - 1];
  document.getElementById("storm-line").innerHTML = `
    <h3>台风动态</h3>
    <div class="big">${s.name} ${s.enName}（${last.strong} ${last.power}级）</div>
    现距${state.city}约 <b>${Math.round(haversine(CITIES[state.city].lat, CITIES[state.city].lng, last.lat, last.lng))} km</b>，
    正以 ${last.moveSpeed} km/h 向${fmtDir(last.moveDir)}方向移动
    ${a.slowMover ? `<div class="slow-badge">🐌 停留型台风：预报移速仅约 ${Math.round(a.moveKmh)} km/h，
      在一地停留久、累计雨量大——<b>这种台风的危险在雨不在风</b></div>` : ""}
    <div class="muted">实况时间 ${last.time} · 数据：温州台风网${s.live ? "（🟢 实时）" : "（快照）"}</div>`;

  const tl = [];
  if (a.inRange.length) {
    tl.push(["", `预计风雨影响时段（进入 ${Math.round(a.galeR)} km 大风半径）`]);
    tl.push([fmtTime(a.inRange[0].time), "风雨开始加强"]);
    tl.push([fmtTime(a.closest.time), `最近距离约 ${Math.round(a.closest.dist)} km，影响最强`]);
    if (a.endPoint) {
      tl.push([fmtTime(a.endPoint.time), "风雨基本结束（移出大风半径）"]);
    } else if (a.stillInRangeAtEnd) {
      tl.push(["", `<b>⚠️ 到预报末端（${fmtTime(a.inRange[a.inRange.length - 1].time)}）仍未移出影响范围</b>——警惕累计雨量`]);
    } else {
      tl.push([fmtTime(a.inRange[a.inRange.length - 1].time), "逐渐减弱"]);
    }
    if (a.durationH) tl.push(["", `影响持续约 <b>${Math.round(a.durationH)} 小时</b>${a.slowMover ? "（停留型，明显偏长）" : ""}`]);
  } else {
    tl.push(["", `台风预计最近距离约 ${Math.round(a.closest.dist)} km（${fmtTime(a.closest.time)}），本地以外围影响为主`]);
  }
  tl.push(["", `<span class="muted">预计过程雨量约 ${a.rain} mm（演示估算${a.slowMover ? "，含停留时长加成" : ""}）</span>`]);
  document.getElementById("timeline").innerHTML =
    `<h3>时间线 · ${state.city}</h3>` +
    tl.map(([t, txt]) => `<div class="tl-row">${t ? `<span class="t">${t}</span>` : ""}<span>${txt}</span></div>`).join("");

  const analog = findAnalog(a.rain);
  const sameCity = analog.region.city === state.city;
  const ratio = a.rain / analog.hazard.rainTotalMm;
  const compare = ratio > 1.3 ? "已超过" : ratio >= 0.7 ? "接近"
    : `约为其 ${Math.round(ratio * 100)}%，远小于`;
  document.getElementById("analog").innerHTML = `
    <h3>历史对照${sameCity ? "" : `（${analog.region.city}，同省参考）`}</h3>
    预计雨量 ${a.rain}mm ${compare} <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>时
    ${analog.region.city}的 ${analog.hazard.rainTotalMm}mm
    <div class="quote">${analog.narrative}</div>`;

  document.getElementById("checklist").innerHTML =
    `<h3>现在该做的（依据气象部门台风防御指引整理）</h3>` +
    CHECKLISTS[a.level].map((item, i) => `
      <label class="check-row" id="ck-${i}">
        <input type="checkbox"><span>${item}</span>
      </label>`).join("");
  document.querySelectorAll(".check-row input").forEach((el) => {
    el.onchange = () => el.closest(".check-row").classList.toggle("done", el.checked);
  });
}

/* ---------- share card ---------- */

const LV_STYLE = {
  1: { color: "#6fdc8c", headline: "预报路径不经过你所在区域", sub: "不必被「超强台风」的标题吓到" },
  2: { color: "#f0c743", headline: "外围风雨会来，备点吃喝更安心", sub: "影响有限，做基础准备即可" },
  3: { color: "#ff9d4d", headline: "影响明显，今天完成防台准备", sub: "重点防内涝和停电" },
  4: { color: "#ff6470", headline: "可能严重受灾，紧盯官方通知", sub: "涉及转移请听从政府安排" },
};

function bindShare() {
  document.getElementById("share-btn").onclick = drawShareCard;
  document.getElementById("share-close").onclick = () =>
    (document.getElementById("share-modal").style.display = "none");
  document.getElementById("share-save").onclick = () => {
    const link = document.createElement("a");
    link.download = `台风${state.storm.name}-${state.city}影响卡.png`;
    link.href = document.getElementById("share-canvas").toDataURL("image/png");
    link.click();
  };
}

function drawShareCard() {
  const a = assess();
  const s = state.storm;
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

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#141a2a");
  bg.addColorStop(1, "#0c0f18");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // brand row
  ctx.fillStyle = "#6b7386";
  ctx.font = F(600, 22);
  ctx.fillText("台风追踪 · 影响卡片", 48, 64);
  ctx.textAlign = "right";
  ctx.fillText(last.time.slice(0, 16), W - 48, 64);
  ctx.textAlign = "left";

  // storm + location
  ctx.fillStyle = "#e8eaf0";
  ctx.font = F(800, 42);
  ctx.fillText(`${s.name} ${s.enName}`, 48, 136);
  ctx.fillStyle = "#9aa3b5";
  ctx.font = F(600, 26);
  ctx.fillText(`${last.strong} ${last.power}级 · 📍 ${state.city}（大概位置）`, 48, 180);

  // level pill
  const pillText = `风险参考：${LEVELS[a.level].name} ${"●".repeat(a.level)}${"○".repeat(4 - a.level)}`;
  ctx.font = F(700, 26);
  const pw = ctx.measureText(pillText).width + 48;
  ctx.fillStyle = lv.color + "26";
  ctx.beginPath();
  ctx.roundRect(48, 214, pw, 56, 28);
  ctx.fill();
  ctx.fillStyle = lv.color;
  ctx.fillText(pillText, 72, 251);

  // headline
  ctx.fillStyle = "#ffffff";
  ctx.font = F(800, 44);
  wrapText(ctx, lv.headline, 48, 356, W - 96, 58);
  ctx.fillStyle = "#9aa3b5";
  ctx.font = F(400, 24);
  ctx.fillText(
    a.slowMover
      ? "停留型台风：移速慢、下得久，危险在雨不在风"
      : lv.sub + " · 台风强度 ≠ 你受影响的程度",
    48, 420);

  // divider
  ctx.strokeStyle = "#232b42";
  ctx.beginPath();
  ctx.moveTo(48, 456);
  ctx.lineTo(W - 48, 456);
  ctx.stroke();

  // facts
  ctx.font = F(400, 27);
  const facts = [
    ["当前距离", `约 ${Math.round(haversine(CITIES[state.city].lat, CITIES[state.city].lng, last.lat, last.lng))} km`],
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

  // analog box
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

  // top tips
  ctx.fillStyle = "#e8eaf0";
  ctx.font = F(700, 26);
  ctx.fillText("现在该做的", 48, 880);
  ctx.font = F(400, 25);
  CHECKLISTS[a.level].slice(0, 2).forEach((item, i) => {
    ctx.fillStyle = lv.color;
    ctx.fillText("☐", 48, 918 + i * 38);
    ctx.fillStyle = "#c6ccd9";
    ctx.fillText(item, 84, 918 + i * 38);
  });

  // footer
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

function maxRadius(p) {
  return p && p.r7 ? Math.max(...p.r7) : null;
}

/* 数据源用日式方位写法（北西=西北），转成中文习惯 */
function fmtDir(dir) {
  const m = { "北西": "西北", "北东": "东北", "南西": "西南", "南东": "东南" };
  return m[dir] || dir;
}

function fmtTime(str) {
  if (!str) return "—";
  const m = str.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2})/);
  return m ? `${+m[3]}日${m[4]}时` : str;
}

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
