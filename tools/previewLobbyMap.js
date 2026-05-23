/*
 * previewLobbyMap.js — emits a standalone HTML that renders a lobby map JSON
 * exactly the way the game's draw.js does (same polygon walk, same textures,
 * background cells skipped) on the white lobby background, with the start button
 * and spawn pad drawn in. For eyeballing island placement; not shipped.
 *
 * Usage: node tools/previewLobbyMap.js [mapFile] [outHtml]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const mapFile = process.argv[2] || path.join(ROOT, "client/maps/_lobbyTutorial.json");
// Written into client/ so the static server serves it; textures use relative paths.
const outHtml = process.argv[3] || path.join(ROOT, "client/_lobby_preview.html");
const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
const imgDir = "assets/img";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#888} canvas{display:block}
</style></head><body>
<canvas id="c" width="1366" height="768"></canvas>
<script>
var MAP = ${JSON.stringify(map)};
var ID = {slow:0, normal:1, fast:2, lava:3, ice:4, goal:6, background:9, bomb:102};
var cv = document.getElementById('c'), ctx = cv.getContext('2d');

// ---- polygon helpers (mirror engine.js / draw.js) ----
function compareSite(a,b){ return a.voronoiId==b.voronoiId && a.x==b.x && a.y==b.y; }
function startp(he){ return compareSite(he.edge.lSite, he.site) ? he.edge.va : he.edge.vb; }
function endp(he){ return compareSite(he.edge.lSite, he.site) ? he.edge.vb : he.edge.va; }

var textures = {}; // id -> Image
var srcs = { 3:'lava.png', 4:'ice.png', 2:'grass.png', 1:'dirt.png', 0:'sand.png', 102:'dirt.png' };
var pats = {};
var toLoad = Object.keys(srcs).length, loaded = 0;

function makePat(id, img){ pats[id] = ctx.createPattern(img, 'repeat'); }
function tryDraw(){ if(loaded === toLoad) draw(); }

Object.keys(srcs).forEach(function(id){
  var img = new Image();
  img.onload = function(){ makePat(id, img); loaded++; tryDraw(); };
  img.onerror = function(){ loaded++; tryDraw(); };
  img.src = '${imgDir}/' + srcs[id];
});

function cellPath(cell){
  var hes = cell.halfedges; if(!hes.length) return false;
  ctx.beginPath();
  var v = startp(hes[0]); ctx.moveTo(v.x, v.y);
  for(var i=0;i<hes.length;i++){ v = endp(hes[i]); ctx.lineTo(v.x, v.y); }
  ctx.closePath(); return true;
}

function draw(){
  // lobby background (white)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,1366,768);

  for(var i=0;i<MAP.cells.length;i++){
    var cell = MAP.cells[i];
    if(cell.id === ID.background) continue;     // transparent -> shows white lobby
    if(!cellPath(cell)) continue;
    if(cell.id > 99){                            // ability tile (bomb): dirt + dashed yellow
      ctx.fillStyle = pats[1] || '#b5651d'; ctx.fill();
      ctx.setLineDash([6,6]); ctx.lineWidth = 4; ctx.strokeStyle = '#FFFF00'; ctx.stroke();
      ctx.setLineDash([]);
    } else if(cell.id === ID.goal){              // gold + brown border
      ctx.fillStyle = '#FFD700'; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = '#756300'; ctx.stroke();
    } else if(pats[cell.id]){                     // textured terrain
      ctx.fillStyle = pats[cell.id]; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
    }
  }

  // spawn pad
  if(MAP.spawnPad){ var s = MAP.spawnPad;
    ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, 6.2832);
    ctx.setLineDash([8,8]); ctx.lineWidth = 3; ctx.strokeStyle = '#2e7d32'; ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#2e7d32'; ctx.font = '16px sans-serif'; ctx.textAlign='center';
    ctx.fillText('spawn pad', s.cx, s.cy);
  }

  // lobby start button (red ring r75 @ world center, like drawLobbyStartButton)
  var bx=683, by=384, br=75;
  ctx.beginPath(); ctx.arc(bx,by,br,0,6.2832); ctx.lineWidth=5; ctx.strokeStyle='red'; ctx.stroke();
  for(var a=0;a<6;a++){ ctx.beginPath();
    ctx.arc(bx,by, br*(a/6), a, a+4.5); ctx.lineWidth=2; ctx.strokeStyle='rgba(255,0,0,0.5)'; ctx.stroke(); }
  ctx.fillStyle='red'; ctx.font='13px sans-serif'; ctx.textAlign='center';
  ctx.fillText('START', bx, by-br-8);

  // dev legend (preview only — no text in the real lobby)
  var L=[['lava (death)','#cf1020'],['ice (slip)','#A5F2F3'],['sand (slow)','#000'],
         ['grass (fast)','#90ee90'],['goal','#FFD700'],['bomb tile','#FFFF00']];
  ctx.textAlign='left'; ctx.font='14px sans-serif';
  for(var j=0;j<L.length;j++){ var y=20+j*22;
    ctx.fillStyle=L[j][1]; ctx.fillRect(12,y-12,16,16);
    ctx.strokeStyle='#333'; ctx.lineWidth=1; ctx.strokeRect(12,y-12,16,16);
    ctx.fillStyle='#111'; ctx.fillText(L[j][0], 34, y); }
}
draw(); // also draw immediately (textures fill in on load)
</script></body></html>`;

fs.writeFileSync(outHtml, html);
console.log("wrote", outHtml);
