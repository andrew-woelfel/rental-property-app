import { useState, useEffect, useRef } from "react";
import { writeTextFile, readTextFile, createDir, exists } from "@tauri-apps/api/fs";
import { appDataDir } from "@tauri-apps/api/path";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = {
  expense: ["Mortgage/Insurance", "Utilities", "Property Tax", "HOA", "Lawn/Snow", "Pest Control", "Management Fee", "Other"],
  improvement: ["Kitchen", "Bathroom", "Flooring", "Roof/Exterior", "HVAC", "Windows/Doors", "Landscaping", "Addition", "Other"],
  fix: ["Plumbing", "Electrical", "Appliance", "HVAC", "Structural", "Cosmetic", "Emergency", "Other"],
};

const TYPE_CONFIG = {
  expense:     { label: "Expense",     color: "#e05c5c", bg: "#3a1a1a", light: "#ff8080", icon: "💸" },
  improvement: { label: "Improvement", color: "#5c9ee0", bg: "#1a243a", light: "#80c0ff", icon: "🔨" },
  fix:         { label: "Fix/Repair",  color: "#5ce09e", bg: "#1a3a2a", light: "#80ffb0", icon: "🔧" },
};

const STATUS_CONFIG = {
  pending:       { label: "Pending",     color: "#f0c040" },
  "in-progress": { label: "In Progress", color: "#5c9ee0" },
  complete:      { label: "Complete",    color: "#5ce09e" },
};

const RENT_STATUS = {
  paid:    { label: "Paid",    color: "#5ce09e", bg: "#1a3a2a" },
  late:    { label: "Late",    color: "#f0c040", bg: "#3a3010" },
  partial: { label: "Partial", color: "#80c0ff", bg: "#1a243a" },
  unpaid:  { label: "Unpaid",  color: "#ff8080", bg: "#3a1a1a" },
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const DATA_FILE = "proptrack-data.json";

const INITIAL_FORM = {
  type: "expense", category: "", title: "", description: "",
  amount: "", date: new Date().toISOString().slice(0, 10),
  status: "complete", vendor: "", receipt: "", receiptUrl: "",
};

const INITIAL_TENANT = { name: "", email: "", phone: "", rentAmount: "", leaseStart: "", leaseEnd: "", notes: "" };

// ─── Tauri Storage ────────────────────────────────────────────────────────────

async function getDataPath() {
  const dir = await appDataDir();
  return dir + "proptrack-data.json";
}

async function loadData() {
  try {
    const path = await getDataPath();
    const fileExists = await exists(path);
    if (!fileExists) return null;
    const text = await readTextFile(path);
    return JSON.parse(text);
  } catch (e) {
    console.error("Load error:", e);
    return null;
  }
}

async function saveData(data) {
  try {
    const dir = await appDataDir();
    const dirExists = await exists(dir);
    if (!dirExists) {
      await createDir(dir, { recursive: true });
    }
    const path = dir + "proptrack-data.json";
    await writeTextFile(path, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Save error:", e);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt$ = (v) => v != null ? `$${Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "—";
const fmtDate = (d) => { if (!d) return "—"; const [y,m,day]=d.split("-"); return `${m}/${day}/${y}`; };
const currentYear  = () => new Date().getFullYear().toString();
const currentMonth = () => new Date().getMonth();

async function exportCSV(entries, rentPayments, yearFilter) {
  const { save } = await import("@tauri-apps/api/dialog");
  const { writeTextFile } = await import("@tauri-apps/api/fs");

  const yr = yearFilter === "all" ? null : yearFilter;
  const fe = yr ? entries.filter(e => e.date?.startsWith(yr)) : entries;
  const fr = yr ? rentPayments.filter(r => String(r.year) === yr) : rentPayments;

  let csv = "Type,Category,Title,Vendor,Date,Amount,Status,Receipt#,ReceiptURL,Notes\n";
  fe.forEach(e => {
    csv += [e.type, e.category||"", `"${(e.title||"").replace(/"/g,'""')}"`,
      `"${(e.vendor||"").replace(/"/g,'""')}"`, e.date, e.amount||"",
      e.status, e.receipt||"", e.receiptUrl||"",
      `"${(e.description||"").replace(/"/g,'""')}"`].join(",") + "\n";
  });
  csv += "\nRENT PAYMENTS\nYear,Month,Amount Due,Amount Paid,Status,Paid Date,Notes\n";
  fr.forEach(r => {
    csv += [r.year, MONTHS[r.month], r.amountDue||"", r.amountPaid||"",
      r.status||"", r.paidDate||"", `"${(r.notes||"").replace(/"/g,'""')}"`].join(",") + "\n";
  });

  const defaultName = `proptrack_${yr || "all"}.csv`;
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });

  if (filePath) {
    await writeTextFile(filePath, csv);
  }
}

function buildTaxSummary(entries, rentPayments, year) {
  const e = entries.filter(x => x.date?.startsWith(year) && x.status === "complete");
  const byType = (t) => e.filter(x => x.type === t);
  const sum = (arr) => arr.reduce((s,x) => s+(parseFloat(x.amount)||0), 0);
  const byCat = (arr) => {
    const m = {};
    arr.forEach(x => { const k=x.category||"Other"; m[k]=(m[k]||0)+(parseFloat(x.amount)||0); });
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  };
  const expenses = byType("expense"), fixes = byType("fix"), improvements = byType("improvement");
  const rentYr = rentPayments.filter(r => String(r.year)===year && r.status==="paid");
  const totalRent = rentYr.reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0);
  return {
    year, totalRent,
    totalExpenses: sum(expenses), totalRepairs: sum(fixes), totalImprovements: sum(improvements),
    netIncome: totalRent - sum(expenses) - sum(fixes),
    expensesByCategory: byCat(expenses), repairsByCategory: byCat(fixes), improvementsByCategory: byCat(improvements),
  };
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [entries,      setEntries]      = useState([]);
  const [rentPayments, setRentPayments] = useState([]);
  const [tenant,       setTenant]       = useState(INITIAL_TENANT);
  const [loaded,       setLoaded]       = useState(false);
  const [view,         setView]         = useState("dashboard");
  const [form,         setForm]         = useState(INITIAL_FORM);
  const [editId,       setEditId]       = useState(null);
  const [filter,       setFilter]       = useState({ type:"all", status:"all", year:"all" });
  const [search,       setSearch]       = useState("");
  const [sortBy,       setSortBy]       = useState("date_desc");
  const [taxYear,      setTaxYear]      = useState(currentYear());
  const [editTenant,   setEditTenant]   = useState(false);
  const [tenantForm,   setTenantForm]   = useState(INITIAL_TENANT);
  const [toast,        setToast]        = useState(null);
  const [receiptModal, setReceiptModal] = useState(null);
  const [rentModal,    setRentModal]    = useState(null);
  const [rentForm,     setRentForm]     = useState({});
  const toastTimer = useRef(null);

  // ── Load from disk on mount ──
  useEffect(() => {
    loadData().then(data => {
      if (data) {
        if (data.entries)      setEntries(data.entries);
        if (data.rentPayments) setRentPayments(data.rentPayments);
        if (data.tenant)       setTenant(data.tenant);
      }
      setLoaded(true);
    });
  }, []);

  // ── Save to disk whenever state changes ──
  useEffect(() => {
    if (!loaded) return;
    saveData({ entries, rentPayments, tenant });
  }, [entries, rentPayments, tenant, loaded]);

  function showToast(msg, type="success") {
    setToast({msg,type});
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(()=>setToast(null), 2800);
  }

  function saveEntry() {
    if (!form.title.trim()||!form.date) { showToast("Title and date are required","error"); return; }
    if (editId) { setEntries(e=>e.map(x=>x.id===editId?{...form,id:editId}:x)); showToast("Entry updated"); }
    else         { setEntries(e=>[{...form,id:Date.now()+Math.random()},...e]);  showToast("Entry added"); }
    setForm(INITIAL_FORM); setEditId(null); setView("log");
  }
  function deleteEntry(id) { setEntries(e=>e.filter(x=>x.id!==id)); showToast("Entry deleted","error"); }
  function startEdit(entry) { setForm({...entry}); setEditId(entry.id); setView("form"); }
  function startNew(type="expense") { setForm({...INITIAL_FORM,type}); setEditId(null); setView("form"); }

  function getRentRecord(year, month) { return rentPayments.find(r=>r.year===year&&r.month===month)||null; }
  function openRentModal(year, month) {
    const ex = getRentRecord(year,month);
    setRentForm(ex||{year,month,amountDue:tenant.rentAmount||"",amountPaid:"",status:"unpaid",paidDate:"",notes:""});
    setRentModal({year,month});
  }
  function saveRent() {
    const key = r=>`${r.year}-${r.month}`;
    const exists = rentPayments.find(r=>r.year===rentForm.year&&r.month===rentForm.month);
    if (exists) setRentPayments(p=>p.map(r=>key(r)===key(rentForm)?{...rentForm}:r));
    else         setRentPayments(p=>[...p,{...rentForm}]);
    setRentModal(null); showToast("Rent record saved");
  }
  function saveTenant() { setTenant({...tenantForm}); setEditTenant(false); showToast("Tenant info saved"); }

  const allYears = [...new Set([
    ...entries.map(e=>e.date?.slice(0,4)),
    ...rentPayments.map(r=>String(r.year)),
  ])].filter(Boolean).sort().reverse();

  const filtered = entries.filter(e=>{
    if (filter.type!=="all"&&e.type!==filter.type) return false;
    if (filter.status!=="all"&&e.status!==filter.status) return false;
    if (filter.year!=="all"&&e.date?.slice(0,4)!==filter.year) return false;
    if (search&&!`${e.title} ${e.description} ${e.vendor} ${e.category}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a,b)=>{
    if (sortBy==="date_desc") return b.date?.localeCompare(a.date)||0;
    if (sortBy==="date_asc")  return a.date?.localeCompare(b.date)||0;
    if (sortBy==="amount_desc") return (parseFloat(b.amount)||0)-(parseFloat(a.amount)||0);
    if (sortBy==="amount_asc")  return (parseFloat(a.amount)||0)-(parseFloat(b.amount)||0);
    return 0;
  });

  const totalByType  = (t) => entries.filter(e=>e.type===t&&e.status==="complete").reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const thisYearTotal= (t) => { const yr=currentYear(); return entries.filter(e=>e.type===t&&e.date?.startsWith(yr)&&e.status==="complete").reduce((s,e)=>s+(parseFloat(e.amount)||0),0); };
  const pending = entries.filter(e=>e.status==="pending"||e.status==="in-progress");
  const rentThisYear = () => { const yr=parseInt(currentYear()); return rentPayments.filter(r=>r.year===yr&&r.status==="paid").reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0); };
  const taxData = buildTaxSummary(entries, rentPayments, taxYear);

  if (!loaded) {
    return (
      <div style={{background:"#0e0e0e",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Mono',monospace",color:"#444",fontSize:13,letterSpacing:".1em"}}>
        LOADING…
      </div>
    );
  }

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Playfair+Display:wght@700;900&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    html,body,#root{height:100%}
    ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#1a1a1a}::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
    input,select,textarea{font-family:inherit}
    /* Disable text selection drag on titlebar area */
    .titlebar{-webkit-app-region:drag;height:28px;background:#0a0a0a;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;padding:0 80px;flex-shrink:0}
    .titlebar-title{font-family:'Playfair Display',serif;font-size:13px;font-weight:700;color:#3a3828;letter-spacing:.05em;margin:0 auto}
    .nav-btn{background:none;border:none;cursor:pointer;color:#888;font-family:inherit;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:8px 13px;border-radius:4px;transition:all .15s;white-space:nowrap;border-bottom:2px solid transparent}
    .nav-btn:hover{color:#d4d0c8;background:#1e1e1e}
    .nav-btn.active{color:#d4d0c8;background:#252520;border-bottom:2px solid #c8b870}
    .abtn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:500;transition:all .15s}
    .abtn:hover{opacity:.85;transform:translateY(-1px)}
    .card{background:#141414;border:1px solid #222;border-radius:8px;padding:18px 22px;position:relative;overflow:hidden;transition:border-color .2s}
    .card:hover{border-color:#2e2e2e}
    .erow{background:#141414;border:1px solid #1e1e1e;border-radius:6px;padding:13px 17px;margin-bottom:8px;transition:all .15s}
    .erow:hover{border-color:#2e2e2e;background:#181818}
    .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:500}
    .fg{margin-bottom:16px}
    .fl{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:5px}
    .fi{width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;padding:9px 12px;color:#d4d0c8;font-size:13px;transition:border-color .15s}
    .fi:focus{outline:none;border-color:#c8b870}
    .ttab{padding:8px 15px;border:1px solid #222;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.06em;background:#141414;color:#666;transition:all .15s}
    .ttab:hover{color:#999}
    .ttab.ae{background:#3a1a1a;border-color:#e05c5c;color:#ff8080}
    .ttab.ai{background:#1a243a;border-color:#5c9ee0;color:#80c0ff}
    .ttab.af{background:#1a3a2a;border-color:#5ce09e;color:#80ffb0}
    .fsel{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;padding:7px 10px;color:#d4d0c8;font-family:inherit;font-size:12px;cursor:pointer}
    .fsel:focus{outline:none;border-color:#c8b870}
    .dbtn{background:none;border:none;cursor:pointer;color:#555;font-size:16px;padding:2px 6px;border-radius:3px;transition:color .15s}
    .dbtn:hover{color:#e05c5c}
    .ebtn{background:none;border:none;cursor:pointer;color:#555;font-size:12px;padding:2px 7px;border-radius:3px;transition:color .15s;font-family:inherit;letter-spacing:.06em}
    .ebtn:hover{color:#c8b870}
    .rcell{background:#141414;border:1px solid #1e1e1e;border-radius:6px;padding:11px 10px;cursor:pointer;transition:all .15s;text-align:center}
    .rcell:hover{border-color:#333;background:#181818}
    .mbg{position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
    .modal{background:#141414;border:1px solid #2a2a2a;border-radius:10px;padding:26px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto}
    .tsec{background:#141414;border:1px solid #1e1e1e;border-radius:8px;padding:18px;margin-bottom:14px}
    .trow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:13px}
    .trow:last-child{border-bottom:none}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes mIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
  `;

  return (
    <div style={{fontFamily:"'DM Mono','Courier New',monospace",background:"#0e0e0e",height:"100vh",color:"#d4d0c8",display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>

      {/* macOS traffic-light spacer — sits under window controls */}
      <div className="titlebar">
        <span className="titlebar-title">PROPTRACK</span>
      </div>

      {/* Nav */}
      <div style={{borderBottom:"1px solid #1e1e1e",padding:"0 20px",background:"#0e0e0e",flexShrink:0}}>
        <div style={{maxWidth:1040,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",height:48,gap:8}}>
          <nav style={{display:"flex",gap:1}}>
            {[{k:"dashboard",l:"Overview"},{k:"rent",l:"🏠 Rent"},{k:"log",l:"Log"},{k:"tax",l:"📋 Tax"},{k:"form",l:"+ Add"}].map(({k,l})=>(
              <button key={k} className={`nav-btn${view===k?" active":""}`} onClick={()=>k==="form"?startNew():setView(k)}>{l}</button>
            ))}
          </nav>
          <button className="abtn" oonClick={() => exportCSV(entries, rentPayments, filter.year).catch(console.error)}
            style={{background:"#1a1a1a",color:"#666",border:"1px solid #252525",fontSize:11,padding:"5px 12px"}}>
            ↓ CSV
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{flex:1,overflowY:"auto"}}>
        <div style={{maxWidth:1040,margin:"0 auto",padding:"24px 20px"}}>

          {/* ══ DASHBOARD ══ */}
          {view==="dashboard"&&(
            <div>
              <div style={{marginBottom:22,display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                <div>
                  <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:"#e8e4d8",marginBottom:3}}>Property Overview</h2>
                  <p style={{fontSize:12,color:"#555"}}>{entries.length} entries · {pending.length} pending · {currentYear()}</p>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button className="abtn" onClick={()=>startNew("expense")}     style={{background:"#3a1a1a",color:"#ff8080",border:"1px solid #6a2a2a"}}>💸 Expense</button>
                  <button className="abtn" onClick={()=>startNew("improvement")} style={{background:"#1a243a",color:"#80c0ff",border:"1px solid #2a4a6a"}}>🔨 Improve</button>
                  <button className="abtn" onClick={()=>startNew("fix")}         style={{background:"#1a3a2a",color:"#80ffb0",border:"1px solid #2a6a4a"}}>🔧 Fix</button>
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:14}}>
                {[
                  {label:"💰 Rent Collected", value:fmt$(rentThisYear()), sub:"this year (paid)", color:"#c8b870"},
                  ...Object.entries(TYPE_CONFIG).map(([t,c])=>({label:`${c.icon} ${c.label}`,value:fmt$(totalByType(t)),sub:`${fmt$(thisYearTotal(t))} this yr`,color:c.light}))
                ].map((s,i)=>(
                  <div key={i} className="card" style={{borderTop:`2px solid ${s.color}`}}>
                    <div style={{fontSize:10,color:"#555",letterSpacing:".1em",textTransform:"uppercase",marginBottom:8}}>{s.label}</div>
                    <div style={{fontSize:20,fontWeight:500,color:s.color,fontFamily:"'Playfair Display',serif",marginBottom:3}}>{s.value}</div>
                    <div style={{fontSize:11,color:"#444"}}>{s.sub}</div>
                  </div>
                ))}
              </div>

              <div className="card" style={{marginBottom:18,display:"flex",alignItems:"center",justifyContent:"space-between",gap:20,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:10,color:"#555",letterSpacing:".1em",textTransform:"uppercase",marginBottom:5}}>All-Time Capital Out</div>
                  <div style={{fontSize:28,fontFamily:"'Playfair Display',serif",color:"#c8b870"}}>{fmt$(totalByType("expense")+totalByType("improvement")+totalByType("fix"))}</div>
                </div>
                <div>
                  <div style={{fontSize:10,color:"#555",letterSpacing:".1em",textTransform:"uppercase",marginBottom:5}}>Net Income {currentYear()}</div>
                  <div style={{fontSize:22,fontFamily:"'Playfair Display',serif",color:rentThisYear()-thisYearTotal("expense")-thisYearTotal("fix")>=0?"#5ce09e":"#ff8080"}}>
                    {fmt$(rentThisYear()-thisYearTotal("expense")-thisYearTotal("fix"))}
                  </div>
                </div>
                <button className="abtn" onClick={()=>setView("rent")} style={{background:"#1a1a1a",color:"#888",border:"1px solid #2a2a2a"}}>View Rent Tracker →</button>
              </div>

              {pending.length>0&&(<>
                <div style={{fontSize:11,color:"#888",letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>⏳ Pending / In Progress</div>
                {pending.map(e=><EntryRow key={e.id} entry={e} onEdit={startEdit} onDelete={deleteEntry} onReceipt={setReceiptModal}/>)}
                <div style={{marginBottom:16}}/>
              </>)}

              <div style={{fontSize:11,color:"#888",letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>Recent Entries</div>
              {entries.slice(0,6).map(e=><EntryRow key={e.id} entry={e} onEdit={startEdit} onDelete={deleteEntry} onReceipt={setReceiptModal}/>)}
              {entries.length>6&&<button className="abtn" onClick={()=>setView("log")} style={{background:"#1e1e1e",color:"#666",border:"1px solid #2a2a2a",marginTop:8}}>View all {entries.length} →</button>}
              {entries.length===0&&<div style={{padding:"32px",textAlign:"center",color:"#333",fontSize:13,border:"1px dashed #1e1e1e",borderRadius:8}}>No entries yet. Add your first above.</div>}
            </div>
          )}

          {/* ══ RENT ══ */}
          {view==="rent"&&(
            <div>
              <div style={{marginBottom:22,display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                <div>
                  <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:"#e8e4d8",marginBottom:3}}>Rent Tracker</h2>
                  <p style={{fontSize:12,color:"#555"}}>Click any month cell to record or update a payment</p>
                </div>
                <button className="abtn" onClick={()=>{setTenantForm({...tenant});setEditTenant(true);}}
                  style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>
                  {tenant.name?"✏️ Edit Tenant":"+ Add Tenant"}
                </button>
              </div>

              {tenant.name&&(
                <div className="card" style={{marginBottom:20,borderTop:"2px solid #c8b870"}}>
                  <div style={{display:"flex",gap:28,flexWrap:"wrap"}}>
                    <div><div style={{fontSize:10,color:"#555",letterSpacing:".1em",marginBottom:3}}>TENANT</div><div style={{fontSize:15,color:"#e8e4d8"}}>{tenant.name}</div></div>
                    {tenant.email&&<div><div style={{fontSize:10,color:"#555",letterSpacing:".1em",marginBottom:3}}>EMAIL</div><div style={{fontSize:13}}>{tenant.email}</div></div>}
                    {tenant.phone&&<div><div style={{fontSize:10,color:"#555",letterSpacing:".1em",marginBottom:3}}>PHONE</div><div style={{fontSize:13}}>{tenant.phone}</div></div>}
                    {tenant.rentAmount&&<div><div style={{fontSize:10,color:"#555",letterSpacing:".1em",marginBottom:3}}>MONTHLY RENT</div><div style={{fontSize:16,color:"#c8b870",fontFamily:"'Playfair Display',serif"}}>{fmt$(tenant.rentAmount)}</div></div>}
                    {tenant.leaseStart&&<div><div style={{fontSize:10,color:"#555",letterSpacing:".1em",marginBottom:3}}>LEASE</div><div style={{fontSize:13}}>{fmtDate(tenant.leaseStart)} → {fmtDate(tenant.leaseEnd)}</div></div>}
                  </div>
                  {tenant.notes&&<div style={{fontSize:12,color:"#555",marginTop:10}}>{tenant.notes}</div>}
                </div>
              )}

              {[currentYear(), String(parseInt(currentYear())-1)].map(yr=>{
                const yrInt=parseInt(yr);
                const collected=rentPayments.filter(r=>r.year===yrInt&&r.status==="paid").reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0);
                const paidCount=rentPayments.filter(r=>r.year===yrInt&&r.status==="paid").length;
                return (
                  <div key={yr} style={{marginBottom:26}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                      <span style={{fontSize:13,color:"#c8b870",letterSpacing:".08em"}}>{yr}</span>
                      <span style={{fontSize:11,color:"#555"}}>{paidCount}/12 paid · {fmt$(collected)} collected</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
                      {MONTHS.map((mo,mi)=>{
                        const rec=getRentRecord(yrInt,mi);
                        const scfg=rec?RENT_STATUS[rec.status]||RENT_STATUS.unpaid:null;
                        const isFuture=yrInt===parseInt(currentYear())&&mi>currentMonth();
                        return (
                          <div key={mi} className="rcell"
                            style={{opacity:isFuture?.45:1,borderColor:scfg?scfg.color+"55":"#1e1e1e"}}
                            onClick={()=>!isFuture&&openRentModal(yrInt,mi)}>
                            <div style={{fontSize:10,color:"#555",letterSpacing:".06em",marginBottom:5}}>{mo.slice(0,3).toUpperCase()}</div>
                            {rec?(<>
                              <div style={{fontSize:12,color:scfg?.color,fontWeight:500}}>{fmt$(rec.amountPaid||rec.amountDue)}</div>
                              <div className="badge" style={{background:scfg?.bg,color:scfg?.color,marginTop:4,fontSize:9}}>{scfg?.label}</div>
                            </>):(
                              <div style={{fontSize:11,color:"#2a2a2a",marginTop:4}}>{isFuture?"–":"+ log"}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ══ LOG ══ */}
          {view==="log"&&(
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18,flexWrap:"wrap",gap:12}}>
                <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,color:"#e8e4d8"}}>Full Log</h2>
                <button className="abtn" onClick={()=>startNew()} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>+ Add Entry</button>
              </div>
              <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
                <input className="fi" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:170,padding:"7px 12px"}}/>
                <select className="fsel" value={filter.type} onChange={e=>setFilter(f=>({...f,type:e.target.value}))}>
                  <option value="all">All Types</option>
                  {Object.entries(TYPE_CONFIG).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                </select>
                <select className="fsel" value={filter.status} onChange={e=>setFilter(f=>({...f,status:e.target.value}))}>
                  <option value="all">All Status</option>
                  {Object.entries(STATUS_CONFIG).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                </select>
                <select className="fsel" value={filter.year} onChange={e=>setFilter(f=>({...f,year:e.target.value}))}>
                  <option value="all">All Years</option>
                  {allYears.map(y=><option key={y} value={y}>{y}</option>)}
                </select>
                <select className="fsel" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
                  <option value="date_desc">Newest</option>
                  <option value="date_asc">Oldest</option>
                  <option value="amount_desc">$ High→Low</option>
                  <option value="amount_asc">$ Low→High</option>
                </select>
                <span style={{fontSize:11,color:"#444",marginLeft:"auto"}}>
                  {filtered.length} · {fmt$(filtered.filter(e=>e.status==="complete").reduce((s,e)=>s+(parseFloat(e.amount)||0),0))}
                </span>
                <button className="abtn" onClick={() => exportCSV(entries, rentPayments, filter.year).catch(console.error)}
                  style={{background:"#1a1a1a",color:"#666",border:"1px solid #252525",fontSize:11,padding:"6px 11px"}}>↓ Export</button>
              </div>
              {filtered.length===0
                ?<div style={{padding:"40px",textAlign:"center",color:"#333",fontSize:13,border:"1px dashed #1e1e1e",borderRadius:8}}>No entries match your filters.</div>
                :filtered.map(e=><EntryRow key={e.id} entry={e} onEdit={startEdit} onDelete={deleteEntry} onReceipt={setReceiptModal}/>)
              }
            </div>
          )}

          {/* ══ TAX ══ */}
          {view==="tax"&&(
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:22,flexWrap:"wrap",gap:12}}>
                <div>
                  <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:"#e8e4d8",marginBottom:3}}>Tax Summary</h2>
                  <p style={{fontSize:12,color:"#555"}}>Schedule E rental income &amp; deduction overview</p>
                </div>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <select className="fsel" value={taxYear} onChange={e=>setTaxYear(e.target.value)}>
                    {(allYears.length?allYears:[currentYear()]).map(y=><option key={y} value={y}>{y}</option>)}
                  </select>
                  <button className="abtn" onClick={() => exportCSV(entries,rentPayments,taxYear).catch(console.error)}
                    style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>↓ Export {taxYear} CSV</button>
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
                {[
                  {l:"Gross Rent Income",    v:fmt$(taxData.totalRent),    c:"#c8b870"},
                  {l:"Operating Expenses",   v:fmt$(taxData.totalExpenses), c:"#ff8080"},
                  {l:"Repairs & Maint.",     v:fmt$(taxData.totalRepairs),  c:"#80ffb0"},
                  {l:"Net Rental Income",    v:fmt$(taxData.netIncome),     c:taxData.netIncome>=0?"#5ce09e":"#ff8080"},
                ].map((s,i)=>(
                  <div key={i} className="card" style={{borderTop:`2px solid ${s.c}`}}>
                    <div style={{fontSize:10,color:"#555",letterSpacing:".1em",textTransform:"uppercase",marginBottom:8}}>{s.l}</div>
                    <div style={{fontSize:20,fontFamily:"'Playfair Display',serif",color:s.c}}>{s.v}</div>
                  </div>
                ))}
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div className="tsec">
                  <div style={{fontSize:11,color:"#ff8080",letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>💸 Operating Expenses</div>
                  {taxData.expensesByCategory.length===0?<div style={{fontSize:12,color:"#333"}}>None this year</div>
                    :taxData.expensesByCategory.map(([cat,amt])=>(
                      <div key={cat} className="trow"><span style={{color:"#777"}}>{cat}</span><span style={{color:"#ff8080"}}>{fmt$(amt)}</span></div>
                    ))}
                  <div className="trow" style={{borderTop:"1px solid #2a2a2a",marginTop:8,paddingTop:8}}>
                    <span style={{color:"#d4d0c8",fontWeight:500}}>Total</span><span style={{color:"#ff8080",fontWeight:500}}>{fmt$(taxData.totalExpenses)}</span>
                  </div>
                </div>
                <div className="tsec">
                  <div style={{fontSize:11,color:"#80ffb0",letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>🔧 Repairs &amp; Maintenance</div>
                  {taxData.repairsByCategory.length===0?<div style={{fontSize:12,color:"#333"}}>None this year</div>
                    :taxData.repairsByCategory.map(([cat,amt])=>(
                      <div key={cat} className="trow"><span style={{color:"#777"}}>{cat}</span><span style={{color:"#80ffb0"}}>{fmt$(amt)}</span></div>
                    ))}
                  <div className="trow" style={{borderTop:"1px solid #2a2a2a",marginTop:8,paddingTop:8}}>
                    <span style={{color:"#d4d0c8",fontWeight:500}}>Total</span><span style={{color:"#80ffb0",fontWeight:500}}>{fmt$(taxData.totalRepairs)}</span>
                  </div>
                </div>
                <div className="tsec">
                  <div style={{fontSize:11,color:"#80c0ff",letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>🔨 Capital Improvements <span style={{fontSize:9,color:"#444"}}>(depreciate 27.5 yrs)</span></div>
                  {taxData.improvementsByCategory.length===0?<div style={{fontSize:12,color:"#333"}}>None this year</div>
                    :taxData.improvementsByCategory.map(([cat,amt])=>(
                      <div key={cat} className="trow"><span style={{color:"#777"}}>{cat}</span><span style={{color:"#80c0ff"}}>{fmt$(amt)}</span></div>
                    ))}
                  <div className="trow" style={{borderTop:"1px solid #2a2a2a",marginTop:8,paddingTop:8}}>
                    <span style={{color:"#d4d0c8",fontWeight:500}}>Total</span><span style={{color:"#80c0ff",fontWeight:500}}>{fmt$(taxData.totalImprovements)}</span>
                  </div>
                </div>
                <div className="tsec">
                  <div style={{fontSize:11,color:"#c8b870",letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>🏠 Rent — {taxYear}</div>
                  {MONTHS.map((mo,mi)=>{
                    const rec=getRentRecord(parseInt(taxYear),mi);
                    if(!rec) return null;
                    const scfg=RENT_STATUS[rec.status]||RENT_STATUS.unpaid;
                    return (
                      <div key={mi} className="trow">
                        <span style={{color:"#777"}}>{mo}</span>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span className="badge" style={{background:scfg.bg,color:scfg.color,fontSize:9}}>{scfg.label}</span>
                          <span style={{color:"#c8b870"}}>{fmt$(rec.amountPaid||0)}</span>
                        </div>
                      </div>
                    );
                  })}
                  {rentPayments.filter(r=>r.year===parseInt(taxYear)).length===0&&<div style={{fontSize:12,color:"#333"}}>No rent records for {taxYear}</div>}
                  <div className="trow" style={{borderTop:"1px solid #2a2a2a",marginTop:8,paddingTop:8}}>
                    <span style={{color:"#d4d0c8",fontWeight:500}}>Total Collected</span><span style={{color:"#c8b870",fontWeight:500}}>{fmt$(taxData.totalRent)}</span>
                  </div>
                </div>
              </div>
              <div style={{background:"#141408",border:"1px solid #3a3a18",borderRadius:6,padding:"13px 16px",marginTop:14,fontSize:12,color:"#888",lineHeight:1.7}}>
                <strong style={{color:"#c8b870"}}>Note:</strong> Expenses &amp; repairs are generally deductible in the year paid (Schedule E). Capital improvements depreciate over 27.5 yrs. Consult your CPA.
              </div>
            </div>
          )}

          {/* ══ FORM ══ */}
          {view==="form"&&(
            <div style={{maxWidth:620}}>
              <div style={{marginBottom:22}}>
                <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,color:"#e8e4d8",marginBottom:3}}>{editId?"Edit Entry":"New Entry"}</h2>
                <p style={{fontSize:12,color:"#555"}}>Log an expense, improvement, or repair</p>
              </div>
              <div className="fg">
                <label className="fl">Entry Type</label>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {Object.entries(TYPE_CONFIG).map(([t,c])=>(
                    <button key={t} className={`ttab${form.type===t?` a${t[0]}`:""}`} onClick={()=>setForm(f=>({...f,type:t,category:""}))}>
                      {c.icon} {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Title *</label>
                  <input className="fi" placeholder="e.g. New water heater" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">Category</label>
                  <select className="fi" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
                    <option value="">Select…</option>
                    {CATEGORIES[form.type]?.map(c=><option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="fg">
                  <label className="fl">Date *</label>
                  <input className="fi" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">Amount ($)</label>
                  <input className="fi" type="number" placeholder="0.00" step="0.01" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">Status</label>
                  <select className="fi" value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>
                    {Object.entries(STATUS_CONFIG).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>
                <div className="fg">
                  <label className="fl">Vendor / Contractor</label>
                  <input className="fi" placeholder="e.g. Joe's Plumbing" value={form.vendor} onChange={e=>setForm(f=>({...f,vendor:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">Receipt / Invoice #</label>
                  <input className="fi" placeholder="INV-1234" value={form.receipt} onChange={e=>setForm(f=>({...f,receipt:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">📎 Receipt Photo URL</label>
                  <input className="fi" placeholder="https://drive.google.com/…" value={form.receiptUrl} onChange={e=>setForm(f=>({...f,receiptUrl:e.target.value}))}/>
                </div>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Notes</label>
                  <textarea className="fi" rows={3} placeholder="Details, warranty info, follow-up needed…" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} style={{resize:"vertical"}}/>
                </div>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button className="abtn" onClick={saveEntry} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>{editId?"Update":"Save Entry"}</button>
                <button className="abtn" onClick={()=>{setForm(INITIAL_FORM);setEditId(null);setView("log");}} style={{background:"#1a1a1a",color:"#555",border:"1px solid #252525"}}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══ MODALS ══ */}
      {rentModal&&(
        <div className="mbg" onClick={()=>setRentModal(null)}>
          <div className="modal" style={{animation:"mIn .2s ease"}} onClick={e=>e.stopPropagation()}>
            <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:19,color:"#e8e4d8",marginBottom:3}}>{MONTHS[rentModal.month]} {rentModal.year}</h3>
            <p style={{fontSize:12,color:"#555",marginBottom:18}}>Record rent payment</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:13}}>
              <div className="fg"><label className="fl">Amount Due</label><input className="fi" type="number" placeholder="0.00" step="0.01" value={rentForm.amountDue||""} onChange={e=>setRentForm(f=>({...f,amountDue:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Amount Paid</label><input className="fi" type="number" placeholder="0.00" step="0.01" value={rentForm.amountPaid||""} onChange={e=>setRentForm(f=>({...f,amountPaid:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Status</label>
                <select className="fi" value={rentForm.status||"unpaid"} onChange={e=>setRentForm(f=>({...f,status:e.target.value}))}>
                  {Object.entries(RENT_STATUS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div className="fg"><label className="fl">Date Received</label><input className="fi" type="date" value={rentForm.paidDate||""} onChange={e=>setRentForm(f=>({...f,paidDate:e.target.value}))}/></div>
              <div className="fg" style={{gridColumn:"1 / -1"}}><label className="fl">Notes</label><input className="fi" placeholder="Venmo, late fee waived…" value={rentForm.notes||""} onChange={e=>setRentForm(f=>({...f,notes:e.target.value}))}/></div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button className="abtn" onClick={saveRent} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>Save</button>
              <button className="abtn" onClick={()=>setRentModal(null)} style={{background:"#1a1a1a",color:"#555",border:"1px solid #252525"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {editTenant&&(
        <div className="mbg" onClick={()=>setEditTenant(false)}>
          <div className="modal" style={{animation:"mIn .2s ease"}} onClick={e=>e.stopPropagation()}>
            <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:19,color:"#e8e4d8",marginBottom:18}}>Tenant Info</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:13}}>
              <div className="fg" style={{gridColumn:"1 / -1"}}><label className="fl">Full Name</label><input className="fi" value={tenantForm.name} onChange={e=>setTenantForm(f=>({...f,name:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Email</label><input className="fi" type="email" value={tenantForm.email} onChange={e=>setTenantForm(f=>({...f,email:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Phone</label><input className="fi" type="tel" value={tenantForm.phone} onChange={e=>setTenantForm(f=>({...f,phone:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Monthly Rent ($)</label><input className="fi" type="number" value={tenantForm.rentAmount} onChange={e=>setTenantForm(f=>({...f,rentAmount:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Lease Start</label><input className="fi" type="date" value={tenantForm.leaseStart} onChange={e=>setTenantForm(f=>({...f,leaseStart:e.target.value}))}/></div>
              <div className="fg"><label className="fl">Lease End</label><input className="fi" type="date" value={tenantForm.leaseEnd} onChange={e=>setTenantForm(f=>({...f,leaseEnd:e.target.value}))}/></div>
              <div className="fg" style={{gridColumn:"1 / -1"}}><label className="fl">Notes</label><textarea className="fi" rows={2} value={tenantForm.notes} onChange={e=>setTenantForm(f=>({...f,notes:e.target.value}))} style={{resize:"vertical"}}/></div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button className="abtn" onClick={saveTenant} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>Save</button>
              <button className="abtn" onClick={()=>setEditTenant(false)} style={{background:"#1a1a1a",color:"#555",border:"1px solid #252525"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {receiptModal&&(
        <div className="mbg" onClick={()=>setReceiptModal(null)}>
          <div className="modal" style={{animation:"mIn .2s ease",maxWidth:580}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:17,color:"#e8e4d8"}}>{receiptModal.title}</h3>
              <button className="dbtn" onClick={()=>setReceiptModal(null)}>×</button>
            </div>
            {receiptModal.receiptUrl?(<>
              <div style={{fontSize:11,color:"#555",marginBottom:10,wordBreak:"break-all"}}>
                <a href={receiptModal.receiptUrl} target="_blank" rel="noreferrer" style={{color:"#80c0ff"}}>{receiptModal.receiptUrl}</a>
              </div>
              <img src={receiptModal.receiptUrl} alt="Receipt" style={{maxWidth:"100%",borderRadius:6,border:"1px solid #2a2a2a"}}
                onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="block";}}/>
              <div style={{display:"none",padding:"20px",background:"#1a1a1a",borderRadius:6,fontSize:12,color:"#555",textAlign:"center"}}>
                Could not load image. <a href={receiptModal.receiptUrl} target="_blank" rel="noreferrer" style={{color:"#80c0ff"}}>Open link →</a>
              </div>
            </>):(
              <div style={{padding:"28px",textAlign:"center",color:"#333",fontSize:12,border:"1px dashed #1e1e1e",borderRadius:6}}>No receipt URL. Edit the entry to add one.</div>
            )}
          </div>
        </div>
      )}

      {toast&&(
        <div style={{position:"fixed",bottom:22,right:22,background:toast.type==="error"?"#3a1a1a":"#1a3a2a",border:`1px solid ${toast.type==="error"?"#6a2a2a":"#2a6a4a"}`,color:toast.type==="error"?"#ff8080":"#80ffb0",padding:"10px 18px",borderRadius:6,fontSize:13,fontFamily:"inherit",letterSpacing:".04em",zIndex:9999,animation:"fadeUp .2s ease"}}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function EntryRow({ entry, onEdit, onDelete, onReceipt }) {
  const cfg  = TYPE_CONFIG[entry.type]    || TYPE_CONFIG.expense;
  const scfg = STATUS_CONFIG[entry.status]|| STATUS_CONFIG.complete;
  return (
    <div className="erow" style={{display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:17,flexShrink:0}}>{cfg.icon}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
          <span style={{fontWeight:500,color:"#d4d0c8",fontSize:14}}>{entry.title}</span>
          {entry.category&&<span className="badge" style={{background:cfg.bg,color:cfg.light}}>{entry.category}</span>}
          <span className="badge" style={{background:"#1a1a1a",color:scfg.color}}>{scfg.label}</span>
          {entry.receiptUrl&&(
            <button onClick={()=>onReceipt(entry)}
              style={{background:"none",border:"1px solid #1e3040",borderRadius:3,cursor:"pointer",color:"#80c0ff",fontSize:10,padding:"1px 7px",fontFamily:"inherit",letterSpacing:".06em"}}>
              🖼 receipt
            </button>
          )}
        </div>
        <div style={{fontSize:11,color:"#444",display:"flex",gap:10,flexWrap:"wrap"}}>
          <span>{fmtDate(entry.date)}</span>
          {entry.vendor&&<span>📍 {entry.vendor}</span>}
          {entry.receipt&&<span>🧾 {entry.receipt}</span>}
          {entry.description&&<span style={{maxWidth:300,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.description}</span>}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
        {entry.amount&&<span style={{fontSize:15,fontWeight:500,color:cfg.light,fontFamily:"'Playfair Display',serif"}}>{fmt$(entry.amount)}</span>}
        <button className="ebtn" onClick={()=>onEdit(entry)}>edit</button>
        <button className="dbtn" onClick={()=>onDelete(entry.id)}>×</button>
      </div>
    </div>
  );
}
