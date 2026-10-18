#!/bin/bash
set -u
RES="$HOME/dsh-final.txt"
LOG="$HOME/dsh-final-session.log"
: > "$RES"; : > "$LOG"
PRE=$(netstat -ano 2>/dev/null | grep ":43194" | grep -c LISTENING || true)
if [ "$PRE" != "0" ]; then echo "ABORT: stale listener on 43194" >> "$RES"; exit 9; fi
cd ~ || exit 3
export ELECTRON_RUN_AS_NODE=1
export DSH_PI_BRIDGE_DSH_SERVE=43194
EXE="/c/Users/ALICE/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"
BIN="C:\\Users\\ALICE\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"
FIXW="E:\\Projects\\testanything\\dsh插件安装\\dsh-pi-bridge\\scripts\\fixtures\\dsh-hostload"
P="Step 1: call dsh_install with source $FIXW. Step 2: call hl_hold with ms=290000. Step 3: call hl_hold with ms=290000. Step 4: call hl_hold with ms=290000. Step 5: call hl_hold with ms=290000. Step 6: call hl_hold with ms=290000. Step 7: reply DONE."
timeout --signal=KILL 1900 "$EXE" "$BIN" bridge-test "$P" > "$LOG" 2>&1 &
BGPID=$!
UP=0
for i in $(seq 1 70); do
  sleep 3
  H=$(curl -s -m 4 http://127.0.0.1:43194/health 2>/dev/null || true)
  case "$H" in *serve*true*) echo "SERVING_AFTER=$((i*3))s $(echo $H | grep -o bridgeVersion..[a-z0-9]*) " >> "$RES"; UP=1; break ;; esac
done
if [ "$UP" != 1 ]; then echo "NEVER_SERVED" >> "$RES"; tail -25 "$LOG" >> "$RES"; kill $BGPID 2>/dev/null; exit 7; fi
sleep 50
cd "/e/Projects/testanything/dsh插件安装/dsh-pi-bridge" || exit 8
export DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43194
echo "########## DSH side: ten published bundles ##########" >> "$RES"
node tools/batch-dsh-to-pi.mjs .tmp/dsh-list2.json >> "$RES" 2>&1
echo "BATCH_EXIT=$?" >> "$RES"
echo "########## session still alive? ##########" >> "$RES"
echo "health: $(curl -s -m 5 http://127.0.0.1:43194/health | head -c 130)" >> "$RES"
echo "########## pi side: same ten through pi ##########" >> "$RES"
node tools/batch-pi-side.mjs .tmp/dsh-list2.json >> "$RES" 2>&1
echo "PISIDE_EXIT=$?" >> "$RES"
curl -s -m 5 http://127.0.0.1:43194/shutdown >/dev/null 2>&1 || true
kill $BGPID 2>/dev/null || true
echo "=== END ===" >> "$RES"
exit 0
