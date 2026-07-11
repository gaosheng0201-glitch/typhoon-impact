#!/usr/bin/env python3
"""生成 docs/data/regions.json：省/市/区三级级联位置数据（含中心坐标）。

数据源：阿里 DataV GeoAtlas（公开服务）。
台风高影响省份细化到区县级；其余省份到市级（内陆主要防台风残涡暴雨，市级够用）。
一次性脚本，行政区划变更时重跑即可。
"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "regions.json"
BASE = "https://geo.datav.aliyun.com/areas_v3/bound"

# 台风高影响省份（沿海 + 广西/江西/安徽等残涡暴雨常客）→ 区县级
DETAILED = {
    "上海市", "江苏省", "浙江省", "福建省", "广东省", "广西壮族自治区",
    "海南省", "山东省", "辽宁省", "天津市", "河北省", "台湾省",
    "江西省", "安徽省", "河南省", "湖南省", "湖北省", "北京市",
    "香港特别行政区", "澳门特别行政区",
}


def get(adcode):
    url = f"{BASE}/{adcode}_full.json"
    req = urllib.request.Request(url, headers={"User-Agent": "typhoon-impact-build"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def feats(adcode):
    try:
        data = get(adcode)
    except Exception as e:
        print(f"  skip {adcode}: {e}")
        return []
    out = []
    for f in data.get("features", []):
        p = f.get("properties", {})
        if not p.get("center") or not p.get("name"):
            continue
        lng, lat = p["center"]
        out.append({
            "adcode": p["adcode"], "name": p["name"],
            "level": p.get("level"), "lat": round(lat, 4), "lng": round(lng, 4),
        })
    return out


def main():
    regions = {}
    provinces = feats(100000)
    print(f"{len(provinces)} provinces")
    for prov in provinces:
        pname = prov["name"]
        pnode = {"lat": prov["lat"], "lng": prov["lng"], "cities": {}}
        regions[pname] = pnode
        time.sleep(0.15)
        children = feats(prov["adcode"])
        # 直辖市/特别行政区：children 直接是区级
        if children and children[0]["level"] == "district":
            pnode["cities"][pname.replace("省", "").replace("市", "") + "市区"] = {
                "lat": prov["lat"], "lng": prov["lng"],
                "districts": {c["name"]: [c["lat"], c["lng"]] for c in children},
            }
            print(f"  {pname}: {len(children)} districts (municipality)")
            continue
        for city in children:
            cnode = {"lat": city["lat"], "lng": city["lng"], "districts": {}}
            pnode["cities"][city["name"]] = cnode
            if pname in DETAILED:
                time.sleep(0.15)
                for d in feats(city["adcode"]):
                    if d["level"] == "district":
                        cnode["districts"][d["name"]] = [d["lat"], d["lng"]]
        n_d = sum(len(c["districts"]) for c in pnode["cities"].values())
        print(f"  {pname}: {len(pnode['cities'])} cities, {n_d} districts")

    OUT.write_text(json.dumps(regions, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
