#!/usr/bin/env python3
"""生成区县级历史台风档案 docs/data/history.json。

输入：IBTrACS 西太平洋子集 CSV（v04r01，NOAA，公开下载）
      docs/data/regions.json（区县坐标）
输出：每个区县 1949 年以来的客观统计——
      中心经过 100km 内次数（直接冲击）、300km 内次数（显著影响）、
      最强纪录 Top3、最高发月份。

纯计算、可复核，是「历史对照」与误差回算的数据地基。
用法：python3 fetcher/build_history.py <ibtracs_wp.csv>
"""
import csv
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGIONS = ROOT / "docs" / "data" / "regions.json"
OUT = ROOT / "docs" / "data" / "history.json"

SINCE = 1949
NEAR_KM = 100    # 直接冲击
WIDE_KM = 300    # 显著影响
CELL = 2.0       # 粗网格（度），用于快速筛选候选区县
REACH = 2        # 邻域格数：±2 格 ≈ ±4° ≈ 444km，覆盖 WIDE_KM 有余


def haversine(lat1, lng1, lat2, lng2):
    d = math.pi / 180
    a = (math.sin((lat2 - lat1) * d / 2) ** 2 +
         math.cos(lat1 * d) * math.cos(lat2 * d) * math.sin((lng2 - lng1) * d / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def load_districts():
    regions = json.loads(REGIONS.read_text(encoding="utf-8"))
    out = []  # (key, lat, lng)
    for pn, prov in regions.items():
        for cn, city in prov["cities"].items():
            dists = city.get("districts") or {}
            if dists:
                for dn, (lat, lng) in dists.items():
                    out.append((f"{pn}|{cn}|{dn}", lat, lng))
            else:
                out.append((f"{pn}|{cn}|", city["lat"], city["lng"]))
    return out


def main():
    csv_path = Path(sys.argv[1])
    districts = load_districts()
    print(f"{len(districts)} districts")

    # 粗网格索引
    grid = {}
    for idx, (_, lat, lng) in enumerate(districts):
        grid.setdefault((int(lat // CELL), int(lng // CELL)), []).append(idx)

    # 每区县聚合器
    agg = [{"c100": 0, "c300": 0, "months": [0] * 13, "top": []} for _ in districts]

    n_storms = 0
    cur_sid = None
    storm = None  # {name, season, month, maxwind, mins: {idx: dist}}

    def close_storm(st):
        nonlocal n_storms
        if not st or not st["mins"]:
            return
        n_storms += 1
        label = st["name"] if st["name"] not in ("NOT_NAMED", "") else "未命名"
        for idx, dmin in st["mins"].items():
            a = agg[idx]
            if dmin <= NEAR_KM:
                a["c100"] += 1
            if dmin <= WIDE_KM:
                a["c300"] += 1
                a["months"][st["month"]] += 1
                a["top"].append((st["maxwind"], label, st["season"], round(dmin)))
                if len(a["top"]) > 8:
                    a["top"].sort(reverse=True)
                    del a["top"][4:]

    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)
        next(reader)  # 单位行
        col = {name: i for i, name in enumerate(header)}
        i_sid, i_season = col["SID"], col["SEASON"]
        i_name, i_time = col["NAME"], col["ISO_TIME"]
        i_lat, i_lon = col["LAT"], col["LON"]
        i_wmo, i_usa = col["WMO_WIND"], col["USA_WIND"]

        for row in reader:
            try:
                season = int(row[i_season])
            except ValueError:
                continue
            if season < SINCE:
                continue
            sid = row[i_sid]
            if sid != cur_sid:
                close_storm(storm)
                cur_sid = sid
                month = 7
                try:
                    month = datetime.strptime(row[i_time][:10], "%Y-%m-%d").month
                except ValueError:
                    pass
                storm = {"name": row[i_name], "season": season, "month": month,
                         "maxwind": 0, "mins": {}}
            try:
                lat, lon = float(row[i_lat]), float(row[i_lon])
            except ValueError:
                continue
            wind = 0
            for iw in (i_usa, i_wmo):
                try:
                    wind = max(wind, int(float(row[iw])))
                except ValueError:
                    pass
            if wind > storm["maxwind"]:
                storm["maxwind"] = wind

            ci, cj = int(lat // CELL), int(lon // CELL)
            mins = storm["mins"]
            for di in range(-REACH, REACH + 1):
                for dj in range(-REACH, REACH + 1):
                    for idx in grid.get((ci + di, cj + dj), ()):
                        _, dlat, dlng = districts[idx]
                        dist = haversine(lat, lon, dlat, dlng)
                        if dist <= WIDE_KM + 60 and dist < mins.get(idx, 9e9):
                            mins[idx] = dist
        close_storm(storm)

    years = datetime.now().year - SINCE
    out = {
        "meta": {
            "source": "IBTrACS v04r01 (WP)",
            "since": SINCE,
            "years": years,
            "storms": n_storms,
            "near_km": NEAR_KM,
            "wide_km": WIDE_KM,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        },
        "d": {},
    }
    for (key, _, _), a in zip(districts, agg):
        if not a["c300"]:
            continue
        a["top"].sort(reverse=True)
        top = [[n, s, d, round(w * 0.514)] for w, n, s, d in a["top"][:3]]
        best_month = max(range(1, 13), key=lambda m: a["months"][m])
        out["d"][key] = [a["c100"], a["c300"], best_month, top]

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"{n_storms} storms since {SINCE}; "
          f"{len(out['d'])} districts with history; "
          f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
