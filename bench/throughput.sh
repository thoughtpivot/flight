#!/usr/bin/env bash
# usage: bench/throughput.sh <a|b|c|t> <port> <server-cpuset> [connections]
#   e.g. single core:  bench/throughput.sh c 4003 1
#        4-core Node:  W=4 bench/throughput.sh t 4004 0-3
# The server is pinned with taskset, wrk runs on WRK_CPUS (default 4-7).
# Output: idle RSS, three 20 s runs after a 10 s warmup, RSS after load.
set -u
name=$1; port=$2; cpus=$3; conns=${4:-100}
WRK_CPUS=${WRK_CPUS:-4-7}
# Published numbers use the defaults: WARMUP_SECS=10 RUN_SECS=20 RUNS=3 (override only for a quick dry run).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
url=http://127.0.0.1:$port/api/hello
( taskset -c "$cpus" bash -c "source '$DIR/env.sh'; start_$name" > /dev/null 2>&1 & )
for _ in $(seq 1 200); do curl -s -o /dev/null -f "$url" && break; sleep 0.1; done
sleep 1
lp=$(ss -ltnp "sport = :$port" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$lp" ] || { echo "server did not start on :$port" >&2; exit 1; }
# RSS of the whole process tree: primary plus workers
tree_rss() { echo $(( $(ps -o rss= -p "$lp") + $(ps --ppid "$lp" -o rss= | awk '{s+=$1} END {print s+0}') )); }
echo "idle_rss_kb $(tree_rss) procs $(( 1 + $(ps --ppid "$lp" --no-headers | wc -l) ))"
taskset -c "$WRK_CPUS" wrk -t4 -c"$conns" -d"${WARMUP_SECS:-10}"s "$url" > /dev/null   # warmup
for _ in $(seq 1 "${RUNS:-3}"); do
  taskset -c "$WRK_CPUS" wrk -t4 -c"$conns" -d"${RUN_SECS:-20}"s --latency "$url" \
    | grep -E "Requests/sec|99%|50%|Non-2xx|Socket errors" | tr -s ' ' | tr '\n' ' '; echo
done
echo "post_load_rss_kb $(tree_rss)"
kill "$lp"; sleep 1; pkill -P "$lp" 2>/dev/null; sleep 1
