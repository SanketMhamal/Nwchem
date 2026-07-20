/* NWChem Studio frontend */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  jobs: [],
  currentJob: null,   // job id
  logOffset: 0,
  pollTimer: null,
  settings: null,
};

async function rawFetch(method, url, body) {
  return fetch(url, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function authFetch(method, url, body) {
  let r = await rawFetch(method, url, body);
  if (r.status === 401 && url !== "/api/login") {
    const pw = prompt("This NWChem Studio instance is password-protected.\nPassword:");
    if (pw !== null) {
      const lr = await rawFetch("POST", "/api/login", { password: pw });
      if (lr.ok) r = await rawFetch(method, url, body);
    }
  }
  return r;
}
const api = {
  async get(url) { const r = await authFetch("GET", url); if (!r.ok) throw await err(r); return r.json(); },
  async send(method, url, body) {
    const r = await authFetch(method, url, body);
    if (!r.ok) throw await err(r);
    return r.json();
  },
};
async function err(r) {
  let msg = r.statusText;
  try { msg = (await r.json()).detail || msg; } catch (e) { /* ignore */ }
  return new Error(msg);
}

/* ---------- views ---------- */
function showView(name) {
  $$(".view").forEach(v => (v.hidden = true));
  $("#view-" + name).hidden = false;
}

/* ---------- docker status ---------- */
async function refreshStatus() {
  try {
    const s = await api.get("/api/status");
    state.settings = s.settings;
    const b = $("#docker-badge");
    if (s.mode === "local") {
      b.textContent = "● NWChem ready (built-in)";
      b.className = "badge ok";
      $("#welcome-docker").textContent = "NWChem is installed in this environment — you can run jobs directly.";
    } else if (s.docker.running) {
      b.textContent = "● Docker ready (" + (s.docker.version || "?") + ")";
      b.className = "badge ok";
      $("#welcome-docker").textContent = "Docker is running — you can execute NWChem jobs.";
    } else if (s.docker.installed) {
      b.textContent = "● Docker installed but not running";
      b.className = "badge bad";
      $("#welcome-docker").textContent = "Docker is installed but the engine is not running. Start Docker Desktop to run jobs.";
    } else {
      b.textContent = "● Docker not installed";
      b.className = "badge bad";
      $("#welcome-docker").textContent =
        "Docker Desktop is not installed, so jobs cannot run yet. You can still build inputs and visualize existing output files. " +
        "Install Docker Desktop (with WSL2) and the app will pick it up automatically.";
    }
  } catch (e) { console.error(e); }
}

/* ---------- job list ---------- */
async function refreshJobs() {
  state.jobs = await api.get("/api/jobs");
  const list = $("#job-list");
  list.innerHTML = "";
  for (const j of state.jobs) {
    const div = document.createElement("div");
    div.className = "job-item" + (j.id === state.currentJob ? " active" : "");
    div.innerHTML = `<span class="nm"></span><span class="st ${j.status}"></span>`;
    $(".nm", div).textContent = j.name;
    $(".st", div).textContent = j.status;
    div.onclick = () => openJob(j.id);
    list.appendChild(div);
  }
}

/* ---------- input generation ---------- */
function parseXYZText(text) {
  const atoms = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([A-Za-z]{1,2})\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)$/);
    if (m) atoms.push({ el: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), x: +m[2], y: +m[3], z: +m[4] });
  }
  return atoms;
}
function atomsToXYZ(atoms, comment = "") {
  return atoms.length + "\n" + comment + "\n" +
    atoms.map(a => `${a.el} ${a.x.toFixed(6)} ${a.y.toFixed(6)} ${a.z.toFixed(6)}`).join("\n");
}

/* ---------- bond-order perception ----------
   3Dmol.js only draws single bonds from XYZ coordinates. To show double/triple
   bonds (e.g. acetone's C=O) we perceive connectivity from covalent radii and
   assign orders from element-pair reference bond lengths, then satisfy valence.
   The structure is emitted as a MOL (V2000) block, which carries bond orders. */
const COVRAD = { H:0.31, B:0.84, C:0.76, N:0.71, O:0.66, F:0.57, Si:1.11, P:1.07,
  S:1.05, Cl:1.02, Br:1.20, I:1.39, Li:1.28, Na:1.66, Mg:1.41, Al:1.21,
  K:2.03, Ca:1.76, Fe:1.32, Zn:1.22, Se:1.20 };
// typical neutral valence — used to decide how many pi bonds an atom wants
const VALENCE = { H:1, B:3, C:4, N:3, O:2, F:1, Si:4, P:3, S:2, Cl:1, Br:1, I:1, Se:2, B:3 };

/* Perceive connectivity and bond orders from 3D coordinates.
   Step 1: bonds by covalent radii. Step 2: each heavy atom "wants" pi bonds
   equal to (valence - number of neighbours). Step 3: greedy shortest-first
   matching promotes bonds between two atoms that both still want pi electrons.
   This yields carbonyl C=O, alkyne/N2 triples, CO2, and a proper alternating
   Kekulé structure for aromatic rings (resonance shown as one resonance form). */
function perceiveBonds(atoms) {
  const bonds = [];
  const deg = atoms.map(() => 0);
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i], b = atoms[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const cut = (COVRAD[a.el] || 0.77) + (COVRAD[b.el] || 0.77) + 0.45;
      if (d > 0.4 && d <= cut) { bonds.push({ i, j, d, order: 1 }); deg[i]++; deg[j]++; }
    }
  }
  const need = atoms.map((a, i) => a.el === "H" ? 0
    : Math.max(0, (VALENCE[a.el] || deg[i]) - deg[i]));
  // candidate pi bonds: both endpoints heavy and still wanting electrons
  const cands = bonds.filter(b => atoms[b.i].el !== "H" && atoms[b.j].el !== "H");
  const availFor = i => cands.filter(b =>
    (b.i === i || b.j === i) && b.order < 3 && need[b.i] > 0 && need[b.j] > 0);
  // most-constrained-first matching: repeatedly satisfy the atom with the
  // fewest available partners (greedy shortest-first mis-solves symmetric rings)
  let guard = 0;
  while (guard++ < 1000) {
    let pick = -1, fewest = Infinity;
    for (let i = 0; i < atoms.length; i++) {
      if (need[i] <= 0) continue;
      const n = availFor(i).length;
      if (n > 0 && n < fewest) { fewest = n; pick = i; }
    }
    if (pick < 0) break;
    const b = availFor(pick).sort((p, q) => p.d - q.d)[0];
    b.order++; need[b.i]--; need[b.j]--;
  }
  return bonds;
}

function atomsToMol(atoms, comment = "") {
  const bonds = perceiveBonds(atoms);
  const pad = (s, n) => String(s).padStart(n);
  const f = v => v.toFixed(4).padStart(10);
  let s = "\n  NWStudio          3D\n" + comment + "\n";
  s += pad(atoms.length, 3) + pad(bonds.length, 3) + "  0  0  0  0  0  0  0  0999 V2000\n";
  for (const a of atoms) s += f(a.x) + f(a.y) + f(a.z) + " " + (a.el + "  ").slice(0, 3) + " 0  0  0  0  0  0  0  0  0  0  0  0\n";
  for (const b of bonds) s += pad(b.i + 1, 3) + pad(b.j + 1, 3) + pad(b.order, 3) + "  0\n";
  s += "M  END\n";
  return s;
}

function generateInput() {
  const name = $("#nj-name").value.trim() || "job";
  const atoms = parseXYZText($("#nj-geom").value);
  const charge = +$("#nj-charge").value || 0;
  const mult = +$("#nj-mult").value || 1;
  const theory = $("#nj-theory").value;
  const xc = $("#nj-xc").value;
  const basis = $("#nj-basis").value;
  const task = $("#nj-task").value;

  let s = "echo\n";
  s += `start ${name.replace(/[^A-Za-z0-9_-]/g, "_")}\n`;
  s += `title "${name}"\n`;
  s += `charge ${charge}\n\n`;
  s += "geometry units angstroms noautosym\n";
  for (const a of atoms) s += ` ${a.el.padEnd(2)} ${a.x.toFixed(6).padStart(12)} ${a.y.toFixed(6).padStart(12)} ${a.z.toFixed(6).padStart(12)}\n`;
  s += "end\n\n";
  s += `basis\n * library ${basis}\nend\n\n`;

  let module = "scf";
  if (theory === "dft") {
    module = "dft";
    s += `dft\n xc ${xc}\n mult ${mult}\nend\n\n`;
  } else if (theory === "scf") {
    if (mult > 1) s += `scf\n ${mult === 2 ? "doublet" : mult === 3 ? "triplet" : "nopen " + (mult - 1)}\n uhf\nend\n\n`;
  } else if (theory === "mp2") {
    module = "mp2";
    if (mult > 1) s += `scf\n uhf\n ${mult === 2 ? "doublet" : "nopen " + (mult - 1)}\nend\n\n`;
  }

  if (task === "energy") s += `task ${module} energy\n`;
  else if (task === "optimize") s += `task ${module} optimize\n`;
  else if (task === "freq") s += `task ${module} freq\n`;
  else if (task === "optfreq") s += `task ${module} optimize\ntask ${module} freq\n`;
  return s;
}

let njViewer = null;
function updateNewJobPreview() {
  $("#nj-preview").textContent = generateInput();
  const atoms = parseXYZText($("#nj-geom").value);
  if (!njViewer) {
    njViewer = $3Dmol.createViewer($("#nj-viewer"), { backgroundColor: "#10161d" });
  }
  njViewer.removeAllModels();
  if (atoms.length) {
    njViewer.addModel(atomsToMol(atoms), "mol");
    njViewer.setStyle({}, { stick: { radius: 0.12 }, sphere: { scale: 0.28 } });
    njViewer.zoomTo();
  }
  njViewer.render();
}

/* ---------- job view ---------- */
async function openJob(id) {
  stopPolling();
  state.currentJob = id;
  const j = await api.get("/api/jobs/" + id);
  $("#job-title").textContent = j.name;
  setStatus(j.status);
  $("#job-input").value = j.input;
  $("#job-log").textContent = "";
  state.logOffset = 0;
  $("#results-root").innerHTML = "";
  showView("job");
  selectTab(j.status === "new" ? "input" : (j.status === "running" ? "log" : "results"));
  refreshJobs();
  await pullLog();
  if (j.status === "running") startPolling();
  if (j.status === "done" || j.status === "failed") loadResults();
}

function setStatus(st) {
  const el = $("#job-status");
  el.textContent = st;
  el.className = "status " + st;
  $("#btn-run").hidden = st === "running";
  $("#btn-cancel").hidden = st !== "running";
}

function selectTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  ["input", "log", "results"].forEach(n => ($("#tab-" + n).hidden = n !== name));
}

async function pullLog() {
  if (!state.currentJob) return null;
  const r = await api.get(`/api/jobs/${state.currentJob}/log?offset=${state.logOffset}`);
  if (r.text) {
    const el = $("#job-log");
    el.textContent += r.text;
    el.scrollTop = el.scrollHeight;
  }
  state.logOffset = r.offset;
  return r.status;
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const st = await pullLog();
      if (st && st !== "running") {
        stopPolling();
        setStatus(st);
        refreshJobs();
        loadResults();
        selectTab("results");
      }
    } catch (e) { /* transient */ }
  }, 1500);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function loadResults() {
  try {
    const r = await api.get(`/api/jobs/${state.currentJob}/results`);
    renderResults($("#results-root"), r);
  } catch (e) {
    $("#results-root").innerHTML = "<p>No parsable results yet.</p>";
  }
}

/* ---------- results rendering ---------- */
function renderResults(root, r) {
  root.innerHTML = "";
  if (r.error) {
    const d = document.createElement("div");
    d.className = "error-banner";
    d.textContent = "NWChem reported an error: " + r.error;
    root.appendChild(d);
  }
  if (!r.n_geometries) {
    const p = document.createElement("p");
    p.textContent = "No geometries found in the output.";
    root.appendChild(p);
    return;
  }
  const node = $("#tpl-results").content.cloneNode(true);
  root.appendChild(node);

  const viewerDiv = $(".r-viewer", root);
  const viewer = $3Dmol.createViewer(viewerDiv, { backgroundColor: "#10161d" });
  const styleSel = $(".style-select", root);
  const labelsChk = $(".labels-chk", root);
  let vibrating = false;

  const styles = {
    ballstick: { stick: { radius: 0.12 }, sphere: { scale: 0.28 } },
    stick: { stick: { radius: 0.15 } },
    sphere: { sphere: { scale: 0.9 } },
    line: { line: {} },
  };
  function applyStyle() {
    viewer.setStyle({}, styles[styleSel.value]);
    viewer.removeAllLabels();
    if (labelsChk.checked) {
      viewer.getModel().selectedAtoms({}).forEach(a => {
        viewer.addLabel(a.elem, {
          position: { x: a.x, y: a.y, z: a.z },
          fontSize: 11, backgroundOpacity: 0, fontColor: "#dbe4ee", inFront: true,
        });
      });
    }
    viewer.render();
  }

  function showStatic(xyz) {
    vibrating = false;
    viewer.stopAnimate();
    viewer.removeAllModels();
    // perceive bond orders so double/triple bonds render (3Dmol XYZ = single only)
    viewer.addModel(atomsToMol(parseXYZText(xyz)), "mol");
    applyStyle();
    viewer.zoomTo();
    viewer.render();
  }
  showStatic(r.final_xyz);

  // trajectory
  const slider = $(".traj-slider", root);
  const playBtn = $(".traj-play", root);
  const geomInfo = $(".geom-info", root);
  const frames = r.trajectory_xyz.split(/\n(?=\d+\n)/);
  slider.max = r.n_geometries - 1;
  slider.value = r.n_geometries - 1;
  geomInfo.textContent = r.n_geometries > 1 ? `(${r.n_geometries} frames)` : "";
  if (r.n_geometries <= 1) { slider.parentElement.style.display = "none"; playBtn.style.display = "none"; }
  slider.oninput = () => showStatic(frames[+slider.value]);
  let playing = null;
  playBtn.onclick = () => {
    if (playing) { clearInterval(playing); playing = null; playBtn.textContent = "▶ Play trajectory"; return; }
    playBtn.textContent = "■ Stop";
    let f = 0;
    playing = setInterval(() => {
      slider.value = f;
      showStatic(frames[f]);
      f = (f + 1) % frames.length;
    }, 350);
  };
  styleSel.onchange = applyStyle;
  labelsChk.onchange = applyStyle;

  // summary cards
  const cards = $(".summary-cards", root);
  function card(k, v, cls = "") {
    const d = document.createElement("div");
    d.className = "card";
    d.innerHTML = `<div class="k"></div><div class="v ${cls}"></div>`;
    $(".k", d).textContent = k;
    $(".v", d).textContent = v;
    cards.appendChild(d);
  }
  if (r.energies.length) {
    const last = r.energies[r.energies.length - 1];
    card("Final " + last.method + " energy", last.energy.toFixed(8) + " Ha");
  }
  if (r.opt_steps.length) {
    card("Optimization", r.converged ? "converged" : "not converged", r.converged ? "good" : "bad");
    card("Steps", String(r.opt_steps.length));
  }
  if ("dipole_au" in r) card("Dipole", (r.dipole_au * 2.5417464).toFixed(3) + " D");
  if (r.frequencies.length) {
    const nImag = r.frequencies.filter(f => f < -1).length;
    card("Imaginary freqs", String(nImag), nImag ? "bad" : "good");
  }

  // energy chart
  if (r.opt_steps.length > 1) {
    $(".energy-title", root).hidden = false;
    const canvas = $(".energy-chart", root);
    canvas.hidden = false;
    new Chart(canvas, {
      type: "line",
      data: {
        labels: r.opt_steps.map(s => s.step),
        datasets: [{
          label: "Energy (Ha)", data: r.opt_steps.map(s => s.energy),
          borderColor: "#4da3ff", backgroundColor: "rgba(77,163,255,.15)",
          tension: 0.25, fill: true, pointRadius: 3,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: "step" }, grid: { color: "#2b3644" }, ticks: { color: "#8496a9" } },
          y: { grid: { color: "#2b3644" }, ticks: { color: "#8496a9" } },
        },
      },
    });
  }

  // frequencies
  if (r.frequencies.length) {
    $(".freq-title", root).hidden = false;
    const list = $(".freq-list", root);
    r.frequencies.forEach((f, idx) => {
      const chip = document.createElement("span");
      chip.className = "freq-chip" + (f < -1 ? " imag" : "");
      chip.textContent = f.toFixed(1) + " cm⁻¹";
      chip.onclick = () => {
        if (chip.classList.contains("active")) {
          $$(".freq-chip", list).forEach(c => c.classList.remove("active"));
          showStatic(r.final_xyz);
          return;
        }
        $$(".freq-chip", list).forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        const xyz = r.modes_xyz[idx];
        if (!xyz) return;
        vibrating = true;
        viewer.stopAnimate();
        viewer.removeAllModels();
        viewer.addModel(xyz, "xyz");
        applyStyle();
        viewer.vibrate(12, 0.6, true);
        viewer.animate({ loop: "backAndForth", interval: 40 });
        viewer.zoomTo();
        viewer.render();
      };
      list.appendChild(chip);
    });
  }
}

/* ---------- events ---------- */
$("#btn-new").onclick = () => { showView("new"); updateNewJobPreview(); };
["nj-name", "nj-geom", "nj-charge", "nj-mult", "nj-theory", "nj-xc", "nj-basis", "nj-task"]
  .forEach(id => ($("#" + id).oninput = updateNewJobPreview));

$("#nj-create").onclick = async () => {
  const atoms = parseXYZText($("#nj-geom").value);
  if (!atoms.length) { alert("No valid atoms in the geometry box."); return; }
  const j = await api.send("POST", "/api/jobs", { name: $("#nj-name").value, input: generateInput() });
  await refreshJobs();
  openJob(j.id);
};

$("#btn-run").onclick = async () => {
  try {
    await api.send("PUT", `/api/jobs/${state.currentJob}/input`, { input: $("#job-input").value });
    const j = await api.send("POST", `/api/jobs/${state.currentJob}/run`);
    setStatus(j.status);
    $("#job-log").textContent = "";
    state.logOffset = 0;
    selectTab("log");
    refreshJobs();
    startPolling();
  } catch (e) { alert(e.message); }
};
$("#btn-cancel").onclick = async () => {
  const j = await api.send("POST", `/api/jobs/${state.currentJob}/cancel`);
  setStatus(j.status);
  stopPolling();
  refreshJobs();
};
$("#btn-delete").onclick = async () => {
  if (!confirm("Delete this job and its files?")) return;
  await api.send("DELETE", `/api/jobs/${state.currentJob}`);
  state.currentJob = null;
  showView("welcome");
  refreshJobs();
};
$("#btn-save-input").onclick = async () => {
  try {
    await api.send("PUT", `/api/jobs/${state.currentJob}/input`, { input: $("#job-input").value });
    $("#btn-save-input").textContent = "Saved ✓";
    setTimeout(() => ($("#btn-save-input").textContent = "Save input"), 1200);
  } catch (e) { alert(e.message); }
};
$$(".tab").forEach(t => (t.onclick = () => selectTab(t.dataset.tab)));

$("#file-open").onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const text = await file.text();
  // .nw input file? just show the geometry; .out → full parse
  const r = await api.send("POST", "/api/parse", { text });
  $("#file-title").textContent = file.name;
  showView("file");
  if (!r.n_geometries) {
    // maybe it's a plain XYZ file
    const atoms = parseXYZText(text);
    if (atoms.length) {
      r.n_geometries = 1;
      r.final_xyz = atomsToXYZ(atoms, file.name);
      r.trajectory_xyz = r.final_xyz;
    }
  }
  renderResults($("#file-results"), r);
  ev.target.value = "";
};

/* help */
$("#btn-help").onclick = () => $("#dlg-help").showModal();
$("#help-close").onclick = () => $("#dlg-help").close();

/* settings */
$("#btn-settings").onclick = () => {
  $("#set-image").value = state.settings?.docker_image || "";
  $("#set-shm").value = state.settings?.shm_size || "1g";
  $("#dlg-settings").showModal();
};
$("#set-cancel").onclick = () => $("#dlg-settings").close();
$("#set-save").onclick = async () => {
  state.settings = await api.send("PUT", "/api/settings", {
    docker_image: $("#set-image").value.trim(),
    shm_size: $("#set-shm").value.trim() || "1g",
  });
  $("#dlg-settings").close();
};

/* ---------- init ---------- */
refreshStatus();
refreshJobs();
setInterval(refreshStatus, 15000);
