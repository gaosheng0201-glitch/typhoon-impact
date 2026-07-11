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
from datetime import datetime, timezone
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


def fetch_once():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    active = get_json(f"{BASE}/Api/TyhoonActivity") or []
    index = {"updatedAt": now, "typhoons": []}

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for item in active:
        tfid = item["tfid"]
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
            "strong": last.get("strong"),
            "power": last.get("power"),
            "lat": last.get("lat"),
            "lng": last.get("lng"),
            "lastTime": last.get("time"),
            "agencies": sorted(out["forecasts"].keys()),
        })
        print(f"  {tfid} {out['name']} ({out['enName']}): "
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
