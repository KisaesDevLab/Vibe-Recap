"""Form profile loader. Profiles are YAML under form-profiles/ and may `extends` another file.

Resolution order for a job: 1040-<year>-<software>.yaml, then the nearest earlier year for
that software, then 1040-<year>-generic.yaml, then any generic. Dict keys merge shallowly per
top-level section; `lines` from the child replace base entries with the same (path, line).
"""

from __future__ import annotations

import copy
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k == "extends":
            continue
        if k == "lines" and isinstance(v, list):
            merged = list(out.get("lines", []))
            for entry in v:
                key = (entry.get("path"), entry.get("line"))
                merged = [e for e in merged if (e.get("path"), e.get("line")) != key]
                merged.append(entry)
            out["lines"] = merged
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


@lru_cache(maxsize=64)
def load_profile_file(path: str) -> dict[str, Any]:
    p = Path(path)
    with open(p, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if data.get("extends"):
        base = load_profile_file(str(p.parent / data["extends"]))
        data = _merge(base, data)
    data["_file"] = p.name
    return data


def resolve_profile_path(profiles_dir: str, form: str, tax_year: int | None, software: str) -> Path:
    d = Path(profiles_dir)
    form_key = form.lower().replace(" ", "")
    candidates: list[Path] = []
    years = [tax_year] if tax_year else []
    years += sorted({int(m.group(1)) for f in d.glob(f"{form_key}-*.yaml") if (m := re.match(rf"{form_key}-(\d{{4}})-", f.name))}, reverse=True)
    seen: set[int] = set()
    for y in years:
        if y in seen:
            continue
        seen.add(y)
        candidates.append(d / f"{form_key}-{y}-{software}.yaml")
    for y in list(seen) and sorted(seen, reverse=True):
        candidates.append(d / f"{form_key}-{y}-generic.yaml")
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError(f"no profile for form {form} software {software} under {profiles_dir}")


def load_profile(profiles_dir: str, form: str, tax_year: int | None, software: str) -> dict[str, Any]:
    return load_profile_file(str(resolve_profile_path(profiles_dir, form, tax_year, software)))


@lru_cache(maxsize=4)
def load_states(profiles_dir: str) -> dict[str, list[str]]:
    with open(Path(profiles_dir) / "states.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)["states"]
