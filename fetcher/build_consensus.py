#!/usr/bin/env python3
"""生成 docs/data/consensus.json：多源台风路径融合 + 校准的不确定性锥。

这是本站自研算法层的核心：把 5 家官方机构（中国/日本/美国/中国香港/中国台湾，
来自温州台风网原始快照）与 FNV3 AI 多期预报，融合成一条「共识路径」，并给出
**用历史误差校准过的**不确定性半径（r68/r90）——机构一致时锥收窄、分歧时放宽，
宽窄不是拍的，是算的。

原料（全部已在库）：
- archive/{tfid}/raw_*.json 最新快照：每个历史轨迹点上挂着**当时**各机构发布的
  预报（issue-time forecasts）——一场台风自带完整检验集：谁、何时、报了什么、
  实际走到哪。
- docs/data/fnv3/{tfid}.json：AI 源（多期 ensemble_mean run + observed）。

算法（四步，全是可回测的统计）：
1) 检验：每个发布时刻 × 每源 × 每预报点，对照后来实况 → 每源每时效桶的
   平均误差表 + 近况技巧（按发布距今指数衰减，τ=48h）——「这场台风谁报得准」。
2) 融合：取各源最后一次发布，插值到逐 6h 网格，权重 ∝ 1/(误差²+ε²) 加权平均；
   同时给出源间散布 spread。
3) 校准锥：把融合器在**每个历史发布时刻**回放一遍 → 融合误差分布 → 取 68/90
   分位数为锥半径；再按「当前散布/历史散布」比值缩放（clamp 0.6–1.8，
   spread-skill 关系的保守用法）。
4) 验证：前 60% 发布时刻定标、后 40% 验收——报告 r68/r90 的实际覆盖率，
   校准是否诚实，用数字说话（--backtest）。

红线：只做路径与不确定性，不做灾损；输出注明多机构来源与「以官方为准」。
"""
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
ARCHIVE = ROOT / "archive"
OUT = DATA / "consensus.json"

BJT = timezone(timedelta(hours=8))
LEADS = list(range(6, 126, 6))     # 6h 桶
EPS_KM = 80                        # 权重压舱石：避免小样本误差表把权重推到极端
TAU_H = 48                         # 近况技巧的指数衰减时标
SRC_AI = "AI·FNV3"


def hav(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def bjt_epoch(s):
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJT).timestamp())


def interp_at(seq, t):
    """seq=[(epoch,lat,lng)...] 升序，线性插值；范围外返回 None。"""
    if not seq or t < seq[0][0] or t > seq[-1][0]:
        return None
    lo, hi = 0, len(seq) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if seq[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, a0, o0), (t1, a1, o1) = seq[lo], seq[hi]
    f = 0 if t1 == t0 else (t - t0) / (t1 - t0)
    return a0 + (a1 - a0) * f, o0 + (o1 - o0) * f


def load_sources(tfid):
    """返回 (obs, issues)。obs=[(epoch,lat,lng)]；
    issues={src: [(issue_epoch, [(valid_epoch,lat,lng),...]), ...]}（每源按发布时刻升序）。
    首选 docs/data/verify/{tfid}.json（fetch.py 产出的瘦身检验集，云端也有）；
    本地退回 archive/ 原始快照解析。"""
    obs, issues = [], {}
    vfile = DATA / "verify" / f"{tfid}.json"
    if vfile.exists():
        d = json.loads(vfile.read_text(encoding="utf-8"))
        obs = [tuple(x) for x in d.get("obs", [])]
        issues = {src: [(i, [tuple(p) for p in fps]) for i, fps in lst]
                  for src, lst in d.get("issues", {}).items()}
    else:
        snaps = sorted((ARCHIVE / tfid).glob("raw_*.json"))
        if not snaps:
            return None, None
        d = json.loads(snaps[-1].read_text(encoding="utf-8"))
        for p in d.get("points", []):
            try:
                t = bjt_epoch(p["time"])
                obs.append((t, float(p["lat"]), float(p["lng"])))
            except (KeyError, ValueError):
                continue
            for f in p.get("forecast") or []:
                src = f.get("tm", "").strip()
                fps = []
                for fp in f.get("forecastpoints") or []:
                    try:
                        vt = bjt_epoch(fp["time"])
                        if vt > t:
                            fps.append((vt, float(fp["lat"]), float(fp["lng"])))
                    except (KeyError, ValueError):
                        continue
                if src and fps:
                    issues.setdefault(src, []).append((t, sorted(fps)))
    obs.sort()

    # AI 源：FNV3 多期 run，与官方同构（issue=init，valid=epoch，UTC 秒）
    fnv = DATA / "fnv3" / f"{tfid}.json"
    if fnv.exists():
        d2 = json.loads(fnv.read_text(encoding="utf-8"))
        for r in d2.get("forecasts", []):
            init = int(datetime.strptime(r["init"], "%Y-%m-%dT%H:%MZ")
                       .replace(tzinfo=timezone.utc).timestamp())
            fps = [(p[1], p[2], p[3]) for p in r["track"] if p[1] > init]
            if fps:
                issues.setdefault(SRC_AI, []).append((init, sorted(fps)))
    for v in issues.values():
        v.sort()
    return obs, issues


def bucket(lead_h):
    b = round(lead_h / 6) * 6
    return b if 6 <= b <= LEADS[-1] else None


def skill_tables(obs, issues, upto):
    """检验：每源每时效桶平均误差 + 近况技巧（≤48h 时效、按发布新旧衰减）。
    只用 issue<=upto 且 valid<=upto 的样本——回放时不偷看未来。"""
    tab, recent = {}, {}
    for src, lst in issues.items():
        bucks, rnum, rden = {}, 0.0, 0.0
        for issue, fps in lst:
            if issue > upto:
                continue
            for vt, la, lo in fps:
                if vt > upto:
                    continue
                o = interp_at(obs, vt)
                b = bucket((vt - issue) / 3600)
                if o is None or b is None:
                    continue
                e = hav(la, lo, o[0], o[1])
                s, n = bucks.get(b, (0.0, 0))
                bucks[b] = (s + e, n + 1)
                if (vt - issue) / 3600 <= 48:
                    w = math.exp(-(upto - issue) / 3600 / TAU_H)
                    rnum += w * e
                    rden += w
        if bucks:
            tab[src] = {b: (s / n, n) for b, (s, n) in bucks.items()}
            recent[src] = rnum / rden if rden > 0 else None
    return tab, recent


def err_of(tab, src, lead_h):
    """误差表查询：桶间线性插值；缺桶按最近桶 × 时效比例外推；整源缺失给通用曲线。"""
    t = tab.get(src)
    if not t:
        return 60 + 1.1 * lead_h
    bs = sorted(t)
    if lead_h <= bs[0]:
        return t[bs[0]][0] * max(0.4, lead_h / bs[0])
    for a, b in zip(bs, bs[1:]):
        if lead_h <= b:
            f = (lead_h - a) / (b - a)
            return t[a][0] + (t[b][0] - t[a][0]) * f
    return t[bs[-1]][0] * (lead_h / bs[-1])


def fuse_at(obs, issues, tab, at, horizon_h=120):
    """融合：各源最后一次 issue<=at 的预报 → 逐 6h 加权平均 + 散布。"""
    active = {}
    for src, lst in issues.items():
        past = [x for x in lst if x[0] <= at]
        if past:
            active[src] = past[-1]
    grid = []
    for h in range(6, horizon_h + 1, 6):
        vt = at + h * 3600
        pts = []
        for src, (issue, fps) in active.items():
            p = interp_at(fps, vt)
            if p is None:
                continue
            lead = (vt - issue) / 3600
            w = 1.0 / (err_of(tab, src, lead) ** 2 + EPS_KM ** 2)
            pts.append((w, p[0], p[1], src))
        if not pts:
            continue
        W = sum(p[0] for p in pts)
        la = sum(p[0] * p[1] for p in pts) / W
        lo = sum(p[0] * p[2] for p in pts) / W
        spread = math.sqrt(sum(p[0] * hav(p[1], p[2], la, lo) ** 2 for p in pts) / W)
        grid.append({"t": vt, "lead": h, "lat": round(la, 2), "lng": round(lo, 2),
                     "nSrc": len(pts), "spreadKm": round(spread)})
    return grid


def quantile(xs, q):
    if not xs:
        return None
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(q * (len(s) - 1))))
    return s[i]


def calibrate(obs, issues, split=1.0):
    """把融合器在每个历史发布时刻回放 → 融合误差与散布的分布（按时效桶）。
    split<1 时只用前段发布时刻（后段留作验收）。返回
    {lead: {"e68","e90","spread","errs":[...]}}。"""
    all_issues = sorted({t for lst in issues.values() for t, _ in lst})
    if not all_issues:
        return {}
    cut = all_issues[min(len(all_issues) - 1, int(split * (len(all_issues) - 1)))]
    dist = {}
    for at in all_issues:
        if at > cut:
            break
        tab, _ = skill_tables(obs, issues, at)
        for g in fuse_at(obs, issues, tab, at):
            o = interp_at(obs, g["t"])
            if o is None:
                continue
            e = hav(g["lat"], g["lng"], o[0], o[1])
            d = dist.setdefault(g["lead"], {"errs": [], "spreads": []})
            d["errs"].append(e)
            d["spreads"].append(g["spreadKm"])
    for d in dist.values():
        d["e68"] = quantile(d["errs"], 0.68)
        d["e90"] = quantile(d["errs"], 0.90)
        d["spread"] = max(1.0, sum(d["spreads"]) / len(d["spreads"]))
    return dist, cut


def cone_radii(dist, lead, spread_now):
    """校准锥：历史融合误差分位数 × spread 比值缩放（clamp 0.6–1.8）。"""
    ds = sorted(dist)
    if not ds:
        return None, None
    b = min(ds, key=lambda x: abs(x - lead))
    base68, base90, sp = dist[b]["e68"], dist[b]["e90"], dist[b]["spread"]
    k = max(0.6, min(1.8, (spread_now or sp) / sp))
    grow = max(1.0, lead / b)          # 超出已校准时效按线性外推
    return round(base68 * k * grow), round(base90 * k * grow)


def storm_consensus(tfid, name, now_epoch):
    obs, issues = load_sources(tfid)
    if not obs or not issues:
        return None
    tab, recent = skill_tables(obs, issues, now_epoch)
    dist, _ = calibrate(obs, issues)
    grid = fuse_at(obs, issues, tab, now_epoch)
    for g in grid:
        g["r68"], g["r90"] = cone_radii(dist, g["lead"], g["spreadKm"])
    ranked = sorted((v, k) for k, v in recent.items() if v is not None)
    return {
        "tfid": tfid, "name": name,
        "skill": {k: {"recentKm": round(v)} for k, v in recent.items() if v is not None},
        "best": ranked[0][1] if ranked else None,
        "fused": grid,
        "stale": not grid,
    }


def backtest(tfid):
    """定标/验收分离的诚实性报告：前 60% 发布时刻定标，后 40% 验收覆盖率。"""
    obs, issues = load_sources(tfid)
    dist, cut = calibrate(obs, issues, split=0.6)
    all_issues = sorted({t for lst in issues.values() for t, _ in lst})
    inside68 = inside90 = total = 0
    fused_err, best_single = {}, {}
    for at in all_issues:
        if at <= cut:
            continue
        tab, _ = skill_tables(obs, issues, at)
        for g in fuse_at(obs, issues, tab, at):
            o = interp_at(obs, g["t"])
            if o is None:
                continue
            e = hav(g["lat"], g["lng"], o[0], o[1])
            r68, r90 = cone_radii(dist, g["lead"], g["spreadKm"])
            total += 1
            inside68 += e <= r68
            inside90 += e <= r90
            fused_err.setdefault(g["lead"], []).append(e)
        # 对照：同一时刻各单源误差
        for src, lst in issues.items():
            past = [x for x in lst if x[0] <= at]
            if not past:
                continue
            issue, fps = past[-1]
            for vt, la, lo in fps:
                o = interp_at(obs, vt)
                b = bucket((vt - issue) / 3600)
                if o is None or b is None:
                    continue
                best_single.setdefault(b, {}).setdefault(src, []).append(
                    hav(la, lo, o[0], o[1]))
    print(f"\n== {tfid} 验收（后 40% 发布时刻，{total} 个检验点）==")
    print(f"锥覆盖率：r68 实测 {inside68 / total:.0%}（名义 68%）  "
          f"r90 实测 {inside90 / total:.0%}（名义 90%）")
    print(f"{'时效':>5} {'融合误差':>8} {'最优单源':>14} {'样本':>4}")
    for b in sorted(fused_err):
        fe = sum(fused_err[b]) / len(fused_err[b])
        singles = {s: sum(v) / len(v) for s, v in best_single.get(b, {}).items()}
        bs = min(singles.items(), key=lambda x: x[1]) if singles else ("-", float("nan"))
        print(f"+{b:>3}h {fe:>7.0f}km {bs[1]:>8.0f}km({bs[0]})  {len(fused_err[b]):>4}")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--backtest":
        backtest(sys.argv[2])
        return
    now = datetime.now(timezone.utc)
    now_epoch = int(now.timestamp())
    idx = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    storms = []
    for t in idx.get("typhoons", []):
        s = storm_consensus(t["tfid"], t["name"], now_epoch)
        if s:
            storms.append(s)
    payload = {
        "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": "多源路径融合（5 官方机构 + FNV3 AI），权重∝1/历史误差²；"
                  "不确定性锥按历史融合误差分位数校准，随源间散布缩放（见 METHODOLOGY.md）",
        "note": "非官方预报综合，仅供参考，以气象部门发布为准",
        "storms": storms,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    n = sum(len(s["fused"]) for s in storms)
    print(f"wrote {OUT}: {len(storms)} 个风暴 / {n} 个融合点")


if __name__ == "__main__":
    main()
