"use strict";
/**
 * Pizza Gourmet — serveur tout-en-un pour Replit (aucune dépendance native).
 * Stockage en mémoire + persistance fichier (data.json). API REST + WebSocket + console de test à "/".
 */
const http = require("http");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const SECRET = process.env.JWT_SECRET || "pizza-gourmet-dev-secret";
const DATA_FILE = "./data.json";

/* ---------- données ---------- */
const EMPLOYEES = [
  { pin: "1001", name: "Marco", role: "Pizzaiolo" },
  { pin: "1002", name: "Giulia", role: "Pasta/Finition" },
  { pin: "9999", name: "Responsable", role: "Manager" },
];
const MENU = [
  ["ANT05","Antipasti","Burrata des Pouilles",5.95,.10,"Finition",1,"Lait"],
  ["ANT02","Antipasti","Burrata al tartufo",8.95,.10,"Finition",1,"Lait"],
  ["PIZ01","Pizze","Margherita",7.95,.10,"Pizza",1,"Gluten,Lait"],
  ["PIZ07","Pizze","Bufala",9.95,.10,"Pizza",1,"Gluten,Lait"],
  ["PIZ06","Pizze","Burrata",11.95,.10,"Pizza",1,"Gluten,Lait"],
  ["PIZ09","Pizze","Tonno",11.95,.10,"Pizza",0,"Gluten,Lait,Poissons"],
  ["PIZ10","Pizze","Mortabella",14.95,.10,"Pizza",0,"Gluten,Lait,Fruits à coque"],
  ["PIZ03","Pizze","Tartuffo",19.95,.10,"Pizza",1,"Gluten,Lait"],
  ["DOL04","Dolci","Tiramisù savoiardi",5.95,.10,"Finition",1,"Gluten,Lait,Œufs"],
  ["GEL02","Gelato","Glace pistache",4.95,.10,"Finition",1,"Lait,Fruits à coque"],
  ["BOI01","Boissons","San Pellegrino 33cl",1.95,.055,"Finition",1,""],
  ["BOI03","Boissons","Limonata 33cl",2.95,.10,"Finition",1,""],
  ["BON01","Bonus","Hot sauce",0.50,.10,"Finition",1,""],
].map(([code,cat,name,price,vat,station,veg,allerg]) => ({ code,cat,name,price,vat,station,veg,allerg,available:1 }));

let DB = {
  products: MENU,
  orders: [],
  counter: 1,
  fiscal: { seq: 1, gt: 0, zcount: 0, lastZ: 0, lastHash: "GENESIS", journal: [] },
  loyalty: {},
};
function load() { try { if (fs.existsSync(DATA_FILE)) { const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); DB = { ...DB, ...d, products: MENU }; } } catch (e) {} }
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify({ orders: DB.orders, counter: DB.counter, fiscal: DB.fiscal, loyalty: DB.loyalty })); } catch (e) {} }, 200); }
load();

/* ---------- helpers ---------- */
const prod = (code) => DB.products.find((p) => p.code === code);
function recompute(o) {
  const done = {};
  for (const s of o.stations) { const its = o.items.filter((i) => i.station === s); done[s] = its.length > 0 && its.every((i) => o.checked[i.key]); }
  o.done = done;
  const all = o.stations.every((s) => done[s]);
  const any = Object.values(o.checked).some(Boolean);
  o.status = all ? "ready" : any ? "preparing" : "new";
  o.readyAt = all ? (o.readyAt || Date.now()) : null;
  return o;
}
function createOrder({ items, type, channel, customer, schedule }) {
  const id = "O" + Date.now() + crypto.randomBytes(2).toString("hex");
  const no = DB.counter++;
  const resolved = (items || []).map((it, idx) => { const p = prod(it.code) || {}; return { key: it.code + "-" + idx, code: it.code, name: it.name || p.name || it.code, qty: it.qty || 1, station: it.station || p.station || "Finition", note: it.note || null }; });
  const stations = [...new Set(resolved.map((i) => i.station))];
  const o = { id, no, time: Date.now(), type: type || "À emporter", channel: channel || "Caisse", customer: customer || null, schedule: schedule || null, status: "new", stations, checked: {}, done: {}, readyAt: null, servedAt: null, items: resolved };
  DB.orders.unshift(o); persist(); return o;
}
function vatBreakdown(lines) {
  const m = {};
  for (const l of lines) { const ttc = l.price * l.qty, ht = ttc / (1 + l.vat); m[l.vat] = m[l.vat] || { rate: l.vat, ht: 0, tva: 0 }; m[l.vat].ht += ht; m[l.vat].tva += ttc - ht; }
  return Object.values(m).sort((a, b) => b.rate - a.rate);
}
function appendJournal(type, payload) {
  const base = { type, created_at: Date.now(), payload };
  const hash = crypto.createHash("sha256").update(DB.fiscal.lastHash + JSON.stringify(base)).digest("hex").toUpperCase();
  DB.fiscal.journal.push({ ev: DB.fiscal.journal.length + 1, ...base, prev_hash: DB.fiscal.lastHash, hash });
  DB.fiscal.lastHash = hash; return hash;
}
function recordSale({ items, tenders, type, discount = 0, phone }) {
  const lines = (items || []).map((i) => { const p = prod(i.code) || {}; return { code: i.code, name: i.name || p.name, qty: i.qty || 1, price: i.price != null ? i.price : p.price, vat: i.vat != null ? i.vat : p.vat }; });
  const gross = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const totalTTC = Math.max(0, gross - discount);
  const ratio = gross > 0 ? totalTTC / gross : 0;
  const vat = vatBreakdown(lines.map((l) => ({ ...l, price: l.price * ratio })));
  const totalHT = vat.reduce((s, v) => s + v.ht, 0);
  const ticketNo = DB.fiscal.seq;
  const payload = { ticketNo, type, lines, totalTTC, totalHT, totalTVA: totalTTC - totalHT, vat, tenders };
  const hash = appendJournal("VENTE", payload);
  DB.fiscal.seq++; DB.fiscal.gt += totalTTC;
  if (phone && String(phone).replace(/\D/g, "").length >= 10) DB.loyalty[phone] = (DB.loyalty[phone] || 0) + Math.round(totalTTC);
  persist();
  return { ticketNo, signature: hash, totalTTC, vat };
}
function periodEntries() { return DB.fiscal.journal.filter((e) => e.ev > DB.fiscal.lastZ); }
function totals(entries) {
  const sales = entries.filter((e) => e.type === "VENTE");
  const ttc = sales.reduce((s, e) => s + e.payload.totalTTC, 0);
  const ht = sales.reduce((s, e) => s + e.payload.totalHT, 0);
  const byMode = {}; sales.forEach((e) => (e.payload.tenders || []).forEach((t) => (byMode[t.mode] = (byMode[t.mode] || 0) + t.amount)));
  const vm = {}; sales.forEach((e) => e.payload.vat.forEach((v) => { vm[v.rate] = vm[v.rate] || { rate: v.rate, ht: 0, tva: 0 }; vm[v.rate].ht += v.ht; vm[v.rate].tva += v.tva; }));
  return { tickets: sales.length, totalTTC: ttc, totalHT: ht, totalTVA: ttc - ht, byMode, vat: Object.values(vm) };
}
function verifyChain() {
  let prev = "GENESIS";
  for (const r of DB.fiscal.journal) { const base = { type: r.type, created_at: r.created_at, payload: r.payload }; const expect = crypto.createHash("sha256").update(prev + JSON.stringify(base)).digest("hex").toUpperCase(); if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAt: r.ev }; prev = r.hash; }
  return { ok: true, length: DB.fiscal.journal.length };
}

/* ---------- auth ---------- */
function authMw(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || ""; const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: "Authentification requise" });
    try { const p = jwt.verify(tok, SECRET); if (role && p.role !== role) return res.status(403).json({ error: "Droits insuffisants" }); req.employee = p; next(); }
    catch (e) { return res.status(401).json({ error: "Jeton invalide" }); }
  };
}

/* ---------- app ---------- */
const app = express();
app.use(cors());
app.use(express.json());
const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

app.get("/api/health", (req, res) => res.json({ ok: true, time: Date.now() }));
app.post("/api/auth/login", wrap((req, res) => {
  const emp = EMPLOYEES.find((e) => e.pin === String(req.body.pin || ""));
  if (!emp) return res.status(401).json({ error: "Code inconnu" });
  res.json({ token: jwt.sign(emp, SECRET, { expiresIn: "12h" }), employee: emp });
}));
app.get("/api/catalog", wrap((req, res) => res.json(DB.products)));
app.patch("/api/catalog/:code", authMw("Manager"), wrap((req, res) => {
  const p = prod(req.params.code); if (!p) return res.status(404).json({ error: "Introuvable" });
  if (req.body.price != null) p.price = Number(req.body.price);
  if (req.body.available != null) p.available = req.body.available ? 1 : 0;
  broadcast("catalog:update", { code: p.code }); res.json(p);
}));
app.post("/api/orders", wrap((req, res) => {
  if (!Array.isArray(req.body.items) || !req.body.items.length) return res.status(400).json({ error: "Articles requis" });
  const o = createOrder(req.body); broadcast("order:new", o); res.status(201).json(o);
}));
app.get("/api/orders", wrap((req, res) => {
  const a = req.query.active === "1"; res.json(a ? DB.orders.filter((o) => o.status !== "done") : DB.orders.slice(0, 200));
}));
app.get("/api/orders/:id", wrap((req, res) => { const o = DB.orders.find((x) => x.id === req.params.id); if (!o) return res.status(404).json({ error: "Introuvable" }); res.json(o); }));
function act(req, res, fn) { const o = DB.orders.find((x) => x.id === req.params.id); if (!o) return res.status(404).json({ error: "Introuvable" }); fn(o); persist(); broadcast("order:update", o); res.json(o); }
app.post("/api/orders/:id/toggle", authMw(), wrap((req, res) => act(req, res, (o) => { o.checked[req.body.key] = !o.checked[req.body.key]; recompute(o); })));
app.post("/api/orders/:id/bump", authMw(), wrap((req, res) => act(req, res, (o) => { o.items.filter((i) => i.station === req.body.station).forEach((i) => (o.checked[i.key] = true)); recompute(o); })));
app.post("/api/orders/:id/recall", authMw(), wrap((req, res) => act(req, res, (o) => { o.items.filter((i) => i.station === req.body.station).forEach((i) => (o.checked[i.key] = false)); recompute(o); })));
app.post("/api/orders/:id/serve", authMw(), wrap((req, res) => act(req, res, (o) => { o.status = "done"; o.servedAt = Date.now(); })));
app.post("/api/fiscal/sale", authMw(), wrap((req, res) => {
  if (!Array.isArray(req.body.items) || !req.body.items.length) return res.status(400).json({ error: "Articles requis" });
  const ticket = recordSale(req.body);
  let order = null;
  if (req.body.sendToKitchen !== false) { order = createOrder({ items: req.body.items, type: req.body.type, channel: req.body.channel || "Caisse", customer: req.body.phone ? "☎ " + String(req.body.phone).slice(-4) : null }); broadcast("order:new", order); }
  res.status(201).json({ ticket, order });
}));
app.get("/api/fiscal/report/x", authMw(), wrap((req, res) => res.json({ ...totals(periodEntries()), grandTotal: DB.fiscal.gt, lastZ: DB.fiscal.zcount })));
app.post("/api/fiscal/report/z", authMw("Manager"), wrap((req, res) => {
  const t = totals(periodEntries()); const z = { numero: DB.fiscal.zcount + 1, date: new Date().toISOString().slice(0, 10), ...t };
  appendJournal("CLOTURE_Z", z); DB.fiscal.zcount++; DB.fiscal.lastZ = DB.fiscal.journal.length; persist();
  res.json({ ...z, signature: DB.fiscal.lastHash });
}));
app.get("/api/fiscal/journal", authMw("Manager"), wrap((req, res) => res.json({ meta: DB.fiscal, entries: DB.fiscal.journal.slice(-200).reverse() })));
app.get("/api/fiscal/verify", authMw("Manager"), wrap((req, res) => res.json(verifyChain())));
app.get("/api/loyalty/:phone", wrap((req, res) => res.json({ phone: req.params.phone, points: DB.loyalty[req.params.phone] || 0 })));

app.get("/", (req, res) => res.type("html").send(CONSOLE));

/* ---------- temps réel ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast(type, payload) { const msg = JSON.stringify({ type, payload, ts: Date.now() }); wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(msg); } catch (e) {} } }); }
setInterval(() => wss.clients.forEach((c) => { try { c.ping(); } catch (e) {} }), 30000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => console.log("Pizza Gourmet en ligne sur le port " + PORT));

/* ---------- console de test intégrée (servie à "/") ---------- */
const CONSOLE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pizza Gourmet — Console</title><style>
:root{--paper:#F1E8DB;--card:#FFFDF8;--ink:#241A17;--sub:#7A6E62;--wine:#6E1423;--gold:#B08D57;--basil:#2E7D4F;--line:#E6DBC9}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,system-ui,sans-serif}
header{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:54px;background:linear-gradient(180deg,#6E1423,#4E0E18);color:#F6ECE2;border-bottom:2px solid var(--gold)}
.brand{font-style:italic;font-size:20px;font-weight:600}
.wrap{max-width:900px;margin:0 auto;padding:14px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px}
h2{color:var(--wine);font-size:18px;margin:0 0 8px}
button{font-weight:700;border:none;border-radius:11px;padding:11px 14px;background:var(--wine);color:#fff;font-size:15px}
button.g{background:var(--basil)}button.k{background:var(--ink)}button.alt{background:var(--card);color:var(--ink);border:1px solid var(--line)}
input{border:1px solid var(--line);border-radius:10px;padding:11px;font-size:16px;width:140px}
.prod{display:inline-block;margin:4px 4px 0 0;padding:8px 11px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:14px}
.order{border:1px solid var(--line);border-left:6px solid var(--gold);border-radius:12px;padding:10px;margin-bottom:8px}
.no{font-weight:700;font-size:19px}.muted{color:var(--sub);font-size:12px}
.log{font-family:ui-monospace,monospace;font-size:12px;color:var(--sub);max-height:120px;overflow:auto;background:var(--paper);border-radius:10px;padding:8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dot{width:9px;height:9px;border-radius:9px;display:inline-block;margin-right:6px}
pre{white-space:pre-wrap;font-size:12px}</style></head><body>
<header><span class="brand">pizza gourmet</span><span id="st" class="row" style="font-size:13px"><span class="dot" style="background:#C0392B"></span>déconnecté</span></header>
<div class="wrap">
<div class="card" id="lg"><h2>Connexion</h2><div class="row"><input id="pin" placeholder="9999" inputmode="numeric"/><button onclick="login()">Se connecter</button></div><div class="muted" id="who" style="margin-top:6px">Codes : 1001 · 1002 · 9999 (Manager)</div></div>
<div class="card" id="oc" style="opacity:.5;pointer-events:none"><h2>Commande / vente</h2><div id="cat"></div><div id="cart" class="muted" style="margin:8px 0">Panier vide</div>
<div class="row"><button onclick="send()">Envoyer en cuisine</button><button class="g" onclick="sale()">Encaisser</button><button class="alt" onclick="clr()">Vider</button></div><div class="muted" id="so" style="margin-top:6px"></div></div>
<div class="card"><h2>Cuisine — temps réel</h2><div id="board"></div></div>
<div class="card"><h2>Caisse</h2><button class="k" onclick="rx()">Rapport X</button> <button class="k alt" onclick="vf()">Vérifier journal</button><pre id="rep" class="log" style="margin-top:8px"></pre></div>
<div class="card"><h2>Journal (live)</h2><div id="log" class="log"></div></div>
</div><script>
var API=location.origin,token=null,cart=[],prices={};
function log(m){var e=document.getElementById('log');e.innerHTML='<div>'+new Date().toLocaleTimeString('fr-FR')+' · '+m+'</div>'+e.innerHTML;}
function api(p,o){o=o||{};return fetch(API+p,{method:o.method||'GET',headers:Object.assign({'Content-Type':'application/json'},token?{Authorization:'Bearer '+token}:{}),body:o.body?JSON.stringify(o.body):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j;});});}
function login(){api('/api/auth/login',{method:'POST',body:{pin:document.getElementById('pin').value.trim()}}).then(function(r){token=r.token;document.getElementById('who').textContent='Connecté : '+r.employee.name+' ('+r.employee.role+')';document.getElementById('st').innerHTML='<span class="dot" style="background:#2E7D4F"></span>connecté';document.getElementById('oc').style.opacity=1;document.getElementById('oc').style.pointerEvents='auto';loadCat();board();ws();}).catch(function(e){alert('Échec : '+e.message);});}
function loadCat(){api('/api/catalog').then(function(items){var el=document.getElementById('cat');el.innerHTML='';items.forEach(function(p){prices[p.code]=p.price;var b=document.createElement('span');b.className='prod';b.textContent=p.name+' '+p.price.toFixed(2).replace('.',',')+'€';b.onclick=function(){var f=cart.find(function(x){return x.code===p.code;});if(f)f.qty++;else cart.push({code:p.code,name:p.name,qty:1});draw();};el.appendChild(b);});});}
function draw(){document.getElementById('cart').textContent=cart.length?cart.map(function(x){return x.qty+'× '+x.name;}).join('  ·  '):'Panier vide';}
function clr(){cart=[];draw();document.getElementById('so').textContent='';}
function send(){if(!cart.length)return;api('/api/orders',{method:'POST',body:{channel:'Caisse',type:'À emporter',items:cart}}).then(function(o){log('Commande #'+o.no+' envoyée');clr();});}
function sale(){if(!cart.length)return;var total=cart.reduce(function(s,x){return s+(prices[x.code]||0)*x.qty;},0);api('/api/fiscal/sale',{method:'POST',body:{items:cart.map(function(x){return{code:x.code,qty:x.qty};}),tenders:[{mode:'Carte bancaire',amount:Math.round(total*100)/100}]}}).then(function(r){document.getElementById('so').textContent='Ticket T'+String(r.ticket.ticketNo)+' · '+r.ticket.totalTTC.toFixed(2).replace('.',',')+'€ · '+r.ticket.signature.slice(0,10)+'…';log('Vente T'+r.ticket.ticketNo);clr();}).catch(function(e){alert(e.message);});}
function board(){api('/api/orders?active=1').then(function(os){var el=document.getElementById('board');el.innerHTML='';if(!os.length){el.innerHTML='<span class="muted">Aucune commande active.</span>';return;}os.forEach(function(o){var col=o.status==='ready'?'#2E7D4F':'#C8901F';var d=document.createElement('div');d.className='order';d.style.borderLeftColor=col;var h='<div class="row" style="justify-content:space-between"><span class="no">#'+o.no+'</span><span class="muted">'+o.status+'</span></div>';h+=o.items.map(function(i){return '<div>'+i.qty+'× '+i.name+'</div>';}).join('');h+='<div class="row" style="margin-top:8px">';if(o.stations.indexOf('Pizza')>=0&&!o.done.Pizza)h+='<button onclick="bump(\\''+o.id+'\\',\\'Pizza\\')">Four prêt</button>';if(o.stations.indexOf('Finition')>=0&&!o.done.Finition)h+='<button class="g" onclick="bump(\\''+o.id+'\\',\\'Finition\\')">Finition prête</button>';if(o.status==='ready')h+='<button class="k" onclick="serve(\\''+o.id+'\\')">Remis</button>';h+='</div>';d.innerHTML=h;el.appendChild(d);});});}
function bump(id,s){api('/api/orders/'+id+'/bump',{method:'POST',body:{station:s}});}
function serve(id){api('/api/orders/'+id+'/serve',{method:'POST'});}
function rx(){api('/api/fiscal/report/x').then(function(r){document.getElementById('rep').textContent=JSON.stringify(r,null,2);});}
function vf(){api('/api/fiscal/verify').then(function(r){document.getElementById('rep').textContent='Intégrité : '+JSON.stringify(r);});}
function ws(){var s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');s.onmessage=function(e){var m=JSON.parse(e.data);if(m.type&&m.type.indexOf('order')===0){log('◄ '+m.type+' #'+(m.payload&&m.payload.no));board();}};s.onclose=function(){setTimeout(ws,2000);};}
</script></body></html>`;
