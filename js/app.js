(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const rub = n => (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("ru-RU") + " ₽";
const CARS = {gazel:"Газель", gazon:"Газон"};
const DIR_ORDER = ["Город","Ростов","Палласовка","Борисоглебск","Саратов","Элиста","Астрахань"];

const S = { db:null, user:null, sample:null, me:null, canWrite:true,
  points:[], settings:{rate:60, step:100, threshold:40}, requests:[], names:{},
  car:"gazel", rf:"new", dir:"Все", q:"", editing:null, last:null };

let toastT;
function toast(t){ const el=$("#toast"); el.textContent=t; el.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>el.hidden=true,2600); }
const ceilStep = (x, step) => Math.ceil(x / (step||1)) * (step||1);

/* ---------- routing ---------- */
function route(){
  const v = ["calc","approve","trip","tariffs","rules"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "calc";
  $$(".view").forEach(s => s.hidden = s.id !== "v-"+v);
  $$("nav a").forEach(a => a.setAttribute("aria-current", a.dataset.view===v ? "page" : "false"));
}
addEventListener("hashchange", route); route();

/* ---------- matching ---------- */
const norm = s => " " + String(s||"").toLowerCase().replace(/ё/g,"е").replace(/[^a-zа-я0-9]+/g," ").trim() + " ";
/* --- address parsing ---
   The address is split into chunks by commas. In each chunk street parts are cut off:
   a street word before the name («ул. Советская») or after it («Советская ул.»).
   House numbers are dropped, ordinals like «1-я» are kept as part of the name. */
const STREET = new Set(["ул","улица","пр","прт","пр-т","проспект","пер","переулок","бул","бульвар","б-р","шоссе","ш","проезд","пр-д","пл","площадь","наб","набережная","туп","тупик","линия","аллея","кв-л","квартал","дом","кв","корп","стр","строение","тракт","спуск","просп","мкр","микрорайон","мкрн","жк"]);
const isOrdinal = t => /^\d+-?(я|й|е|ая|ый|ой|ий|го)$/.test(t);
const isNum = t => /\d/.test(t) && !isOrdinal(t);
const CONTAINER = new Set(["россия","рф","волгоград","волгоградская","ростовская","саратовская","астраханская","воронежская","ставропольский","калмыкия","калмыкии","республика","респ","край","обл","область","г","город","городской","округ","го"]);
const LOCMARK = new Set(["г","п","с","х","ст","пос","поселок","рп","пгт","село","хутор","станица","ст-ца","деревня","д","снт","сл","слобода","аул"]);
function addrWords(addr){
  const out = [];
  String(addr).toLowerCase().replace(/ё/g,"е").split(/[,;]/).forEach((chunk, ci) => {
    let T = chunk.split(/[\s.]+/).map(t => t.replace(/^[^a-zа-я0-9]+|[^a-zа-я0-9]+$/g,"")).filter(Boolean);
    // «1 я» → «1-я»
    T = T.reduce((acc, t) => { const prev = acc[acc.length-1]; if (prev && /^\d+$/.test(prev) && /^(я|й|е|ая|ый|ой|ий|го)$/.test(t)) acc[acc.length-1] = prev + "-" + t; else acc.push(t); return acc; }, []);
    // часть адреса с районом/областью уступает части с самим населённым пунктом
    const district = T.some(t => /^(р-н|рн|район|улус)$/.test(t)) ? 1 : 0;
    const container = !district && T.length > 0 && T.every(t => CONTAINER.has(t) || isNum(t));
    // «д.» — это дом, если за ним номер; иначе деревня
    const isStreet = (t, i) => STREET.has(t) || ((t==="д"||t==="к") && T[i+1] && isNum(T[i+1]));
    const i = T.findIndex(isStreet);
    if (i === 0) return;                       // «ул. Ленина 5» — вся часть улица
    if (i > 0){
      const afterName = T.slice(i+1).some(t => !isNum(t));
      if (!afterName) return;                  // «Садовая ул., 5» — вся часть улица
      T = T.slice(0, i);                       // «Волжский ул Мира» — до слова «ул»
    }
    const marked = T.some(t => LOCMARK.has(t));
    const hasNum = T.some(isNum);
    const words = [];
    let k = 0; // позиция в части без «г.», «п.», «снт» и т. п.
    T.forEach(t => {
      if (isNum(t)) return;
      const mark = LOCMARK.has(t) || /^(р-н|рн|район|улус)$/.test(t);
      t.split("-").filter(Boolean).forEach(w => words.push({w, chunk:ci, district, container, marked, hasNum, inChunk: mark ? -1 : k++}));
    });
    words.forEach(x => { x.pos = out.length; out.push(x); });
  });
  return out;
}
const STOP = new Set(["р","н","рн","ст","снт","рп","пос","п","с","х","ца","станица","хутор","поселок","село","город","г","район"]);
const ABBR = new Set(["б","бол","м","мал","н","нов","в","верх","ниж","ср","сред","ст","стар","кр","красн","г","гор","бел","кол"]);
function parts(name){
  return String(name||"").split(",").map(p => norm(p).trim().split(" ").filter(w => w && !STOP.has(w))).filter(ws => ws.join(" ").length >= 3);
}
const pointParts = p => parts(p.name).concat(parts(p.aliases));
const approved = () => S.points.filter(p => p.status === "ok" && (p.gazel != null || p.gazon != null));
// Регион в адресе, который точно не Волгоград: тогда городские пункты (районы, СНТ) не подходят
const NOT_VOLGOGRAD = /(край|республик|калмык|ростовск|саратовск|воронежск|астраханск|краснодарск|ставропольск|ставрополь)/;
function matchPart(pw, W){
  const used = new Set(), got = [];
  for (let k = 0; k < pw.length; k++){
    const w = pw[k], last = k === pw.length-1;
    let hit = W.find(x => !used.has(x.pos) && x.w === w);
    if (!hit && !last && pw.length > 1) hit = W.find(x => !used.has(x.pos) && ABBR.has(x.w) && w.startsWith(x.w));
    if (!hit) return null;
    used.add(hit.pos); got.push(hit);
  }
  return got;
}
function findMatches(addr){
  const W = addrWords(addr);
  if (!W.length) return [];
  const foreign = NOT_VOLGOGRAD.test(String(addr).toLowerCase());
  // первая часть адреса, похожая на населённый пункт (не область, не город-контейнер, не район)
  const loc = W.find(x => !x.container && !x.district);
  const firstLoc = loc ? loc.chunk : Infinity;
  const hits = [];
  for (const p of approved()){
    if (foreign && p.dir === "Город") continue;
    let best = null;
    for (const pw of pointParts(p)){
      const got = matchPart(pw, W);
      if (!got) continue;
      const chunk = Math.min(...got.map(x=>x.chunk));
      const district = Math.min(...got.map(x=>x.district));
      // после незнакомого пункта следующая часть засчитывается, только если это район или есть «п.», «х.», «ст.»…
      if (chunk > firstLoc && !district && !got.some(x=>x.marked)) continue;
      const first = Math.min(...got.map(x=>x.inChunk));
      // «название + номер дома» не в самом начале адреса — это улица, не пункт
      if (got.some(x => x.hasNum && (x.chunk !== W[0].chunk || first > 0))) continue;
      const pos = Math.min(...got.map(x=>x.pos));
      const key = {district, chunk, suspect:0, len: pw.join("").length, pos};
      if (!best || better(key, best)) best = key;
    }
    if (best) hits.push({p, ...best});
  }
  if (!hits.length) return [];
  hits.sort((a,b) => better(a,b) ? -1 : better(b,a) ? 1 : 0);
  const top = hits[0];
  return hits.filter(h => !better(top, h)).map(h => h.p);
}
function better(a, b){
  if (a.suspect !== b.suspect) return a.suspect < b.suspect;
  if (a.district !== b.district) return a.district < b.district;
  if (a.chunk !== b.chunk) return a.chunk < b.chunk;
  if (a.suspect !== b.suspect) return a.suspect < b.suspect;
  if (a.len !== b.len) return a.len > b.len;
  if (a.pos !== b.pos) return a.pos < b.pos;
  return false;
}
function findBase(dir, name){
  const pool = approved();
  const n = norm(name).trim();
  return pool.find(p => p.dir===dir && norm(p.name).trim()===n)
      || pool.find(p => p.dir===dir && pointParts(p).some(x => parts(name).some(y => y.join(" ")===x.join(" "))))
      || pool.find(p => norm(p.name).trim()===n);
}
const priceOf = (p, car) => p ? p[car] : null;
// По прайсу Волгограда доплата за км не применяется: только фиксированные тарифы
const NO_KM_DIRS = new Set(["Город"]);
const kmAllowed = dir => !NO_KM_DIRS.has(dir);
const NO_KM_TEXT = "Для Волгограда доплата за километры не применяется — цену адреса вне списка назначает логист.";

/* ---------- manager calc ---------- */
// Менеджер: направление + адрес + машина. Опорную точку, км и расчёт система определяет сама.
const dirsForManager = () => DIR_ORDER.filter(d=>approved().some(p=>p.dir===d)).concat([...new Set(approved().map(p=>p.dir))].filter(d=>d&&!DIR_ORDER.includes(d)));
function fillDirSelect(){
  const sel = $("#dir"), cur = sel.value;
  const dirs = dirsForManager();
  sel.innerHTML = `<option value="">— выберите —</option>` + dirs.map(d=>`<option${d===cur?" selected":""}>${esc(d)}</option>`).join("");
}
$("#car").onchange = () => {
  S.car = $("#car").value;
  if (!S.last) return;
  if (S.last.kind === "approved") { $("#calcForm").requestSubmit(); return; }
  recalcLast();
};
$("#dir").onchange = () => { S.last = null; renderResult(); };
$("#addr").oninput = () => { if (S.last) { S.last = null; renderResult(); } };
function recalcLast(){
  const r = S.last; r.car = S.car;
  if (r.kind === "price") r.total = priceOf(r.point, S.car);
  if (r.kind === "estimate"){ r.tariff = priceOf(r.basePoint, S.car); r.extra = r.km * S.settings.rate; r.total = r.tariff==null?null:ceilStep(r.tariff + r.extra, S.settings.step); }
  if (r.kind === "nokm") r.tariff = priceOf(r.basePoint, S.car);
  renderResult();
}

$("#calcForm").onsubmit = async e => {
  e.preventDefault();
  const dir = $("#dir").value, addr = $("#addr").value.trim();
  if (!dir){ toast("Выберите направление"); $("#dir").focus(); return; }
  if (!addr){ $("#addr").focus(); return; }
  S.car = $("#car").value;
  const btn = $("#goBtn");
  S.last = null;
  // 1) этот адрес уже согласован логистом
  const prev = S.requests.find(r => r.status==="approved" && norm(r.address)===norm(addr) && r.car===S.car && r.finalPrice);
  if (prev){ S.last = {kind:"approved", dir, address:addr, car:S.car, total:prev.finalPrice, comment:prev.logistComment, base:prev.base, km:prev.km, locality:prev.locality}; return renderResult(); }
  // 2) прайс выбранного направления
  const all = findMatches(addr);
  const m = all.filter(p => p.dir === dir);
  if (m.length === 1){ S.last = {kind:"price", dir, address:addr, car:S.car, point:m[0], total:priceOf(m[0], S.car)}; return renderResult(); }
  if (m.length > 1){ S.last = {kind:"choose", dir, address:addr, car:S.car, options:m}; return renderResult(); }
  if (all.length){ S.last = {kind:"otherdir", dir, address:addr, car:S.car, options:all}; return renderResult(); }
  // 3) опорная точка и км внутри направления
  if (!S.sample){ S.last = {kind:"notfound", dir, address:addr, car:S.car, comment:"Автоматическое определение опорной точки недоступно в этой версии."}; return renderResult(); }
  btn.disabled = true; btn.textContent = "Определяю опорную точку…";
  S.last = {kind:"wait", dir, address:addr, car:S.car}; renderResult();
  try {
    const ans = await S.sample.json(buildPrompt(addr, dir), {modelTier:"default"});
    if (!ans || ans.found === false || !ans.base){
      S.last = {kind:"notfound", dir, address:addr, car:S.car, locality:ans?.locality, comment: ans?.comment || "Адрес не удалось привязать к пунктам направления."};
    } else {
      const bp = findBase(dir, ans.base);
      const km = Math.max(0, Math.round(Number(ans.km)||0));
      if (!bp || bp.dir !== dir) S.last = {kind:"notfound", dir, address:addr, car:S.car, locality:ans.locality, comment:`Опорная точка «${ans.base||""}» не найдена в прайсе направления «${dir}».`};
      else if (!kmAllowed(dir)) S.last = {kind:"nokm", dir, address:addr, car:S.car, locality:ans.locality, region:ans.region, base:bp.name, basePoint:bp, km, tariff:priceOf(bp,S.car), comment:ans.comment||""};
      else {
        const tariff = priceOf(bp, S.car), extra = km * S.settings.rate;
        S.last = {kind:"estimate", dir, address:addr, car:S.car, locality:ans.locality, region:ans.region, base:bp.name, basePoint:bp,
          km, tariff, extra, total: tariff==null?null:ceilStep(tariff+extra, S.settings.step),
          confidence: ans.confidence || "medium", comment: ans.comment || ""};
      }
    }
  } catch(err){
    S.last = {kind:"notfound", dir, address:addr, car:S.car, err: err?.code, comment: err?.code==="not_granted" ? "Автоматическое определение не разрешено в этом окне." : "Не получилось определить опорную точку."};
    if (err?.code === "not_granted" || err?.code === "sampling_disabled") S.sample = null;
  } finally { btn.disabled = false; btn.textContent = "Рассчитать"; }
  renderResult();
};

const ROUTE_ROSTOV = "Схема Ростовского направления (из прайса): основная ветка Волгоград → Новый Рогачик → Калач → Суровикино → Обливская → Морозовск → Белая Калитва → Лиховской → Шахты → Новочеркасск → Аксай → Ростов-на-Дону → Батайск → Зерноград; от Обливской/Морозовска на запад: Советская, Боковская, Вешенская, Кашары, Миллерово, Чертково, Глубокий, Каменск-Шахтинский, Донецк; у Шахт — Новошахтинск; вторая ветка Волгоград → Червлёное → Абганерово → Октябрьский → Котельниково → Дубовское → Волгодонск → Семикаракорск → Багаевская, Егорлыкская; третья ветка Зимовники → Пролетарск → Сальск → Песчанокопское.";
function buildPrompt(addr, dir){
  const names = approved().filter(p=>p.dir===dir).map(p=>p.name).join("; ");
  return `Ты логист компании АЗКиФ. Склад: г. Волгоград, ул. Ясноморская, 2. Машина едет по направлению «${dir}».
Пункты прайса этого направления (разделены «;»): ${names}
${dir==="Ростов" ? "\n"+ROUTE_ROSTOV+"\n" : ""}
Адрес клиента: «${addr}»

Задача:
1. Определи населённый пункт и регион клиента (исправь опечатки).
2. Выбери из списка выше опорный пункт — ближайший по дороге пункт прайса, от которого машине заехать к клиенту (обычно последний пункт по пути из Волгограда перед съездом к клиенту).
3. km — расстояние по автодороге от опорного пункта до клиента в одну сторону, целое число.
4. Если адрес не понять или он не по этому направлению — found = false и в comment напиши, по какому направлению он скорее.

Ответь только JSON без пояснений:
{"found":true,"locality":"Яшкуль","region":"Калмыкия","base":"Элиста","km":89,"confidence":"high","comment":"Элиста → Яшкуль по трассе Р-22"}
base — точно как в списке. confidence: high, medium или low.`;
}

function chooseOption(i){
  const p = S.last.options[i];
  if (p.dir !== $("#dir").value) $("#dir").value = p.dir;
  S.last = {kind:"price", dir:p.dir, address:S.last.address, car:S.car, point:p, total:priceOf(p,S.car)};
  renderResult();
}

const badge = (cls, t) => `<span class="badge ${cls}"><i></i>${t}</span>`;
function renderResult(){
  const r = S.last;
  $("#sRateV").textContent = S.settings.rate;
  $("#sStepV").textContent = S.settings.step;
  const set = (id, v) => { $(id).textContent = (v==null || v==="") ? "—" : v; };
  const box = $("#rExtraBox");
  if (!r){
    ["#rBase","#rExtra","#rTotal","#sPlace","#sBase","#sKm","#sState"].forEach(id=>set(id,null));
    $("#rStatus").innerHTML = badge("b-chk","Введите адрес");
    $("#sNote").textContent = ""; box.hidden = true; box.innerHTML = ""; return;
  }
  const num = v => v==null ? null : Math.round(v).toLocaleString("ru-RU");
  let base=null, extra=null, total=null, st, place=null, bpt=null, km=null, state, note="", extraHtml="", canSend=false;
  if (r.kind === "wait"){
    st = badge("b-info","Определяю…"); state = "Определяется…"; note = "Адреса нет в прайсе направления — подбираю опорную точку и расстояние. Обычно 10–30 секунд.";
  } else if (r.kind === "price"){
    const p = r.point;
    base = r.total; extra = 0; total = r.total; place = p.name; bpt = p.base ? `${p.base} (${p.dir})` : `${p.name} (${p.dir})`; km = p.base && p.km ? p.km : 0;
    state = "Точный адрес из прайса";
    if (r.total == null){ st = badge("b-new","СОГЛАСОВАТЬ С ЛОГИСТОМ"); note = `Для машины «${CARS[r.car]}» цены в прайсе нет.`; canSend = true; }
    else { st = badge("b-ok","ЦЕНА ГОТОВА"); note = p.base && p.km ? `Пункт утверждён логистом: ${p.base} + ${p.km} км. Цену можно называть клиенту.` : "Цену можно называть клиенту."; }
  } else if (r.kind === "approved"){
    base = null; extra = null; total = r.total; place = r.locality || r.address; bpt = r.base; km = r.km;
    st = badge("b-ok","ЦЕНА ГОТОВА"); state = "Согласовано логистом"; note = r.comment ? `Комментарий логиста: ${r.comment}` : "";
  } else if (r.kind === "choose" || r.kind === "otherdir"){
    st = badge("b-info","ВЫБЕРИТЕ ПУНКТ"); state = "Несколько вариантов";
    note = r.kind === "otherdir" ? `В направлении «${r.dir}» такого пункта нет, но он есть в прайсе другого направления.` : "Адрес подходит к нескольким пунктам прайса.";
    extraHtml = `<div class="fl">${r.kind==="otherdir"?"Найдено в другом направлении":"Выберите пункт"}</div><div class="choices">${r.options.map((p,i)=>`<button type="button" class="choice" data-i="${i}"><span><b>${esc(p.name)}</b> <span class="muted">· ${esc(p.dir)}</span></span><b>${rub(priceOf(p,r.car))}</b></button>`).join("")}</div>`;
  } else if (r.kind === "estimate"){
    base = r.tariff; extra = r.extra; total = r.total; place = r.locality ? r.locality + (r.region?`, ${r.region}`:"") : r.address; bpt = `${r.base} (${r.dir})`; km = r.km;
    st = badge("b-new","СОГЛАСОВАТЬ С ЛОГИСТОМ"); state = "Предварительно";
    note = `Опорная точка и расстояние определены автоматически${r.comment?`: ${r.comment}`:""}. Доплата: ${r.km} км × ${S.settings.rate} ₽, округление вверх до ${S.settings.step} ₽.`;
    canSend = true;
  } else if (r.kind === "nokm"){
    base = r.tariff; extra = null; total = null; place = r.locality ? r.locality + (r.region?`, ${r.region}`:"") : r.address; bpt = `${r.base} (${r.dir})`; km = r.km;
    st = badge("b-new","СОГЛАСОВАТЬ С ЛОГИСТОМ"); state = "Предварительно";
    note = `${NO_KM_TEXT}${r.comment?` ${r.comment}`:""}`; canSend = true;
  } else {
    place = r.locality || null;
    st = badge("b-bad","ЗАПРОС ЛОГИСТУ"); state = "Не определён"; note = r.comment || ""; canSend = true;
  }
  set("#rBase", num(base)); set("#rExtra", num(extra)); set("#rTotal", total==null ? null : num(total));
  $("#rStatus").innerHTML = st;
  set("#sPlace", place); set("#sBase", bpt); set("#sKm", km); set("#sState", state);
  $("#sNote").textContent = note;
  if (canSend) extraHtml += `<label class="fl" for="reqNote">Комментарий для логиста (необязательно)</label>
      <textarea class="inp" id="reqNote" placeholder="Например: клиент ждёт ответа до 15:00"></textarea>
      <div class="row"><button type="button" class="btn primary" id="sendReq">Отправить на согласование</button><span id="sendState"></span></div>`;
  box.innerHTML = extraHtml; box.hidden = !extraHtml;
  box.querySelectorAll(".choice").forEach(b => b.onclick = () => chooseOption(+b.dataset.i));
  const sb = $("#sendReq"); if (sb) sb.onclick = sendRequest;
}

async function sendRequest(){
  const r = S.last; if (!r || !S.db) { toast("Нет связи с базой — попробуйте позже"); return; }
  const btn = $("#sendReq"); btn.disabled = true;
  const doc = { address:r.address, car:r.car, managerDir:r.dir||null, kind:r.kind, managerId:S.me||null, managerNote:$("#reqNote")?.value.trim()||"",
    createdAt:Date.now(), status:"new",
    locality:r.locality||null, dir:r.dir||r.point?.dir||null, base:r.base||r.point?.name||null,
    km:r.km ?? null, estimate:r.total ?? null, confidence:r.confidence||null, autoComment:r.comment||null };
  try { await S.db.collection("requests").add(doc); $("#sendState").innerHTML = `<span class="sent">Отправлено логисту</span>`; }
  catch(e){ btn.disabled = false; toast(e?.code==="invalid_argument" ? "У вас нет прав отправлять запросы" : "Не отправилось, попробуйте ещё раз"); }
}

/* ---------- my requests ---------- */
function reqPill(r){
  if (r.status==="approved") return `<span class="badge b-ok"><i></i>Согласовано</span>`;
  if (r.status==="rejected") return `<span class="badge b-bad"><i></i>Отказ</span>`;
  return `<span class="badge b-new"><i></i>Ждёт логиста</span>`;
}
const fmtDate = t => t ? new Date(t).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "";
function renderMine(){
  const mine = S.requests.filter(r => !S.me || r.managerId === S.me).slice(0,15);
  const el = $("#mineList");
  if (!mine.length){ el.innerHTML = `<div class="empty">Здесь появятся адреса, отправленные логисту, и его ответ.</div>`; return; }
  el.innerHTML = mine.map(r => `<div class="item">
      <div class="a">${esc(r.address)} <span class="muted">· ${CARS[r.car]||""}</span></div>
      <div class="p">${r.status==="approved"?rub(r.finalPrice):r.estimate?`<span class="muted">≈ ${rub(r.estimate)}</span>`:""}</div>
      <div class="m">${reqPill(r)} ${fmtDate(r.createdAt)}${r.logistComment?` · ${esc(r.logistComment)}`:""}</div>
    </div>`).join("");
}

/* ---------- approvals ---------- */
$$("[data-rf]").forEach(b => b.onclick = () => { S.rf = b.dataset.rf; $$("[data-rf]").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderReqs(); });
const dirOptions = sel => [...new Set([...DIR_ORDER, ...S.points.map(p=>p.dir)])].filter(Boolean).map(d=>`<option${d===sel?" selected":""}>${esc(d)}</option>`).join("");
function renderReqs(){
  const nNew = S.requests.filter(r=>r.status==="new").length;
  const c = $("#newCount"); c.textContent = nNew; c.hidden = !nNew;
  const list = S.requests.filter(r => S.rf==="new" ? r.status==="new" : r.status!=="new");
  const el = $("#reqList");
  // don't wipe a form someone is typing in
  if (el.contains(document.activeElement) && document.activeElement.matches("input,textarea,select")) return;
  if (!list.length){ el.innerHTML = `<div class="empty">${S.rf==="new"?"Новых запросов нет.":"Решённых запросов пока нет."}</div>`; return; }
  el.innerHTML = list.map(r => {
    const who = S.names[r.managerId] || "Менеджер";
    const facts = `<div class="sum">
        <div><span>Машина</span><b>${CARS[r.car]||"—"}</b></div>
        <div><span>Опорная точка</span><b>${esc(r.base||"не найдена")}${r.dir?` · ${esc(r.dir)}`:""}</b></div>
        <div><span>Доп. пробег</span><b>${r.km!=null?r.km+" км":"—"}</b></div>
        <div><span>Предв. цена</span><b>${rub(r.estimate)}</b></div>
      </div>
      ${r.autoComment?`<div class="note">Автооценка: ${esc(r.autoComment)}${r.confidence==="low"?" (низкая уверенность)":""}</div>`:""}
      ${r.managerNote?`<div class="note">Менеджер: ${esc(r.managerNote)}</div>`:""}`;
    if (r.status !== "new") return `<div class="card req">
        <div class="req-head"><div class="a">${esc(r.address)}</div><div>${reqPill(r)}</div></div>
        <div class="note">${esc(who)} · ${fmtDate(r.createdAt)}</div>${facts}
        <div><b>${r.status==="approved"?"Итог: "+rub(r.finalPrice):"Отказано"}</b>${r.logistComment?` — ${esc(r.logistComment)}`:""}</div>
      </div>`;
    return `<div class="card req" data-id="${r.id}">
      <div class="req-head"><div class="a">${esc(r.address)}</div><div class="note">${esc(who)} · ${fmtDate(r.createdAt)}</div></div>
      ${facts}
      <div class="decide">
        <div><label class="fl" for="pr-${r.id}">Цена клиенту, ₽</label><input class="inp" id="pr-${r.id}" type="number" min="0" step="100" value="${r.estimate??""}"></div>
        <div><label class="fl" for="cm-${r.id}">Комментарий менеджеру</label><input class="inp" id="cm-${r.id}" placeholder="Например: Элиста + 89 км"></div>
      </div>
      <label class="check"><input type="checkbox" class="sw-in" id="ad-${r.id}"> Добавить населённый пункт в тарифы, чтобы цена считалась сразу</label>
      <div class="addpt" id="ap-${r.id}" hidden>
        <div><label class="fl" for="an-${r.id}">Населённый пункт</label><input class="inp" id="an-${r.id}" value="${esc(r.locality||r.address)}"></div>
        <div><label class="fl" for="adr-${r.id}">Направление</label><select class="inp" id="adr-${r.id}">${dirOptions(r.dir)}</select></div>
        <div><label class="fl" for="ab-${r.id}">Опорная точка</label><input class="inp" id="ab-${r.id}" value="${esc(r.base||"")}"></div>
        <div><label class="fl" for="ak-${r.id}">Доп. км</label><input class="inp" id="ak-${r.id}" type="number" min="0" value="${r.km??0}"></div>
      </div>
      <div class="row"><button type="button" class="btn primary" data-act="ok">Утвердить цену</button><button type="button" class="btn danger-t" data-act="no">Отказать</button></div>
    </div>`;
  }).join("");
  el.querySelectorAll(".req[data-id]").forEach(card => {
    const id = card.dataset.id;
    card.querySelector(`#ad-${id}`).onchange = e => card.querySelector(`#ap-${id}`).hidden = !e.target.checked;
    card.querySelector('[data-act="ok"]').onclick = () => decide(id, "approved", card);
    card.querySelector('[data-act="no"]').onclick = () => decide(id, "rejected", card);
  });
}
async function decide(id, status, card){
  const r = S.requests.find(x=>x.id===id); if (!r) return;
  const price = Number(card.querySelector(`#pr-${id}`).value);
  const comment = card.querySelector(`#cm-${id}`).value.trim();
  if (status==="approved" && !(price>0)){ toast("Укажите цену клиенту"); card.querySelector(`#pr-${id}`).focus(); return; }
  if (status==="rejected" && !comment){ toast("Напишите менеджеру причину отказа"); card.querySelector(`#cm-${id}`).focus(); return; }
  card.querySelectorAll("button").forEach(b=>b.disabled=true);
  try{
    if (status==="approved" && card.querySelector(`#ad-${id}`).checked){
      const name = card.querySelector(`#an-${id}`).value.trim();
      const dir = card.querySelector(`#adr-${id}`).value;
      const base = card.querySelector(`#ab-${id}`).value.trim();
      const km = Math.max(0, Number(card.querySelector(`#ak-${id}`).value)||0);
      const bp = base ? findBase(dir, base) : null;
      const calc = c => bp && bp[c]!=null && kmAllowed(dir) ? ceilStep(bp[c] + km*S.settings.rate, S.settings.step) : null;
      const pt = {dir, name, base: bp?bp.name:base, km, gazel:calc("gazel"), gazon:calc("gazon"), status:"ok", order:Date.now(), note:"Из согласования"};
      pt[r.car] = price; // the approved price wins for the requested car
      if (name) await S.db.collection("points").add(pt);
    }
    await S.db.doc("requests/"+id).update({status, finalPrice: status==="approved"?price:null, logistComment:comment, resolvedAt:Date.now(), resolvedBy:S.me||null});
    toast(status==="approved"?"Цена утверждена":"Отказ отправлен");
  }catch(e){ card.querySelectorAll("button").forEach(b=>b.disabled=false); toast("Не сохранилось — проверьте права доступа"); }
}

/* ---------- tariffs ---------- */
function renderChips(){
  const dirs = ["Все", ...DIR_ORDER.filter(d=>S.points.some(p=>p.dir===d)), ...[...new Set(S.points.map(p=>p.dir))].filter(d=>d && !DIR_ORDER.includes(d)), "На проверке"];
  const cnt = d => d==="Все" ? S.points.length : d==="На проверке" ? S.points.filter(p=>p.status!=="ok").length : S.points.filter(p=>p.dir===d).length;
  $("#dirChips").innerHTML = dirs.map(d=>`<button type="button" class="chip" data-d="${esc(d)}" aria-pressed="${d===S.dir}">${esc(d)}<span>${cnt(d)}</span></button>`).join("");
  $$("#dirChips .chip").forEach(b => b.onclick = () => { S.dir = b.dataset.d; renderChips(); renderTable(); });
}
$("#tSearch").oninput = e => { S.q = e.target.value; renderTable(); };
function visiblePoints(){
  const q = norm(S.q).trim();
  return S.points.filter(p =>
    (S.dir==="Все" || (S.dir==="На проверке" ? p.status!=="ok" : p.dir===S.dir)) &&
    (!q || norm(p.name+" "+(p.aliases||"")+" "+(p.base||"")).includes(q)));
}
function rowView(p){
  return `<tr data-id="${p.id}">
    <td>${esc(p.dir||"—")}</td><td><b>${esc(p.name)}</b></td><td class="muted">${esc(p.aliases||"")}</td><td class="${p.base?"":"muted"}">${esc(p.base||"—")}</td>
    <td class="n">${p.km?p.km:'<span class="muted">0</span>'}</td><td class="n">${rub(p.gazel)}</td><td class="n">${rub(p.gazon)}</td>
    <td>${p.status==="ok"?'<span class="badge b-ok"><i></i>Утверждён</span>':'<span class="badge b-chk"><i></i>На проверке</span>'}</td>
    <td>${S.canWrite?`<button type="button" class="lnk" data-edit="${p.id}">Изменить</button>`:""}</td></tr>`;
}
function rowEdit(p){
  const id = p.id||"new";
  return `<tr class="editing" data-id="${id}">
    <td><select id="e-dir">${dirOptions(p.dir)}</select></td>
    <td><input id="e-name" value="${esc(p.name||"")}" placeholder="Населённый пункт"></td>
    <td><input id="e-alias" value="${esc(p.aliases||"")}" placeholder="через запятую"></td>
    <td><input id="e-base" value="${esc(p.base||"")}" placeholder="—"></td>
    <td><input id="e-km" type="number" min="0" value="${p.km??0}"></td>
    <td><input id="e-g1" type="number" min="0" step="100" value="${p.gazel??""}"></td>
    <td><input id="e-g2" type="number" min="0" step="100" value="${p.gazon??""}"></td>
    <td><select id="e-st"><option value="ok"${p.status==="ok"?" selected":""}>Утверждён</option><option value="check"${p.status!=="ok"?" selected":""}>На проверке</option></select></td>
    <td style="white-space:nowrap">
      <button type="button" class="lnk" id="e-calc" title="Тариф опорной точки + км × ставка">Пересчитать</button>
      <button type="button" class="btn primary sm" id="e-save">Сохранить</button>
      <button type="button" class="lnk" id="e-cancel">Отмена</button>
      ${p.id?`<button type="button" class="lnk red" id="e-del">Удалить</button>`:""}
    </td></tr>`;
}
function renderTable(){
  const rows = visiblePoints();
  $("#tCount").textContent = `Показано ${rows.length} из ${S.points.length}`;
  const ed = S.editing;
  let html = ed && !ed.id ? rowEdit(ed) : "";
  html += rows.map(p => ed && ed.id===p.id ? rowEdit(ed) : rowView(p)).join("");
  $("#tBody").innerHTML = html || `<tr><td colspan="9" class="muted" style="text-align:center;padding:28px">Ничего не найдено</td></tr>`;
  $$("[data-edit]").forEach(b => b.onclick = () => { S.editing = {...S.points.find(p=>p.id===b.dataset.edit)}; renderTable(); });
  if (ed) bindEditor();
}
$("#addPoint").onclick = () => { S.editing = {dir: S.dir!=="Все"&&S.dir!=="На проверке"?S.dir:"Город", name:"", base:"", km:0, gazel:null, gazon:null, status:"ok"}; renderTable(); $("#e-name")?.focus(); };
function readEditor(){
  const num = v => v===""?null:Math.max(0,Number(v));
  return { dir:$("#e-dir").value, name:$("#e-name").value.trim(), aliases:$("#e-alias").value.trim(), base:$("#e-base").value.trim(), km:num($("#e-km").value)??0,
    gazel:num($("#e-g1").value), gazon:num($("#e-g2").value), status:$("#e-st").value };
}
function bindEditor(){
  $("#e-cancel").onclick = () => { S.editing=null; renderTable(); };
  $("#e-calc").onclick = () => {
    const v = readEditor(); const bp = v.base ? findBase(v.dir, v.base) : null;
    if (!bp){ toast("Опорная точка не найдена в утверждённом прайсе"); return; }
    if (!kmAllowed(v.dir)){ toast(NO_KM_TEXT); return; }
    $("#e-g1").value = bp.gazel!=null ? ceilStep(bp.gazel + v.km*S.settings.rate, S.settings.step) : "";
    $("#e-g2").value = bp.gazon!=null ? ceilStep(bp.gazon + v.km*S.settings.rate, S.settings.step) : "";
  };
  $("#e-save").onclick = async () => {
    const v = readEditor();
    if (!v.name){ toast("Впишите населённый пункт"); return; }
    if (v.status==="ok" && v.gazel==null && v.gazon==null){ toast("Для утверждения нужна хотя бы одна цена"); return; }
    try{
      if (S.editing.id) await S.db.doc("points/"+S.editing.id).set({...v, order:S.editing.order??Date.now(), note:S.editing.note||""});
      else await S.db.collection("points").add({...v, order:Date.now(), note:""});
      S.editing=null; renderTable(); toast("Сохранено");
    }catch(e){ toast("Не сохранилось — проверьте права доступа"); }
  };
  const del = $("#e-del");
  if (del) del.onclick = async () => {
    if (del.dataset.sure !== "1"){ del.dataset.sure="1"; del.textContent="Точно удалить?"; return; }
    try{ await S.db.doc("points/"+S.editing.id).delete(); S.editing=null; renderTable(); toast("Удалено"); }catch(e){ toast("Не удалилось"); }
  };
}
function renderSettings(){
  for (const [id,k] of [["#sRate","rate"],["#sStep","step"],["#sThr","threshold"]]){
    const el=$(id); if (document.activeElement!==el) el.value = S.settings[k];
  }
}
for (const [id,k] of [["#sRate","rate"],["#sStep","step"],["#sThr","threshold"]]){
  $(id).onchange = async e => {
    const v = Number(e.target.value); if (!(v>=0) || (k==="step" && !(v>0))){ renderSettings(); return; }
    try{ await S.db.doc("settings/main").set({...S.settings, [k]:v}); toast("Сохранено"); }catch(err){ toast("Не сохранилось"); renderSettings(); }
  };
}

/* ---------- data ---------- */
function setReadOnly(){
  S.canWrite = false;
  $("#addPoint").hidden = true;
  $$(".set input").forEach(i=>i.disabled=true);
}
async function resolveNames(){
  if (!S.user?.profiles) return;
  const ids = [...new Set(S.requests.map(r=>r.managerId).filter(Boolean))].filter(id=>!(id in S.names));
  if (!ids.length) return;
  try{ const ps = await S.user.profiles(ids); for (const id of ids) S.names[id] = ps?.[id]?.name || ""; renderReqs(); }catch(e){}
}
async function init(){
  renderChips(); renderTable(); renderSettings();
  const timer = setTimeout(()=>{ const n=$("#netNote"); n.textContent="Не удаётся загрузить тарифы. Проверьте интернет — данные появятся сами."; n.hidden=false; }, 10000);
  const RT = (window.claude && window.claude.use) ? window.claude : window.LocalClaude;
  if (RT === window.LocalClaude) LocalClaude.ui();
  const [db, user, sample] = await Promise.all([RT.use("db"), RT.use("user"), RT.use("sample")]).catch(()=>[null,null,null]);
  S.db = db; S.user = user; S.sample = sample;
  if (!db){ clearTimeout(timer); const n=$("#netNote"); n.textContent="Общая база тарифов недоступна в этом окне. Откройте сайт по ссылке, войдя в свой аккаунт Claude."; n.hidden=false; return; }
  if (user){
    try{ S.me = await user.id(); }catch(e){}
    try{ if (await user.can("data.write") === false) setReadOnly(); }catch(e){}
  }
  db.collection("points").orderBy("order").onSnapshot(snap => {
    if (!snap.metadata.fromCache){ clearTimeout(timer); $("#netNote").hidden=true; }
    S.points = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderChips(); if (!S.editing) renderTable(); fillTripSelects(); renderTrip(); fillDirSelect();
  }, ()=>{ clearTimeout(timer); });
  db.doc("settings/main").onSnapshot(s => { if (s.exists) S.settings = {...S.settings, ...s.data()}; renderSettings(); renderTrip(); renderRulesNums(); if (S.last) recalcLast(); else renderResult(); }, ()=>{});
  db.collection("requests").orderBy("createdAt","desc").limit(300).onSnapshot(snap => {
    S.requests = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderMine(); renderReqs(); resolveNames();
  }, ()=>{});
}
/* ---------- trip calculator ---------- */
const T = { dir:null, base:null, car:"gazel", fmt:"regular", type:"dead" };
const TYPE_HINT = {way:"Объезда нет — доп. пробег 0 км.", dead:"Доп. пробег = км до адреса × 2 (туда и обратно к маршруту).", cont:"Доп. пробег = км в одну сторону; возвращаться не нужно."};
const dirsWithPrices = () => DIR_ORDER.filter(d=>approved().some(p=>p.dir===d)).concat([...new Set(approved().map(p=>p.dir))].filter(d=>d&&!DIR_ORDER.includes(d)));
function fillTripSelects(){
  const dirs = dirsWithPrices();
  if (!dirs.includes(T.dir)) T.dir = dirs[0] || null;
  $("#tDir").innerHTML = dirs.map(d=>`<option${d===T.dir?" selected":""}>${esc(d)}</option>`).join("");
  const bases = approved().filter(p=>p.dir===T.dir);
  if (!bases.some(p=>p.id===T.base)) T.base = bases[0]?.id || null;
  $("#tBase").innerHTML = bases.map(p=>`<option value="${p.id}"${p.id===T.base?" selected":""}>${esc(p.name)} — ${rub(p[T.car])}</option>`).join("");
}
$("#tDir").onchange = e => { T.dir = e.target.value; T.base = null; fillTripSelects(); renderTrip(); };
$("#tBase").onchange = e => { T.base = e.target.value; renderTrip(); };
$$("[data-group]").forEach(g => g.querySelectorAll("button").forEach(b => b.onclick = () => {
  const key = {tCar:"car", tFmt:"fmt", tType:"type"}[g.dataset.group];
  T[key] = b.dataset.v; g.querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed", x===b));
  if (key==="car") fillTripSelects();
  renderTrip();
}));
$("#tKm").oninput = renderTrip;
function renderTrip(){
  const st = S.settings;
  $("#tTypeHint").textContent = TYPE_HINT[T.type];
  $("#tParams").textContent = `Ставка ${st.rate} ₽/км · порог согласования ${st.threshold} км · округление вверх до ${st.step} ₽. Меняются во вкладке «Тарифы».`;
  const bp = S.points.find(p=>p.id===T.base);
  const km = Math.max(0, Number($("#tKm").value)||0);
  const extraKm = T.type==="way" ? 0 : T.type==="dead" ? km*2 : km;
  const tariff = bp ? bp[T.car] : null;
  const rate = bp && !kmAllowed(bp.dir) ? 0 : st.rate;
  const extra = extraKm * rate;
  const raw = tariff==null ? null : tariff + extra;
  const total = raw==null ? null : ceilStep(raw, st.step);
  let status, c, why;
  if (!bp || tariff==null){ status="Нет данных"; c="#F87171"; why="Проверьте опорный пункт, параметры и единицы."; }
  else if (rate === 0 && extraKm > 0){ status="Согласовать"; c="#FBBF24"; why=NO_KM_TEXT; }
  else if (extraKm > st.threshold){ status="Согласовать"; c="#FBBF24"; why=`Большой дополнительный пробег: ${extraKm} км больше порога ${st.threshold} км.`; }
  else if (T.fmt==="orders"){ status="Проверить рейс"; c="#FBBF24"; why="Нужно подтвердить маршрут и распределение заезда."; }
  else { status="Расчёт готов"; c="#4ADE80"; why="Использован базовый тариф и отклонение."; }
  $("#tripRes").innerHTML = `<span class="res-status" style="--c:${c}"><i></i>${status}</span>
    <div class="place">${bp?`<b>${esc(bp.name)}</b> · ${esc(bp.dir)} · ${CARS[T.car]}`:"Опорный пункт не выбран"}</div>
    <div class="big-n">${rub(total)}<small>клиенту</small></div>
    <div class="t-rule"></div>
    <div>
      <div class="kv"><span>Ключ тарифа</span><b>${esc((bp?.dir||T.dir||"")+"|"+(bp?.name||""))}</b></div>
      <div class="kv"><span>Базовый тариф</span><b>${rub(tariff)}</b></div>
      <div class="kv"><span>Доп. пробег всего</span><b>${extraKm} км</b></div>
      <div class="kv"><span>Фактическая доплата к заказу${rate===0?" (не применяется)":""}</span><b>${rub(extra)}</b></div>
      <div class="kv"><span>До округления</span><b>${rub(raw)}</b></div>
      <div class="kv"><span>Итого для клиента</span><b>${rub(total)}</b></div>
    </div>
    <div class="note">${esc(why)}${$("#tNote").value.trim()?`<br>Примечание: ${esc($("#tNote").value.trim())}`:""}</div>`;
}
$("#tNote").oninput = renderTrip;
$("#tAutoBtn").onclick = async () => {
  const addr = $("#tAddr").value.trim(), next = $("#tNext").value.trim();
  const bp = S.points.find(p=>p.id===T.base);
  const st = $("#tAutoState");
  if (!addr || !bp){ st.textContent = "Выберите опорный пункт и впишите адрес клиента."; return; }
  if (!S.sample){ st.textContent = "Автоматический расчёт недоступен в этом окне — введите км вручную."; return; }
  const btn = $("#tAutoBtn"); btn.disabled = true; st.textContent = "Считаю расстояние… обычно 10–30 секунд";
  try {
    const ans = await S.sample.json(`Ты логист. Оцени расстояния по автодорогам в России, целыми километрами.
Опорная точка (A): ${bp.name} (направление ${bp.dir}, рейсы из Волгограда).
Клиент (B): ${addr}
${next ? `Следующая остановка (C): ${next}` : "Следующей остановки нет."}
Верни только JSON: {"ab": км A→B, ${next ? `"bc": км B→C, "ac": км A→C, ` : ""}"comment": "кратко маршрут"}`, {modelTier:"default"});
    const ab = Math.round(Number(ans?.ab));
    if (!(ab >= 0)) throw {code:"invalid_json"};
    if (next){
      const bc = Math.round(Number(ans.bc)), ac = Math.round(Number(ans.ac));
      const extra = Math.max(0, ab + bc - ac);
      T.type = "cont"; $("#tKm").value = extra;
      st.textContent = `A→B ${ab} км + B→C ${bc} км − A→C ${ac} км = ${extra} км доп. пробега. ${ans.comment||""}`;
    } else {
      T.type = "cont"; $("#tKm").value = ab;
      st.textContent = `До клиента ${ab} км по маршруту от опорной точки. Если машине нужно вернуться к маршруту, выберите «Заезд с возвратом». ${ans.comment||""}`;
    }
    $$('[data-group="tType"] button').forEach(x=>x.setAttribute("aria-pressed", x.dataset.v===T.type));
    renderTrip();
  } catch(e){
    st.textContent = e?.code==="not_granted" ? "Автоматический расчёт не разрешён — введите км вручную." : "Не получилось посчитать. Введите км вручную или попробуйте ещё раз.";
    if (e?.code==="not_granted" || e?.code==="sampling_disabled") S.sample = null;
  } finally { btn.disabled = false; }
};
function renderRulesNums(){
  $$(".js-rate").forEach(e=>e.textContent=S.settings.rate);
  $$(".js-step").forEach(e=>e.textContent=S.settings.step);
  $$(".js-thr").forEach(e=>e.textContent=S.settings.threshold);
}

renderReqs();
fillTripSelects(); renderTrip(); renderRulesNums(); fillDirSelect(); renderResult();
init();
})();
