#!/usr/bin/env python3
"""Extract the 35 PLC case sections from the teacher DOCX.

The extractor keeps the source wording, tables, and image references.  It does
not attempt to interpret the teacher material as executable instructions.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Dict, Iterable, List, Tuple
from zipfile import ZipFile
from xml.etree import ElementTree as ET


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W, "a": A, "r": R, "pr": PR}


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def paragraph_text(node: ET.Element) -> str:
    parts: List[str] = []
    for child in node.iter():
        if child.tag == f"{{{W}}}t":
            parts.append(child.text or "")
        elif child.tag == f"{{{W}}}tab":
            parts.append("\t")
        elif child.tag == f"{{{W}}}br":
            parts.append("\n")
    return "".join(parts).strip()


def cell_text(cell: ET.Element) -> str:
    paragraphs = [compact(paragraph_text(p)) for p in cell.findall(".//w:p", NS)]
    return " / ".join(p for p in paragraphs if p)


def table_markdown(table: ET.Element) -> str:
    rows: List[List[str]] = []
    for row in table.findall("./w:tr", NS):
        cells = [cell_text(cell) for cell in row.findall("./w:tc", NS)]
        if cells and any(cells):
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def image_targets(docx_path: Path) -> Dict[str, str]:
    with ZipFile(docx_path) as archive:
        rels = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        return {
            rel.attrib["Id"]: "word/" + rel.attrib.get("Target", "").lstrip("/")
            for rel in rels.findall("pr:Relationship", NS)
            if rel.attrib.get("Target", "").startswith("media/")
        }


def extract(docx_path: Path, output_dir: Path) -> Dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    with ZipFile(docx_path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        rel_map = image_targets(docx_path)
        body = root.find("w:body", NS)
        if body is None:
            raise ValueError("DOCX does not contain a document body")

        blocks: Dict[int, List[str]] = {number: [] for number in range(1, 36)}
        titles: Dict[int, str] = {}
        images: Dict[int, List[str]] = {number: [] for number in range(1, 36)}
        current: int | None = None

        for element in list(body):
            tag = element.tag.rsplit("}", 1)[-1]
            text = compact(paragraph_text(element)) if tag == "p" else table_markdown(element)
            # Case 25 in the source is formatted as ``案例25洗车机`` without a
            # separator, while the other headings use spaces or punctuation.
            heading_match = re.match(r"^案例\s*([0-9]{1,2})(.*)$", text)
            if heading_match:
                number = int(heading_match.group(1))
                if 1 <= number <= 35:
                    current = number
                    titles[number] = text

            if current is None:
                continue

            refs: List[str] = []
            for blip in element.findall(".//a:blip", NS):
                rid = blip.attrib.get(f"{{{R}}}embed", "")
                target = rel_map.get(rid)
                if target:
                    refs.append(target)
                    if target not in images[current]:
                        images[current].append(target)

            if text:
                blocks[current].append(text)
            for ref in refs:
                blocks[current].append(f"[IMAGE_REF: {ref}]")

    missing = [number for number in range(1, 36) if not blocks[number]]
    if missing:
        raise ValueError(f"Missing case sections: {missing}")

    manifest = {
        "source": str(docx_path),
        "caseCount": 35,
        "cases": [],
    }
    for number in range(1, 36):
        case_file = output_dir / f"case_{number:02d}.md"
        content = "\n\n".join(blocks[number]).strip() + "\n"
        case_file.write_text(content, encoding="utf-8")
        manifest["cases"].append(
            {
                "caseNo": number,
                "title": titles.get(number, f"案例 {number}"),
                "file": str(case_file),
                "imageRefs": images[number],
                "status": "EXTRACTED",
            }
        )

    (output_dir / "case_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("docx", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("plc_case_pipeline/01_sources"))
    args = parser.parse_args()
    result = extract(args.docx, args.output_dir)
    print(json.dumps({"caseCount": result["caseCount"], "outputDir": str(args.output_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
