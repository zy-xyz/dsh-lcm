K=$(grep -A3 "OMNIROUTE_API_KEY" /home/agent/.dsh/.credentials.yaml | grep -oE "[A-Za-z0-9_-]{20,}" | head -1)
for i in 1 2 3 4 5; do
  T0=$(date +%s%N)
  CODE=$(timeout 30 curl -s -o /dev/null -w '%{http_code}' -X POST http://10.126.126.4:20128/v1/embeddings -H 'content-type: application/json' -H "authorization: Bearer $K" -d '{"model":"mistral-proxy/codestral-embed","input":["x"]}' 2>/dev/null)
  T1=$(date +%s%N)
  echo "  attempt $i: http=$CODE $(( (T1-T0)/1000000 ))ms"
done