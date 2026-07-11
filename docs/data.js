/* 数据层：优先直连温州台风网实时接口（API 开放 CORS），失败回退仓库内快照。
   快照由 fetcher/fetch.py 生成，兼作离线演示数据与接口故障时的降级。 */
const TyphoonData = (() => {
  const BASE = "https://typhoon.slt.zj.gov.cn";

  async function fetchJSON(url, timeoutMs = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function parseRadius(v) {
    if (!v) return null;
    const nums = String(v).split("|").filter((s) => s !== "").map(Number);
    if (!nums.length || nums.some(isNaN)) return null;
    while (nums.length < 4) nums.push(nums[nums.length - 1]);
    return nums.slice(0, 4);
  }

  function normPoint(p) {
    return {
      time: p.time, lat: +p.lat, lng: +p.lng,
      strong: p.strong || "", power: p.power || "",
      speed: p.speed || "", pressure: p.pressure || "",
      moveDir: p.movedirection || "", moveSpeed: p.movespeed || "",
      r7: parseRadius(p.radius7), r10: parseRadius(p.radius10), r12: parseRadius(p.radius12),
    };
  }

  function normForecastPoint(p) {
    return {
      time: p.time, lat: +p.lat, lng: +p.lng,
      strong: p.strong || "", power: p.power || "",
      speed: p.speed || "", pressure: p.pressure || "",
    };
  }

  /* 从最新往旧找，每家机构取最近一次预报（与 fetcher/fetch.py 逻辑一致） */
  function latestForecasts(points) {
    const seen = {};
    for (let i = points.length - 1; i >= 0; i--) {
      for (const fc of points[i].forecast || []) {
        if (!fc.tm || seen[fc.tm]) continue;
        const fps = fc.forecastpoints || [];
        if (!fps.length) continue;
        seen[fc.tm] = {
          issued: (fps.find((q) => q.ybsj) || {}).ybsj || null,
          basedOn: points[i].time,
          points: fps.map(normForecastPoint),
        };
      }
      if (Object.keys(seen).length) break;
    }
    return seen;
  }

  function normalize(detail) {
    const points = detail.points || [];
    return {
      tfid: detail.tfid,
      name: detail.name,
      enName: detail.enname,
      active: detail.isactive === "1",
      updatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
      live: true,
      track: points.map(normPoint),
      forecasts: latestForecasts(points),
    };
  }

  async function loadIndex() {
    try {
      const list = await fetchJSON(`${BASE}/Api/TyhoonActivity`);
      return {
        live: true,
        typhoons: (list || []).map((t) => ({
          tfid: t.tfid, name: t.name, enName: t.enname,
          strong: t.strong, power: t.power,
          lastTime: t.timeformate || t.time,
        })),
      };
    } catch (e) {
      const idx = await fetchJSON(`data/index.json?t=${Date.now()}`);
      return { live: false, ...idx };
    }
  }

  async function loadStorm(tfid, live = true) {
    if (live) {
      try {
        return normalize(await fetchJSON(`${BASE}/Api/TyphoonInfo/${tfid}`));
      } catch (e) { /* fall through to snapshot */ }
    }
    return fetchJSON(`data/typhoon_${tfid}.json?t=${Date.now()}`);
  }

  return { loadIndex, loadStorm };
})();
