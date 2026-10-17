#!/bin/sh
# Manual smoke test against a running brain (any adapter). Not part of `npm test`.
# Usage: sh scripts/smoke.sh [base-url]   (default http://127.0.0.1:7341)
set -eu
URL="${1:-http://127.0.0.1:7341}"
DAY1='{"season":"spring","day":5,"year":1,"time":1130,"weather":"sunny","location":"Town"}'
DAY2='{"season":"spring","day":6,"year":1,"time":1000,"weather":"rainy","location":"Town"}'
SAVE='Smoke_1'

talk() {
  curl -sS -w '\n  latency=%{time_total}s http=%{http_code}\n' -X POST "$URL/v1/talk" -H 'content-type: application/json' -d "$1"
}

echo "== day 1, opening line"
talk "{\"saveId\":\"$SAVE\",\"npc\":\"Abigail\",\"playerName\":\"Tae\",\"day\":$DAY1,\"friendship\":{\"hearts\":2,\"points\":500}}"

echo "== day 1, player picks a reply"
talk "{\"saveId\":\"$SAVE\",\"npc\":\"Abigail\",\"playerName\":\"Tae\",\"day\":$DAY1,\"friendship\":{\"hearts\":2,\"points\":500},\"transcript\":[{\"speaker\":\"npc\",\"text\":\"Oh, hey. You are the new farmer, right?\"}],\"recentChoice\":{\"id\":\"c\",\"text\":\"I found a weird glowing rock in the mines.\"}}"

echo "== day end"
curl -sS -X POST "$URL/v1/day-end" -H 'content-type: application/json' -d "{\"saveId\":\"$SAVE\",\"playerName\":\"Tae\",\"day\":$DAY1,\"events\":[{\"type\":\"talk\",\"npc\":\"Abigail\",\"location\":\"Town\",\"time\":1130,\"npcLine\":\"Oh, hey. You are the new farmer, right?\",\"playerChoice\":\"I found a weird glowing rock in the mines.\"},{\"type\":\"gift\",\"npc\":\"Abigail\",\"location\":\"Town\",\"time\":1140,\"item\":\"Amethyst\",\"taste\":\"loved\"}]}"
echo

echo "== day 2, opening line (should remember the rock or the amethyst)"
talk "{\"saveId\":\"$SAVE\",\"npc\":\"Abigail\",\"playerName\":\"Tae\",\"day\":$DAY2,\"friendship\":{\"hearts\":2,\"points\":580}}"
