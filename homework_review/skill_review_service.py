"""作业批阅 Skills 的平台客户端与批量结果标准化工具。"""

from __future__ import annotations

import mimetypes
import statistics
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


UPLOAD_URL = "https://cloudapi.polymas.com/basic-resource/file/upload?hidden=false"
EXECUTE_URL = "https://cloudapi.polymas.com/ai-biz/v1/correction-skill/execute"
REPORT_URL = "https://cloudapi.polymas.com/ai-biz/v1/correction-skill/report-detail"
MODEL_LIST_URL = "https://cloudapi.polymas.com/flow/bot/v1/list/model"


class CorrectionSkillError(RuntimeError):
    """智慧树作业批阅 Skill 接口返回异常。"""


def _headers(authorization: str, cookie: str, *, json_request: bool = False) -> Dict[str, str]:
    headers = {
        "Authorization": authorization,
        "Cookie": cookie,
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
        ),
    }
    if json_request:
        headers["Content-Type"] = "application/json; charset=utf-8"
    return headers


def _read_json_response(response: Any, operation: str) -> Dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        preview = response.text[:500]
        raise CorrectionSkillError(
            f"{operation}返回了非 JSON 响应（HTTP {response.status_code}）：{preview}"
        ) from exc

    if not response.ok:
        message = payload.get("msg") or payload.get("message") or payload.get("error")
        raise CorrectionSkillError(f"{operation}失败（HTTP {response.status_code}）：{message or payload}")

    code = payload.get("code")
    success = payload.get("success")
    if (code is not None and code != 200) or success is False:
        message = payload.get("msg") or payload.get("message") or payload.get("error")
        raise CorrectionSkillError(f"{operation}失败：{message or payload}")
    return payload


def upload_student_attachment(
    file_path: str,
    authorization: str,
    cookie: str,
    *,
    timeout_seconds: int = 180,
) -> Dict[str, str]:
    """上传一份学生作业，返回 Skill 执行接口需要的附件对象。"""
    import requests

    path = Path(file_path)
    if not path.is_file():
        raise CorrectionSkillError(f"学生作业文件不存在：{path.name}")

    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    identify_code = str(uuid.uuid4())
    data = {
        "identifyCode": identify_code,
        "name": path.name,
        "chunk": "0",
        "chunks": "1",
        "size": str(path.stat().st_size),
    }
    with path.open("rb") as source:
        response = requests.post(
            UPLOAD_URL,
            headers=_headers(authorization, cookie),
            data=data,
            files={"file": (path.name, source, mime_type)},
            timeout=timeout_seconds,
        )
    payload = _read_json_response(response, f"上传「{path.name}」")
    uploaded = payload.get("data") or {}
    oss_url = uploaded.get("ossUrl")
    if not oss_url:
        raise CorrectionSkillError(f"上传「{path.name}」成功，但响应缺少 ossUrl")

    suffix = (uploaded.get("suffix") or path.suffix.lstrip(".") or "file").lower()
    return {
        "type": suffix,
        "url": str(oss_url),
        "fileId": str(uploaded.get("fileId") or ""),
        "fileName": str(uploaded.get("originFileName") or uploaded.get("fileName") or path.name),
    }


def execute_correction_skill(
    *,
    skill_version_id: str,
    task_id: str,
    model_name: str,
    submission_requirement: str,
    student_submission: str,
    student_attachments: List[Dict[str, str]],
    requirement_attachments: Optional[List[Dict[str, str]]],
    authorization: str,
    cookie: str,
    timeout_seconds: int = 60,
) -> Dict[str, Any]:
    import requests

    payload = {
        "skillVersionId": skill_version_id,
        "taskId": task_id,
        "isTestRun": True,
        "modelName": model_name,
        "requirementAttachments": requirement_attachments or [],
        "studentAttachments": [
            {"type": item["type"], "url": item["url"]}
            for item in student_attachments
        ],
        "studentSubmission": student_submission,
        "submissionRequirement": submission_requirement,
    }
    response = requests.post(
        EXECUTE_URL,
        headers=_headers(authorization, cookie, json_request=True),
        json=payload,
        timeout=timeout_seconds,
    )
    result = _read_json_response(response, "启动 Skills 批阅")
    if result.get("data") is not True:
        raise CorrectionSkillError(f"启动 Skills 批阅未返回成功标记：{result}")
    return result


def get_correction_skill_report(
    task_id: str,
    authorization: str,
    cookie: str,
    *,
    timeout_seconds: int = 60,
) -> Dict[str, Any]:
    import requests

    response = requests.get(
        REPORT_URL,
        headers=_headers(authorization, cookie),
        params={"taskId": task_id},
        timeout=timeout_seconds,
    )
    return _read_json_response(response, "读取 Skills 批阅报告")


def normalize_skill_models(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """将 scene=8 模型列表标准化为前端下拉框结构。

    平台当前返回 data 数组，元素核心字段为 code、description、
    logo 和 defaultFlag。兼容少量旧字段，但不会把批阅报告 taskId 误认为模型。
    """
    data = response.get("data")
    if isinstance(data, list):
        raw_models = data
    elif isinstance(data, dict):
        raw_models = next(
            (
                data.get(key)
                for key in ("models", "records", "rows", "list")
                if isinstance(data.get(key), list)
            ),
            [],
        )
    else:
        raw_models = []

    models: List[Dict[str, Any]] = []
    seen = set()
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        code = item.get("code") or item.get("modelCode") or item.get("modelName")
        if not isinstance(code, str) or not code.strip():
            continue
        normalized_code = code.strip()
        if normalized_code in seen:
            continue
        seen.add(normalized_code)
        default_flag = item.get("defaultFlag")
        models.append({
            "code": normalized_code,
            "description": str(
                item.get("description")
                or item.get("displayName")
                or item.get("name")
                or normalized_code
            ),
            "logo": str(item.get("logo") or item.get("icon") or ""),
            "isDefault": default_flag is True or str(default_flag).strip() == "1",
        })

    if not models:
        raise CorrectionSkillError("模型列表接口未返回可用模型")
    return models


def list_correction_skill_models(
    authorization: str,
    cookie: str,
    *,
    scene: int = 8,
    timeout_seconds: int = 60,
) -> List[Dict[str, Any]]:
    """读取作业批阅 Skills 可选模型。"""
    import requests

    response = requests.get(
        MODEL_LIST_URL,
        headers=_headers(authorization, cookie),
        params={"scene": scene},
        timeout=timeout_seconds,
    )
    payload = _read_json_response(response, "读取 Skills 批阅模型")
    return normalize_skill_models(payload)


def decode_surface_value(value: Any) -> Any:
    """把 surfaces 使用的 valueString/valueArray/valueMap 协议解码为普通 JSON。"""
    if not isinstance(value, dict):
        return value
    for field in ("valueString", "valueNumber", "valueBoolean"):
        if field in value:
            return value[field]
    if "valueArray" in value:
        return [decode_surface_value(item) for item in value.get("valueArray") or []]
    if "valueMap" in value:
        return {
            str(item.get("key", "")): decode_surface_value(item)
            for item in value.get("valueMap") or []
            if isinstance(item, dict) and item.get("key") is not None
        }
    if "key" in value:
        remaining = {key: item for key, item in value.items() if key != "key"}
        return {str(value.get("key")): decode_surface_value(remaining)}
    return {key: decode_surface_value(item) for key, item in value.items()}


def extract_surface_sections(surfaces: Any) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = []
    for surface in surfaces if isinstance(surfaces, list) else []:
        if not isinstance(surface, dict):
            continue
        contents = ((surface.get("dataModelUpdate") or {}).get("contents") or [])
        decoded: Dict[str, Any] = {}
        for item in contents:
            if isinstance(item, dict) and item.get("key") is not None:
                decoded[str(item["key"])] = decode_surface_value(item)
        sections.append({
            "surfaceId": surface.get("surfaceId"),
            "templateType": surface.get("templateType"),
            "title": decoded.get("sectionTitle") or "",
            "cards": decoded.get("cards") or [],
            "entries": decoded.get("entries") or [],
        })
    return sections


def compact_skill_report(
    response: Dict[str, Any],
    *,
    file_name: str,
    file_index: int,
    attempt_index: int,
    task_id: str,
    report_url: str,
) -> Dict[str, Any]:
    data = response.get("data") or {}
    skill = data.get("skill") or {}
    scoring = data.get("scoring") or {}
    score_data = scoring.get("scoreData") or {}
    raw_items = score_data.get("items") or []
    items = [
        {
            "itemIndex": item.get("itemIndex"),
            "itemName": item.get("itemName") or "未命名评分项",
            "itemScore": item.get("itemScore"),
            "itemFullMark": item.get("itemFullMark"),
            "comment": item.get("comment") or "",
        }
        for item in raw_items
        if isinstance(item, dict)
    ]
    total_score = score_data.get("totalScore", scoring.get("totalScore"))
    full_mark = score_data.get("fullMark")
    if full_mark is None:
        full_mark = sum(
            float(item["itemFullMark"])
            for item in items
            if isinstance(item.get("itemFullMark"), (int, float))
        ) or 100

    return {
        "success": str(skill.get("reportStatus") or "").upper() == "SUCCESS",
        "fileName": file_name,
        "fileIndex": file_index,
        "attemptIndex": attempt_index,
        "taskId": task_id,
        "reportUrl": report_url,
        "reportStatus": skill.get("reportStatus"),
        "skillName": skill.get("name"),
        "skillDescription": skill.get("description"),
        "createTime": skill.get("createTime"),
        "finishedAt": skill.get("finishedAt"),
        "scoringType": scoring.get("scoringType"),
        "totalScore": total_score,
        "fullMark": full_mark,
        "items": items,
        "sections": extract_surface_sections(data.get("surfaces")),
    }


def _stats(values: Iterable[Optional[float]]) -> Dict[str, Optional[float]]:
    valid = [float(value) for value in values if isinstance(value, (int, float))]
    if not valid:
        return {"mean": None, "variance": None}
    mean = round(statistics.fmean(valid), 2)
    variance = round(statistics.pvariance(valid), 2) if len(valid) > 1 else 0.0
    return {"mean": mean, "variance": variance}


def build_skill_score_table(results: List[Dict[str, Any]], attempts: int) -> Dict[str, Any]:
    by_file: Dict[int, List[Dict[str, Any]]] = {}
    for result in results:
        by_file.setdefault(int(result.get("fileIndex", 0)), []).append(result)

    students = []
    for file_index in sorted(by_file):
        file_results = sorted(by_file[file_index], key=lambda item: int(item.get("attemptIndex", 0)))
        first = file_results[0]
        full_mark = max(
            [float(item.get("fullMark")) for item in file_results if isinstance(item.get("fullMark"), (int, float))]
            or [100.0]
        )
        total_scores: List[Optional[float]] = [None] * attempts
        item_map: Dict[str, Dict[str, Any]] = {}
        item_order: List[str] = []

        for result in file_results:
            attempt_index = int(result.get("attemptIndex", 0))
            if 1 <= attempt_index <= attempts and result.get("success"):
                score = result.get("totalScore")
                total_scores[attempt_index - 1] = float(score) if isinstance(score, (int, float)) else None
            for item in result.get("items") or []:
                name = str(item.get("itemName") or "未命名评分项")
                if name not in item_map:
                    item_order.append(name)
                    item_map[name] = {
                        "scores": [None] * attempts,
                        "total": item.get("itemFullMark"),
                    }
                if 1 <= attempt_index <= attempts and result.get("success"):
                    item_score = item.get("itemScore")
                    item_map[name]["scores"][attempt_index - 1] = (
                        float(item_score) if isinstance(item_score, (int, float)) else None
                    )

        total_stats = _stats(total_scores)
        questions = []
        for name in item_order:
            item = item_map[name]
            item_stats = _stats(item["scores"])
            questions.append({
                "name": name,
                "total": item.get("total"),
                "scores": item["scores"],
                **item_stats,
            })

        students.append({
            "name": Path(str(first.get("fileName") or f"作业{file_index + 1}")).stem,
            "full_mark": full_mark,
            "total_scores": total_scores,
            **total_stats,
            "categories": [],
            "questions": questions,
            "dimensions": [],
        })

    return {"attempts": attempts, "students": students}


def platform_report_url(
    *,
    skill_version_id: str,
    skill_nid: str,
    task_id: str,
) -> str:
    from urllib.parse import urlencode

    query = urlencode({
        "skillVersionId": skill_version_id,
        "skillNid": skill_nid,
        "type": "1",
        "tab": "preview",
        "taskId": task_id,
    })
    return f"https://pds.polymas.com/im-capability-square/preview-skill/report?{query}"
