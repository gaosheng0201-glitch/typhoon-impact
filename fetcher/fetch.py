#!/usr/bin/env python3
"""Fetch real-time typhoon data (track + multi-agency forecasts) and
normalize it into docs/data/ for the frontend.

Data source: 温州台风网 (Zhejiang water resources dept)
  list:   https://typhoon.slt.zj.gov.cn/Api/TyhoonActivity   (sic: "Tyhoon")
  detail: https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo/{tfid}

Every run also appends a raw snapshot under archive/ — this is the raw
material for forecast-error scoring later. Do not delete archive/.

Usage:
  python3 fetcher/fetch.py            # fetch once
  python3 fetcher/fetch.py --loop     # fetch every 5 minutes
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
ARCHIVE_DIR = ROOT / "archive"

BASE = "https://typhoon.slt.zj.gov.cn"
HEADERS = {
    "Referer": "https://typhoon.slt.zj.gov.cn/",
    "User-Agent": "Mozilla/5.0 (typhoon-tracker-dev)",
}


def get_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_radius(value):
    """'400|400|200|200' -> [ne, se, sw, nw]; '200' -> uniform; else None."""
    if not value:
        return None
    parts = str(value).split("|")
    try:
        nums = [float(p) for p in parts if p != ""]
    except ValueError:
        return None
    if not nums:
        return None
    if len(nums) == 1:
        return [nums[0]] * 4
    while len(nums) < 4:
        nums.append(nums[-1])
    return nums[:4]


def norm_point(p):
    return {
        "time": p.get("time"),
        "lat": float(p["lat"]),
        "lng": float(p["lng"]),
        "strong": p.get("strong") or "",
        "power": p.get("power") or "",
        "speed": p.get("speed") or "",
        "pressure": p.get("pressure") or "",
        "moveDir": p.get("movedirection") or "",
        "moveSpeed": p.get("movespeed") or "",
        "r7": parse_radius(p.get("radius7")),
        "r10": parse_radius(p.get("radius10")),
        "r12": parse_radius(p.get("radius12")),
    }


def norm_forecast_point(p):
    return {
        "time": p.get("time"),
        "lat": float(p["lat"]),
        "lng": float(p["lng"]),
        "strong": p.get("strong") or "",
        "power": p.get("power") or "",
        "speed": p.get("speed") or "",
        "pressure": p.get("pressure") or "",
    }


def latest_forecasts(points):
    """Walk track points from newest to oldest and keep the most recent
    forecast per agency (older points retain stale forecasts)."""
    seen = {}
    for p in reversed(points):
        for fc in p.get("forecast") or []:
            agency = fc.get("tm")
            if not agency or agency in seen:
                continue
            fps = fc.get("forecastpoints") or []
            if not fps:
                continue
            issued = next((q.get("ybsj") for q in fps if q.get("ybsj")), None)
            seen[agency] = {
                "issued": issued,
                "basedOn": p.get("time"),
                "points": [norm_forecast_point(q) for q in fps],
            }
        if seen:
            break  # only the newest point that carries any forecast
    return seen


RESIDUAL_MAX_H = 72   # 停编后继续追踪的硬上限（防呆）
RESIDUAL_RAIN_MM = 30  # 残涡下游 24h 模式预报雨量门槛：雨还在，就继续盯


def residual_rain_ok(lat, lng):
    """残涡最后位置及四周（±2°）是否仍有显著降雨预报。
    窗口由天气本身决定，而非固定时长；API 失败时保守保留。"""
    for dla, dlo in ((0, 0), (2, 0), (-2, 0), (0, 2), (0, -2)):
        try:
            d = get_json(
                "https://api.open-meteo.com/v1/forecast"
                f"?latitude={lat + dla}&longitude={lng + dlo}"
                "&daily=precipitation_sum&forecast_days=2")
            if max((x or 0) for x in d["daily"]["precipitation_sum"]) >= RESIDUAL_RAIN_MM:
                return True
        except Exception:
            return True  # 查不到宁可多盯，不可漏盯
    return False


def residual_tfids(active_ids):
    """已停编的台风：72h 内且残涡区仍有强降雨预报时继续追踪。"""
    found = []
    # 数据时间为北京时间：两边都用无时区的“北京钟面”直接比较
    now_bj = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=8)
    for f in sorted(DATA_DIR.glob("typhoon_*.json")):
        tfid = f.stem.split("_", 1)[1]
        if tfid in active_ids:
            continue
        try:
            track = json.loads(f.read_text(encoding="utf-8")).get("track") or []
            last_p = track[-1]
            last = datetime.strptime(last_p["time"], "%Y-%m-%d %H:%M:%S")
        except (ValueError, KeyError, IndexError, json.JSONDecodeError):
            continue
        if now_bj - last > timedelta(hours=RESIDUAL_MAX_H):
            continue
        if residual_rain_ok(last_p["lat"], last_p["lng"]):
            found.append(tfid)
    return found


def fetch_once():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    active = get_json(f"{BASE}/Api/TyhoonActivity") or []
    index = {"updatedAt": now, "typhoons": []}

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    active_ids = {item["tfid"] for item in active}
    targets = [(item["tfid"], "active") for item in active]
    targets += [(tfid, "residual") for tfid in residual_tfids(active_ids)]

    for tfid, status in targets:
        detail = get_json(f"{BASE}/Api/TyphoonInfo/{tfid}")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        arch = ARCHIVE_DIR / tfid
        arch.mkdir(parents=True, exist_ok=True)
        (arch / f"raw_{stamp}.json").write_text(
            json.dumps(detail, ensure_ascii=False), encoding="utf-8"
        )

        points = detail.get("points") or []
        out = {
            "tfid": tfid,
            "name": detail.get("name"),
            "enName": detail.get("enname"),
            "active": detail.get("isactive") == "1",
            "updatedAt": now,
            "track": [norm_point(p) for p in points],
            "forecasts": latest_forecasts(points),
        }
        (DATA_DIR / f"typhoon_{tfid}.json").write_text(
            json.dumps(out, ensure_ascii=False), encoding="utf-8"
        )

        last = out["track"][-1] if out["track"] else {}
        index["typhoons"].append({
            "tfid": tfid,
            "name": out["name"],
            "enName": out["enName"],
            "status": status,
            "strong": last.get("strong"),
            "power": last.get("power"),
            "lat": last.get("lat"),
            "lng": last.get("lng"),
            "lastTime": last.get("time"),
            "agencies": sorted(out["forecasts"].keys()),
        })
        print(f"  {tfid} {out['name']} ({out['enName']}) [{status}]: "
              f"{len(out['track'])} track pts, "
              f"forecasts from {', '.join(out['forecasts']) or 'none'}")

    (DATA_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[{now}] wrote {len(index['typhoons'])} active typhoon(s)")


def main():
    loop = "--loop" in sys.argv
    while True:
        try:
            fetch_once()
        except Exception as e:  # keep the loop alive on transient failures
            print(f"fetch failed: {e}", file=sys.stderr)
            if not loop:
                sys.exit(1)
        if not loop:
            break
        time.sleep(300)


if __name__ == "__main__":
    main()
