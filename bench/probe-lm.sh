URL=http://10.126.126.3:1234/v1/embeddings
echo "== reachability =="
curl -s -o /tmp/lm.json -w 'http=%{http_code} time=%{time_total}s\n' -X POST $URL -H 'content-type: application/json' -d '{"model":"text-embedding-qwen3-vl-embedding-8b","input":"probe"}' 2>&1 | tail -2
head -c 200 /tmp/lm.json 2>/dev/null; echo
echo "== batch of 32 =="
BODY=$(node -e "console.log(JSON.stringify({model:'text-embedding-qwen3-vl-embedding-8b',input:Array.from({length:32},(_,i)=>'batch text '+i)}))")
T0=$(date +%s%N); CODE=$(curl -s -o /tmp/lm32.json -w '%{http_code}' -X POST $URL -H 'content-type: application/json' -d "$BODY"); T1=$(date +%s%N)
echo "http=$CODE ms=$(( (T1-T0)/1000000 )) vectors=$(node -e "try{const d=require('/tmp/lm32.json');console.log(d.data?d.data.length:'-')}catch{console.log('-')}")"
node -e "try{const d=require('/tmp/lm32.json');console.log('dim:',d.data?.[0]?.embedding?.length)}catch{}"