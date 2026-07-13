#!/usr/bin/env python3
"""生成 docs/data/warnings.json：中国官方气象预警（生效集）。

数据源：WMO 恶劣天气信息中心（SWIC 3.0）中国 CAP feed——世界气象组织公开中继
中国气象局（CMA）发布的官方预警，feed 声明 <copyright>public domain</copyright>，
合规可转载、无需 key。每条 guid 前 6 位即行政区划码（adcode），与本站区县同源对齐。

    feed: https://severeweather.wmo.int/v2/cap-alerts/cn-cma-xx/rss.xml

要点：
- feed 只保留最近 500 条（含"发布"与"解除"）。本脚本与上一份快照合并，按
  发布/解除/过期维护"生效集"，避免大范围预警时被 500 条截断。
- 只转达、不改写：等级、类型、失效时间原样带出，展示时统一注明"以官方为准"。

红线：本项目只做影响与避险，不触碰伤亡/经济损失。预警文本仅保留类型/等级/区域/
时效等结构化字段，不摘录官方正文里的灾情描述。
"""
import json
import re
import urllib.request
from pathlib import Path
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

BJT = timezone(timedelta(hours=8))   # 北京时（官方预警发布时刻用）

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "warnings.json"
ADCODES = ROOT / "docs" / "data" / "adcodes.json"
FEED = "https://severeweather.wmo.int/v2/cap-alerts/cn-cma-xx/rss.xml"
CAP = "{urn:oasis:names:tc:emergency:cap:1.1}"

# 颜色 ↔ 级别（中国气象预警信号：蓝Ⅳ 黄Ⅲ 橙Ⅱ 红Ⅰ）
COLOR_LEVEL = {"蓝色": "Ⅳ", "黄色": "Ⅲ", "橙色": "Ⅱ", "红色": "Ⅰ"}
EN_COLOR = [("blue", "蓝色"), ("yellow", "黄色"), ("orange", "橙色"), ("red", "红色")]
LEVEL_COLOR = {"iv": "蓝色", "iii": "黄色", "ii": "橙色", "i": "红色"}


def classify(event, title):
    """由 cap:event + 英文标题判定中文预警类型。"""
    s = (event + " " + title).lower()
    if "typhoon" in s:
        return "台风"
    if "geological" in s:
        return "地质灾害气象风险"
    if "mountain" in s and "flood" in s:
        return "山洪"
    if "waterlog" in s or "inundation" in s:
        return "渍涝风险"
    if "flood" in s:
        return "洪水"
    if "thunder" in s:
        return "雷暴大风" if ("wind" in s or "gale" in s) else "雷电"
    if "rainstorm" in s or "rainfall" in s or "heavy rain" in s or "rain" in s:
        return "暴雨"
    if "high temperature" in s or "heat" in s:
        return "高温"
    if "gale" in s or "strong wind" in s or ("wind" in s and "warning" in s):
        return "大风"
    if "fog" in s:
        return "大雾"
    if "haze" in s:
        return "霾"
    if "snow" in s or "blizzard" in s:
        return "暴雪"
    if "cold wave" in s or "cold spell" in s:
        return "寒潮"
    if "frost" in s:
        return "霜冻"
    if "low temperature" in s:
        return "低温"
    if "road ic" in s or "icing" in s or "ice" in s:
        return "道路结冰"
    if "drought" in s:
        return "气象干旱"
    if "hail" in s:
        return "冰雹"
    if "sand" in s or "dust" in s:
        return "沙尘暴"
    return event.strip() or "气象预警"


def color_of(title):
    t = title.lower()
    for en, zh in EN_COLOR:
        if en in t:
            return zh
    m = re.search(r"level\s*(iv|iii|ii|i)\b", t)
    if m:
        return LEVEL_COLOR.get(m.group(1), "")
    return ""


def is_lift(title):
    t = title.lower()
    return any(w in t for w in ("lift", "cancel", "remov", "clear"))


def dt(s):
    try:
        return parsedate_to_datetime(s)
    except Exception:
        return None


def iso(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


def load_prev():
    """载入上一份快照的生效记录，键 (adcode, type)。"""
    prev = {}
    if OUT.exists():
        try:
            data = json.loads(OUT.read_text(encoding="utf-8"))
            for ad, lst in data.get("warnings", {}).items():
                for w in lst:
                    prev[(ad, w["type"])] = w
        except Exception:
            pass
    return prev


def main():
    now = datetime.now(timezone.utc)
    req = urllib.request.Request(FEED, headers={"User-Agent": "typhoonandcicada"})
    with urllib.request.urlopen(req, timeout=40) as resp:
        root = ET.fromstring(resp.read().decode("utf-8"))

    names = {}
    if ADCODES.exists():
        names = json.loads(ADCODES.read_text(encoding="utf-8"))

    # feed 内按 (adcode,type) 取最新一条为当前状态
    latest = {}
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        guid = (it.findtext("guid") or "").strip()
        if not re.match(r"^\d{6}", guid):
            continue
        adcode = guid[:6]
        event = it.findtext(CAP + "event") or ""
        typ = classify(event, title)
        pub = dt(it.findtext("pubDate") or "")
        exp = dt(it.findtext(CAP + "expires") or "")
        area = (it.findtext(CAP + "areaDesc") or "").strip()
        # guid 尾部 _YYYYMMDDHHMMSS 是官方原始发布时刻（北京时）——比 pubDate（WMO
        # 转发时刻，晚约十分钟）更准。核对台山两条与中央气象台页面一致。
        m = re.search(r"_(\d{14})$", guid)
        issued = None
        if m:
            try:
                issued = datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=BJT)
            except ValueError:
                pass
        k = (adcode, typ)
        cur = latest.get(k)
        if cur is None or (pub and cur["_pub"] and pub > cur["_pub"]):
            latest[k] = {
                "adcode": adcode, "type": typ, "color": color_of(title),
                "area_en": area, "expires": exp, "lift": is_lift(title),
                "_pub": pub, "_issued": issued or pub,
            }

    # 合并：上一份快照打底，本轮 feed 覆盖其涉及的 (adcode,type)
    merged = dict(load_prev())          # (adcode,type) -> record(dict, expires 为 iso 字符串)
    for k, x in latest.items():
        if x["lift"]:
            merged.pop(k, None)
            continue
        color = x["color"]
        merged[k] = {
            "adcode": x["adcode"], "type": x["type"], "color": color,
            "level": COLOR_LEVEL.get(color, ""),
            "issued": iso(x["_issued"]),       # 官方发布时刻（guid，北京时）；无失效时间时用它兜底
            "expires": iso(x["expires"]),
            "name": names.get(x["adcode"]) or x["area_en"],
        }

    # 丢弃已过期
    def alive(w):
        e = w.get("expires")
        if not e:
            return True  # 无失效时间：留到官方解除（下一轮 lift 会移除）
        try:
            return datetime.strptime(e, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) > now
        except Exception:
            return True

    out = {}
    for (ad, _typ), w in merged.items():
        if not alive(w):
            continue
        out.setdefault(ad, []).append({k: v for k, v in w.items() if k != "adcode"})

    payload = {
        "updated": iso(now),
        "source": "中国气象局 · 经 WMO 恶劣天气信息中心公开中继",
        "note": "官方预警，以气象部门发布为准",
        "count": sum(len(v) for v in out.values()),
        "warnings": out,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT}: {payload['count']} 条生效预警 / {len(out)} 个区县")


if __name__ == "__main__":
    main()
