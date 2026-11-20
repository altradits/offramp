# usage: scenario.sh <log> <kes> ; prints quote, pays it from the wallet node, prints outcome
source ${0:A:h}/env.sh
bal(){ wal channelbalance | grep -A1 '"local_balance"' | grep sat | grep -o '[0-9]*'; }
B0=$(bal)
Q=$(curl -s -X POST localhost:7080/quote -d "{\"phone\":\"${3:-0712 345 678}\",\"kes\":$2}")
echo "quote: $(echo "$Q" | python3 -c 'import json,sys;q=json.load(sys.stdin);q.get("invoice") and q.update(invoice=q["invoice"][:24]+"…");print(json.dumps(q))')"
INV=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("invoice",""))'); ID=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -z "$INV" ] && exit 0
wal decodepayreq $INV | grep -E 'num_satoshis|description|cltv_expiry' | tr -s ' '
S=$(date +%s.%N); wal payinvoice --force $INV 2>&1 | grep -E 'Payment status|FAILED|failure' | tail -2; E=$(date +%s.%N)
printf "payinvoice returned after %.1f s\n" $(echo "$E - $S" | bc)
echo "order: $(curl -s localhost:7080/order/$ID)"
echo "wallet channel balance: $B0 -> $(bal) (change $(( $(bal) - B0 )))"
