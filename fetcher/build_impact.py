#!/usr/bin/env python3
"""生成 docs/data/impact.json：把 FNV3 多期预报翻译成「对每个城市意味着什么」。

这是本站自己的「小预测层」：不算大气，只做统计与翻译。原料是
docs/data/fnv3/{tfid}.json 里的多期 ensemble_mean 轨迹（fetch_fnv3.py 产出，
每 12 小时一期）+ 各期 errorsKm 实测误差。

方法（滞后集合 lagged ensemble）：
- 「概率」：最近 K 期预报里，有几期把台风送进城市的影响半径 → hits/of。
  期数少（刚生成的风暴只有两三期）本身就是「还看不准」的信号，如实带出。
- 「影响半径」：150km（典型大风圈量级）+ 该时效的历史实测误差（summary
  errorsKm 插值）——误差随时效放大，半径随之放大，这就是「校准」。
- 「收敛度」：风暴刚形成时各期预报吵架，随更新趋于一致。取同一未来时刻
  （now+24h/+48h），比较最近 3 期 vs 更早 3 期预报位置的散布（km）：
  散布收窄 = 正在收敛，结论可以说硬一点；散布仍大 = 明说「还看不准」。
  收敛度是一等公民字段，「不确定」本身就是要交付给用户的信息。

红线：本项目只做影响与避险，不触碰伤亡/经济损失。FNV3 为研究性数据，
输出必须带「仅供研究、以官方预警为准」，本文件的 note 字段不可省。
"""
import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "impact.json"

K_RUNS = 6            # 参与统计的最近期数（12h 一期 ≈ 3 天）
BASE_RADIUS_KM = 150  # 影响半径基数：台风大风圈的典型量级
CONV_LEADS_H = (24, 48)          # 在 now+这些小时处度量收敛度
CONV_TIGHT_KM, CONV_LOOSE_KM = 120, 300


def haversine(lat1, lng1, lat2, lng2):
    d = math.pi / 180
    a = (math.sin((lat2 - lat1) * d / 2) ** 2 +
         math.cos(lat1 * d) * math.cos(lat2 * d) * math.sin((lng2 - lng1) * d / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def hourly(track):
    """6h 轨迹点线性插值到逐小时：[(epoch, lat, lng, windKt, leadH)]。"""
    pts = []
    for (l0, t0, la0, lo0, w0), (l1, t1, la1, lo1, w1) in zip(track, track[1:]):
        steps = max(1, int((t1 - t0) // 3600))
        for i in range(steps):
            f = i / steps
            pts.append((t0 + i * 3600, la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f,
                        (w0 or 0) + ((w1 or 0) - (w0 or 0)) * f, l0 + (l1 - l0) * f))
    l, t, la, lo, w = track[-1]
    pts.append((t, la, lo, w or 0, l))
    return pts


def err_at(summary, lead_h):
    """summary errorsKm（{24:29,48:41,...}）按时效线性插值。"""
    ks = sorted(int(k) for k in summary)
    if not ks:
        return 80
    if lead_h <= ks[0]:
        return summary[str(ks[0])]
    for a, b in zip(ks, ks[1:]):
        if lead_h <= b:
            f = (lead_h - a) / (b - a)
            return summary[str(a)] + (summary[str(b)] - summary[str(a)]) * f
    return summary[str(ks[-1])]


def pos_at(pts, epoch):
    """逐小时序列里取给定时刻的位置（超出范围返回 None）。"""
    if not pts or epoch < pts[0][0] or epoch > pts[-1][0]:
        return None
    i = min(range(len(pts)), key=lambda j: abs(pts[j][0] - epoch))
    return pts[i][1], pts[i][2]


def spread_km(positions):
    """若干预报位置的散布：两两距离的最大值。"""
    if len(positions) < 2:
        return None
    return max(haversine(*a, *b) for i, a in enumerate(positions) for b in positions[i + 1:])


def bjt(epoch):
    return datetime.fromtimestamp(epoch, timezone(timedelta(hours=8))).strftime("%m-%d %H:%M")


def load_cities():
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))
    return [(cn, c["lat"], c["lng"])
            for prov in regions.values() for cn, c in prov["cities"].items()]


def convergence(runs, now_epoch):
    """同一未来时刻，最近 3 期 vs 更早 3 期预报位置的散布 → 收敛判断。"""
    recent, prior = runs[-3:], runs[-6:-3]
    spreads, trend = [], None
    for lead in CONV_LEADS_H:
        target = now_epoch + lead * 3600
        s_new = spread_km([p for r in recent if (p := pos_at(r["pts"], target))])
        s_old = spread_km([p for r in prior if (p := pos_at(r["pts"], target))])
        if s_new is not None:
            spreads.append(s_new)
            if s_old:
                trend = (trend or 1) * (s_new / s_old) ** (1 / len(CONV_LEADS_H))
    if not spreads:
        return {"state": "unknown", "text": "可比对的预报期数不足，暂无法评估一致性"}
    s = max(spreads)
    if s <= CONV_TIGHT_KM:
        state, text = "converged", "最近几期预报已高度一致，结论可信度较高"
    elif s <= CONV_LOOSE_KM:
        state, text = "converging", "各期预报趋于一致，仍可能有调整"
    else:
        state, text = "divergent", "各期预报分歧仍大，路径还看不准——先别下结论"
    if trend and trend < 0.7 and state != "converged":
        text += "（分歧正在快速收窄）"
    elif trend and trend > 1.4:
        text += "（注意：最近几期分歧反而加大）"
    return {"state": state, "spreadKm": round(s), "trend": round(trend, 2) if trend else None,
            "runsCompared": [len(runs[-3:]), len(runs[-6:-3])], "text": text}


def storm_impact(storm, cities, now_epoch):
    runs_all = [{"init": f["init"], "pts": hourly(f["track"])}
                for f in storm["forecasts"] if len(f["track"]) >= 2]
    # 两头过滤：init 必须不晚于「现在」（回放模式防穿越——不许拿未来的预报
    # 回答过去的问题），且轨迹末端要伸进未来（整条都在过去的旧期没话说）
    def init_epoch(r):
        return datetime.strptime(r["init"], "%Y-%m-%dT%H:%MZ")\
            .replace(tzinfo=timezone.utc).timestamp()
    runs = [r for r in runs_all
            if init_epoch(r) <= now_epoch and r["pts"][-1][0] > now_epoch][-K_RUNS:]
    latest_init = runs_all[-1]["init"] if runs_all else None
    if not runs:
        return {"tfid": storm["tfid"], "name": storm["name"], "enName": storm["enName"],
                "stale": True, "latestInit": latest_init,
                "text": "最新一期预报已全部过期，等待下一期更新"}

    summary = storm.get("summary", {})
    conv = convergence(runs, now_epoch)

    hit_map = {}
    for r in runs:
        future = [p for p in r["pts"] if p[0] >= now_epoch]
        for name, la, lo in cities:
            best = None
            for t, plat, plng, w, lead in future:
                dist = haversine(la, lo, plat, plng)
                if best is None or dist < best[0]:
                    best = (dist, t, w, lead)
            if best is None:
                continue
            dist, t, w, lead = best
            if dist <= BASE_RADIUS_KM + err_at(summary, lead):
                hit_map.setdefault(name, []).append((t, dist, w))

    out_cities = []
    rank = {"low": 0, "medium": 1, "high": 2}
    for name, hits in hit_map.items():
        n = len(hits)
        times = sorted(h[0] for h in hits)
        dists = sorted(h[1] for h in hits)
        winds = sorted(h[2] for h in hits)
        level = "high" if n >= 5 else ("medium" if n >= 3 else "low")
        # 诚实性封顶——不确定性随时效和样本量放大，结论的嘴必须跟着松：
        # ① 期数不足 4 期（风暴刚生成）说不出 high；② 影响时刻在 5 天外
        # 封顶 low、3 天外封顶 medium（长时效落点常整体偏移，回测实证）。
        lead_h = (times[len(times) // 2] - now_epoch) / 3600
        cap = "low" if lead_h > 120 else ("medium" if lead_h > 72 or len(runs) < 4 else "high")
        if rank[cap] < rank[level]:
            level = cap
        out_cities.append({
            "city": name,
            "hits": n, "of": len(runs), "level": level,
            "leadH": round(lead_h),
            "window": {"from": bjt(times[0]), "to": bjt(times[-1])},
            "closestKm": round(dists[len(dists) // 2]),
            "windKt": round(winds[len(winds) // 2]),
        })
    out_cities.sort(key=lambda c: (-rank[c["level"]], -c["hits"], c["closestKm"]))

    return {"tfid": storm["tfid"], "name": storm["name"], "enName": storm["enName"],
            "latestInit": runs[-1]["init"], "runsUsed": len(runs),
            "convergence": conv, "cities": out_cities}


def main():
    # --at 2026-07-11T00:00Z ：回放模式，把「现在」拨回历史时刻，
    # 用于回测算法在当时会说什么（检验/复盘用，正常运行不带参数）。
    import sys
    now = datetime.now(timezone.utc)
    if len(sys.argv) == 3 and sys.argv[1] == "--at":
        now = datetime.strptime(sys.argv[2], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
        print(f"impact: 回放模式 now={sys.argv[2]}（不写正式文件）")
    now_epoch = int(now.timestamp())
    idx_file = DATA / "fnv3" / "index.json"
    if not idx_file.exists():
        print("impact: 无 fnv3 数据，跳过")
        return
    cities = load_cities()

    storms = []
    for s in json.loads(idx_file.read_text(encoding="utf-8")).get("storms", []):
        f = DATA / "fnv3" / f"{s['tfid']}.json"
        if f.exists():
            storms.append(storm_impact(json.loads(f.read_text(encoding="utf-8")),
                                        cities, now_epoch))

    replay = len(sys.argv) == 3
    payload = {
        "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": "FNV3 多期预报滞后集合统计，影响半径=150km+该时效历史实测误差（见 METHODOLOGY.md）",
        "note": "研究性数据（Google FNV3，CC BY 4.0），仅供参考，避险决策以官方预警为准",
        "storms": storms,
    }
    out = OUT.with_suffix(".replay.json") if replay else OUT
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    n = sum(len(s.get("cities", [])) for s in storms)
    print(f"wrote {out}: {len(storms)} 个风暴 / {n} 个受影响城市")


if __name__ == "__main__":
    main()
