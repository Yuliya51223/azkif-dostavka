/* Локальная база для работы без сервера: данные хранятся в браузере (localStorage).
   Повторяет то, что сайт ждёт от общей базы: коллекции, документы, подписки на изменения.
   При переносе на сервер этот файл заменяется подключением к серверной базе. */
(function () {
  const KEY = "azkif-dostavka-v1";
  let store;
  function load() {
    try { store = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { store = null; }
    if (!store) { store = JSON.parse(JSON.stringify(window.SEED || {})); save(); }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { console.warn("Не удалось сохранить данные", e); } }
  load();

  const listeners = new Set();
  function notify() { for (const l of listeners) { try { l(); } catch (e) { console.error(e); } } }
  window.addEventListener("storage", e => { if (e.key === KEY) { load(); notify(); } });

  const meta = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (id, d) => ({ id, exists: !!d, data: () => d ? JSON.parse(JSON.stringify(d)) : undefined, metadata: meta });
  const coll = name => (store[name] ||= {});
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function query(name, order, lim) {
    const q = {
      orderBy: (f, dir = "asc") => query(name, { f, dir }, lim),
      limit: n => query(name, order, n),
      where: () => q,
      get: async () => run(),
      onSnapshot(next) { const l = () => next(run()); listeners.add(l); setTimeout(l, 0); return () => listeners.delete(l); }
    };
    function run() {
      let docs = Object.entries(coll(name)).map(([id, d]) => ({ id, d }));
      if (order) docs.sort((a, b) => {
        const x = a.d[order.f], y = b.d[order.f];
        if (x == null) return 1; if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (order.dir === "desc" ? -1 : 1);
      }); else docs.sort((a, b) => a.id < b.id ? -1 : 1);
      if (lim) docs = docs.slice(0, lim);
      const out = docs.map(x => snapDoc(x.id, x.d));
      return { docs: out, size: out.length, empty: !out.length, metadata: meta, docChanges: () => [] };
    }
    return q;
  }
  function docRef(name, id) {
    return {
      id, path: name + "/" + id,
      get: async () => snapDoc(id, coll(name)[id]),
      async set(data) { coll(name)[id] = JSON.parse(JSON.stringify(data)); save(); notify(); },
      async update(data) {
        if (!coll(name)[id]) throw { code: "invalid_argument", message: "Документ не найден" };
        Object.assign(coll(name)[id], JSON.parse(JSON.stringify(data))); save(); notify();
      },
      async delete() { delete coll(name)[id]; save(); notify(); },
      onSnapshot(next) { const l = () => next(snapDoc(id, coll(name)[id])); listeners.add(l); setTimeout(l, 0); return () => listeners.delete(l); }
    };
  }
  const db = {
    collection(name) {
      return Object.assign(query(name), {
        path: name,
        doc: id => docRef(name, id || newId()),
        async add(data) { const r = docRef(name, newId()); await r.set(data); return r; }
      });
    },
    doc(path) { const [name, id] = path.split("/"); return docRef(name, id); }
  };
  const user = { id: async () => "local", can: async () => true, isOwner: () => true, profiles: async () => ({}) };

  window.LocalClaude = {
    use: async name => name === "db" ? db : name === "user" ? user : null,
    ui() {
      const badge = document.getElementById("envBadge");
      if (badge) badge.innerHTML = "<i></i>Локальная версия";
      const row = document.getElementById("backupRow");
      if (!row) return;
      row.hidden = false;
      document.getElementById("bkSave").onclick = () => {
        const blob = new Blob([JSON.stringify(store, null, 1)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "azkif-dostavka-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
      document.getElementById("bkLoad").onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          if (!data || !data.points) throw 0;
          store = data; save(); notify();
          alert("Резервная копия загружена");
        } catch (err) { alert("Это не резервная копия сайта доставки"); }
        e.target.value = "";
      };
    }
  };
})();
