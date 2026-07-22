#!/usr/bin/env python3
"""生成对照库缺口优先级报告 docs/data/analogs-gap.md。

把「客观台风活动」与「现有叙事对照」交叉，找出**有台风活动却一条对照都没有**
的地级市，按「沿海暴露 × 近 100km 过境频次」排序——用客观清单决定该补哪座城市，
而不是跟着搜索结果的记载偏好走（城市优先方法论的量化底座）。

输入（全部是仓库已有产物，无外部依赖）：
  docs/data/history.json  build_history.py 产出：每区县 c100 次数 + 最强台风 Top3
  docs/data/analogs.json  现有叙事对照库（决定哪些城市已覆盖）
  docs/data/coastal.json  build_coastal.py 产出：沿海区县坐标 key
  docs/data/regions.json  区县坐标（把区县归并到地级市）
输出：
  docs/data/analogs-gap.md  Top 60 缺口表（城市 / 省 / 近100km / 沿海 / 代表台风）

用法：python3 fetcher/build_gap.py [--top N]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "analogs-gap.md"

TOP_N = 60  # 报告收录前 N 个缺口

# analog 里直辖市/特区常用省名而非市名记录，归并时按省名也算已覆盖
DIRECT = {"上海", "北京", "天津", "重庆", "香港", "澳门"}


def norm(c):
    """城市名归一：剥去行政级别后缀，让 history / analog / coastal 三方能对齐。"""
    c = (c or "").strip()
    c = re.sub(r"市区$", "", c)
    c = re.sub(r"特别行政区$", "", c)
    c = re.sub(r"(市|地区|自治州|盟)$", "", c)
    return c


def dkey(lat, lng):
    """coastal.json 的坐标 key：lat*100,lng*100 取整。"""
    return "%d,%d" % (round(lat * 100), round(lng * 100))


def load():
    hist = json.loads((DATA / "history.json").read_text(encoding="utf-8"))["d"]
    analogs = json.loads((DATA / "analogs.json").read_text(encoding="utf-8"))["events"]
    coastal = json.loads((DATA / "coastal.json").read_text(encoding="utf-8"))
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))
    return hist, analogs, coastal, regions


def covered_cities(analogs):
    """已有叙事对照的城市集合（市名 + 省名，后者兜住直辖市/特区口径）。"""
    covered = set()
    for e in analogs:
        r = e.get("region") or {}
        if r.get("city"):
            covered.add(norm(r["city"]))
        if r.get("province"):
            covered.add(norm(r["province"]))
    return covered


def coastal_city_set(coastal, regions):
    """任一区县在沿海带上，则该地级市算「沿海暴露」。"""
    ck = set(coastal.keys())
    out = set()
    for prov, pobj in regions.items():
        for city, cobj in pobj.get("cities", {}).items():
            if any(dkey(ll[0], ll[1]) in ck for ll in cobj.get("districts", {}).values()):
                out.add(norm(city))
    return out


def aggregate(hist):
    """把区县级 history 归并到地级市：近100km 取各区县最大值；
    代表台风汇总各区县最强 Top3，同名取最近距离。"""
    city = {}
    for k, v in hist.items():
        p = k.split("|")
        if len(p) < 2 or not isinstance(v, list):
            continue
        cn = norm(p[1])
        d = city.setdefault(cn, {"prov": norm(p[0]), "near": 0, "storms": {}})
        d["near"] = max(d["near"], v[0] if v else 0)
        for s in (v[3] if len(v) > 3 and isinstance(v[3], list) else []):
            try:
                nm, yr, dist = s[0], s[1], s[2]
            except (IndexError, TypeError):
                continue
            if nm not in d["storms"] or dist < d["storms"][nm][1]:
                d["storms"][nm] = (yr, dist)
    return city


def main():
    top_n = TOP_N
    if len(sys.argv) == 3 and sys.argv[1] == "--top":
        top_n = int(sys.argv[2])

    hist, analogs, coastal, regions = load()
    covered = covered_cities(analogs)
    coastal_cities = coastal_city_set(coastal, regions)
    city = aggregate(hist)

    gaps = [(cn, d["prov"], d["near"], cn in coastal_cities, d["storms"])
            for cn, d in city.items() if cn not in covered and d["near"] >= 1]
    gaps.sort(key=lambda x: (x[3], x[2]), reverse=True)  # 沿海优先，再按近距频次

    cov = len([c for c in city if c in covered])
    n_coastal_gap = len([g for g in gaps if g[3]])
    pct = cov * 100 // len(city) if city else 0

    lines = [
        "# 城市记忆对照库 · 缺口优先级报告", "",
        "由 IBTrACS v04r01(1949 年以来)与现有 analogs.json 交叉得出。",
        f"覆盖地级市 **{len(city)}**，已有叙事对照 **{cov}**（{pct}%），",
        f"有台风活动却无对照的缺口 **{len(gaps)}**（沿海暴露 {n_coastal_gap}）。", "",
        "排序：沿海暴露优先 × 近 100km 过境频次。代表台风取各市最近距离的著名系统（供策展时定锚点）。", "",
        "| 城市 | 省 | 近100km | 沿海 | 代表台风（年·最近km） |",
        "|---|---|---|---|---|",
    ]
    for cn, prov, near, isc, storms in gaps[:top_n]:
        top = sorted(storms.items(), key=lambda kv: kv[1][1])[:3]  # 按最近距离
        rep = " / ".join(f"{n}{y}·{d}km" for n, (y, d) in top)
        lines.append(f"| {cn} | {prov} | {near} | {'●' if isc else ''} | {rep} |")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"地级市 {len(city)} | 已覆盖 {cov} ({pct}%) | "
          f"缺口 {len(gaps)}（沿海 {n_coastal_gap}）→ 写入 {OUT}（Top {top_n}）")


if __name__ == "__main__":
    main()
