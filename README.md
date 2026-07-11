# 台风影响 Typhoon Impact

**把台风预报翻译成每个人能懂、能行动的信息。**公益项目，免费、无广告、不商业化。

缘起：2026 年台风美莎克在广西停留过久，600mm+ 降雨成灾——预报明明存在，
但"预报"和"普通人的行动"之间隔着一道没人翻译的鸿沟。这个项目就是那个翻译。

- 🌀 **路径图**：实况 + 五家机构预报同屏对比（中国/日本/美国/中国台湾/中国香港）
- 📍 **我会不会受灾（主页内嵌）**：位置精确到**区县级**（全国 1600+ 区县）或浏览器定位，
  给出风险参考 / 开始与**结束**时间 / 历史对照 / 该做什么，详情折叠、主次分明
- 👥 **分人群清单**：城市居民（可叠加高层/低洼/商铺情境）、农户、水产、畜禽、渔船沿海——
  把真实受灾经验变成可复用资产，含「决策窗口」提示（如运输车通常在暴雨前 24h 停摆）
- 🐌 **停留型台风检测**：移速慢的台风危险在雨不在风——美莎克问题的直接答案
- 📤 **分享卡片**：一键生成发给家人的图片，核心信息是「台风强度 ≠ 你受影响的程度」

**本应用不发布预警**，只做官方信息的转译、客观计算与历史事实陈列。
灾害预警以各级气象与应急管理部门发布为准。欢迎共建，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 运行

```bash
python3 fetcher/fetch.py            # 抓一次数据 → docs/data/
python3 fetcher/fetch.py --loop     # 每 5 分钟抓一次（常驻）
python3 -m http.server 8642 -d docs  # 启动本地页面 http://localhost:8642
```

无任何第三方依赖（Python 标准库 + 前端 CDN 引入 MapLibre）。

## 结构

```
fetcher/fetch.py   抓取器：温州台风网 API → 规范化 JSON
docs/              静态前端（MapLibre GL JS，深色底图），GitHub Pages 直接发布此目录
docs/data/         抓取器输出（index.json + typhoon_{tfid}.json）
archive/           每次抓取的原始快照，按台风编号分目录
                   ⚠️ 这是将来做「预报误差打分」的原料，不要删
```

## 数据源

| 用途 | 来源 | 说明 |
|---|---|---|
| 主数据（实况+五机构预报） | 温州台风网 `typhoon.slt.zj.gov.cn/Api/*` | 非正式公开接口，需带 Referer 头 |
| 备用：中央气象台 | `typhoon.nmc.cn/weatherservice/typhoon/jsons/*` | JSONP，仅 BABJ 一家预报 |
| 备用：日本气象厅 | `www.jma.go.jp/bosai/typhoon/data/*` | 官方 JSON，含预报圆概率半径 |
| 历史最佳路径 | JMA RSMC / IBTrACS | 用于误差回算 |
| 前期实测雨量 | Open-Meteo API | 免费、开 CORS，前端直连 |

## 区县历史台风档案（docs/data/history.json）

每个区县 1949 年以来的客观统计（数据源 IBTrACS v04r01 西太子集，NOAA 公开数据）：
台风中心 100km 内经过次数、300km 内次数、最高发月份、最强过境 Top3。
1407 个台风 × 1757 个区县，纯计算、可复核。重新生成：

```bash
curl -O https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.WP.list.v04r01.csv
python3 fetcher/build_history.py ibtracs.WP.list.v04r01.csv
```

## 历史台风对照库（docs/data/analogs.json）

「影响预警」的核心资产：历次台风 × 城市 × 灾情的结构化记录，用于把预报雨量
翻译成本地人有体感的对照（"接近 2019 利奇马时本地的雨量"）。字段：

```
eventId    唯一标识（tfid-enname-city）
typhoon    { tfid, name, enName }
region     { province, city }
hazard     { rainTotalMm(过程雨量,约数), rainDurationH, peakPower, landfall, approx }
impact     { level(1-4), flood, power, water, evacuation, note }
narrative  一句给普通用户看的人话总结
sources    数据出处（年鉴/公开报道）
```

当前为人工整理的种子数据（7 个经典案例），数值均为约数。扩充方向：
《中国气象灾害年鉴》逐案录入 + 应急管理部灾情通报。
**定位合规**：产品只做官方预警的转译、历史对照与备灾建议，不自行发布预警；
涉撤离一律指向官方通知。

## 路线图

- [x] 底座：抓取 + 地图 + 实况路径（按强度着色）+ 风圈 + 多机构预报叠加
- [x] 影响卡片原型（docs/impact.html）：位置 → 影响等级/时间线/历史对照/备灾清单
      （雨量目前为按距离的演示估算，正式版接 WeatherNext 降水格点）
- [x] 分享卡片：Canvas 生成 750×1000 竖版图片（城市级位置 + 结论 + 历史对照 + 提示），
      核心传播点是「台风强度 ≠ 你受影响的程度」——离得远时它就是一张辟谣卡
- [x] 停留型台风检测：预报路径移速 < 18 km/h 触发（美莎克/广西 600mm 场景的直接答案），
      影响评估切换为累计雨量主导、雨量按停留时长加成、等级下限抬升
- [x] 结束时间：时间线含「风雨基本结束」时刻与影响持续小时数
      （社区调研发现：解除/结束时间是刚需——「几点解除警报？要通知机电拆防水闸门」）
- [ ] 面 1：台风结束后用最佳路径回算各机构 24/48/72h 预报误差，累积排行榜
- [ ] WeatherNext 2 接入：申请表已提交后，从格点场跑涡旋追踪，作为「AI 预报」一条线加入对比
      （<https://developers.google.com/weathernext/guides/access-forecast>；
      注意 <48h 实时数据的实验性条款，商用前需确认）
- [ ] 面 2：输入位置 → 逐时风雨时间线（依赖 WeatherNext 格点数据）
- [x] 残涡不停追：停编 ≤48h 且有近期实况的台风继续追踪并标注「残余环流」，
      影响卡提示"风的威胁结束了，雨的风险还没有"（郑州 7·20 型灾害的教训）
- [x] 前期降雨上下文：Open-Meteo 过去 14 天实测累计，≥150mm 提示
      "这场雨将落在已经湿透的土地上"（菲特/利奇马型灾害的共同前提）
- [ ] **双情景卡**：机构预报分歧大时给两个分支（快速过境 vs 停滞），分歧本身就是信号
- [ ] 官方预警信号接入：等级判断挂靠官方发布，应用只做转译
- [ ] 部署：fetcher 挂 cron 定时更新 docs/data/ 并 push（Pages 自动跟随）

## 数据流

前端**直连**温州台风网实时接口（接口开放 CORS），打开页面即是实时数据，
每 5 分钟自动刷新——线上站点无需任何定时任务。

`docs/data/` 内的快照有两个用途：接口故障/被限流时的**自动降级**（页面会标注
"快照数据"），以及克隆仓库后的离线演示。刷新快照：`python3 fetcher/fetch.py`
或 `sh scripts/update.sh`（抓取+提交+推送一条龙）。fetcher 的另一个职责是把
每次抓到的原始预报存进 `archive/`——这是将来做预报误差打分的原料。

## 许可

代码 MIT；`docs/data/analogs.json` 对照库 CC BY 4.0（见 LICENSE）。
