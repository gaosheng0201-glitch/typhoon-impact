#!/usr/bin/env python3
"""风场网格快照：Open-Meteo 当前 10m 风（速度+风向），供地图风羽箭头层用。

为什么这样做：前端要一整片风场而非单点；Open-Meteo 支持多坐标批量（纯 JSON、
零依赖，不用碰 GRIB），但一次 URL 太长会 414，故按批请求再合并。风场变化平缓，
每几小时刷新即可。输出 docs/data/wind.json（精简：[lat,lon,speed_kmh,dir_deg]）。

零依赖、纯标准库。抓取失败保留旧快照，不清空。
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "wind.json"
# 网格覆盖中国 + 西太台风区；1.5° 间距，配合前端碰撞稀释足够
LAT0, LAT1, LON0, LON1, STEP = 3.0, 45.0, 100.0, 145.0, 1.5
BATCH = 250  # 每批点数（控制 URL 长度，避免 414）
API = "https://api.open-meteo.com/v1/forecast"


def grid():
    lats = [round(LAT0 + STEP * i, 1) for i in range(int((LAT1 - LAT0) / STEP) + 1)]
    lons = [round(LON0 + STEP * i, 1) for i in range(int((LON1 - LON0) / STEP) + 1)]
    return [(la, lo) for la in lats for lo in lons]


def fetch_batch(pts):
    la = ",".join(str(a) for a, _ in pts)
    lo = ",".join(str(b) for _, b in pts)
    url = (f"{API}?latitude={la}&longitude={lo}"
           f"&current=wind_speed_10m,wind_direction_10m&timezone=UTC")
    req = urllib.request.Request(url, headers={"User-Agent": "typhoonandcicada/1.0 (public-good)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8"))
    # 单点时返回对象、多点时返回数组，统一成列表
    return d if isinstance(d, list) else [d]


def main():
    pts = grid()
    out = []
    ok = 0
    for i in range(0, len(pts), BATCH):
        if i > 0:
            time.sleep(1.5)  # 批间延时，避免 Open-Meteo 429 限流
        chunk = pts[i:i + BATCH]
        try:
            for x in fetch_batch(chunk):
                c = x.get("current", {})
                sp, dr = c.get("wind_speed_10m"), c.get("wind_direction_10m")
                if sp is None or dr is None:
                    continue
                out.append([round(x["latitude"], 2), round(x["longitude"], 2),
                            round(sp, 1), int(dr)])
            ok += 1
        except Exception as e:
            print(f"[wind] 批 {i//BATCH} 失败: {e}", file=sys.stderr)

    if not out:
        print(f"[wind] 全部批失败，保留旧快照", file=sys.stderr)
        return 0

    snap = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": "Open-Meteo · 当前 10m 风",
        "unit": "km/h",
        "points": out,
    }
    OUT.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    print(f"[wind] 写入 {len(out)} 点（{ok} 批）→ {OUT}，{len(json.dumps(snap))//1024}KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
