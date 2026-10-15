#!/usr/bin/env bash
# usage: bench/startup.sh <a|b|c|t> <port>
# Starts the server, exits once /api/hello returns 200, then stops it. Time it with hyperfine:
#   hyperfine --warmup 2 --runs 15 'bench/startup.sh c 4003' 'bench/startup.sh t 4004'
name=$1; port=$2
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash -c "source '$DIR/env.sh'; start_$name" > /dev/null 2>&1 &
pid=$!
until curl -s --max-time 1 -o /dev/null -f "http://127.0.0.1:$port/api/hello"; do sleep 0.005; done
lp=$(ss -ltnp "sport = :$port" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)   # the actual listener
kill $pid $lp 2>/dev/null; pkill -P $pid 2>/dev/null
while ss -ltn "sport = :$port" | grep -q LISTEN; do sleep 0.01; done
