"""作业批阅 Skills 的平台客户端与批量结果标准化工具。"""

from __future__ import annotations

import mimetypes
import re
import stat
import statistics
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional


UPLOAD_URL = "https://cloudapi.polymas.com/basic-resource/file/upload?hidden=false"
EXECUTE_URL = "https://cloudapi.polymas.com/ai-biz/v1/correction-skill/execute"
REPORT_URL = "https://cloudapi.polymas.com/ai-biz/v1/correction-skill/report-detail"
MODEL_LIST_URL = "https://cloudapi.polymas.com/flow/bot/v1/list/model"
OVERVIEW_URL = "https://cloudapi.polymas.com/ai-biz/v1/correction-skill/overview"
AGENT_SKILL_UPLOAD_URL = "https://cloudapi.polymas.com/ai-biz/v1/skill/create/unify/agentSkill"
SKILL_CARD_LIST_URL = "https://cloudapi.polymas.com/ai-biz/v1/skill/cardList"
SKILL_METADATA_SAVE_URL = "https://cloudapi.polymas.com/ai-biz/v1/skill/metadata/save"

SKILL_PACKAGE_ALLOWED_ROOT_FILES = {"README.md", "SKILL.md"}
SKILL_PACKAGE_ALLOWED_ROOT_DIRS = {"references", "scripts"}
SKILL_PACKAGE_EXCLUDED_PARTS = {".DS_Store", "__MACOSX", "__pycache__", "agents", "assets"}
SKILL_PACKAGE_EXCLUDED_SUFFIXES = {".pyc", ".pyo"}
SKILL_PACKAGE_MAX_FILES = 500
SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
SKILL_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
SKILL_NAME_RE = re.compile(r"^name:\s*[\"']?([a-z0-9]+(?:-[a-z0-9]+)*)[\"']?\s*$", re.M)
SKILL_DESCRIPTION_RE = re.compile(r"^description:\s*(.+)$", re.M)


class CorrectionSkillError(RuntimeError):
    """智慧树作业批阅 Skill 接口返回异常。"""


def validate_grading_skill_package(file_path: str) -> Dict[str, Any]:
    """按作业批阅技能模板校验 ZIP，并提取上传后元数据的回退值。"""
    path = Path(file_path)
    if path.suffix.lower() != ".zip" or not path.is_file() or not zipfile.is_zipfile(path):
        raise CorrectionSkillError("请上传有效的 .zip 作业批阅技能包")

    with zipfile.ZipFile(path) as archive:
        file_entries = [item for item in archive.infolist() if not item.is_dir()]
        if not file_entries:
            raise CorrectionSkillError("技能包为空")
        if len(file_entries) > SKILL_PACKAGE_MAX_FILES:
            raise CorrectionSkillError(f"技能包文件数超过 {SKILL_PACKAGE_MAX_FILES} 个")

        roots = set()
        normalized_entries: Dict[str, zipfile.ZipInfo] = {}
        uncompressed_size = 0
        for item in file_entries:
            raw_name = item.filename.replace("\\", "/")
            relative = PurePosixPath(raw_name)
            parts = relative.parts
            if relative.is_absolute() or not parts or any(part in {"", ".", ".."} for part in parts):
                raise CorrectionSkillError(f"技能包包含不安全路径：{item.filename}")
            file_mode = (item.external_attr >> 16) & 0o170000
            if file_mode == stat.S_IFLNK:
                raise CorrectionSkillError(f"技能包不允许符号链接：{item.filename}")
            if item.flag_bits & 0x1:
                raise CorrectionSkillError(f"技能包不允许加密文件：{item.filename}")
            if any(part in SKILL_PACKAGE_EXCLUDED_PARTS for part in parts):
                raise CorrectionSkillError(f"技能包包含模板外目录或缓存：{item.filename}")
            if PurePosixPath(parts[-1]).suffix.lower() in SKILL_PACKAGE_EXCLUDED_SUFFIXES:
                raise CorrectionSkillError(f"技能包包含缓存文件：{item.filename}")

            roots.add(parts[0])
            if len(parts) == 1:
                raise CorrectionSkillError("ZIP 内文件必须位于唯一的技能根目录中")
            if len(parts) == 2 and parts[1] not in SKILL_PACKAGE_ALLOWED_ROOT_FILES:
                raise CorrectionSkillError(f"技能根目录包含模板外文件：{item.filename}")
            if len(parts) > 2 and parts[1] not in SKILL_PACKAGE_ALLOWED_ROOT_DIRS:
                raise CorrectionSkillError(f"技能包包含模板外目录：{item.filename}")

            uncompressed_size += item.file_size
            if uncompressed_size > SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES:
                raise CorrectionSkillError("技能包解压后超过 100 MB")
            normalized_entries[raw_name] = item

        if len(roots) != 1:
            raise CorrectionSkillError("技能包必须且只能包含一个根目录")
        root_name = next(iter(roots))
        required = {
            f"{root_name}/README.md",
            f"{root_name}/SKILL.md",
        }
        missing = sorted(required - normalized_entries.keys())
        if missing:
            raise CorrectionSkillError("技能包缺少根目录下的 README.md 或 SKILL.md")

        try:
            skill_text = archive.read(normalized_entries[f"{root_name}/SKILL.md"]).decode("utf-8")
            readme_text = archive.read(normalized_entries[f"{root_name}/README.md"]).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CorrectionSkillError("README.md 和 SKILL.md 必须使用 UTF-8 编码") from exc

    frontmatter = SKILL_FRONTMATTER_RE.search(skill_text)
    if not frontmatter:
        raise CorrectionSkillError("SKILL.md 缺少有效 YAML frontmatter")
    name_match = SKILL_NAME_RE.search(frontmatter.group(1))
    description_match = SKILL_DESCRIPTION_RE.search(frontmatter.group(1))
    skill_name = name_match.group(1) if name_match else ""
    skill_description = (
        description_match.group(1).strip().strip("\"'")
        if description_match
        else ""
    )
    if not skill_name:
        raise CorrectionSkillError("SKILL.md frontmatter 的 name 缺失或格式不正确")
    if skill_name != root_name:
        raise CorrectionSkillError(
            f"技能根目录 {root_name!r} 与 frontmatter name {skill_name!r} 不一致"
        )
    if len(skill_description) < 30:
        raise CorrectionSkillError("SKILL.md frontmatter 的 description 缺失或过短")
    if "批阅技能 · 文件结构说明" not in readme_text:
        raise CorrectionSkillError("README.md 不符合指定作业批阅模板")
    for heading in ("## 批阅对象", "## 批阅流程", "## 1. 评分项（score）", "## 2. 评价项（evaluations）"):
        if heading not in skill_text:
            raise CorrectionSkillError(f"SKILL.md 缺少模板章节：{heading}")
    placeholders = [
        token for token in ("TODO", "【技能名称】", "【满分值】", "<skill-name>")
        if token in skill_text
    ]
    if placeholders:
        raise CorrectionSkillError("技能包仍含模板占位内容：" + "、".join(placeholders))

    display_name = skill_name
    skill_heading = re.search(r"^#\s+(.+?)\s*$", skill_text, re.M)
    if skill_heading:
        display_name = skill_heading.group(1).strip()[:80] or skill_name
    return {
        "rootName": root_name,
        "skillName": skill_name,
        "skillDescription": skill_description,
        "displayName": display_name,
        "fileCount": len(file_entries),
        "uncompressedBytes": uncompressed_size,
    }


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


def get_correction_skill_overview(
    skill_version_id: str,
    authorization: str,
    cookie: str,
    *,
    skill_type: str = "1",
    timeout_seconds: int = 120,
) -> Dict[str, Any]:
    """读取平台生成的作业批阅 Skill 概览。"""
    import requests

    response = requests.post(
        OVERVIEW_URL,
        headers=_headers(authorization, cookie, json_request=True),
        json={"skillVersionId": skill_version_id, "type": skill_type},
        timeout=timeout_seconds,
    )
    return _read_json_response(response, "生成 Skills 作业要求")


def upload_agent_skill_package(
    file_path: str,
    authorization: str,
    cookie: str,
    *,
    skill_type: str = "2",
    source: str = "BUILTIN",
    timeout_seconds: int = 300,
) -> Dict[str, str]:
    """上传一个已生成并校验通过的 Skill ZIP。"""
    import requests

    path = Path(file_path)
    mime_type = "application/zip"
    with path.open("rb") as source_file:
        response = requests.post(
            AGENT_SKILL_UPLOAD_URL,
            headers=_headers(authorization, cookie),
            data={"type": skill_type, "source": source},
            files={"zipFile": (path.name, source_file, mime_type)},
            timeout=timeout_seconds,
        )
    payload = _read_json_response(response, "上传 Skills 技能包")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    skill_nid = str(data.get("skillNid") or "").strip()
    skill_version_id = str(data.get("skillVersionNid") or data.get("skillVersionId") or "").strip()
    if not skill_nid or not skill_version_id:
        raise CorrectionSkillError("技能包上传成功，但响应缺少 skillNid 或 skillVersionNid")
    return {
        "skillNid": skill_nid,
        "skillVersionId": skill_version_id,
        "name": str(data.get("name") or "").strip(),
    }


def list_skill_cards(
    authorization: str,
    cookie: str,
    *,
    query_word: str = "",
    page_size: int = 50,
    timeout_seconds: int = 60,
) -> List[Dict[str, Any]]:
    """读取 Skill 卡片元数据，用于在切换类型时保留平台自动生成字段。"""
    import requests

    request_payload = {
        "pageNum": 1,
        "pageSize": min(100, max(1, page_size)),
        "typeTagId": None,
        "sourceTagId": None,
        "identityTagId": None,
        "customTagIds": [],
        "onlyMine": False,
        "queryWord": query_word,
        "showVerOption": False,
        "skillVersionStatus": None,
        "updateTimeOrder": "DESC",
    }
    response = requests.post(
        SKILL_CARD_LIST_URL,
        headers=_headers(authorization, cookie, json_request=True),
        json=request_payload,
        timeout=timeout_seconds,
    )
    payload = _read_json_response(response, "读取上传后的 Skill 元数据")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    records = data.get("records")
    if not isinstance(records, list):
        records = data.get("list") if isinstance(data.get("list"), list) else []
    return [item for item in records if isinstance(item, dict)]


def get_uploaded_skill_card(
    *,
    skill_nid: str,
    skill_name: str,
    authorization: str,
    cookie: str,
    attempts: int = 5,
    retry_interval_seconds: float = 1.0,
) -> Dict[str, Any]:
    """等待刚上传的 Skill 出现在卡片列表，并按 skillNid 精确匹配。"""
    for attempt in range(max(1, attempts)):
        records = list_skill_cards(
            authorization,
            cookie,
            query_word=skill_name,
        )
        matched = next(
            (item for item in records if str(item.get("skillNid") or "").strip() == skill_nid),
            None,
        )
        if matched:
            return matched
        if attempt + 1 < attempts:
            time.sleep(max(0.0, retry_interval_seconds))
    raise CorrectionSkillError(f"技能已上传（Skill NID：{skill_nid}），但暂未读取到其卡片元数据")


def build_grading_skill_metadata_payload(
    *,
    skill_nid: str,
    card: Dict[str, Any],
    fallback_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """在保留卡片元数据的前提下，仅把 Skill 类型切换为作业批阅。"""
    fallback = fallback_metadata or {}
    custom_tags = card.get("customTags") if isinstance(card.get("customTags"), list) else []
    custom_tag_ids = []
    for tag in custom_tags:
        if isinstance(tag, dict):
            tag_id = tag.get("id", tag.get("tagId"))
        else:
            tag_id = tag
        if tag_id is not None and str(tag_id).strip():
            custom_tag_ids.append(tag_id)

    return {
        "skillNid": skill_nid,
        "cnName": str(card.get("cnName") or fallback.get("displayName") or card.get("name") or "").strip(),
        "customTagIds": custom_tag_ids,
        "iconUrl": str(card.get("iconUrl") or fallback.get("iconUrl") or "").strip(),
        "identityTagId": card.get("identityTagId") or 0,
        "skillDesc": str(
            card.get("description")
            or fallback.get("skillDescription")
            or ""
        ).strip(),
        "sourceTagId": card.get("sourceTagId") or 0,
        "typeTagId": 1,
    }


def save_grading_skill_metadata(
    payload: Dict[str, Any],
    authorization: str,
    cookie: str,
    *,
    timeout_seconds: int = 60,
) -> Dict[str, Any]:
    """调用 metadata/save，把通用型 Skill 转为批阅类型 Skill。"""
    import requests

    response = requests.post(
        SKILL_METADATA_SAVE_URL,
        headers=_headers(authorization, cookie, json_request=True),
        json=payload,
        timeout=timeout_seconds,
    )
    result = _read_json_response(response, "设置 Skill 为批阅类型")
    if result.get("data") is not True:
        raise CorrectionSkillError(f"设置 Skill 为批阅类型未返回成功标记：{result}")
    return result


def upload_and_prepare_grading_skill(
    file_path: str,
    authorization: str,
    cookie: str,
) -> Dict[str, Any]:
    """校验、上传 Skill ZIP，并自动切换为可测试的批阅类型。"""
    package = validate_grading_skill_package(file_path)
    uploaded = upload_agent_skill_package(file_path, authorization, cookie)
    skill_name = uploaded.get("name") or package["skillName"]
    card = get_uploaded_skill_card(
        skill_nid=uploaded["skillNid"],
        skill_name=skill_name,
        authorization=authorization,
        cookie=cookie,
    )
    metadata_payload = build_grading_skill_metadata_payload(
        skill_nid=uploaded["skillNid"],
        card=card,
        fallback_metadata=package,
    )
    save_grading_skill_metadata(metadata_payload, authorization, cookie)

    from urllib.parse import urlencode

    preview_url = "https://pds.polymas.com/im-capability-square/preview-skill?" + urlencode({
        "skillNid": uploaded["skillNid"],
        "skillVersionId": uploaded["skillVersionId"],
        "versionStatus": "0",
        "type": "1",
        "tab": "preview",
    })
    return {
        **uploaded,
        "name": skill_name,
        "cnName": metadata_payload["cnName"],
        "description": metadata_payload["skillDesc"],
        "iconUrl": metadata_payload["iconUrl"],
        "typeTagId": 1,
        "metadataUpdated": True,
        "previewUrl": preview_url,
        "package": package,
    }


def build_submission_requirement_from_overview(response: Dict[str, Any]) -> str:
    """把 Skill 概览转换为可编辑的学生作业要求。"""
    data = response.get("data")
    if not isinstance(data, dict):
        raise CorrectionSkillError("Skills 概览接口未返回有效内容")

    skill = data.get("skill") if isinstance(data.get("skill"), dict) else {}
    extraction_status = str(skill.get("extractionStatus") or "").upper()
    if extraction_status and extraction_status != "SUCCESS":
        raise CorrectionSkillError(f"Skills 概览提取状态：{extraction_status}，请稍后重试")

    scoring = data.get("scoring") if isinstance(data.get("scoring"), dict) else {}
    score_data = scoring.get("scoreData") if isinstance(scoring.get("scoreData"), dict) else {}
    raw_items = score_data.get("items") if isinstance(score_data.get("items"), list) else []
    evaluations = data.get("evaluations") if isinstance(data.get("evaluations"), list) else []

    description = str(skill.get("description") or "").strip()
    full_mark = scoring.get("fullMark", score_data.get("fullMark"))
    item_split = str(score_data.get("itemSplit") or "").strip()
    lines: List[str] = ["一、作业内容"]
    lines.append(description or "请按照本作业的任务要求完成并提交作业成果。")

    if raw_items or item_split or full_mark is not None:
        score_title = "二、评分要求"
        if full_mark is not None:
            score_title += f"（满分 {full_mark} 分）"
        lines.extend(["", score_title])
        if item_split:
            lines.append(item_split)
        for position, item in enumerate(raw_items, start=1):
            if not isinstance(item, dict):
                continue
            index = item.get("itemIndex") or position
            content = str(item.get("itemContent") or item.get("itemName") or f"评分项 {index}").strip()
            item_mark = item.get("itemFullMark")
            title = f"{index}. {content}"
            if item_mark is not None:
                title += f"（{item_mark} 分）"
            lines.append(title)
            item_description = str(item.get("itemDescription") or "").strip()
            if item_description:
                lines.append(item_description)

    valid_evaluations = [item for item in evaluations if isinstance(item, dict)]
    if valid_evaluations:
        lines.extend(["", "三、提交质量要求"])
        for item in valid_evaluations:
            name = str(item.get("evaluationName") or "").strip()
            evaluation_description = str(item.get("evaluationDescription") or "").strip()
            if name:
                lines.append(f"- {name}{f'：{evaluation_description}' if evaluation_description else ''}")

    requirement = "\n".join(lines).strip()
    if not description and not raw_items:
        raise CorrectionSkillError("Skills 概览中缺少作业描述和评分项")
    return requirement


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
