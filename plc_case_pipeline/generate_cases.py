#!/usr/bin/env python3
"""Run one bounded training-generation request per PLC case.

The script is resumable: completed case outputs are kept, failed cases are
recorded individually, and a later run retries only missing/failed cases.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, Tuple


def read_env(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def module_plan(case_title: str) -> Dict[str, Any]:
    prefix = case_title.split("基础案例", 1)[0].strip(" -") or case_title
    modules = [
        {
            "id": "m1",
            "title": "案例导入与基础理论问答",
            "moduleType": "general",
            "objective": f"掌握{prefix}案例涉及的 PLC 指令、信号和安全基础",
            "description": "依据教师案例原始要求进行分层理论问答，先判断概念掌握，再用启发式方式纠错。",
            "keyPoints": ["核心原理", "I/O 与接线规范", "实训安全"],
            "interactionStyle": "顺序检查型，逐题判断",
            "transitionGoal": "理论回答达到基本正确后进入工业案例实操",
            "suggestedRounds": 5,
        },
        {
            "id": "m2",
            "title": "工业案例实操分析",
            "moduleType": "sequential",
            "objective": "将控制要求转换为 I/O 分配、程序结构并完成故障分析",
            "description": "围绕教师文档中的工业场景分层追问，要求学生说明控制逻辑、调试方法和故障定位思路。",
            "keyPoints": ["需求拆解", "I/O 分配", "程序结构", "故障排查"],
            "interactionStyle": "顺序检查型，分层追问",
            "transitionGoal": "完成场景分析后进入优化拓展",
            "suggestedRounds": 6,
        },
        {
            "id": "m3",
            "title": "优化拓展思考",
            "moduleType": "general",
            "objective": "针对原案例提出有依据的功能扩展和保护措施",
            "description": "引导学生从急停、异常、时序、维护或性能角度提出改进方案，不直接泄露标准答案。",
            "keyPoints": ["功能扩展", "安全保护", "异常处理"],
            "interactionStyle": "累积检查型，逐项补齐",
            "transitionGoal": "形成至少一项有依据的改进方案后进入课程思政",
            "suggestedRounds": 4,
        },
        {
            "id": "m4",
            "title": "课程思政专项互动",
            "moduleType": "roleplay",
            "objective": "把工程严谨性、可靠性和国产 PLC 应用价值与本案例联系起来",
            "description": "通过专业情境追问工程责任、工匠精神和产业适配思考，保持 PLC 实训指导教师人设。",
            "keyPoints": ["可靠性意识", "工匠精神", "国产 PLC 与产业需求"],
            "interactionStyle": "开放问答，结合案例回应",
            "transitionGoal": "完成专业价值反思后进入总结",
            "suggestedRounds": 3,
        },
        {
            "id": "m5",
            "title": "训练小结与评价",
            "moduleType": "summary",
            "objective": "回顾本案例知识点、实操思路和薄弱项",
            "description": "总结学生表现并输出后续学习建议；本阶段结束本案例。",
            "keyPoints": ["知识回顾", "实操评价", "薄弱项建议"],
            "interactionStyle": "总结复盘",
            "transitionGoal": "结束",
            "suggestedRounds": 1,
        },
    ]
    return {
        "taskName": case_title,
        "audience": "机电、自动化及相关专业学生",
        "overallObjective": f"完成{prefix}案例的理论、实操、优化与工程素养训练。",
        "recommendedMode": "general",
        "flowType": "linear",
        "modules": modules,
        "edges": [],
        "notes": ["严格基于教师案例素材生成", "每个案例固定五阶段"],
    }


def parse_sse(raw: bytes) -> Tuple[str, str, Dict[str, Any]]:
    script_chunks = []
    rubric_chunks = []
    complete: Dict[str, Any] = {}
    errors = []
    for line in raw.decode("utf-8", "replace").splitlines():
        if not line.startswith("data: "):
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if event.get("type") == "chunk":
            (script_chunks if event.get("phase") == "script" else rubric_chunks).append(event.get("content", ""))
        elif event.get("type") == "phase_complete":
            if event.get("phase") == "script":
                script_chunks = [event.get("fullContent", "")]
            elif event.get("phase") == "rubric":
                rubric_chunks = [event.get("fullContent", "")]
        elif event.get("type") == "complete":
            complete = event
            if event.get("script"):
                script_chunks = [event["script"]]
            if event.get("rubric"):
                rubric_chunks = [event["rubric"]]
        elif event.get("type") == "error":
            errors.append(str(event.get("message", "generation error")))
    if errors:
        raise RuntimeError("; ".join(errors))
    script = "".join(script_chunks).strip()
    rubric = "".join(rubric_chunks).strip()
    if not script or not complete:
        raise RuntimeError("SSE did not contain a complete script")
    return script, rubric, complete


def generate_one(case: Dict[str, Any], args: argparse.Namespace, env: Dict[str, str]) -> Dict[str, Any]:
    number = int(case["caseNo"])
    case_file = Path(case["file"])
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    script_path = out_dir / f"case_{number:02d}_script.md"
    rubric_path = out_dir / f"case_{number:02d}_rubric.md"
    raw_path = out_dir / f"case_{number:02d}.sse"
    if script_path.exists() and script_path.stat().st_size > 500 and not args.force:
        return {"caseNo": number, "status": "SKIPPED", "script": str(script_path)}

    content = case_file.read_text(encoding="utf-8")
    title = str(case.get("title") or f"案例 {number}")
    body = {
        "teacherDocContent": content,
        "teacherDocName": f"案例{number:02d}",
        "generateScript": True,
        "generateRubric": True,
        "scriptMode": "general",
        "modulePlan": module_plan(title),
        "apiKey": env.get("LLM_API_KEY", ""),
        "apiUrl": env.get("LLM_BASE_URL") or env.get("LLM_API_URL", ""),
        "model": args.model,
    }
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(1, args.retries + 1):
        try:
            # curl handles long-lived SSE responses from the local Next route
            # more reliably than urllib's default connection reuse. The JSON,
            # including the API key, is piped via stdin and never placed in a
            # command-line argument or temporary file.
            completed = subprocess.run(
                [
                    "curl",
                    "-sS",
                    "--fail-with-body",
                    "--max-time",
                    str(args.timeout),
                    "-H",
                    "Content-Type: application/json",
                    "--data-binary",
                    "@-",
                    args.endpoint,
                ],
                input=encoded,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=args.timeout + 30,
                check=False,
            )
            if completed.returncode != 0:
                detail = completed.stderr.decode("utf-8", "replace").strip()
                body = completed.stdout.decode("utf-8", "replace").strip()
                raise RuntimeError(detail or body or f"curl exited with {completed.returncode}")
            raw = completed.stdout
            raw_path.write_bytes(raw)
            script, rubric, complete = parse_sse(raw)
            script_path.write_text(script + "\n", encoding="utf-8")
            if rubric:
                rubric_path.write_text(rubric + "\n", encoding="utf-8")
            return {
                "caseNo": number,
                "status": "GENERATED",
                "attempt": attempt,
                "script": str(script_path),
                "rubric": str(rubric_path) if rubric else None,
                "taskName": complete.get("taskName", ""),
            }
        except (TimeoutError, subprocess.TimeoutExpired, RuntimeError, OSError) as exc:
            last_error = exc
            if attempt < args.retries:
                time.sleep(min(10 * attempt, 30))
    error_path = out_dir / f"case_{number:02d}.error.txt"
    error_path.write_text(str(last_error), encoding="utf-8")
    return {"caseNo": number, "status": "FAILED", "error": str(last_error)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("plc_case_pipeline/01_sources/case_manifest.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("plc_case_pipeline/02_generated"))
    parser.add_argument("--endpoint", default="http://localhost:3000/api/training-generate")
    parser.add_argument("--env-file", type=Path, default=Path("frontend/.env.local"))
    parser.add_argument("--model", default="claude-opus-4-8")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    env = {**read_env(args.env_file), **{k: v for k, v in os.environ.items() if k.startswith("LLM_")}}
    cases = manifest.get("cases", [])
    results = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3))) as pool:
        futures = [pool.submit(generate_one, case, args, env) for case in cases]
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    results.sort(key=lambda item: item["caseNo"])
    report = {"model": args.model, "endpoint": args.endpoint, "results": results}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "generation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    failed = [item for item in results if item["status"] == "FAILED"]
    print(json.dumps({"generated": len(results) - len(failed), "failed": len(failed)}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
