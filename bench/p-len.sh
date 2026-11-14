K=$(grep -A3 "OMNIROUTE_API_KEY" /home/agent/.dsh/.credentials.yaml | grep -oE "[A-Za-z0-9_-]{20,}" | head -1)
URL=http://10.126.126.4:20128/v1/embeddings
M=mistral-proxy/codestral-embed
for CH of 4000 8000 16000 32000 64000; do
  TXT=$(node -e "console.log('word '.repeat($CH/5))")
  BODY=$(node -e "const t='word '.repeat($CH/5);console.log(JSON.stringify({model:'$M',input:[t]}))")
  CODE=$(timeout 120 curl -s -o /tmp/L$CH.json -w '%{http_code}' -X POST $URL -H 'content-type: application/json' -H "authorization: Bearer $K" -d "$BODY" 2>/dev/null)
  MSG=$(node -e "try{const d=require('/tmp/L$CH.json');console.log(d.error?JSON.stringify(d.error).slice(0,90):'ok dim='+d.data[0].embedding.length)}catch{console.log('-')}" 2>/dev/null)
  echo "chars=$CH http=$CODE $MSG"
done