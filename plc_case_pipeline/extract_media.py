#!/usr/bin/env python3
"""Extract only body-referenced DOCX media and write an upload manifest."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from zipfile import ZipFile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("docx", type=Path)
    parser.add_argument("--case-manifest", type=Path, default=Path("plc_case_pipeline/01_sources/case_manifest.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("plc_case_pipeline/assets"))
    args = parser.parse_args()

    manifest = json.loads(args.case_manifest.read_text(encoding="utf-8"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    seen = set()
    with ZipFile(args.docx) as archive:
        primary_paths = {}
        for case in manifest.get("cases", []):
            number = int(case["caseNo"])
            for index, target in enumerate(case.get("imageRefs", []), 1):
                if target in seen:
                    # Reuse the already extracted asset instead of emitting a
                    # manifest path that does not exist on disk.
                    output = primary_paths[target]
                    rows.append({
                        "caseNo": number,
                        "source": target,
                        "file": str(output),
                        "duplicate": True,
                        "duplicateOf": str(output),
                    })
                    continue
                seen.add(target)
                suffix = Path(target).suffix.lower() or ".bin"
                output = args.output_dir / f"case_{number:02d}_image_{index:02d}{suffix}"
                output.write_bytes(archive.read(target))
                primary_paths[target] = output
                rows.append({
                    "caseNo": number,
                    "source": target,
                    "file": str(output),
                    "primaryStage": f"案例{number:02d}-案例导入与基础理论问答",
                    "duplicate": False,
                    "conversionNeeded": suffix in {".wmf", ".emf", ".gif"},
                })
    (args.output_dir / "resource_manifest.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"placements": len(rows), "uniqueFiles": len(seen), "outputDir": str(args.output_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
