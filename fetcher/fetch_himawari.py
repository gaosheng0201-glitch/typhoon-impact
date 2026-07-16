#!/usr/bin/env python3
"""生成 docs/data/satellite.json：葵花9号（Himawari-9）实况云图帧列表（真彩 + 红外）。

两个产品互补，缺一不可：
- truecolor 真彩（可见光）：白天直观漂亮，是「首屏英雄图」；夜间无图（全黑）。
- ir 红外 B13：测云顶热辐射，**昼夜可用**——夜里的台风眼、眼壁、螺旋雨带全靠它。
  「静风陷阱 / 解除信号」多发生在夜间，必须用这个通道。

数据源（均公开、无需 key，本站只写「帧时刻 + 瓦片地址」，图片由前端直取）：
- 真彩：NICT（日本情报通信研究机构）实时中继，550px 瓦片，10 分钟一帧
    latest: https://himawari8-dl.nict.go.jp/himawari8/img/D531106/latest.json
    tile:   .../D531106/{z}d/550/{Y}/{M}/{D}/{hhmmss}_{x}_{y}.png   z∈{1,2,4,8}
- 红外：RAMMB/CIRA SLIDER（科罗拉多州立大学），688px 瓦片，约 10 分钟一帧
    times:  https://rammb-slider.cira.colostate.edu/data/json/himawari/full_disk/band_13/latest_times.json
    tile:   .../data/imagery/{Y}/{m}/{d}/himawari---full_disk/band_13/{ts}/{zz}/{row}_{col}.png
            zoom zz∈{00..03}，每级 2^z × 2^z 张（已实测 00-03 全通）

要点：
- 瓦片是**静止卫星全圆盘投影**（星下点约 140.7°E），不是 EPSG:4326 / 墨卡托，
  不能直接叠地图图层；当前用途是独立的「实况云图」视觉块。
- 真彩帧按 10 分钟网格自 latest 回推并逐帧 HEAD 校验；红外帧直接取
  latest_times.json 里真实存在的时刻，无需探测。

红线：本项目只做影响与避险。卫星只作实况呈现与强度佐证，不做灾损评估。
"""
import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "satellite.json"

FRAMES = 12             # 每产品 12 帧 ≈ 最近 2 小时，够放一段动画
UA = {"User-Agent": "typhoonandcicada"}

NICT_BASE = "https://himawari8-dl.nict.go.jp/himawari8/img/D531106"
NICT_TILE = NICT_BASE + "/{z}d/550/{path}_{x}_{y}.png"   # path = YYYY/MM/DD/hhmmss

SLIDER_TIMES = ("https://rammb-slider.cira.colostate.edu/data/json/"
                "himawari/full_disk/band_13/latest_times.json")
SLIDER_TILE = ("https://rammb-slider.cira.colostate.edu/data/imagery/"
               "{date}/himawari---full_disk/band_13/{ts}/{zz}/{row}_{col}.png")


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def head_ok(url):
    req = urllib.request.Request(url, headers=UA, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False


def iso(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def truecolor_frames():
    """NICT 真彩：latest 对齐 10 分钟网格回推，逐帧 HEAD 校验。"""
    meta = get_json(f"{NICT_BASE}/latest.json")
    latest = datetime.strptime(meta["date"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    latest -= timedelta(minutes=latest.minute % 10, seconds=latest.second)

    frames = []
    for i in range(FRAMES):
        t = latest - i * timedelta(minutes=10)
        path = t.strftime("%Y/%m/%d/%H%M%S")
        if head_ok(NICT_TILE.format(z=1, path=path, x=0, y=0)):
            frames.append({"time": iso(t), "path": path})
    frames.reverse()
    return frames, meta.get("file", "")


def ir_frames():
    """SLIDER 红外 B13：latest_times.json 给的就是真实存在的帧，取最近 FRAMES 个。"""
    times = get_json(SLIDER_TIMES).get("timestamps_int", [])[:FRAMES]
    frames = []
    for ts in times:
        t = datetime.strptime(str(ts), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        frames.append({"time": iso(t), "date": t.strftime("%Y/%m/%d"), "ts": str(ts)})
    frames.reverse()
    return frames


def main():
    now = datetime.now(timezone.utc)

    tc, product = truecolor_frames()
    ir = ir_frames()
    if not tc and not ir:
        raise SystemExit("no frames from NICT nor SLIDER — 不覆盖旧快照，本轮放弃")

    payload = {
        "updated": iso(now),
        "note": "实况云图，静止卫星全圆盘投影（非地图坐标）。真彩为可见光、夜间无图；红外昼夜可用",
        "products": {
            "truecolor": {
                "source": "葵花9号 · 日本气象厅观测 / NICT 实时中继",
                "product": product,
                "latest": tc[-1]["time"] if tc else None,
                "tile": {"template": NICT_TILE, "levels": [1, 2, 4, 8], "size": 550},
                "frames": tc,
            },
            "ir": {
                "source": "葵花9号 红外B13 · 日本气象厅观测 / RAMMB·CIRA SLIDER 中继",
                "latest": ir[-1]["time"] if ir else None,
                "tile": {"template": SLIDER_TILE, "zooms": [0, 1, 2, 3], "size": 688,
                         "zz": "zoom 两位补零；每级 2^z × 2^z 张，row/col 三位补零"},
                "frames": ir,
            },
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT}: 真彩 {len(tc)} 帧 / 红外 {len(ir)} 帧 / 最新 "
          f"{(ir or tc)[-1]['time']}")


if __name__ == "__main__":
    main()
