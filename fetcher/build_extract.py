#!/usr/bin/env python3
"""对照库「城市×台风」批量抽取脚手架（CONTRIBUTING.md 流水线的可复跑实现）。

设计要点：整条 6 步流水线里只有第 3 步（从原文抽引文、起草条目）需要 LLM，
其余全是确定性代码。本程序把 1/2/4/5 固化成可复跑命令，第 3 步做成**可插拔
抽取器**——subagent/人工（免费）或 API（计费，无人值守）二选一。

  1 官方路径定清单  --tfid X --cities   温州台风网路径 → 150km 内候选城市 + 降雨锚点
  2 抓网页          --tfid X --fetch    中文维基条目正文（免 key）→ 缓存
  3 抽取起草        --tfid X --packets  吐工作包给 subagent/人工填（默认，免费）
                    --extractor api     直接调 Claude API 起草（需 ANTHROPIC_API_KEY，计费）
  4 引文回查+红线    --verify draft.json 每个数字必须在 quotes、quotes 必须在原文、红线正则
  5 机器校验        （--verify 末尾自动调 scripts/validate_analogs.py）
  6 人工终审        你把关（程序不替代）

零预算取向：不建议把第 3 步固化成常开 API（会计费、且人工终审瓶颈仍在）。
默认走 packet + subagent；--extractor api 仅为需要无人值守时的可选开关。
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
QUEUE = DATA / "extract-queue"           # 工作包/原文缓存（gitignore）
DRAFT = DATA / "analogs-draft.json"
VALIDATOR = ROOT / "scripts" / "validate_analogs.py"

WZTF = "https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo"
WIKI = "https://zh.wikipedia.org/w/api.php"
HEADERS = {"Referer": "https://typhoon.slt.zj.gov.cn/",
           "User-Agent": "Mozilla/5.0 (typhoon-tracker-dev)"}

TRANSIT_KM = 150   # CONTRIBUTING 定义的过境门槛（官方路径定清单）
BANNED = re.compile(r"(?<!无)(死亡|遇难|丧生|失踪|伤亡)|经济损失|亿元|万元")
NUM = re.compile(r"\d+(?:\.\d+)?")

import math


def haversine(lat1, lng1, lat2, lng2):
    d = math.pi / 180
    a = (math.sin((lat2 - lat1) * d / 2) ** 2 +
         math.cos(lat1 * d) * math.cos(lat2 * d) * math.sin((lng2 - lng1) * d / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def get_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── 步骤 1：官方路径定清单 ──────────────────────────────────────────────
def track_and_cities(tfid):
    d = get_json(f"{WZTF}/{tfid}")
    name, en = d.get("name"), d.get("enname")
    track = []
    for p in d.get("points") or []:
        try:
            track.append((float(p["lat"]), float(p["lng"])))
        except (KeyError, ValueError):
            continue
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))
    rain = {}
    rf = DATA / "rain-history.json"
    if rf.exists():
        rain = json.loads(rf.read_text(encoding="utf-8")).get("d", {}).get(tfid, {}).get("cities", {})
    out = []
    for prov, pobj in regions.items():
        for cn, c in pobj.get("cities", {}).items():
            dmin = min((haversine(c["lat"], c["lng"], la, lo) for la, lo in track),
                       default=9e9)
            if dmin <= TRANSIT_KM:
                out.append({"province": prov, "city": cn, "closestKm": round(dmin),
                            "rainAnchor": rain.get(cn)})
    out.sort(key=lambda x: x["closestKm"])
    return name, en, out


# ── 步骤 2：抓网页（中文维基正文，免 key） ─────────────────────────────
def fetch_wiki(name, en):
    q = urllib.parse.urlencode({
        "action": "query", "format": "json", "redirects": 1,
        "prop": "extracts", "explaintext": 1, "exsectionformat": "plain",
        "generator": "search", "gsrsearch": f"台风{name} {en}", "gsrlimit": 1})
    try:
        d = get_json(f"{WIKI}?{q}")
        pages = (d.get("query") or {}).get("pages") or {}
        for p in pages.values():
            return p.get("title", ""), p.get("extract", "")
    except Exception as e:
        print(f"  wiki 抓取失败: {e}", file=sys.stderr)
    return "", ""


# ── 步骤 3：工作包（默认，交 subagent/人工填） ─────────────────────────
SCHEMA_HINT = {
    "eventId": "<tfid>-<enName小写>-<city>", "typhoon": {"tfid": "", "name": "", "enName": ""},
    "region": {"province": "不带后缀", "city": "地级市名"},
    "hazard": {"rainTotalMm": "数字或null，没原文依据填null", "peakPower": None,
               "landfall": False, "approx": True},
    "impact": {"level": "1-4", "flood": "", "note": ""},
    "narrative": "≤90字，每个数字必须能在 quotes 找到",
    "quotes": ["逐字原文片段"], "sources": ["媒体名: URL"], "review": "pending",
}
REDLINE = "narrative/impact 禁止出现：死亡/遇难/丧生/失踪/伤亡/经济损失/亿元/万元（只写对生活的影响）"


def write_packets(tfid, name, en, cities, source_title, source_text, limit):
    QUEUE.mkdir(parents=True, exist_ok=True)
    (QUEUE / f"source_{tfid}.txt").write_text(
        f"# {source_title}\n\n{source_text}", encoding="utf-8")
    packets = []
    for c in cities[:limit]:
        packets.append({
            "task": "从 sourceText 抽取该城市在此台风中的生活影响，起草 1 条对照库草稿",
            "typhoon": {"tfid": tfid, "name": name, "enName": en},
            "city": c["city"], "province": c["province"],
            "closestKm": c["closestKm"], "rainAnchor": c["rainAnchor"],
            "redline": REDLINE, "schema": SCHEMA_HINT,
            "rule": "每个数字逐字来自 sourceText；抽不到城市级灾情就返回 {skip: 原因}",
            "sourceTitle": source_title,
            "sourceRef": f"docs/data/extract-queue/source_{tfid}.txt",
        })
    pf = QUEUE / f"packets_{tfid}.json"
    pf.write_text(json.dumps(packets, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  写入 {len(packets)} 个工作包 → {pf}")
    print(f"  原文 → {QUEUE / f'source_{tfid}.txt'}（{len(source_text)} 字）")
    print("  下一步：交 subagent 逐包填（免费），或 --extractor api 自动起草（计费）")


# ── 步骤 3'：API 抽取器（可选，计费；对上 CONTRIBUTING「Sonnet 级起草」） ──
DRAFT_MODEL = "claude-sonnet-5"   # 起草：Sonnet 级
CHECK_MODEL = "claude-opus-4-8"   # 终检：Opus 级


def extract_api(packet):
    """直接调 Anthropic API 起草一条草稿（结构化输出）。需要 ANTHROPIC_API_KEY。"""
    try:
        import anthropic
    except ImportError:
        sys.exit("需要 anthropic SDK：pip install anthropic（且 export ANTHROPIC_API_KEY=...）")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("未设 ANTHROPIC_API_KEY——API 抽取会计费，与零预算冲突，确认后再开。")
    client = anthropic.Anthropic()
    source = (QUEUE / Path(packet["sourceRef"]).name).read_text(encoding="utf-8")
    tool = {"name": "draft", "description": "输出一条对照库草稿或 skip",
            "input_schema": {"type": "object", "properties": {
                "skip": {"type": "string"},
                "entry": {"type": "object"}}}}
    msg = client.messages.create(
        model=DRAFT_MODEL, max_tokens=1500, tools=[tool],
        tool_choice={"type": "tool", "name": "draft"},
        messages=[{"role": "user", "content":
                   f"台风 {packet['typhoon']['name']}({packet['typhoon']['enName']})、"
                   f"城市 {packet['city']}。规则：{packet['rule']}；红线：{packet['redline']}；"
                   f"schema：{json.dumps(packet['schema'], ensure_ascii=False)}。\n\n"
                   f"原文：\n{source[:12000]}"}])
    for b in msg.content:
        if b.type == "tool_use":
            return b.input
    return {"skip": "no tool output"}


# ── 步骤 4：引文回查 + 红线（纯代码，整条链可信的关键） ────────────────
def normalize(s):
    return re.sub(r"[^一-鿿0-9]", "", s or "")


def recheck(entry, source_text):
    """返回 errors 列表（空=通过）。"""
    errs = []
    eid = entry.get("eventId", "?")
    quotes_text = "".join(entry.get("quotes", []))
    # ① narrative 每个数字必须出现在 quotes
    for n in NUM.findall(entry.get("narrative", "")):
        if n not in quotes_text:
            errs.append(f"{eid}: narrative 数字「{n}」在 quotes 里找不到")
    # ② 每条 quote 必须能在原文里回查到（标点/引号差异做归一）
    src = normalize(source_text)
    if src:
        for q in entry.get("quotes", []):
            nq = normalize(q)
            if len(nq) >= 6 and nq not in src:
                errs.append(f"{eid}: quote 在原文回查不到「{q[:20]}…」")
    # ③ 红线
    blob = entry.get("narrative", "") + json.dumps(entry.get("impact", {}), ensure_ascii=False)
    m = BANNED.search(blob)
    if m:
        errs.append(f"{eid}: 触红线「{m.group()}」")
    return errs


def cmd_verify(draft_path):
    data = json.loads(Path(draft_path).read_text(encoding="utf-8"))
    total = fail = 0
    for e in data.get("events", []):
        if "skip" in e:
            continue
        total += 1
        tfid = e.get("typhoon", {}).get("tfid", "")
        sf = QUEUE / f"source_{tfid}.txt"
        src = sf.read_text(encoding="utf-8") if sf.exists() else ""
        if not src:
            print(f"  ⚠ {e.get('eventId')}: 无缓存原文，跳过引文回查（仅红线/数字自检）")
        errs = recheck(e, src)
        for x in errs:
            print("  ✗", x)
        fail += bool(errs)
    print(f"引文回查：{total} 条，{fail} 条有问题")
    print("── 交给机器校验器 ──")
    r = subprocess.run([sys.executable, str(VALIDATOR)], cwd=str(ROOT))
    return fail == 0 and r.returncode == 0


# ── CLI ────────────────────────────────────────────────────────────────
def main():
    a = sys.argv[1:]
    if "--verify" in a:
        ok = cmd_verify(a[a.index("--verify") + 1] if a.index("--verify") + 1 < len(a) else DRAFT)
        sys.exit(0 if ok else 1)

    if "--tfid" not in a:
        print(__doc__)
        return
    tfid = a[a.index("--tfid") + 1]
    limit = int(a[a.index("--limit") + 1]) if "--limit" in a else 20

    name, en, cities = track_and_cities(tfid)
    print(f"{tfid} {name}({en})：{len(cities)} 个 150km 内候选城市")

    if "--cities" in a:
        for c in cities[:limit]:
            anc = c["rainAnchor"]
            tag = f" 雨≈{anc['totalMm']}mm(峰{anc['peakMm']})" if anc else " 无降雨锚点"
            print(f"  {c['city']:<10} {c['closestKm']:>3}km{tag}")
        return

    if "--fetch" in a or "--packets" in a:
        title, text = fetch_wiki(name, en)
        if "--packets" in a:
            write_packets(tfid, name, en, cities, title, text, limit)
        else:
            QUEUE.mkdir(parents=True, exist_ok=True)
            (QUEUE / f"source_{tfid}.txt").write_text(f"# {title}\n\n{text}", encoding="utf-8")
            print(f"  原文 {title}（{len(text)} 字）→ {QUEUE / f'source_{tfid}.txt'}")
        return

    print("指定动作：--cities / --fetch / --packets（或 --verify <draft.json>）")


if __name__ == "__main__":
    main()
