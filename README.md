# NWChem Studio

A local web app for building, running and visualizing NWChem quantum chemistry
calculations.

- **Build inputs** with a guided form (geometry, charge/multiplicity, DFT/HF/MP2,
  functional, basis set, task) — with a live 3D preview and a generated, editable
  `.nw` input file.
- **Run jobs** through the official NWChem Docker image with live log streaming.
- **Visualize results**: interactive 3D structures (3Dmol.js), geometry
  optimization trajectories with playback, energy convergence charts, and
  vibrational frequencies with animated normal modes.
- **Open existing files**: drop in any NWChem `.out` output (or plain `.xyz`)
  to visualize it without running anything.

## Run the app

```
start.bat
```

then open http://127.0.0.1:8317. (Requires Python 3.10+ with
`pip install -r requirements.txt`.)

## Running NWChem jobs (Docker)

Executing calculations requires Docker Desktop:

1. Install WSL2: `wsl --install` in an admin PowerShell, then reboot.
2. Install Docker Desktop for Windows (WSL2 backend) and start it.
3. The app's sidebar badge turns green ("Docker ready") automatically.

The first run pulls the NWChem image (`ghcr.io/nwchemgit/nwchem-dev/amd64`,
~1 GB — progress appears in the job log). The image can be changed in
⚙ Settings (e.g. a pinned release tag).

## Deploy on Render

The repo contains a `Dockerfile` (installs NWChem from the Debian package —
no Docker-in-Docker needed) and a `render.yaml` blueprint. The server
auto-detects the environment: on Render it runs the `nwchem` binary directly;
on your PC it uses Docker Desktop.

1. Push this repo to GitHub.
2. On https://dashboard.render.com choose **New → Blueprint**, connect the repo.
3. Render reads `render.yaml`; set a value for `APP_PASSWORD` when prompted
   (the web UI asks for this password on first use — leave it strong, the app
   runs real compute jobs).
4. Deploy. First build takes a few minutes (NWChem package ~700 MB).

Notes:
- The filesystem is ephemeral: job history is lost on redeploy/restart unless
  you attach a persistent disk (see the commented block in `render.yaml`).
- On the free plan the instance spins down when idle, which kills running jobs;
  the starter plan avoids that. `MAX_JOB_SECONDS` (default 1800) kills runaway jobs.
- Keep molecules modest — cloud instances have little RAM; add e.g.
  `memory 400 mb` to inputs if jobs die with memory errors.

## Layout

- `app/server.py` — FastAPI backend (job management, Docker execution, parsing API)
- `app/nwparse.py` — NWChem output parser (geometries, energies, frequencies, normal modes)
- `app/static/` — frontend (3Dmol.js + Chart.js via CDN)
- `jobs/<id>/` — one folder per job: `input.nw`, `output.out`, `meta.json`
- `settings.json` — Docker image / shm size
