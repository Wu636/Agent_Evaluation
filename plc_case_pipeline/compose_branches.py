#!/usr/bin/env python3
"""Compose generated five-stage case scripts into seven linear branch scripts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Dict, List, Tuple


GROUPS = [
    {"branchCode": "T1_B1", "finalTraining": 1, "branchName": "基本指令案例", "cases": list(range(1, 7))},
    {"branchCode": "T1_B2", "finalTraining": 1, "branchName": "状态表法程序设计", "cases": [7, 8]},
    {"branchCode": "T1_B3", "finalTraining": 1, "branchName": "定时器指令案例", "cases": list(range(9, 14))},
    {"branchCode": "T2_B1", "finalTraining": 2, "branchName": "指令综合应用", "cases": list(range(14, 19))},
    {"branchCode": "T2_B2", "finalTraining": 2, "branchName": "结构化程序设计", "cases": list(range(19, 24))},
    {"branchCode": "T3_B1", "finalTraining": 3, "branchName": "顺序控制系统设计", "cases": list(range(24, 32))},
    {"branchCode": "T3_B2", "finalTraining": 3, "branchName": "工艺对象设计", "cases": list(range(32, 36))},
]


def read_title(manifest: Dict[str, object], number: int) -> str:
    for item in manifest.get("cases", []):
        if int(item.get("caseNo", -1)) == number:
            title = str(item.get("title", f"案例 {number}"))
            return re.sub(r"^案例\s*\d+\s*", "", title).strip() or title
    return f"案例 {number}"


def parse_stages(markdown: str) -> Tuple[str, List[Tuple[str, str]], str]:
    lines = markdown.splitlines()
    # Ignore the generated flow/configuration sections: they contain prose
    # headings such as “### 阶段1 → 阶段2” that are not stage cards.
    body_end = next(
        (index for index, line in enumerate(lines)
         if re.match(r"^##\s+(?:🔄|🔀|📖|阶段跳转关系|配置说明)", line.strip())),
        len(lines),
    )
    body_lines = lines[:body_end]
    matches = [
        (index, match)
        for index, line in enumerate(body_lines)
        if (match := re.match(r"^###\s*阶段\s*(\d+)\s*[:：]\s*(.*)$", line.strip()))
    ]
    if not matches:
        raise ValueError("未找到阶段标题")
    prefix = "\n".join(lines[: matches[0][0]]).strip()
    stages: List[Tuple[str, str]] = []
    for position, (start, match) in enumerate(matches):
        end = matches[position + 1][0] if position + 1 < len(matches) else len(body_lines)
        # The final generated stage is followed by the source script's flow,
        # notes, and completion marker. Those belong to the composite wrapper,
        # not to the stage block; keeping them would terminate parsing before
        # later cases are reached.
        if position == len(matches) - 1:
            for index in range(start + 1, end):
                if re.match(r"^##\s+(?:🔄|🔀|📖|阶段跳转关系|配置说明)", body_lines[index].strip()):
                    end = index
                    break
        block = "\n".join(body_lines[start:end])
        block = re.sub(r"^\s*<!--\s*STAGE_(?:START|END)\s*:?\s*\d*\s*-->\s*$", "", block, flags=re.MULTILINE)
        block = re.sub(r"^\s*<!--\s*TRAINING_SCRIPT_COMPLETE\s*-->\s*$", "", block, flags=re.MULTILINE).strip()
        stages.append((match.group(2).strip(), block))
    return prefix, stages, ""


def replace_task_prefix(prefix: str, task_name: str, description: str) -> str:
    lines = prefix.splitlines()
    title_index = next((i for i, line in enumerate(lines) if re.match(r"^#\s+", line)), None)
    if title_index is None:
        lines.insert(0, f"# {task_name} - 训练剧本配置")
    else:
        lines[title_index] = f"# {task_name} - 训练剧本配置"
    name_pattern = re.compile(r"^-\s*\*\*任务名称\*\*\s*[:：].*$")
    desc_pattern = re.compile(r"^-\s*\*\*任务描述\*\*\s*[:：].*$")
    for i, line in enumerate(lines):
        if name_pattern.match(line):
            lines[i] = f"- **任务名称**: {task_name}"
        elif desc_pattern.match(line):
            lines[i] = f"- **任务描述**: {description}"
    return "\n".join(lines).strip()


def rewrite_stage(block: str, case_no: int, local_index: int, target_condition: str, global_index: int, title: str) -> str:
    lines = block.splitlines()
    if not lines:
        return block
    lines[0] = f"### 阶段{global_index}: 案例{case_no:02d}-{title}"
    flow_line = re.compile(r"^(\s*\*\*flowCondition\*\*\s*[:：]).*$", re.I)
    old_condition = ""
    for line in lines:
        if flow_line.match(line):
            old_condition = line.split(":", 1)[-1].strip().strip('"`')
            break
    for i, line in enumerate(lines):
        if flow_line.match(line):
            lines[i] = f'**flowCondition**: "{target_condition}"'
    # Keep generated prompts aligned with the serialized flow condition.  The
    # replacement is limited to the old outgoing token, avoiding unrelated text.
    if old_condition:
        # Keep the rewritten heading out of the local-stage substitution;
        # otherwise “阶段21” contains “阶段2” and becomes “阶段221”.
        heading = lines[0]
        text = "\n".join(lines[1:])
        text = text.replace(old_condition, target_condition)
        text = text.replace(f"阶段{local_index + 1}", f"阶段{global_index + 1}")
        return "\n".join([heading, text])
    return "\n".join(lines)


def compose_group(group: Dict[str, object], manifest: Dict[str, object], generated_dir: Path) -> Dict[str, object]:
    cases = [int(value) for value in group["cases"]]
    all_stages: List[str] = []
    jump_rows: List[str] = []
    global_index = 0
    for case_pos, case_no in enumerate(cases):
        script_path = generated_dir / f"case_{case_no:02d}_script.md"
        if not script_path.exists():
            raise FileNotFoundError(script_path)
        _, stages, _ = parse_stages(script_path.read_text(encoding="utf-8"))
        if len(stages) != 5:
            raise ValueError(f"案例{case_no:02d} 期望5个阶段，实际{len(stages)}个")
        title = read_title(manifest, case_no)
        for local_zero, (_, block) in enumerate(stages):
            global_index += 1
            if local_zero < 4:
                target = f"NEXT_TO_C{case_no:02d}_S{local_zero + 2:02d}"
            elif case_pos < len(cases) - 1:
                target = f"NEXT_TO_C{cases[case_pos + 1]:02d}_S01"
            else:
                target = "TASK_COMPLETE"
            all_stages.append(rewrite_stage(block, case_no, local_zero + 1, target, global_index, title))
            jump_rows.append(f"- 案例{case_no:02d}阶段{local_zero + 1} → `{target}`")

    task_name = f"PLC能力训练-训练{group['finalTraining']}-{group['branchName']}"
    description = f"按案例编号串行完成：{'、'.join(f'案例{x}' for x in cases)}。每个案例包含理论、实操、优化、思政和总结五阶段。"
    first_prefix, _, _ = parse_stages((generated_dir / f"case_{cases[0]:02d}_script.md").read_text(encoding="utf-8"))
    prefix = replace_task_prefix(first_prefix, task_name, description)
    prefix = "\n".join(
        line for line in prefix.splitlines()
        if not re.match(r"^##+\s*(?:📝\s*)?训练阶段\b", line.strip()) and
        not re.match(r"^\s*<!--\s*STAGE_(?:START|END)\b", line.strip())
    ).strip()
    output = "\n\n".join(
        [
            prefix,
            "## 📝 训练阶段",
            "\n\n---\n\n".join(all_stages),
            "## 🔄 阶段跳转关系\n\n" + "\n".join(jump_rows),
            "## 📖 配置说明\n\n本配置由独立案例配置按案例编号串行拼接生成；案例之间只通过唯一跳转关键词连接。\n\n<!-- TRAINING_SCRIPT_COMPLETE -->",
        ]
    ).strip() + "\n"
    return {"group": group, "taskName": task_name, "cases": cases, "stageCount": len(all_stages), "markdown": output}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("plc_case_pipeline/01_sources/case_manifest.json"))
    parser.add_argument("--generated-dir", type=Path, default=Path("plc_case_pipeline/02_generated"))
    parser.add_argument("--output-dir", type=Path, default=Path("plc_case_pipeline/03_composed"))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for group in GROUPS:
        result = compose_group(group, manifest, args.generated_dir)
        filename = f"{group['branchCode'].lower()}_cases_{group['cases'][0]:02d}_{group['cases'][-1]:02d}.md"
        path = args.output_dir / filename
        path.write_text(result.pop("markdown"), encoding="utf-8")
        result["file"] = str(path)
        results.append(result)
        print(json.dumps({k: result[k] for k in ("taskName", "cases", "stageCount", "file")}, ensure_ascii=False))
    (args.output_dir / "branch_manifest.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
