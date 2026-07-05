#!/usr/bin/env python3
"""Promote session-mining recipe reports into pending profile customizations.

This is deterministic and local-only. It does not run mining, call an LLM, or
edit the shared dev-story. It reads already-emitted analysis.json files and
adds pending entries under onboarding.story_customizations for operator review.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def slug(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "recipe"


def find_analysis(root: Path, explicit: list[str]) -> list[Path]:
    if explicit:
        return [Path(item).expanduser().resolve() for item in explicit]
    jobs = root / ".artifacts" / "mining" / "jobs"
    if not jobs.exists():
        return []
    return sorted(jobs.glob("*/analysis.json"))


def load_recipes(path: Path) -> list[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        return [{"id": slug(str(path)), "status": "error", "summary": f"Could not read {path}: {err}", "evidence": str(path)}]
    out: list[dict] = []
    for inst in doc.get("instances", []):
        if not isinstance(inst, dict):
            continue
        grounding = inst.get("grounding") if isinstance(inst.get("grounding"), dict) else {}
        if grounding.get("quarantined"):
            continue
        instance_id = str(inst.get("instance_id") or "")
        if not instance_id:
            continue
        determinism = str(inst.get("determinism") or "unknown")
        tags = inst.get("tags") if isinstance(inst.get("tags"), dict) else {}
        actions = tags.get("action") if isinstance(tags.get("action"), list) else []
        action_text = ", ".join(str(item) for item in actions[:4]) or "session-mined workflow"
        out.append({
            "id": "mined-" + slug(instance_id)[-48:],
            "status": "pending",
            "summary": f"Review session-mined {determinism} recipe: {action_text}.",
            "evidence": f"{path}#{instance_id}",
        })
    return out


def yaml_quote(value: str) -> str:
    return json.dumps(str(value))


def entry_yaml(entry: dict) -> list[str]:
    return [
        f"    - id: {yaml_quote(entry['id'])}",
        f"      status: {yaml_quote(entry['status'])}",
        f"      summary: {yaml_quote(entry['summary'])}",
        f"      evidence: {yaml_quote(entry['evidence'])}",
    ]


def existing_ids(text: str) -> set[str]:
    return set(re.findall(r'^\s+id:\s+"([^"]+)"\s*$', text, flags=re.MULTILINE))


def parse_scalar(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    return str(value)


def customization_ranges(lines: list[str]) -> list[tuple[int, int, dict]]:
    start = -1
    for index, line in enumerate(lines):
        if line == "  story_customizations:":
            start = index
            break
    if start == -1:
        return []
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.startswith("  ") and not line.startswith("    ") and line.strip():
            end = index
            break
        if line and not line.startswith((" ", "\t")):
            end = index
            break
    starts: list[int] = []
    for index in range(start + 1, end):
        if re.match(r"^\s*-\s*(?:\w+:.*)?$", lines[index]):
            starts.append(index)
    ranges: list[tuple[int, int, dict]] = []
    for pos, item_start in enumerate(starts):
        item_end = starts[pos + 1] if pos + 1 < len(starts) else end
        entry: dict[str, str] = {}
        for line in lines[item_start:item_end]:
            match = re.match(r"^\s*(?:-\s*)?([A-Za-z_][\w-]*):\s*(.*)$", line)
            if match:
                entry[match.group(1)] = parse_scalar(match.group(2))
        ranges.append((item_start, item_end, entry))
    return ranges


def list_customizations(text: str) -> list[dict]:
    lines = text.splitlines()
    return [entry for _, _, entry in customization_ranges(lines) if entry.get("id")]


def status_counts(entries: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for entry in entries:
        status = str(entry.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
        alias = status.replace("-", "_")
        if alias != status:
            counts[alias] = counts.get(alias, 0) + 1
    return counts


def replace_or_insert_key(block: list[str], key: str, value: str) -> list[str]:
    rendered = f"      {key}: {yaml_quote(value)}"
    pattern = re.compile(rf"^(\s*(?:-\s*)?{re.escape(key)}:\s*).*$")
    out = list(block)
    for index, line in enumerate(out):
        if pattern.match(line):
            prefix = pattern.match(line).group(1)
            out[index] = f"{prefix}{yaml_quote(value)}"
            return out
    insert_at = len(out)
    for index, line in enumerate(out):
        if re.match(r"^\s*(?:-\s*)?evidence:\s*", line):
            insert_at = index + 1
            break
    out.insert(insert_at, rendered)
    return out


def update_pending_customizations(text: str, status: str, feedback: str = "") -> tuple[str, list[dict]]:
    lines = text.splitlines()
    ranges = customization_ranges(lines)
    if not ranges:
        return text, []
    out: list[str] = []
    cursor = 0
    changed: list[dict] = []
    for start, end, entry in ranges:
        out.extend(lines[cursor:start])
        block = lines[start:end]
        if entry.get("status") == "pending":
            block = replace_or_insert_key(block, "status", status)
            if feedback:
                block = replace_or_insert_key(block, "review_feedback", feedback)
            updated = dict(entry)
            updated["status"] = status
            if feedback:
                updated["review_feedback"] = feedback
            changed.append(updated)
        out.extend(block)
        cursor = end
    out.extend(lines[cursor:])
    return "\n".join(out) + "\n", changed


def insert_customizations(text: str, entries: list[dict]) -> str:
    if not entries:
        return text
    ids = existing_ids(text)
    new_entries = [entry for entry in entries if entry["id"] not in ids]
    if not new_entries:
        return text
    lines = text.splitlines()
    start = -1
    for index, line in enumerate(lines):
        if line == "  story_customizations:":
            start = index
            break
    block: list[str] = []
    for entry in new_entries:
        block.extend(entry_yaml(entry))
    if start == -1:
        onboarding = -1
        for index, line in enumerate(lines):
            if line == "onboarding:":
                onboarding = index
                break
        if onboarding == -1:
            return text.rstrip() + "\n\nonboarding:\n  story_customizations:\n" + "\n".join(block) + "\n"
        insert_at = len(lines)
        for index in range(onboarding + 1, len(lines)):
            if lines[index] and not lines[index].startswith((" ", "\t")):
                insert_at = index
                break
        return "\n".join(lines[:insert_at] + ["  story_customizations:"] + block + lines[insert_at:]) + "\n"
    insert_at = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.startswith("  ") and not line.startswith("    ") and line.strip():
            insert_at = index
            break
        if line and not line.startswith((" ", "\t")):
            insert_at = index
            break
    return "\n".join(lines[:insert_at] + block + lines[insert_at:]) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Promote session-mining analysis into pending Kitsoki customizations.")
    parser.add_argument("analysis", nargs="*", help="analysis.json path(s); defaults to .artifacts/mining/jobs/*/analysis.json")
    parser.add_argument("--profile", default=".kitsoki/project-profile.yaml", help="project profile to update")
    parser.add_argument("--dry-run", action="store_true", help="print proposed entries without writing")
    parser.add_argument("--json", action="store_true", help="print machine-readable summary")
    parser.add_argument("--list", action="store_true", help="list current profile customizations")
    parser.add_argument("--accept-pending", action="store_true", help="mark pending profile customizations accepted")
    parser.add_argument("--refine-pending", metavar="FEEDBACK", help="mark pending profile customizations as needing refinement")
    args = parser.parse_args()

    root = Path.cwd()
    profile = root / args.profile
    if args.list or args.accept_pending or args.refine_pending is not None:
        if not profile.exists():
            print(f"profile not found: {profile}", file=sys.stderr)
            return 2
        text = profile.read_text(encoding="utf-8")
        updated = text
        changed: list[dict] = []
        action = "list"
        if args.accept_pending:
            action = "accept"
            updated, changed = update_pending_customizations(text, "accepted")
        elif args.refine_pending is not None:
            action = "refine"
            updated, changed = update_pending_customizations(text, "needs-refinement", args.refine_pending)
        if updated != text and not args.dry_run:
            profile.write_text(updated, encoding="utf-8")
        summary = {
            "action": action,
            "entries": list_customizations(updated if not args.dry_run else text),
            "changed": changed,
            "counts": status_counts(list_customizations(updated if not args.dry_run else text)),
            "updated": updated != text and not args.dry_run,
        }
        print(json.dumps(summary, indent=2, sort_keys=True) if args.json or args.dry_run else f"{action} {len(changed)} pending customization(s); updated={summary['updated']}")
        return 0

    analyses = find_analysis(root, args.analysis)
    entries: list[dict] = []
    for path in analyses:
        entries.extend(load_recipes(path))
    entries = [entry for entry in entries if entry.get("status") == "pending"]
    summary = {"action": "promote", "analysis_files": [str(path) for path in analyses], "entries": entries, "updated": False}
    if args.dry_run:
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0
    if not profile.exists():
        print(f"profile not found: {profile}", file=sys.stderr)
        return 2
    text = profile.read_text(encoding="utf-8")
    updated = insert_customizations(text, entries)
    if updated != text:
        profile.write_text(updated, encoding="utf-8")
        summary["updated"] = True
    summary["entries"] = list_customizations(updated)
    summary["counts"] = status_counts(summary["entries"])
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(f"promoted {len(entries)} pending customization(s); updated={summary['updated']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
