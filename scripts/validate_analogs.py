#!/usr/bin/env python3
"""对照库校验器：analogs.json / analogs-draft.json 的机器把关。

在 CI 里对每个 PR 运行；本地提交前运行：python3 scripts/validate_analogs.py
规则与 CONTRIBUTING.md「对照库数据规范」一一对应——改规则请两处同步。
退出码非 0 = 校验失败。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGIONS = ROOT / "docs" / "data" / "regions.json"

# 内容红线：生活影响之外的词禁止出现在 narrative/impact（"无伤亡"类正面表述除外）
BANNED = re.compile(r"(?<!无)(死亡|遇难|丧生|失踪|伤亡)|经济损失|亿元|万元")
TFID = re.compile(r"^(19|20)\d{2}\d{2}$")  # 6位：年份+编号
NUM_IN_TEXT = re.compile(r"\d")

REQUIRED_TOP = ["eventId", "typhoon", "region", "hazard", "impact", "narrative", "sources"]
LEVELS = {1, 2, 3, 4}


def load_city_names():
    regions = json.loads(REGIONS.read_text(encoding="utf-8"))
    names = set()
    provinces = set()
    for pn, prov in regions.items():
        short = re.sub(r"(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$", "", pn)
        provinces.add(short)
        for cn in prov["cities"]:
            names.add(re.sub(r"(市|地区|自治州|盟)$", "", cn))
            names.add(cn)  # 台湾县市等全名
    return names, provinces


def check_event(e, cities, provinces, strict):
    errs, warns = [], []
    eid = e.get("eventId", "<无eventId>")

    for k in REQUIRED_TOP:
        if k not in e:
            errs.append(f"{eid}: 缺少字段 {k}")
    if errs:
        return errs, warns

    t = e["typhoon"]
    if not t.get("name") or not t.get("enName"):
        errs.append(f"{eid}: typhoon.name/enName 不能为空")
    if not TFID.match(str(t.get("tfid", ""))):
        (errs if strict else warns).append(f"{eid}: tfid 应为6位（年份4+编号2），当前 {t.get('tfid')}")

    r = e["region"]
    prov, city = r.get("province", ""), r.get("city", "")
    if re.search(r"(省|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$", prov):
        errs.append(f"{eid}: province 不带后缀（{prov} → {re.sub(r'(省|自治区|特别行政区)$', '', prov)}）")
    if prov not in provinces:
        errs.append(f"{eid}: 未知省份 {prov}")
    if city != prov and city not in cities:
        # city==省名 允许（省级条目约定）；否则必须能在 regions.json 里找到
        (errs if strict else warns).append(f"{eid}: city「{city}」不在行政区划表（须为地级市名或省级条目）")

    h = e["hazard"]
    if h.get("rainTotalMm") is not None and not isinstance(h["rainTotalMm"], (int, float)):
        errs.append(f"{eid}: rainTotalMm 须为数字或 null")
    if h.get("approx") is not True:
        warns.append(f"{eid}: hazard.approx 建议为 true（数值均为约数）")

    imp = e["impact"]
    if imp.get("level") not in LEVELS:
        errs.append(f"{eid}: impact.level 须为 1-4")

    text = e.get("narrative", "") + json.dumps(imp, ensure_ascii=False)
    m = BANNED.search(text)
    if m:
        errs.append(f"{eid}: 违反内容红线（出现「{m.group()}」）——只写生活影响")
    if len(e.get("narrative", "")) > 90:
        warns.append(f"{eid}: narrative 超过90字，建议精简")

    if not e.get("sources"):
        errs.append(f"{eid}: sources 不能为空")
    # quotes 仅草稿要求：审核合入生产库时会剥离 quotes/review 字段
    if not strict and NUM_IN_TEXT.search(e.get("narrative", "")) and not e.get("quotes"):
        errs.append(f"{eid}: narrative 含数字但缺 quotes 原文支撑——每个数字必须可溯源")
    return errs, warns


def validate(path, strict):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cities, provinces = load_city_names()
    all_errs, all_warns = [], []
    for e in data.get("events", []):
        if "skip" in e:
            continue
        errs, warns = check_event(e, cities, provinces, strict)
        all_errs += errs
        all_warns += warns
    return all_errs, all_warns


def main():
    failed = False
    for path, strict in [("docs/data/analogs.json", True), ("docs/data/analogs-draft.json", False)]:
        p = ROOT / path
        if not p.exists():
            continue
        try:
            errs, warns = validate(p, strict)
        except json.JSONDecodeError as e:
            print(f"✗ {path}: JSON 语法错误 — {e}")
            failed = True
            continue
        tag = "严格" if strict else "宽松"
        print(f"== {path}（{tag}模式）: {len(errs)} 错误 / {len(warns)} 警告")
        for x in errs[:30]:
            print("  ✗", x)
        for x in warns[:15]:
            print("  ⚠", x)
        if errs:
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
