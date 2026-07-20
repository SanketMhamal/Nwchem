"""Parser for NWChem output files.

Extracts geometries, energies, optimization history, vibrational
frequencies and normal modes into plain dicts that serialize to JSON.
"""

import re

BOHR_TO_ANGSTROM = 0.529177210903

_GEOM_HEADER = re.compile(r"Output coordinates in (angstroms|a\.u\.)", re.IGNORECASE)
_GEOM_ROW = re.compile(
    r"^\s*\d+\s+(\S+)\s+-?\d+\.\d+\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$"
)
_ENERGY = re.compile(r"Total (SCF|DFT|MP2|CCSD(?:\(T\))?) energy\s*=?\s*(-?\d+\.\d+)")
_OPT_STEP = re.compile(r"^@\s+(\d+)\s+(-?\d+\.\d+)")
_FREQ_ROW = re.compile(r"^\s*P\.Frequency\s+((?:-?\d+\.\d+\s*)+)$")
_MODE_HEADER = re.compile(r"NORMAL MODE EIGENVECTORS IN CARTESIAN COORDINATES")
_DIPOLE = re.compile(r"Total dipole\s*=?\s*(-?\d+\.\d+)\s*au")


def _clean_tag(tag):
    """NWChem tags may be lowercase or decorated (e.g. 'o1', 'H_x'). Return element symbol."""
    m = re.match(r"([A-Za-z]{1,2})", tag)
    sym = m.group(1) if m else tag
    return sym.capitalize()


def parse_output(text):
    lines = text.splitlines()
    geometries = []
    opt_steps = []
    energies = []
    frequencies = []
    normal_modes = []  # list of modes; each mode is list of [dx,dy,dz] per atom

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        m = _GEOM_HEADER.search(line)
        if m:
            unit = m.group(1).lower()
            scale = 1.0 if unit == "angstroms" else BOHR_TO_ANGSTROM
            j = i + 1
            atoms = []
            # skip blank lines and the two header lines until rows start
            while j < n and not _GEOM_ROW.match(lines[j]):
                j += 1
                if j - i > 8:
                    break
            while j < n:
                row = _GEOM_ROW.match(lines[j])
                if not row:
                    break
                atoms.append({
                    "el": _clean_tag(row.group(1)),
                    "x": float(row.group(2)) * scale,
                    "y": float(row.group(3)) * scale,
                    "z": float(row.group(4)) * scale,
                })
                j += 1
            if atoms:
                geometries.append(atoms)
            i = j
            continue

        m = _ENERGY.search(line)
        if m:
            energies.append({"method": m.group(1), "energy": float(m.group(2))})
            i += 1
            continue

        m = _OPT_STEP.match(line)
        if m:
            opt_steps.append({"step": int(m.group(1)), "energy": float(m.group(2))})
            i += 1
            continue

        if _MODE_HEADER.search(line):
            i = _parse_normal_modes(lines, i + 1, frequencies, normal_modes)
            continue

        i += 1

    result = {
        "geometries": geometries,
        "energies": energies,
        "opt_steps": opt_steps,
        "frequencies": frequencies,
        "normal_modes": normal_modes,
        "converged": "Optimization converged" in text,
        "finished": "Total times  cpu" in text or "CITATION" in text,
        "error": _find_error(text),
    }
    m = _DIPOLE.search(text)
    if m:
        result["dipole_au"] = float(m.group(1))
    return result


def _parse_normal_modes(lines, start, frequencies, normal_modes):
    """Parse blocks of frequency columns with 3N eigenvector rows each."""
    i = start
    n = len(lines)
    while i < n:
        # find next P.Frequency row within this section
        while i < n and not _FREQ_ROW.match(lines[i]):
            # stop if we clearly left the section
            if "Projected Infra Red Intensities" in lines[i] or "----" in lines[i] and i > start + 400:
                return i
            if lines[i].strip().startswith("NORMAL MODE"):
                return i
            if i - start > 20000:
                return i
            # section typically ends with the intensities table
            if "Normal Eigenvalue" in lines[i]:
                return i
            i += 1
        if i >= n:
            return i
        freqs = [float(v) for v in _FREQ_ROW.match(lines[i]).group(1).split()]
        ncols = len(freqs)
        frequencies.extend(freqs)
        cols = [[] for _ in range(ncols)]
        i += 1
        rows_seen = 0
        while i < n:
            row = re.match(r"^\s*(\d+)\s+((?:-?\d+\.\d+\s*)+)$", lines[i])
            if row:
                vals = [float(v) for v in row.group(2).split()]
                if len(vals) == ncols:
                    for c in range(ncols):
                        cols[c].append(vals[c])
                    rows_seen += 1
                i += 1
            elif lines[i].strip() == "":
                i += 1
                if rows_seen:
                    break
            else:
                break
        # convert flat 3N lists into per-atom displacement triples
        for c in range(ncols):
            flat = cols[c]
            mode = [flat[k:k + 3] for k in range(0, len(flat) - len(flat) % 3, 3)]
            normal_modes.append(mode)
        # continue: next block of columns may follow
        if i >= n or "Normal Eigenvalue" in lines[i]:
            return i


def _find_error(text):
    if "For further details see manual" in text or "NWChem Terminated" in text.replace("Execution", ""):
        pass
    m = re.search(r"^[ \t]*-+\s*\n([^\n]*[Ee]rror[^\n]*)\n", text, re.MULTILINE)
    if "There is an error in the input file" in text:
        return "There is an error in the input file"
    if m:
        return m.group(1).strip()
    m = re.search(r"This type of error is most commonly[^\n]*", text)
    if m:
        return m.group(0).strip()
    return None


def geometry_to_xyz(atoms, comment=""):
    out = [str(len(atoms)), comment]
    for a in atoms:
        out.append(f"{a['el']} {a['x']:.6f} {a['y']:.6f} {a['z']:.6f}")
    return "\n".join(out)


def trajectory_to_xyz(geometries):
    return "\n".join(geometry_to_xyz(g, f"frame {i}") for i, g in enumerate(geometries))


def mode_to_vibrating_xyz(atoms, mode):
    """XYZ with extra dx dy dz columns; 3Dmol.js animates these as a vibration."""
    out = [str(len(atoms)), "vibration"]
    for a, d in zip(atoms, mode):
        out.append(
            f"{a['el']} {a['x']:.6f} {a['y']:.6f} {a['z']:.6f} "
            f"{d[0]:.6f} {d[1]:.6f} {d[2]:.6f}"
        )
    return "\n".join(out)
