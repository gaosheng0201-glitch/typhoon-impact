#!/bin/sh
# 抓取最新台风数据，有变化时提交并推送（Pages 自动跟随重新发布）
cd "$(dirname "$0")/.." || exit 1
python3 fetcher/fetch.py || exit 1
python3 fetcher/fetch_metar.py || true
python3 fetcher/fetch_wind.py || true
python3 fetcher/fetch_fnv3.py || true
if ! git diff --quiet docs/data; then
  git add docs/data
  git commit --quiet -m "data: 自动更新台风数据 $(date -u +%Y-%m-%dT%H:%MZ)"
  git push --quiet
  echo "pushed data update"
else
  echo "no data change"
fi
