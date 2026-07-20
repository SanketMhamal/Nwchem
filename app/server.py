"""NWChem Studio backend.

Manages NWChem jobs: each job lives in jobs/<id>/ with input.nw,
output.out and meta.json. Jobs run through the official NWChem
Docker image; results are parsed with nwparse.
"""

import json
import os
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import nwparse

ROOT = Path(__file__).resolve().parent.parent
JOBS_DIR = ROOT / "jobs"
SETTINGS_FILE = ROOT / "settings.json"
STATIC_DIR = Path(__file__).resolve().parent / "static"

DEFAULT_SETTINGS = {"docker_image": "ghcr.io/nwchemgit/nwchem-dev/amd64", "shm_size": "1g"}

# Optional deployment hardening (set on Render): password gate + job time limit.
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
MAX_JOB_SECONDS = int(os.environ.get("MAX_JOB_SECONDS", "0") or 0)

app = FastAPI(title="NWChem Studio")
_processes = {}  # job_id -> Popen
_lock = threading.Lock()

# /api/status stays open so Render's health check works; /api/login must be open.
_AUTH_EXEMPT = {"/api/login", "/api/status"}


@app.middleware("http")
async def auth_middleware(request, call_next):
    path = request.url.path
    if APP_PASSWORD and path.startswith("/api") and path not in _AUTH_EXEMPT:
        if not secrets.compare_digest(request.cookies.get("nwstudio_key", ""), APP_PASSWORD):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


def load_settings():
    if SETTINGS_FILE.exists():
        try:
            return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_FILE.read_text())}
        except (json.JSONDecodeError, OSError):
            pass
    return dict(DEFAULT_SETTINGS)


def save_settings(s):
    SETTINGS_FILE.write_text(json.dumps(s, indent=2))


def exec_mode():
    """'local' if an nwchem binary is on PATH (Render/container deploy),
    'docker' if the Docker engine is running, else None."""
    if shutil.which("nwchem"):
        return "local"
    if docker_available().get("running"):
        return "docker"
    return None


def docker_available():
    if shutil.which("docker") is None:
        return {"installed": False, "running": False}
    try:
        r = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                           capture_output=True, text=True, timeout=10)
        return {"installed": True, "running": r.returncode == 0,
                "version": r.stdout.strip() if r.returncode == 0 else None}
    except (subprocess.TimeoutExpired, OSError):
        return {"installed": True, "running": False}


def job_dir(job_id):
    d = JOBS_DIR / job_id
    if not d.is_dir():
        raise HTTPException(404, "job not found")
    return d


def read_meta(d):
    f = d / "meta.json"
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            pass
    return {}


def write_meta(d, meta):
    (d / "meta.json").write_text(json.dumps(meta, indent=2))


class NewJob(BaseModel):
    name: str
    input: str


class InputUpdate(BaseModel):
    input: str


class ParseRequest(BaseModel):
    text: str


class SettingsUpdate(BaseModel):
    docker_image: str
    shm_size: str = "1g"


class Login(BaseModel):
    password: str


@app.post("/api/login")
def login(body: Login):
    if APP_PASSWORD and not secrets.compare_digest(body.password, APP_PASSWORD):
        raise HTTPException(401, "wrong password")
    resp = JSONResponse({"ok": True})
    if APP_PASSWORD:
        resp.set_cookie("nwstudio_key", APP_PASSWORD, httponly=True,
                        max_age=30 * 24 * 3600, samesite="strict")
    return resp


@app.get("/api/status")
def api_status():
    return {"mode": exec_mode(), "docker": docker_available(),
            "settings": load_settings(), "auth": bool(APP_PASSWORD)}


@app.put("/api/settings")
def api_settings(s: SettingsUpdate):
    save_settings({"docker_image": s.docker_image, "shm_size": s.shm_size})
    return load_settings()


@app.get("/api/jobs")
def list_jobs():
    JOBS_DIR.mkdir(exist_ok=True)
    jobs = []
    for d in JOBS_DIR.iterdir():
        if d.is_dir() and (d / "meta.json").exists():
            jobs.append(read_meta(d))
    jobs.sort(key=lambda j: j.get("created", 0), reverse=True)
    return jobs


@app.post("/api/jobs")
def create_job(body: NewJob):
    JOBS_DIR.mkdir(exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    d = JOBS_DIR / job_id
    d.mkdir()
    (d / "input.nw").write_text(body.input, newline="\n")
    meta = {"id": job_id, "name": body.name.strip() or "untitled",
            "status": "new", "created": time.time()}
    write_meta(d, meta)
    return meta


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    d = job_dir(job_id)
    meta = read_meta(d)
    meta["input"] = (d / "input.nw").read_text() if (d / "input.nw").exists() else ""
    return meta


@app.put("/api/jobs/{job_id}/input")
def update_input(job_id: str, body: InputUpdate):
    d = job_dir(job_id)
    meta = read_meta(d)
    if meta.get("status") == "running":
        raise HTTPException(409, "job is running")
    (d / "input.nw").write_text(body.input, newline="\n")
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    d = job_dir(job_id)
    meta = read_meta(d)
    if meta.get("status") == "running":
        raise HTTPException(409, "cancel the job first")
    shutil.rmtree(d)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/run")
def run_job(job_id: str):
    d = job_dir(job_id)
    meta = read_meta(d)
    if meta.get("status") == "running":
        raise HTTPException(409, "already running")
    mode = exec_mode()
    if mode is None:
        raise HTTPException(400, "No NWChem backend available. Install and start "
                                 "Docker Desktop, or install an nwchem binary.")

    container = f"nwchem-job-{job_id}"
    if mode == "docker":
        settings = load_settings()
        subprocess.run(["docker", "rm", "-f", container], capture_output=True)
        cmd = ["docker", "run", "--rm", "--name", container,
               "--shm-size", settings["shm_size"],
               "-v", f"{d}:/data", "-w", "/data",
               settings["docker_image"], "input.nw"]
    else:
        cmd = ["nwchem", "input.nw"]

    out = open(d / "output.out", "w", encoding="utf-8", errors="replace")
    out.write("$ " + " ".join(cmd) + "\n\n")
    out.flush()
    proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, cwd=str(d))
    with _lock:
        _processes[job_id] = proc

    meta.update(status="running", started=time.time(), mode=mode)
    meta.pop("exit_code", None)
    write_meta(d, meta)

    def waiter():
        try:
            code = proc.wait(timeout=MAX_JOB_SECONDS or None)
        except subprocess.TimeoutExpired:
            if mode == "docker":
                subprocess.run(["docker", "rm", "-f", container], capture_output=True)
            proc.kill()
            proc.wait()
            code = -9
            out.write(f"\n[job killed: exceeded time limit of {MAX_JOB_SECONDS}s]\n")
        out.close()
        with _lock:
            _processes.pop(job_id, None)
        m = read_meta(d)
        if m.get("status") == "cancelled":
            return
        m.update(status="done" if code == 0 else "failed",
                 exit_code=code, finished=time.time())
        write_meta(d, m)

    threading.Thread(target=waiter, daemon=True).start()
    return read_meta(d)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    d = job_dir(job_id)
    meta = read_meta(d)
    meta.update(status="cancelled", finished=time.time())
    write_meta(d, meta)
    if meta.get("mode") != "local":
        subprocess.run(["docker", "rm", "-f", f"nwchem-job-{job_id}"], capture_output=True)
    with _lock:
        proc = _processes.pop(job_id, None)
    if proc and proc.poll() is None:
        proc.kill()
    return meta


@app.get("/api/jobs/{job_id}/log")
def get_log(job_id: str, offset: int = 0):
    d = job_dir(job_id)
    f = d / "output.out"
    text = ""
    if f.exists():
        raw = f.read_text(encoding="utf-8", errors="replace")
        text = raw[offset:]
        offset = len(raw)
    return {"text": text, "offset": offset, "status": read_meta(d).get("status")}


@app.get("/api/jobs/{job_id}/results")
def get_results(job_id: str):
    d = job_dir(job_id)
    f = d / "output.out"
    if not f.exists():
        raise HTTPException(404, "no output yet")
    return _results_payload(f.read_text(encoding="utf-8", errors="replace"))


@app.post("/api/parse")
def parse_text(body: ParseRequest):
    return _results_payload(body.text)


def _results_payload(text):
    r = nwparse.parse_output(text)
    payload = {k: r[k] for k in ("energies", "opt_steps", "frequencies",
                                 "converged", "finished", "error")}
    payload["n_geometries"] = len(r["geometries"])
    if r["geometries"]:
        payload["trajectory_xyz"] = nwparse.trajectory_to_xyz(r["geometries"])
        payload["final_xyz"] = nwparse.geometry_to_xyz(r["geometries"][-1], "final")
        last = r["geometries"][-1]
        payload["modes_xyz"] = [
            nwparse.mode_to_vibrating_xyz(last, mode)
            for mode in r["normal_modes"]
            if len(mode) == len(last)
        ]
    else:
        payload["modes_xyz"] = []
    if "dipole_au" in r:
        payload["dipole_au"] = r["dipole_au"]
    return JSONResponse(payload)


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
