#!/usr/bin/env python3
"""FNV3（Google DeepMind FGN）AI 台风路径「历史复盘」数据管线。

做什么：对指定台风，抓取多期历史 FNV3 集合平均预报（ensemble_mean），
对官方实况轨迹逐个提前量算偏差（great-circle km），产出 docs/data/fnv3/<tfid>.json，
供前端展示「AI 提前 N 天预报，实际差多少公里」。

合规红线（重要）：
- 只使用「关联时刻在 48 小时以前」的数据——此部分按 CC BY 4.0 授权，可公开展示。
  48 小时以内的实时数据受 GDM 实验性数据条款限制，本管线一律不取。
- 署名：实验性数据 © Google LLC，CC BY 4.0；仅供研究，不用于实际预警。
- URL 官方明示可 wget/curl 脚本化下载，无需鉴权。

真值：温州台风网官方实况轨迹（与全站同源）。注意 FNV3 valid_time 为 UTC，
温州实况为北京时，脚本内统一按 epoch 对齐。

零依赖、纯标准库。抓取失败保留旧结果，不清空。
"""
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "docs" / "data" / "fnv3"
FNV3_BASE = "https://deepmind.google.com/science/weatherlab/download/cyclones/FNV3/ensemble_mean/paired/csv"
WENZHOU = "https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo/{tfid}"
TERMS = "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf"
ATTR = ("实验性数据 © 2024–2025 Google LLC，其机器学习模型生成，"
        "按 CC BY 4.0 授权（关联时刻 48 小时前）。仅供研究，不用于实际预警。")
SAFETY_H = 48  # 只用 48h 以前的数据

# 需要复盘的台风：track_id 为 FNV3 编号（basin+序号+年，如 WP092026）
STORMS = [
    {"tfid": "202609", "trackId": "WP092026", "name": "巴威", "enName": "BAVI"},
]


def hav(a, b, c, d):
    R = 6371.0
    p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "typhoon-impact/1.0 (public-good research)"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8")


def load_observed(tfid):
    """官方实况轨迹（北京时→epoch），返回按 epoch 升序的 [(ep,lat,lon)]。"""
    d = json.loads(get(WENZHOU.format(tfid=tfid)))
    pts = []
    for p in d.get("points", []):
        s = p["time"].replace("T", " ").split("+")[0].split(".")[0]
        t = datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone(timedelta(hours=8)))
        pts.append((t.timestamp(), float(p["lat"]), float(p["lng"])))
    pts.sort()
    return pts, d.get("name"), d.get("enname")


def obs_at(obs, ep):
    """把实况轨迹线性插值到某 epoch；超出范围返回 None。"""
    if not obs or ep < obs[0][0] or ep > obs[-1][0]:
        return None
    for i in range(1, len(obs)):
        if obs[i][0] >= ep:
            (e0, la0, lo0), (e1, la1, lo1) = obs[i - 1], obs[i]
            f = (ep - e0) / (e1 - e0) if e1 > e0 else 0
            return (la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f)
    return None


def init_times(obs, now_utc):
    """从实况时间跨度生成待抓 init（00Z/12Z），只取 48h 前、且在生成后。"""
    start = datetime.fromtimestamp(obs[0][0], timezone.utc)
    cutoff = now_utc - timedelta(hours=SAFETY_H)
    out = []
    day = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    while day <= cutoff:
        for hh in (0, 12):
            t = day.replace(hour=hh)
            if start <= t <= cutoff:
                out.append(t)
        day += timedelta(days=1)
    return out


def fetch_forecast(track_id, init_dt):
    """下载某期 FNV3 ensemble_mean，返回该台风的 [(leadH, validEpoch, lat, lon, windKt)]。"""
    fn = f"FNV3_{init_dt.strftime('%Y_%m_%dT%H_%M')}_paired.csv"
    txt = get(f"{FNV3_BASE}/{fn}")
    track = []
    for line in txt.splitlines():
        if line.startswith("#") or line.startswith("init_time") or not line.strip():
            continue
        c = line.split(",")
        if c[1] != track_id:
            continue
        lead = int(c[5])
        vt = datetime.strptime(c[3], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        wind = None
        try:
            wind = float(c[9])
        except (ValueError, IndexError):
            pass
        track.append((lead, vt, float(c[6]), float(c[7]), wind))
    return track


def hindcast_storm(st, now_utc):
    obs, name, enname = load_observed(st["tfid"])
    if not obs:
        raise RuntimeError("实况轨迹为空")
    forecasts = []
    lead_errs = {}  # leadH -> [errors] 用于全局均值
    for init_dt in init_times(obs, now_utc):
        try:
            track = fetch_forecast(st["trackId"], init_dt)
        except Exception:
            continue  # 该期缺失，跳过
        if not track:
            continue
        errs, tk = {}, []
        for lead, vt, la, lo, wind in track:
            tk.append([lead, round(vt), round(la, 2), round(lo, 2),
                       round(wind) if wind is not None else None])
            o = obs_at(obs, vt)
            if o:
                e = round(hav(la, lo, o[0], o[1]))
                errs[str(lead)] = e
                lead_errs.setdefault(lead, []).append(e)
        forecasts.append({
            "init": init_dt.strftime("%Y-%m-%dT%H:%MZ"),
            "track": tk,
            "errorsKm": errs,
        })
    # 各提前量（整天）全局平均偏差
    summary = {}
    for h in (24, 48, 72, 96, 120):
        vals = lead_errs.get(h, [])
        if vals:
            summary[str(h)] = round(sum(vals) / len(vals))
    return {
        "tfid": st["tfid"], "name": name or st["name"], "enName": enname or st["enName"],
        "trackId": st["trackId"],
        "updatedAt": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
        "license": ATTR, "terms": TERMS,
        "observed": [[round(e), round(la, 2), round(lo, 2)] for e, la, lo in obs],
        "forecasts": forecasts,
        "summary": summary,
    }


def main():
    # Date.now 在 JS 里不可用；此处用真实 UTC 现在时刻判定 48h 红线
    now_utc = datetime.now(timezone.utc)
    OUTDIR.mkdir(parents=True, exist_ok=True)
    index = []
    for st in STORMS:
        try:
            data = hindcast_storm(st, now_utc)
        except Exception as e:
            print(f"[fnv3] {st['tfid']} 复盘失败，保留旧结果: {e}", file=sys.stderr)
            continue
        (OUTDIR / f"{st['tfid']}.json").write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        index.append({"tfid": st["tfid"], "name": data["name"], "enName": data["enName"],
                      "summary": data["summary"], "nForecasts": len(data["forecasts"])})
        s = data["summary"]
        print(f"[fnv3] {data['name']} {st['tfid']}: {len(data['forecasts'])} 期预报, "
              f"平均偏差 +72h={s.get('72','-')}km +120h={s.get('120','-')}km")
    if index:
        (OUTDIR / "index.json").write_text(json.dumps(
            {"updatedAt": now_utc.strftime("%Y-%m-%d %H:%M UTC"), "storms": index},
            ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
