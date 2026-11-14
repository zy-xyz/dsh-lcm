K=$(grep -A3 "OMNIROUTE_API_KEY" /home/agent/.dsh/.credentials.yaml | grep -oE "[A-Za-z0-9_-]{20,}" | head -1)
URL=http://10.126.126.4:20128/v1/embeddings
M=mistral-proxy/codestral-embed
# one probe text, long enough to matter
T="a medium length sentence about context compaction and leaf summaries in an agent harness with enough tokens to exercise the tokenizer"
# alone
timeout 90 curl -s -X POST $URL -H 'content-type: application/json' -H "authorization: Bearer $K" -d "{\"model\":\"$M\",\"input\":[\"$T\"]}" -o /tmp/s1.json
# inside a 256 batch at position 0 and 255
for POS in 0 255; do
  BODY=$(node -e "
const t='$T';
const b=Array.from({length:256},(_,i)=>'filler text number '+i);
b[$POS]=t;
console.log(JSON.stringify({model:'$M',input:b}));")
  timeout 200 curl -s -X POST $URL -H 'content-type: application/json' -H "authorization: Bearer $K" -d "$BODY" -o /tmp/b$POS.json
  echo "batch pos $POS: $(stat -c%s /tmp/b$POS.json 2>/dev/null || echo 0) bytes"
done
node -e '
const fs=require("fs");
const cos=(a,b)=>{let d=0,na=0,nb=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}return d/Math.sqrt(na*nb)};
const alone=JSON.parse(fs.readFileSync("/tmp/s1.json")).data[0].embedding;
for (const pos of [0,255]) {
  try {
    const b=JSON.parse(fs.readFileSync("/tmp/b"+pos+".json")).data;
    console.log("pos "+pos+": cosine = "+cos(alone,b[pos].embedding).toFixed(12)+" | dim="+b[pos].embedding.length);
  } catch(e) { console.log("pos "+pos+": "+e.message); }
}
console.log("alone dim: "+alone.length);'