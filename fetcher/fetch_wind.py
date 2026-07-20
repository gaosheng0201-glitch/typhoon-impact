#!/usr/bin/env python3
"""风场逐时预报帧：Open-Meteo 10m 风（速度+风向），供地图风羽箭头层 + 时间滑块用。

为什么带时间帧：台风移动快，「一张当前风场」和台风位置对不上；改抓逐时预报帧，
前端时间滑块拖到某小时，台风位置与风场切到同一帧，两者沿同一时间轴对齐。
窗口 now→+48h、每 3 小时一帧。多坐标批量（纯 JSON、零依赖，不碰 GRIB），URL 太长会
414 故分批；批间延时避 429。

输出 docs/data/wind.json：
  { updatedAt, unit, times:[iso UTC...], grid:[[lat,lon]...],
    frames:[ [[spd,dir]...每点], ...每帧 ] }

零依赖、纯标准库。抓取失败保留旧快照，不清空。
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "wind.json"
LAT0, LAT1, LON0, LON1, STEP = 3.0, 45.0, 100.0, 145.0, 1.5
BATCH = 200          # 每批点数（hourly 数据更大，批更小以控 URL/响应）
FRAME_STEP_H = 3     # 每 3 小时一帧
FRAME_COUNT = 17     # now → +48h
API = "https://api.open-meteo.com/v1/forecast"


def grid():
    lats = [round(LAT0 + STEP * i, 1) for i in range(int((LAT1 - LAT0) / STEP) + 1)]
    lons = [round(LON0 + STEP * i, 1) for i in range(int((LON1 - LON0) / STEP) + 1)]
    return [(la, lo) for la in lats for lo in lons]


def fetch_batch(pts):
    la = ",".join(str(a) for a, _ in pts)
    lo = ",".join(str(b) for _, b in pts)
    url = (f"{API}?latitude={la}&longitude={lo}"
           f"&hourly=wind_speed_10m,wind_direction_10m&forecast_days=3&timezone=UTC")
    req = urllib.request.Request(url, headers={"User-Agent": "typhoonandcicada/1.0 (public-good)"})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode("utf-8"))
    return d if isinstance(d, list) else [d]


def frame_indices(times_iso, now_utc):
    """从逐时时间轴挑帧：第一个 >= now 的整点起，每 FRAME_STEP_H 小时取一帧。"""
    ts = [datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc) for t in times_iso]
    start = 0
    for i, t in enumerate(ts):
        if t >= now_utc:
            start = i
            break
    idxs = [start + k * FRAME_STEP_H for k in range(FRAME_COUNT)]
    return [i for i in idxs if i < len(ts)]


def main():
    now_utc = datetime.now(timezone.utc)
    pts = grid()
    per_point = {}      # (lat,lon) -> {"time":[...], "spd":[...], "dir":[...]}
    axis = None
    failed = 0
    for i in range(0, len(pts), BATCH):
        chunk = pts[i:i + BATCH]
        for attempt in range(3):                 # 批级重试 + 退避（Open-Meteo 偶发 429）
            if i > 0 or attempt > 0:
                time.sleep(1.5 * (attempt + 1))
            try:
                for x in fetch_batch(chunk):
                    h = x.get("hourly", {})
                    t, sp, dr = h.get("time"), h.get("wind_speed_10m"), h.get("wind_direction_10m")
                    if not t or not sp:
                        continue
                    per_point[(round(x["latitude"], 2), round(x["longitude"], 2))] = (t, sp, dr)
                    if axis is None:
                        axis = t
                break
            except Exception as e:
                print(f"[wind] 批 {i//BATCH} 第{attempt+1}次失败: {e}", file=sys.stderr)
        else:
            failed += 1                          # 3 次都失败

    if not per_point or axis is None:
        print("[wind] 无数据，保留旧快照", file=sys.stderr)
        return 0
    # 完整性守卫：任一批彻底失败 / 点数明显不足 → 保留旧的完整快照，绝不写带洞的
    # （宁可风场晚半小时更新，也不让地图中间空一条纬度带）
    if failed or len(per_point) < len(pts) * 0.98:
        print(f"[wind] {failed} 批失败、仅 {len(per_point)}/{len(pts)} 点——"
              f"保留旧完整快照，不写带洞快照", file=sys.stderr)
        return 0

    idxs = frame_indices(axis, now_utc)
    times = [axis[i] + "Z" for i in idxs]
    grid_pts, frames = [], [[] for _ in idxs]
    for (la, lo), (t, sp, dr) in per_point.items():
        grid_pts.append([la, lo])
        for fi, gi in enumerate(idxs):
            s = sp[gi] if gi < len(sp) else None
            d = dr[gi] if dr and gi < len(dr) else None
            frames[fi].append([round(s, 1) if s is not None else 0,
                               int(d) if d is not None else 0])

    snap = {
        "updatedAt": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
        "source": "Open-Meteo · 10m 风逐时预报",
        "unit": "km/h",
        "stepH": FRAME_STEP_H,
        "times": times,
        "grid": grid_pts,
        "frames": frames,
    }
    OUT.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    print(f"[wind] {len(grid_pts)} 点 × {len(times)} 帧 → {OUT}，{len(OUT.read_text())//1024}KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
