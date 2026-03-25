import { useState, useEffect, useRef } from "react";
import { writeTextFile, readTextFile, createDir, exists } from "@tauri-apps/api/fs";
import { appDataDir } from "@tauri-apps/api/path";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = {
  expense:     ["Mortgage/Insurance","Utilities","Property Tax","HOA","Lawn/Snow","Pest Control","Management Fee","Other"],
  improvement: ["Kitchen","Bathroom","Flooring","Roof/Exterior","HVAC","Windows/Doors","Landscaping","Addition","Other"],
  fix:         ["Plumbing","Electrical","Appliance","HVAC","Structural","Cosmetic","Emergency","Other"],
};

const TYPE_CONFIG = {
  expense:     { label:"Expense",     color:"#e05c5c", bg:"#3a1a1a", light:"#ff8080", icon:"💸" },
  improvement: { label:"Improvement", color:"#5c9ee0", bg:"#1a243a", light:"#80c0ff", icon:"🔨" },
  fix:         { label:"Fix/Repair",  color:"#5ce09e", bg:"#1a3a2a", light:"#80ffb0", icon:"🔧" },
};

const STATUS_CONFIG = {
  pending:       { label:"Pending",     color:"#f0c040" },
  "in-progress": { label:"In Progress", color:"#5c9ee0" },
  complete:      { label:"Complete",    color:"#5ce09e" },
};

const RENT_STATUS = {
  paid:    { label:"Paid",    color:"#5ce09e", bg:"#1a3a2a" },
  late:    { label:"Late",    color:"#f0c040", bg:"#3a3010" },
  partial: { label:"Partial", color:"#80c0ff", bg:"#1a243a" },
  unpaid:  { label:"Unpaid",  color:"#ff8080", bg:"#3a1a1a" },
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const LOG_TABS = [
  { key:"all",         label:"All"          },
  { key:"expense",     label:"💸 Expenses"  },
  { key:"fix",         label:"🔧 Repairs"   },
  { key:"improvement", label:"🔨 Improvements" },
  { key:"rent",        label:"🏠 Rent"      },
];

const DATA_FILE = "proptrack-data.json";

const mkForm = (propId) => ({
  type:"expense", category:"", title:"", description:"",
  amount:"", date:new Date().toISOString().slice(0,10),
  status:"complete", vendor:"", receipt:"", receiptUrl:"",
  propertyId: propId || "",
});

const INITIAL_TENANT  = { name:"", email:"", phone:"", rentAmount:"", leaseStart:"", leaseEnd:"", notes:"" };
const INITIAL_PROPERTY = { name:"", address:"", type:"single-family", purchaseDate:"", purchasePrice:"", notes:"" };

// ─── Storage ──────────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const dir  = await appDataDir();
    const path = dir + DATA_FILE;
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path));
  } catch(e) { console.error("Load error:", e); return null; }
}

async function saveData(data) {
  try {
    const dir = await appDataDir();
    if (!(await exists(dir))) await createDir(dir, { recursive: true });
    await writeTextFile(dir + DATA_FILE, JSON.stringify(data, null, 2));
  } catch(e) { console.error("Save error:", e); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt$    = (v) => v!=null ? `$${Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "—";
const fmtDate = (d) => { if(!d) return "—"; const [y,m,day]=d.split("-"); return `${m}/${day}/${y}`; };
const uid     = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const curYear = () => new Date().getFullYear().toString();
const curMon  = () => new Date().getMonth();

async function exportCSV(entries, rentPayments, properties, propId, yearFilter) {
  const { save }          = await import("@tauri-apps/api/dialog");
  const { writeTextFile } = await import("@tauri-apps/api/fs");

  const yr  = yearFilter === "all" ? null : yearFilter;
  const pid = propId     === "all" ? null : propId;
  const prop = properties.find(p=>p.id===pid);

  const fe = entries.filter(e =>
    (!pid || e.propertyId===pid) && (!yr || e.date?.startsWith(yr))
  );
  const fr = rentPayments.filter(r =>
    (!pid || r.propertyId===pid) && (!yr || String(r.year)===yr)
  );

  let csv = "Property,Type,Category,Title,Vendor,Date,Amount,Status,Receipt#,ReceiptURL,Notes\n";
  fe.forEach(e => {
    const pName = properties.find(p=>p.id===e.propertyId)?.name || "";
    csv += [pName, e.type, e.category||"", `"${(e.title||"").replace(/"/g,'""')}"`,
      `"${(e.vendor||"").replace(/"/g,'""')}"`, e.date, e.amount||"",
      e.status, e.receipt||"", e.receiptUrl||"",
      `"${(e.description||"").replace(/"/g,'""')}"`].join(",") + "\n";
  });
  csv += "\nRENT PAYMENTS\nProperty,Year,Month,Amount Due,Amount Paid,Status,Paid Date,Notes\n";
  fr.forEach(r => {
    const pName = properties.find(p=>p.id===r.propertyId)?.name || "";
    csv += [pName, r.year, MONTHS[r.month], r.amountDue||"", r.amountPaid||"",
      r.status||"", r.paidDate||"", `"${(r.notes||"").replace(/"/g,'""')}"`].join(",") + "\n";
  });

  const label = [prop?.name||"all-properties", yr||"all-years"].join("_").replace(/\s+/g,"-");
  const filePath = await save({ defaultPath:`proptrack_${label}.csv`, filters:[{name:"CSV",extensions:["csv"]}] });
  if (filePath) await writeTextFile(filePath, csv);
}

function buildTaxSummary(entries, rentPayments, propId, year) {
  const pid = propId==="all" ? null : propId;
  const e = entries.filter(x =>
    x.date?.startsWith(year) && x.status==="complete" && (!pid || x.propertyId===pid)
  );
  const byType = (t) => e.filter(x=>x.type===t);
  const sum    = (arr) => arr.reduce((s,x)=>s+(parseFloat(x.amount)||0),0);
  const byCat  = (arr) => {
    const m={};
    arr.forEach(x=>{const k=x.category||"Other"; m[k]=(m[k]||0)+(parseFloat(x.amount)||0);});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  };
  const expenses=byType("expense"), fixes=byType("fix"), improvements=byType("improvement");
  const rentYr = rentPayments.filter(r=>String(r.year)===year&&r.status==="paid"&&(!pid||r.propertyId===pid));
  const totalRent = rentYr.reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0);
  return {
    year, totalRent,
    totalExpenses:sum(expenses), totalRepairs:sum(fixes), totalImprovements:sum(improvements),
    netIncome: totalRent-sum(expenses)-sum(fixes),
    expensesByCategory:byCat(expenses), repairsByCategory:byCat(fixes), improvementsByCategory:byCat(improvements),
  };
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [properties,   setProperties]   = useState([]);
  const [entries,      setEntries]      = useState([]);
  const [rentPayments, setRentPayments] = useState([]);
  const [tenants,      setTenants]      = useState({}); // { propertyId: tenant }
  const [loaded,       setLoaded]       = useState(false);

  // Navigation
  const [view,         setView]         = useState("dashboard"); // dashboard|properties|log|tax|form|propform
  const [activeProp,   setActiveProp]   = useState("all");       // property id or "all"
  const [logTab,       setLogTab]       = useState("all");

  // Forms
  const [form,         setForm]         = useState(mkForm(""));
  const [editId,       setEditId]       = useState(null);
  const [propForm,     setPropForm]     = useState(INITIAL_PROPERTY);
  const [editPropId,   setEditPropId]   = useState(null);
  const [tenantForm,   setTenantForm]   = useState(INITIAL_TENANT);
  const [editTenantFor,setEditTenantFor]= useState(null); // propertyId

  // Filters (log)
  const [search,       setSearch]       = useState("");
  const [filterYear,   setFilterYear]   = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [sortBy,       setSortBy]       = useState("date_desc");

  // Tax
  const [taxYear,      setTaxYear]      = useState(curYear());

  // UI
  const [toast,        setToast]        = useState(null);
  const [receiptModal, setReceiptModal] = useState(null);
  const [rentModal,    setRentModal]    = useState(null);
  const [rentForm,     setRentForm]     = useState({});
  const toastTimer = useRef(null);

  // ── Load ──
  useEffect(()=>{
    loadData().then(data=>{
      if (data) {
        if (data.properties)   setProperties(data.properties);
        if (data.entries)      setEntries(data.entries);
        if (data.rentPayments) setRentPayments(data.rentPayments);
        if (data.tenants)      setTenants(data.tenants);
        // Migrate old data: assign orphaned entries to first property
        if (data.properties?.length && data.entries?.some(e=>!e.propertyId)) {
          const pid = data.properties[0].id;
          setEntries(es=>es.map(e=>e.propertyId?e:{...e,propertyId:pid}));
          setRentPayments(rs=>rs.map(r=>r.propertyId?r:{...r,propertyId:pid}));
        }
      }
      setLoaded(true);
    });
  },[]);

  // ── Save ──
  useEffect(()=>{
    if (!loaded) return;
    saveData({ properties, entries, rentPayments, tenants });
  },[properties, entries, rentPayments, tenants, loaded]);

  function showToast(msg,type="success") {
    setToast({msg,type});
    clearTimeout(toastTimer.current);
    toastTimer.current=setTimeout(()=>setToast(null),2800);
  }

  // ── Properties ──
  function startNewProp()   { setPropForm(INITIAL_PROPERTY); setEditPropId(null); setView("propform"); }
  function startEditProp(p) { setPropForm({...p}); setEditPropId(p.id); setView("propform"); }
  function saveProp() {
    if (!propForm.name.trim()) { showToast("Property name required","error"); return; }
    if (editPropId) {
      setProperties(ps=>ps.map(p=>p.id===editPropId?{...propForm,id:editPropId}:p));
      showToast("Property updated");
    } else {
      const id = uid();
      setProperties(ps=>[...ps,{...propForm,id}]);
      setActiveProp(id);
      showToast("Property added");
    }
    setView("properties");
  }
  function deleteProp(id) {
    setProperties(ps=>ps.filter(p=>p.id!==id));
    setEntries(es=>es.filter(e=>e.propertyId!==id));
    setRentPayments(rs=>rs.filter(r=>r.propertyId!==id));
    setTenants(ts=>{ const t={...ts}; delete t[id]; return t; });
    if (activeProp===id) setActiveProp("all");
    showToast("Property deleted","error");
  }

  // ── Entries ──
  function startNew(type="expense") {
    const pid = activeProp==="all" ? (properties[0]?.id||"") : activeProp;
    setForm({...mkForm(pid),type});
    setEditId(null);
    setView("form");
  }
  function startEdit(entry) { setForm({...entry}); setEditId(entry.id); setView("form"); }
  function saveEntry() {
    if (!form.title.trim()||!form.date) { showToast("Title and date are required","error"); return; }
    if (!form.propertyId) { showToast("Select a property","error"); return; }
    if (editId) { setEntries(es=>es.map(x=>x.id===editId?{...form,id:editId}:x)); showToast("Entry updated"); }
    else         { setEntries(es=>[{...form,id:uid()},...es]); showToast("Entry added"); }
    setForm(mkForm(form.propertyId)); setEditId(null); setView("log");
  }
  function deleteEntry(id) { setEntries(es=>es.filter(x=>x.id!==id)); showToast("Entry deleted","error"); }

  // ── Rent ──
  function getRentRecord(propId,year,month) { return rentPayments.find(r=>r.propertyId===propId&&r.year===year&&r.month===month)||null; }
  function openRentModal(propId,year,month) {
    const tenant = tenants[propId];
    const ex = getRentRecord(propId,year,month);
    setRentForm(ex||{propertyId:propId,year,month,amountDue:tenant?.rentAmount||"",amountPaid:"",status:"unpaid",paidDate:"",notes:""});
    setRentModal({propId,year,month});
  }
  function saveRent() {
    const key = r=>`${r.propertyId}-${r.year}-${r.month}`;
    const exists = rentPayments.find(r=>r.propertyId===rentForm.propertyId&&r.year===rentForm.year&&r.month===rentForm.month);
    if (exists) setRentPayments(rs=>rs.map(r=>key(r)===key(rentForm)?{...rentForm}:r));
    else         setRentPayments(rs=>[...rs,{...rentForm}]);
    setRentModal(null); showToast("Rent record saved");
  }

  // ── Tenants ──
  function saveTenant() {
    setTenants(ts=>({...ts,[editTenantFor]:{...tenantForm}}));
    setEditTenantFor(null);
    showToast("Tenant saved");
  }

  // ── Derived ──
  const pid = activeProp==="all" ? null : activeProp;
  const activePropObj = properties.find(p=>p.id===activeProp)||null;

  const allYears = [...new Set([
    ...entries.map(e=>e.date?.slice(0,4)),
    ...rentPayments.map(r=>String(r.year)),
  ])].filter(Boolean).sort().reverse();

  const propEntries = (propId) => entries.filter(e=>e.propertyId===propId);
  const propRent    = (propId) => rentPayments.filter(r=>r.propertyId===propId);

  const filteredEntries = entries.filter(e=>{
    if (pid && e.propertyId!==pid) return false;
    if (logTab!=="all"&&logTab!=="rent"&&e.type!==logTab) return false;
    if (filterYear!=="all"&&e.date?.slice(0,4)!==filterYear) return false;
    if (filterStatus!=="all"&&e.status!==filterStatus) return false;
    if (search&&!`${e.title} ${e.description} ${e.vendor} ${e.category}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a,b)=>{
    if (sortBy==="date_desc") return b.date?.localeCompare(a.date)||0;
    if (sortBy==="date_asc")  return a.date?.localeCompare(b.date)||0;
    if (sortBy==="amount_desc") return (parseFloat(b.amount)||0)-(parseFloat(a.amount)||0);
    if (sortBy==="amount_asc")  return (parseFloat(a.amount)||0)-(parseFloat(b.amount)||0);
    return 0;
  });

  const filteredRent = rentPayments.filter(r=>{
    if (pid && r.propertyId!==pid) return false;
    if (filterYear!=="all"&&String(r.year)!==filterYear) return false;
    return true;
  });

  const totalByType = (type,propId) => {
    const p = propId==="all"?null:propId;
    return entries.filter(e=>e.type===type&&e.status==="complete"&&(!p||e.propertyId===p)).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  };
  const thisYearByType = (type,propId) => {
    const p=propId==="all"?null:propId; const yr=curYear();
    return entries.filter(e=>e.type===type&&e.date?.startsWith(yr)&&e.status==="complete"&&(!p||e.propertyId===p)).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  };
  const rentCollectedThisYear = (propId) => {
    const p=propId==="all"?null:propId; const yr=parseInt(curYear());
    return rentPayments.filter(r=>r.year===yr&&r.status==="paid"&&(!p||r.propertyId===p)).reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0);
  };
  const pending = entries.filter(e=>(e.status==="pending"||e.status==="in-progress")&&(!pid||e.propertyId===pid));
  const taxData = buildTaxSummary(entries,rentPayments,activeProp,taxYear);

  if (!loaded) return (
    <div style={{background:"#0e0e0e",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Mono',monospace",color:"#444",fontSize:13,letterSpacing:".1em"}}>
      LOADING…
    </div>
  );

  // ─── CSS ──────────────────────────────────────────────────────────────────
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Playfair+Display:wght@700;900&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    html,body,#root{height:100%}
    ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#1a1a1a}::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
    input,select,textarea{font-family:inherit}
    .titlebar{-webkit-app-region:drag;height:28px;background:#0a0a0a;border-bottom:1px solid #181818;display:flex;align-items:center;padding:0 80px;flex-shrink:0}
    .titlebar-title{font-family:'Playfair Display',serif;font-size:12px;font-weight:700;color:#2e2c24;letter-spacing:.08em;margin:0 auto}
    .nav-btn{background:none;border:none;cursor:pointer;color:#666;font-family:inherit;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:8px 13px;border-radius:4px;transition:all .15s;white-space:nowrap;border-bottom:2px solid transparent}
    .nav-btn:hover{color:#d4d0c8;background:#1e1e1e}
    .nav-btn.active{color:#d4d0c8;background:#252520;border-bottom:2px solid #c8b870}
    .tab-btn{background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;color:#555;font-family:inherit;font-size:12px;letter-spacing:.06em;padding:8px 14px;transition:all .15s;white-space:nowrap}
    .tab-btn:hover{color:#999}
    .tab-btn.active{color:#d4d0c8;border-bottom-color:#c8b870}
    .abtn{display:inline-flex;align-items:center;gap:6px;padding:7px 15px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:500;transition:all .15s}
    .abtn:hover{opacity:.85;transform:translateY(-1px)}
    .card{background:#141414;border:1px solid #222;border-radius:8px;padding:16px 20px;position:relative;overflow:hidden;transition:border-color .2s}
    .card:hover{border-color:#2e2e2e}
    .propcard{background:#141414;border:1px solid #222;border-radius:8px;padding:18px 20px;transition:all .2s;cursor:pointer}
    .propcard:hover{border-color:#3a3830;background:#181816}
    .propcard.selected{border-color:#c8b870;background:#1a1a14}
    .erow{background:#141414;border:1px solid #1e1e1e;border-radius:6px;padding:12px 16px;margin-bottom:7px;transition:all .15s}
    .erow:hover{border-color:#2e2e2e;background:#181818}
    .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:500}
    .fg{margin-bottom:15px}
    .fl{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#777;margin-bottom:5px}
    .fi{width:100%;background:#1a1a1a;border:1px solid #252525;border-radius:4px;padding:9px 12px;color:#d4d0c8;font-size:13px;transition:border-color .15s}
    .fi:focus{outline:none;border-color:#c8b870}
    .ttab{padding:7px 14px;border:1px solid #222;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.06em;background:#141414;color:#555;transition:all .15s}
    .ttab:hover{color:#999}
    .ttab.ae{background:#3a1a1a;border-color:#e05c5c;color:#ff8080}
    .ttab.ai{background:#1a243a;border-color:#5c9ee0;color:#80c0ff}
    .ttab.af{background:#1a3a2a;border-color:#5ce09e;color:#80ffb0}
    .fsel{background:#1a1a1a;border:1px solid #252525;border-radius:4px;padding:6px 10px;color:#d4d0c8;font-family:inherit;font-size:12px;cursor:pointer}
    .fsel:focus{outline:none;border-color:#c8b870}
    .dbtn{background:none;border:none;cursor:pointer;color:#444;font-size:15px;padding:2px 6px;border-radius:3px;transition:color .15s}
    .dbtn:hover{color:#e05c5c}
    .ebtn{background:none;border:none;cursor:pointer;color:#444;font-size:12px;padding:2px 7px;border-radius:3px;transition:color .15s;font-family:inherit;letter-spacing:.06em}
    .ebtn:hover{color:#c8b870}
    .rcell{background:#141414;border:1px solid #1e1e1e;border-radius:6px;padding:10px 8px;cursor:pointer;transition:all .15s;text-align:center}
    .rcell:hover{border-color:#333;background:#181818}
    .mbg{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
    .modal{background:#141414;border:1px solid #2a2a2a;border-radius:10px;padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto}
    .tsec{background:#141414;border:1px solid #1e1e1e;border-radius:8px;padding:16px;margin-bottom:12px}
    .trow{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #1a1a1a;font-size:13px}
    .trow:last-child{border-bottom:none}
    .prop-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;border:1px solid #2a2a2a;cursor:pointer;font-family:inherit;font-size:11px;letter-spacing:.06em;background:#141414;color:#666;transition:all .15s;white-space:nowrap}
    .prop-pill:hover{border-color:#3a3830;color:#999}
    .prop-pill.active{background:#252520;border-color:#c8b870;color:#c8b870}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes mIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
  `;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{fontFamily:"'DM Mono','Courier New',monospace",background:"#0e0e0e",height:"100vh",color:"#d4d0c8",display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>

      {/* Traffic light spacer */}
      <div className="titlebar"><span className="titlebar-title">PROPTRACK</span></div>

      {/* Nav */}
      <div style={{borderBottom:"1px solid #1a1a1a",padding:"0 20px",background:"#0e0e0e",flexShrink:0}}>
        <div style={{maxWidth:1060,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",height:46,gap:8}}>
          <nav style={{display:"flex",gap:1}}>
            {[
              {k:"dashboard",   l:"Overview"},
              {k:"properties",  l:"🏘 Properties"},
              {k:"log",         l:"Log"},
              {k:"tax",         l:"📋 Tax"},
            ].map(({k,l})=>(
              <button key={k} className={`nav-btn${view===k?" active":""}`} onClick={()=>setView(k)}>{l}</button>
            ))}
          </nav>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button className="abtn" onClick={()=>startNew()}
              style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30",fontSize:11,padding:"5px 13px"}}>
              + Add Entry
            </button>
            <button className="abtn"
              onClick={()=>exportCSV(entries,rentPayments,properties,activeProp,filterYear).catch(console.error)}
              style={{background:"#1a1a1a",color:"#555",border:"1px solid #222",fontSize:11,padding:"5px 11px"}}>
              ↓ CSV
            </button>
          </div>
        </div>
      </div>

      {/* Property pills */}
      {properties.length>0&&(
        <div style={{borderBottom:"1px solid #141414",padding:"8px 20px",background:"#0c0c0c",flexShrink:0,overflowX:"auto"}}>
          <div style={{maxWidth:1060,margin:"0 auto",display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:10,color:"#333",letterSpacing:".1em",marginRight:4,flexShrink:0}}>PROPERTY:</span>
            <button className={`prop-pill${activeProp==="all"?" active":""}`} onClick={()=>setActiveProp("all")}>All</button>
            {properties.map(p=>(
              <button key={p.id} className={`prop-pill${activeProp===p.id?" active":""}`} onClick={()=>setActiveProp(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scrollable body */}
      <div style={{flex:1,overflowY:"auto"}}>
        <div style={{maxWidth:1060,margin:"0 auto",padding:"22px 20px"}}>

          {/* ══ DASHBOARD ══ */}
          {view==="dashboard"&&(
            <div>
              <div style={{marginBottom:20,display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                <div>
                  <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,color:"#e8e4d8",marginBottom:3}}>
                    {activePropObj ? activePropObj.name : "All Properties"}
                  </h2>
                  <p style={{fontSize:12,color:"#444"}}>{entries.filter(e=>!pid||e.propertyId===pid).length} entries · {pending.length} pending · {curYear()}</p>
                </div>
                <div style={{display:"flex",gap:7}}>
                  <button className="abtn" onClick={()=>startNew("expense")}     style={{background:"#3a1a1a",color:"#ff8080",border:"1px solid #5a2a2a"}}>💸 Expense</button>
                  <button className="abtn" onClick={()=>startNew("improvement")} style={{background:"#1a243a",color:"#80c0ff",border:"1px solid #2a4060"}}>🔨 Improve</button>
                  <button className="abtn" onClick={()=>startNew("fix")}         style={{background:"#1a3a2a",color:"#80ffb0",border:"1px solid #2a6040"}}>🔧 Fix</button>
                </div>
              </div>

              {/* Stat cards */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:14}}>
                {[
                  {label:"💰 Rent Collected", value:fmt$(rentCollectedThisYear(activeProp)), sub:"this year (paid)", color:"#c8b870"},
                  ...Object.entries(TYPE_CONFIG).map(([t,c])=>({
                    label:`${c.icon} ${c.label}`, value:fmt$(totalByType(t,activeProp)),
                    sub:`${fmt$(thisYearByType(t,activeProp))} this yr`, color:c.light,
                  }))
                ].map((s,i)=>(
                  <div key={i} className="card" style={{borderTop:`2px solid ${s.color}`}}>
                    <div style={{fontSize:10,color:"#444",letterSpacing:".1em",textTransform:"uppercase",marginBottom:7}}>{s.label}</div>
                    <div style={{fontSize:19,fontWeight:500,color:s.color,fontFamily:"'Playfair Display',serif",marginBottom:3}}>{s.value}</div>
                    <div style={{fontSize:11,color:"#3a3a3a"}}>{s.sub}</div>
                  </div>
                ))}
              </div>

              {/* Net card */}
              <div className="card" style={{marginBottom:18,display:"flex",alignItems:"center",justifyContent:"space-between",gap:20,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:10,color:"#444",letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>All-Time Capital Out</div>
                  <div style={{fontSize:26,fontFamily:"'Playfair Display',serif",color:"#c8b870"}}>
                    {fmt$(totalByType("expense",activeProp)+totalByType("improvement",activeProp)+totalByType("fix",activeProp))}
                  </div>
                </div>
                <div>
                  <div style={{fontSize:10,color:"#444",letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>Net Income {curYear()}</div>
                  {(()=>{
                    const net=rentCollectedThisYear(activeProp)-thisYearByType("expense",activeProp)-thisYearByType("fix",activeProp);
                    return <div style={{fontSize:20,fontFamily:"'Playfair Display',serif",color:net>=0?"#5ce09e":"#ff8080"}}>{fmt$(net)}</div>;
                  })()}
                </div>
                {properties.length===0&&(
                  <button className="abtn" onClick={startNewProp} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>+ Add First Property</button>
                )}
              </div>

              {/* Pending */}
              {pending.length>0&&(<>
                <div style={{fontSize:11,color:"#666",letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>⏳ Pending / In Progress</div>
                {pending.map(e=><EntryRow key={e.id} entry={e} properties={properties} onEdit={startEdit} onDelete={deleteEntry} onReceipt={setReceiptModal}/>)}
                <div style={{marginBottom:16}}/>
              </>)}

              {/* Recent */}
              <div style={{fontSize:11,color:"#666",letterSpacing:".1em",textTransform:"uppercase",marginBottom:10}}>Recent Entries</div>
              {entries.filter(e=>!pid||e.propertyId===pid).slice(0,6).map(e=>(
                <EntryRow key={e.id} entry={e} properties={properties} onEdit={startEdit} onDelete={deleteEntry} onReceipt={setReceiptModal}/>
              ))}
              {entries.filter(e=>!pid||e.propertyId===pid).length===0&&(
                <div style={{padding:"28px",textAlign:"center",color:"#2a2a2a",fontSize:13,border:"1px dashed #1a1a1a",borderRadius:8}}>
                  {properties.length===0 ? "Add a property first, then start logging entries." : "No entries yet for this property."}
                </div>
              )}
            </div>
          )}

          {/* ══ PROPERTIES ══ */}
          {view==="properties"&&(
            <div>
              <div style={{marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,color:"#e8e4d8"}}>Properties</h2>
                <button className="abtn" onClick={startNewProp} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>+ Add Property</button>
              </div>

              {properties.length===0&&(
                <div style={{padding:"40px",textAlign:"center",color:"#2a2a2a",fontSize:13,border:"1px dashed #1a1a1a",borderRadius:8}}>
                  No properties yet. Add your first one above.
                </div>
              )}

              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:14}}>
                {properties.map(p=>{
                  const pe = propEntries(p.id);
                  const pr = propRent(p.id);
                  const tenant = tenants[p.id];
                  const ytdRent = pr.filter(r=>r.year===parseInt(curYear())&&r.status==="paid").reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0);
                  const ytdExp  = pe.filter(e=>e.date?.startsWith(curYear())&&e.status==="complete").reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
                  return (
                    <div key={p.id} className={`propcard${activeProp===p.id?" selected":""}`} onClick={()=>setActiveProp(p.id)}>
                      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12}}>
                        <div>
                          <div style={{fontSize:15,color:"#e8e4d8",fontWeight:500,marginBottom:2}}>{p.name}</div>
                          {p.address&&<div style={{fontSize:12,color:"#555"}}>{p.address}</div>}
                          <div style={{fontSize:10,color:"#3a3a3a",marginTop:3,letterSpacing:".06em",textTransform:"uppercase"}}>{p.type}</div>
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          <button className="ebtn" onClick={e=>{e.stopPropagation();startEditProp(p);}}>edit</button>
                          <button className="dbtn" onClick={e=>{e.stopPropagation();deleteProp(p.id);}}>×</button>
                        </div>
                      </div>

                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
                        <div style={{background:"#0e0e0e",borderRadius:5,padding:"8px 10px"}}>
                          <div style={{fontSize:10,color:"#444",letterSpacing:".08em",marginBottom:3}}>YTD RENT</div>
                          <div style={{fontSize:14,color:"#c8b870",fontFamily:"'Playfair Display',serif"}}>{fmt$(ytdRent)}</div>
                        </div>
                        <div style={{background:"#0e0e0e",borderRadius:5,padding:"8px 10px"}}>
                          <div style={{fontSize:10,color:"#444",letterSpacing:".08em",marginBottom:3}}>YTD COSTS</div>
                          <div style={{fontSize:14,color:"#ff8080",fontFamily:"'Playfair Display',serif"}}>{fmt$(ytdExp)}</div>
                        </div>
                        <div style={{background:"#0e0e0e",borderRadius:5,padding:"8px 10px"}}>
                          <div style={{fontSize:10,color:"#444",letterSpacing:".08em",marginBottom:3}}>ENTRIES</div>
                          <div style={{fontSize:14,color:"#d4d0c8",fontFamily:"'Playfair Display',serif"}}>{pe.length}</div>
                        </div>
                      </div>

                      {/* Tenant row */}
                      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingTop:10,borderTop:"1px solid #1a1a1a"}}>
                        {tenant?.name ? (
                          <div style={{fontSize:12,color:"#666"}}>
                            👤 {tenant.name}
                            {tenant.rentAmount&&<span style={{color:"#555",marginLeft:8}}>{fmt$(tenant.rentAmount)}/mo</span>}
                          </div>
                        ):(
                          <div style={{fontSize:12,color:"#2a2a2a"}}>No tenant on record</div>
                        )}
                        <div style={{display:"flex",gap:6}}>
                          <button className="ebtn" onClick={e=>{e.stopPropagation();setTenantForm(tenant||INITIAL_TENANT);setEditTenantFor(p.id);}}>
                            {tenant?"edit tenant":"+ tenant"}
                          </button>
                          <button className="ebtn" onClick={e=>{e.stopPropagation();openRentModal(p.id,parseInt(curYear()),curMon());}}>
                            log rent
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ══ LOG ══ */}
          {view==="log"&&(
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:12}}>
                <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,color:"#e8e4d8"}}>
                  Log{activePropObj?` — ${activePropObj.name}`:""}
                </h2>
                <button className="abtn" onClick={()=>startNew()} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>+ Add Entry</button>
              </div>

              {/* Log tabs */}
              <div style={{display:"flex",gap:0,borderBottom:"1px solid #1a1a1a",marginBottom:16,overflowX:"auto"}}>
                {LOG_TABS.map(t=>(
                  <button key={t.key} className={`tab-btn${logTab===t.key?" active":""}`} onClick={()=>setLogTab(t.key)}>{t.label}</button>
                ))}
              </div>

              {/* Filters */}
              {logTab!=="rent"&&(
                <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
                  <input className="fi" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:160,padding:"6px 11px"}}/>
                  <select className="fsel" value={filterYear} onChange={e=>setFilterYear(e.target.value)}>
                    <option value="all">All Years</option>
                    {allYears.map(y=><option key={y} value={y}>{y}</option>)}
                  </select>
                  <select className="fsel" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
                    <option value="all">All Status</option>
                    {Object.entries(STATUS_CONFIG).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                  </select>
                  <select className="fsel" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
                    <option value="date_desc">Newest</option>
                    <option value="date_asc">Oldest</option>
                    <option value="amount_desc">$ High→Low</option>
                    <option value="amount_asc">$ Low→High</option>
                  </select>
                  <span style={{fontSize:11,color:"#333",marginLeft:"auto"}}>
                    {filteredEntries.length} entries · {fmt$(filteredEntries.filter(e=>e.status==="complete").reduce((s,e)=>s+(parseFloat(e.amount)||0),0))}
                  </span>
                  <button className="abtn" onClick={()=>exportCSV(entries,rentPayments,properties,activeProp,filterYear).catch(console.error)}
                    style={{background:"#1a1a1a",color:"#555",border:"1px solid #222",fontSize:11,padding:"5px 10px"}}>↓ Export</button>
                </div>
              )}

              {/* Rent tab */}
              {logTab==="rent"&&(
                <RentLogView
                  properties={properties} rentPayments={filteredRent} tenants={tenants}
                  activeProp={activeProp} filterYear={filterYear} allYears={allYears}
                  setFilterYear={setFilterYear} onOpenRent={openRentModal}
                  fmt$={fmt$} fmtDate={fmtDate}
                />
              )}

              {/* Entry tabs */}
              {logTab!=="rent"&&(
                filteredEntries.length===0
                  ?<div style={{padding:"36px",textAlign:"center",color:"#2a2a2a",fontSize:13,border:"1px dashed #1a1a1a",borderRadius:8}}>No entries match your filters.</div>
                  :filteredEntries.map(e=><EntryRow key={e.id} entry={e} properties={properties} onEdit={startEdit} onDelete={deleteEntry} onReceipt={setReceiptModal}/>)
              )}
            </div>
          )}

          {/* ══ TAX ══ */}
          {view==="tax"&&(
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}>
                <div>
                  <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,color:"#e8e4d8",marginBottom:3}}>Tax Summary</h2>
                  <p style={{fontSize:12,color:"#444"}}>Schedule E — {activePropObj?.name||"All Properties"}</p>
                </div>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <select className="fsel" value={taxYear} onChange={e=>setTaxYear(e.target.value)}>
                    {(allYears.length?allYears:[curYear()]).map(y=><option key={y} value={y}>{y}</option>)}
                  </select>
                  <button className="abtn" onClick={()=>exportCSV(entries,rentPayments,properties,activeProp,taxYear).catch(console.error)}
                    style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>↓ Export {taxYear} CSV</button>
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
                {[
                  {l:"Gross Rent",       v:fmt$(taxData.totalRent),    c:"#c8b870"},
                  {l:"Expenses",         v:fmt$(taxData.totalExpenses), c:"#ff8080"},
                  {l:"Repairs",          v:fmt$(taxData.totalRepairs),  c:"#80ffb0"},
                  {l:"Net Income",       v:fmt$(taxData.netIncome),     c:taxData.netIncome>=0?"#5ce09e":"#ff8080"},
                ].map((s,i)=>(
                  <div key={i} className="card" style={{borderTop:`2px solid ${s.c}`}}>
                    <div style={{fontSize:10,color:"#444",letterSpacing:".1em",textTransform:"uppercase",marginBottom:7}}>{s.l}</div>
                    <div style={{fontSize:19,fontFamily:"'Playfair Display',serif",color:s.c}}>{s.v}</div>
                  </div>
                ))}
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[
                  {title:"💸 Operating Expenses", data:taxData.expensesByCategory, total:taxData.totalExpenses, color:"#ff8080"},
                  {title:"🔧 Repairs & Maintenance", data:taxData.repairsByCategory, total:taxData.totalRepairs, color:"#80ffb0"},
                  {title:"🔨 Capital Improvements", data:taxData.improvementsByCategory, total:taxData.totalImprovements, color:"#80c0ff", note:"depreciate 27.5 yrs"},
                ].map(({title,data,total,color,note})=>(
                  <div key={title} className="tsec">
                    <div style={{fontSize:11,color,letterSpacing:".1em",textTransform:"uppercase",marginBottom:11}}>
                      {title}{note&&<span style={{fontSize:9,color:"#333",marginLeft:6}}>({note})</span>}
                    </div>
                    {data.length===0?<div style={{fontSize:12,color:"#2a2a2a"}}>None this year</div>
                      :data.map(([cat,amt])=>(
                        <div key={cat} className="trow"><span style={{color:"#666"}}>{cat}</span><span style={{color}}>{fmt$(amt)}</span></div>
                      ))}
                    <div className="trow" style={{borderTop:"1px solid #252525",marginTop:7,paddingTop:7}}>
                      <span style={{color:"#d4d0c8",fontWeight:500}}>Total</span><span style={{color,fontWeight:500}}>{fmt$(total)}</span>
                    </div>
                  </div>
                ))}

                {/* Rent by month */}
                <div className="tsec">
                  <div style={{fontSize:11,color:"#c8b870",letterSpacing:".1em",textTransform:"uppercase",marginBottom:11}}>🏠 Rent — {taxYear}</div>
                  {MONTHS.map((mo,mi)=>{
                    const recs = rentPayments.filter(r=>r.year===parseInt(taxYear)&&r.month===mi&&(!pid||r.propertyId===pid));
                    if(!recs.length) return null;
                    return recs.map((rec,ri)=>{
                      const scfg=RENT_STATUS[rec.status]||RENT_STATUS.unpaid;
                      const pName=properties.find(p=>p.id===rec.propertyId)?.name||"";
                      return (
                        <div key={`${mi}-${ri}`} className="trow">
                          <span style={{color:"#666"}}>{mo}{!pid&&<span style={{color:"#333",fontSize:10,marginLeft:6}}>{pName}</span>}</span>
                          <div style={{display:"flex",alignItems:"center",gap:7}}>
                            <span className="badge" style={{background:scfg.bg,color:scfg.color,fontSize:9}}>{scfg.label}</span>
                            <span style={{color:"#c8b870"}}>{fmt$(rec.amountPaid||0)}</span>
                          </div>
                        </div>
                      );
                    });
                  })}
                  {rentPayments.filter(r=>r.year===parseInt(taxYear)&&(!pid||r.propertyId===pid)).length===0&&(
                    <div style={{fontSize:12,color:"#2a2a2a"}}>No rent records for {taxYear}</div>
                  )}
                  <div className="trow" style={{borderTop:"1px solid #252525",marginTop:7,paddingTop:7}}>
                    <span style={{color:"#d4d0c8",fontWeight:500}}>Total Collected</span>
                    <span style={{color:"#c8b870",fontWeight:500}}>{fmt$(taxData.totalRent)}</span>
                  </div>
                </div>
              </div>

              <div style={{background:"#141408",border:"1px solid #323218",borderRadius:6,padding:"12px 16px",marginTop:12,fontSize:12,color:"#666",lineHeight:1.7}}>
                <strong style={{color:"#c8b870"}}>Note:</strong> Expenses &amp; repairs are deductible the year paid (Schedule E). Capital improvements depreciate over 27.5 yrs. Export CSV to share with your CPA.
              </div>
            </div>
          )}

          {/* ══ ENTRY FORM ══ */}
          {view==="form"&&(
            <div style={{maxWidth:620}}>
              <div style={{marginBottom:20}}>
                <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:22,color:"#e8e4d8",marginBottom:3}}>{editId?"Edit Entry":"New Entry"}</h2>
              </div>

              <div className="fg">
                <label className="fl">Entry Type</label>
                <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                  {Object.entries(TYPE_CONFIG).map(([t,c])=>(
                    <button key={t} className={`ttab${form.type===t?` a${t[0]}`:""}`} onClick={()=>setForm(f=>({...f,type:t,category:""}))}>
                      {c.icon} {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Property *</label>
                  <select className="fi" value={form.propertyId} onChange={e=>setForm(f=>({...f,propertyId:e.target.value}))}>
                    <option value="">Select property…</option>
                    {properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
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
                  <label className="fl">📎 Receipt URL</label>
                  <input className="fi" placeholder="https://drive.google.com/…" value={form.receiptUrl} onChange={e=>setForm(f=>({...f,receiptUrl:e.target.value}))}/>
                </div>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Notes</label>
                  <textarea className="fi" rows={3} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} style={{resize:"vertical"}} placeholder="Details, warranty, follow-up…"/>
                </div>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button className="abtn" onClick={saveEntry} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>{editId?"Update":"Save Entry"}</button>
                <button className="abtn" onClick={()=>{setEditId(null);setView("log");}} style={{background:"#1a1a1a",color:"#444",border:"1px solid #222"}}>Cancel</button>
              </div>
            </div>
          )}

          {/* ══ PROPERTY FORM ══ */}
          {view==="propform"&&(
            <div style={{maxWidth:560}}>
              <div style={{marginBottom:20}}>
                <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:22,color:"#e8e4d8",marginBottom:3}}>{editPropId?"Edit Property":"New Property"}</h2>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Property Name *</label>
                  <input className="fi" placeholder="e.g. 123 Main St or 'The Duplex'" value={propForm.name} onChange={e=>setPropForm(f=>({...f,name:e.target.value}))}/>
                </div>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Address</label>
                  <input className="fi" placeholder="Full street address" value={propForm.address} onChange={e=>setPropForm(f=>({...f,address:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">Property Type</label>
                  <select className="fi" value={propForm.type} onChange={e=>setPropForm(f=>({...f,type:e.target.value}))}>
                    {["single-family","duplex","multi-family","condo","townhouse","commercial","other"].map(t=>(
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="fg">
                  <label className="fl">Purchase Date</label>
                  <input className="fi" type="date" value={propForm.purchaseDate} onChange={e=>setPropForm(f=>({...f,purchaseDate:e.target.value}))}/>
                </div>
                <div className="fg">
                  <label className="fl">Purchase Price ($)</label>
                  <input className="fi" type="number" placeholder="0.00" value={propForm.purchasePrice} onChange={e=>setPropForm(f=>({...f,purchasePrice:e.target.value}))}/>
                </div>
                <div className="fg" style={{gridColumn:"1 / -1"}}>
                  <label className="fl">Notes</label>
                  <textarea className="fi" rows={2} value={propForm.notes} onChange={e=>setPropForm(f=>({...f,notes:e.target.value}))} style={{resize:"vertical"}} placeholder="HOA info, key codes, anything useful…"/>
                </div>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button className="abtn" onClick={saveProp} style={{background:"#252520",color:"#c8b870",border:"1px solid #3a3a30"}}>{editPropId?"Update":"Add Property"}</button>
                <button className="abtn" onClick={()=>setView("properties")} style={{background:"#1a1a1a",color:"#444",border:"1px solid #222"}}>Cancel</button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ══ MODALS ══ */}

      {/* Rent record */}
      {rentModal&&(
        <div className="mbg" onClick={()=>setRentModal(null)}>
          <div className="modal" style={{animation:"mIn .2s ease"}} onClick={e=>e.stopPropagation()}>
            <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"#e8e4d8",marginBottom:3}}>
              {MONTHS[rentModal.month]} {rentModal.year}
            </h3>
            <p style={{fontSize:12,color:"#444",marginBottom:16}}>
              {properties.find(p=>p.id===rentModal.propId)?.name||""}
            </p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
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
              <button className="abtn" onClick={()=>setRentModal(null)} style={{background:"#1a1a1a",color:"#444",border:"1px solid #222"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Tenant */}
      {editTenantFor&&(
        <div className="mbg" onClick={()=>setEditTenantFor(null)}>
          <div className="modal" style={{animation:"mIn .2s ease"}} onClick={e=>e.stopPropagation()}>
            <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:18,color:"#e8e4d8",marginBottom:16}}>
              Tenant — {properties.find(p=>p.id===editTenantFor)?.name}
            </h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
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
              <button className="abtn" onClick={()=>setEditTenantFor(null)} style={{background:"#1a1a1a",color:"#444",border:"1px solid #222"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt */}
      {receiptModal&&(
        <div className="mbg" onClick={()=>setReceiptModal(null)}>
          <div className="modal" style={{animation:"mIn .2s ease",maxWidth:560}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <h3 style={{fontFamily:"'Playfair Display',serif",fontSize:16,color:"#e8e4d8"}}>{receiptModal.title}</h3>
              <button className="dbtn" onClick={()=>setReceiptModal(null)}>×</button>
            </div>
            {receiptModal.receiptUrl?(<>
              <div style={{fontSize:11,color:"#444",marginBottom:10,wordBreak:"break-all"}}>
                <a href={receiptModal.receiptUrl} target="_blank" rel="noreferrer" style={{color:"#80c0ff"}}>{receiptModal.receiptUrl}</a>
              </div>
              <img src={receiptModal.receiptUrl} alt="Receipt" style={{maxWidth:"100%",borderRadius:6,border:"1px solid #252525"}}
                onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="block";}}/>
              <div style={{display:"none",padding:"20px",background:"#1a1a1a",borderRadius:6,fontSize:12,color:"#444",textAlign:"center"}}>
                Could not load image. <a href={receiptModal.receiptUrl} target="_blank" rel="noreferrer" style={{color:"#80c0ff"}}>Open link →</a>
              </div>
            </>):(
              <div style={{padding:"24px",textAlign:"center",color:"#2a2a2a",fontSize:12,border:"1px dashed #1a1a1a",borderRadius:6}}>No receipt URL attached.</div>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      {toast&&(
        <div style={{position:"fixed",bottom:20,right:20,background:toast.type==="error"?"#3a1a1a":"#1a3a2a",border:`1px solid ${toast.type==="error"?"#6a2a2a":"#2a6a4a"}`,color:toast.type==="error"?"#ff8080":"#80ffb0",padding:"9px 16px",borderRadius:6,fontSize:13,fontFamily:"inherit",letterSpacing:".04em",zIndex:9999,animation:"fadeUp .2s ease"}}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EntryRow({ entry, properties, onEdit, onDelete, onReceipt }) {
  const cfg  = TYPE_CONFIG[entry.type]    || TYPE_CONFIG.expense;
  const scfg = STATUS_CONFIG[entry.status]|| STATUS_CONFIG.complete;
  const prop = properties.find(p=>p.id===entry.propertyId);
  return (
    <div className="erow" style={{display:"flex",alignItems:"center",gap:11}}>
      <span style={{fontSize:16,flexShrink:0}}>{cfg.icon}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
          <span style={{fontWeight:500,color:"#d4d0c8",fontSize:14}}>{entry.title}</span>
          {entry.category&&<span className="badge" style={{background:cfg.bg,color:cfg.light}}>{entry.category}</span>}
          <span className="badge" style={{background:"#1a1a1a",color:scfg.color}}>{scfg.label}</span>
          {prop&&<span style={{fontSize:10,color:"#3a3a3a",letterSpacing:".04em"}}>· {prop.name}</span>}
          {entry.receiptUrl&&(
            <button onClick={()=>onReceipt(entry)} style={{background:"none",border:"1px solid #1e3040",borderRadius:3,cursor:"pointer",color:"#80c0ff",fontSize:10,padding:"1px 6px",fontFamily:"inherit"}}>🖼 receipt</button>
          )}
        </div>
        <div style={{fontSize:11,color:"#3a3a3a",display:"flex",gap:10,flexWrap:"wrap"}}>
          <span>{entry.date ? (()=>{const [y,m,d]=entry.date.split("-");return `${m}/${d}/${y}`;})() : "—"}</span>
          {entry.vendor&&<span>📍 {entry.vendor}</span>}
          {entry.receipt&&<span>🧾 {entry.receipt}</span>}
          {entry.description&&<span style={{maxWidth:280,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.description}</span>}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
        {entry.amount&&<span style={{fontSize:14,fontWeight:500,color:cfg.light,fontFamily:"'Playfair Display',serif"}}>${Number(entry.amount).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>}
        <button className="ebtn" onClick={()=>onEdit(entry)}>edit</button>
        <button className="dbtn" onClick={()=>onDelete(entry.id)}>×</button>
      </div>
    </div>
  );
}

function RentLogView({ properties, rentPayments, tenants, activeProp, filterYear, allYears, setFilterYear, onOpenRent, fmt$, fmtDate }) {
  const pid = activeProp==="all" ? null : activeProp;
  const showProps = pid ? properties.filter(p=>p.id===pid) : properties;
  const yr = filterYear==="all" ? null : parseInt(filterYear);
  const displayYears = yr ? [yr] : [parseInt(new Date().getFullYear()), parseInt(new Date().getFullYear())-1];

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center"}}>
        <select className="fsel" value={filterYear} onChange={e=>setFilterYear(e.target.value)}>
          <option value="all">Recent (2 yrs)</option>
          {allYears.map(y=><option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {showProps.length===0&&(
        <div style={{padding:"36px",textAlign:"center",color:"#2a2a2a",fontSize:13,border:"1px dashed #1a1a1a",borderRadius:8}}>No properties found.</div>
      )}

      {showProps.map(prop=>{
        const tenant = tenants[prop.id];
        return displayYears.map(yrInt=>{
          const collected = rentPayments.filter(r=>r.propertyId===prop.id&&r.year===yrInt&&r.status==="paid").reduce((s,r)=>s+(parseFloat(r.amountPaid)||0),0);
          const paidCount = rentPayments.filter(r=>r.propertyId===prop.id&&r.year===yrInt&&r.status==="paid").length;
          return (
            <div key={`${prop.id}-${yrInt}`} style={{marginBottom:24}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:13,color:"#e8e4d8",fontWeight:500}}>{prop.name}</span>
                  <span style={{fontSize:12,color:"#c8b870"}}>{yrInt}</span>
                </div>
                <span style={{fontSize:11,color:"#444"}}>{paidCount}/12 paid · {fmt$(collected)}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:7}}>
                {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((mo,mi)=>{
                  const rec = rentPayments.find(r=>r.propertyId===prop.id&&r.year===yrInt&&r.month===mi);
                  const scfg = rec ? RENT_STATUS[rec.status]||RENT_STATUS.unpaid : null;
                  const isFuture = yrInt===new Date().getFullYear()&&mi>new Date().getMonth();
                  return (
                    <div key={mi} className="rcell"
                      style={{opacity:isFuture?.4:1,borderColor:scfg?scfg.color+"44":"#1e1e1e"}}
                      onClick={()=>!isFuture&&onOpenRent(prop.id,yrInt,mi)}>
                      <div style={{fontSize:10,color:"#444",letterSpacing:".04em",marginBottom:4}}>{mo}</div>
                      {rec?(<>
                        <div style={{fontSize:11,color:scfg?.color,fontWeight:500}}>{fmt$(rec.amountPaid||rec.amountDue)}</div>
                        <div className="badge" style={{background:scfg?.bg,color:scfg?.color,marginTop:3,fontSize:8}}>{scfg?.label}</div>
                      </>):(
                        <div style={{fontSize:10,color:"#222",marginTop:3}}>{isFuture?"–":"+ log"}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        });
      })}
    </div>
  );
}
