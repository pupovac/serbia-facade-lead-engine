#!/bin/zsh
set -e
cd "$(dirname "$0")"
# Per-code sample crawl. A baseline copy is taken before each code so overlap
# can be measured against the database as it stood when that code was crawled.
CODES=("23.64:40" "46.73:350" "41.20:350" "43.33:250" "71.11:250" "71.12:250")
cp data/leads.sqlite data/fuzz46/baseline-empty.sqlite
for entry in $CODES; do
  code="${entry%%:*}"; limit="${entry##*:}"
  cp data/leads.sqlite "data/fuzz46/baseline-${code}.sqlite"
  echo "=== $code limit=$limit $(date +%H:%M:%S)"
  npx tsx src/scraper/cli.ts --source kompanije-net --query "$code" --limit "$limit" --budget 1000 2>&1 | tail -12
done
echo "=== ALL DONE $(date +%H:%M:%S)"
