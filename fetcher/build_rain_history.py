#!/usr/bin/env python3
"""生成「城市 × 台风」客观降雨底座 docs/data/rain-history.json。

这是「自动覆盖主干」的降雨层：不靠人工查报道，用官方路径 + 再分析降雨，
给每座过境城市算出「这场台风当时下了多少雨」的客观数字，供叙事层校验与
覆盖兜底（对照 CONTRIBUTING.md「机器辅助抽取流水线」第 1 步：官方路径定清单）。

方法：
  1. 官方路径：温州台风网 /Api/TyphoonInfo/<tfid>（支持历史年份，与 analogs 同一
     tfid 命名空间），拿整条 track（北京时逐 6h 点）。
  2. 过境清单：几何算各城市到路径的最近距离；≤ NEAR_KM 记为「直接过境」，
     ≤ WIDE_KM 记为「显著影响」，只对显著影响城市取雨。用客观清单决定覆盖。
  3. 降雨窗口：按「台风逼近该城市」的日期定窗（进入 APPROACH_KM 的日期
     前 1 天到后 TRAIL 天，兜住残涡拖尾雨——本站因美莎克停滞成灾而生）。
  4. 降雨量：Open-Meteo Historical（ERA5 再分析，免 key、覆盖 1940+，与前端
     panel.js 同源），取城市质心逐日 precipitation_sum → 累计 mm / 单日峰值 / 峰值日。

红线：这是**客观降雨底座**，只记雨量与过境距离，不触碰伤亡/经济损失。
再分析对极端峰值偏平滑，数字是「量级参考」，叙事层引用仍以原文出处为准。

用法：
  python3 fetcher/build_rain_history.py 201909 202409     # 指定 tfid
  python3 fetcher/build_rain_history.py --from-analogs     # analogs.json 里所有台风
  python3 fetcher/build_rain_history.py --from-analogs --force   # 重算已有条目
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "rain-history.json"
CACHE = ROOT / "fetcher" / ".cache"  # gitignored；再分析结果不变，缓存永久有效

WZTF = "https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
HEADERS = {"Referer": "https://typhoon.slt.zj.gov.cn/",
           "User-Agent": "Mozilla/5.0 (typhoon-tracker-dev)"}

NEAR_KM = 100      # 直接过境
WIDE_KM = 300      # 显著影响（取雨门槛）
APPROACH_KM = 600  # 定义降雨窗口：台风进入此范围的日期才算数
LEAD_DAYS = 1      # 窗口前扩（登陆前外围雨）
TRAIL_DAYS = 2     # 窗口后扩（残涡拖尾雨）
THROTTLE_S = 0.2   # Open-Meteo 免费档限速，客气点


def haversine(lat1, lng1, lat2, lng2):
    d = math.pi / 180
    a = (math.sin((lat2 - lat1) * d / 2) ** 2 +
         math.cos(lat1 * d) * math.cos(lat2 * d) * math.sin((lng2 - lng1) * d / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def get_json(url, cache_key=None, timeout=60, retries=1):
    """带磁盘缓存的 GET（再分析/历史路径都是不变量，缓存一次永久有效）。
    网络抖动时快速重试；始终失败才抛（由调用方 per-台风 容错）。"""
    cf = None
    if cache_key:
        CACHE.mkdir(parents=True, exist_ok=True)
        cf = CACHE / (cache_key + ".json")
        if cf.exists():
            return json.loads(cf.read_text(encoding="utf-8"))
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if cf is not None:
                cf.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        except Exception as e:  # 老台风路径接口常 SSL/EOF 抖动，快速重试而非久等
            last = e
            time.sleep(1)
    raise last


def load_cities():
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))
    out = []
    for prov, pobj in regions.items():
        for cn, c in pobj.get("cities", {}).items():
            out.append((prov, cn, c["lat"], c["lng"]))
    return out


def fetch_track(tfid):
    """温州台风网历史路径 → [(datetime_bjt, lat, lng)]。"""
    d = get_json(f"{WZTF}/{tfid}", cache_key=f"track_{tfid}", timeout=12, retries=1)
    pts = []
    for p in d.get("points") or []:
        try:
            t = datetime.strptime(p["time"], "%Y-%m-%d %H:%M:%S")
            pts.append((t, float(p["lat"]), float(p["lng"])))
        except (KeyError, ValueError):
            continue
    return d.get("name"), d.get("enname"), pts


def rain_at(lat, lng, start, end):
    """城市质心在 [start,end]（date）区间逐日雨量 → (总mm, 峰值mm, 峰值日)。"""
    q = urllib.parse.urlencode({
        "latitude": round(lat, 3), "longitude": round(lng, 3),
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": "precipitation_sum", "timezone": "Asia/Shanghai"})
    key = f"rain_{round(lat*100)}_{round(lng*100)}_{start.isoformat()}_{end.isoformat()}"
    hit = (CACHE / (key + ".json")).exists()
    d = get_json(f"{ARCHIVE}?{q}", cache_key=key)
    if not hit:
        time.sleep(THROTTLE_S)
    days = d.get("daily", {})
    times, vals = days.get("time", []), days.get("precipitation_sum", [])
    vals = [v or 0 for v in vals]
    if not vals:
        return None
    total = round(sum(vals), 1)
    pi = max(range(len(vals)), key=lambda i: vals[i])
    return total, round(vals[pi], 1), times[pi]


def storm_rain(tfid):
    name, en, track = fetch_track(tfid)
    if not track:
        print(f"  {tfid}: 无路径，跳过")
        return None
    cities = load_cities()
    result = {}
    for prov, cn, la, lo in cities:
        # 该城市到整条路径的最近距离 + 逼近日期集合
        dmin = 9e9
        near_dates = set()
        for t, plat, plng in track:
            dist = haversine(la, lo, plat, plng)
            dmin = min(dmin, dist)
            if dist <= APPROACH_KM:
                near_dates.add(t.date())
        if dmin > WIDE_KM or not near_dates:
            continue
        start = min(near_dates) - timedelta(days=LEAD_DAYS)
        end = max(near_dates) + timedelta(days=TRAIL_DAYS)
        r = rain_at(la, lo, start, end)
        if not r:
            continue
        total, peak, peak_day = r
        result[cn] = {
            "province": prov.replace("省", "").replace("市", "")
                            .replace("自治区", "").replace("特别行政区", ""),
            "closestKm": round(dmin),
            "transit": dmin <= NEAR_KM,
            "totalMm": total, "peakMm": peak, "peakDay": peak_day,
            "windowFrom": start.isoformat(), "windowTo": end.isoformat(),
        }
    print(f"  {tfid} {name}({en}): {len(result)} 个显著影响城市", flush=True)
    return {"name": name, "enName": en, "cities": result}


def main():
    args = sys.argv[1:]
    force = "--force" in args
    args = [a for a in args if a != "--force"]

    if "--from-analogs" in args:
        events = json.loads((DATA / "analogs.json").read_text(encoding="utf-8"))["events"]
        tfids = sorted({e["typhoon"]["tfid"] for e in events
                        if e.get("typhoon", {}).get("tfid")})
    else:
        tfids = [a for a in args if a.isdigit()]
    if not tfids:
        print(__doc__)
        return

    out = {"meta": {}, "d": {}}
    if OUT.exists():
        out = json.loads(OUT.read_text(encoding="utf-8"))
        out.setdefault("d", {})

    def save():
        out["meta"] = {
            "source": "温州台风网官方路径 × Open-Meteo Historical (ERA5)",
            "near_km": NEAR_KM, "wide_km": WIDE_KM,
            "note": "再分析降雨，极端峰值偏平滑，仅作量级参考；不含伤亡/经济损失。",
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "storms": len(out["d"]),
        }
        OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                       encoding="utf-8")

    done = skipped = failed = 0
    for tfid in tfids:
        if tfid in out["d"] and not force:
            skipped += 1
            continue
        try:
            s = storm_rain(tfid)
        except Exception as e:
            failed += 1
            print(f"  {tfid}: 失败 {e}", file=sys.stderr, flush=True)
            continue
        if s:
            out["d"][tfid] = s
            done += 1
            save()  # 增量落盘：中途被打断也不丢已完成的台风
    save()
    n_city = sum(len(s.get("cities", {})) for s in out["d"].values())
    print(f"新增 {done} / 跳过 {skipped}（已存在）；"
          f"共 {len(out['d'])} 场台风 / {n_city} 条城市降雨 → {OUT}")


if __name__ == "__main__":
    main()
