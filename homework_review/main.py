"""
作业批阅后端API服务
提供生成学生答案和批阅评测功能
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse

app = FastAPI(title="作业批阅API", version="1.0.0")

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 获取当前脚本目录
SCRIPT_DIR = Path(__file__).parent
GENERATE_SCRIPT = SCRIPT_DIR / "generate_and_review_service.py"
REVIEW_SCRIPT = SCRIPT_DIR / "review_service.py"

MAX_REVIEW_FILES = 150
DEFAULT_REVIEW_CONCURRENCY = 5
MAX_REVIEW_CONCURRENCY = 10
MAX_ACTIVE_REVIEW_JOBS = 1
REVIEW_UPLOAD_CHUNK_SIZE = 1024 * 1024

# Asynchronous review jobs intentionally live in the service process and /tmp.
# The opaque job id is the only handle exposed to the browser; credentials are
# passed straight to the worker environment and are never written to job state.
REVIEW_JOBS: Dict[str, Dict[str, Any]] = {}
REVIEW_JOB_TASKS: set[asyncio.Task] = set()
REVIEW_JOB_SEMAPHORE = asyncio.Semaphore(MAX_ACTIVE_REVIEW_JOBS)
REVIEW_JOBS_ROOT = Path(tempfile.gettempdir()) / "homework_review_jobs"
REVIEW_JOBS_ROOT.mkdir(parents=True, exist_ok=True)

# 确保.env文件存在（子脚本会尝试加载它，不存在会报错）
env_file = SCRIPT_DIR / ".env"
if not env_file.exists():
    env_file.touch()


def clamp_review_concurrency(value: int) -> int:
    return min(MAX_REVIEW_CONCURRENCY, max(1, int(value)))


def get_review_job(job_id: str) -> Dict[str, Any]:
    job = REVIEW_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="批阅任务不存在或服务已重启")
    return job


def append_review_job_log(job: Dict[str, Any], message: str, level: str = "info") -> None:
    job["logs"].append({
        "index": len(job["logs"]),
        "message": message,
        "level": level,
    })
    job["updatedAt"] = datetime.now(timezone.utc).isoformat()


def safe_upload_name(filename: str) -> str:
    basename = Path(filename or "file").name
    safe = "".join(
        ch if ch.isalnum() or ch in "-_.()[] " or "\u4e00" <= ch <= "\u9fff" else "_"
        for ch in basename
    ).strip(" .")
    return safe[:180] or "file"


def unique_upload_path(upload_dir: Path, filename: str) -> Path:
    candidate = upload_dir / safe_upload_name(filename)
    if not candidate.exists():
        return candidate

    stem, suffix = candidate.stem, candidate.suffix
    index = 2
    while True:
        candidate = upload_dir / f"{stem}({index}){suffix}"
        if not candidate.exists():
            return candidate
        index += 1


async def terminate_review_job_process(job: Dict[str, Any]) -> None:
    process = job.get("_process")
    if process is None or process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def execute_async_review_job(
    job_id: str,
    *,
    authorization: str,
    cookie: str,
    instance_nid: str,
    attempts: int,
    output_format: str,
    max_concurrency: int,
    local_parse: bool,
    llm_api_key: str,
    llm_api_url: str,
    llm_model: str,
    skip_llm_files: Optional[str],
    file_groups: Optional[str],
) -> None:
    job = get_review_job(job_id)
    job["status"] = "running"
    append_review_job_log(
        job,
        f"🚀 后台批阅已启动：{len(job['files'])} 份作业，每份 {attempts} 次，并发 {max_concurrency}",
    )

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["AUTHORIZATION"] = authorization
    env["COOKIE"] = cookie
    env["INSTANCE_NID"] = instance_nid
    env["LLM_API_KEY"] = llm_api_key or os.getenv("LLM_API_KEY", "")
    env["LLM_API_URL"] = llm_api_url or os.getenv("LLM_API_URL", "")
    env["LLM_MODEL"] = llm_model or os.getenv("LLM_MODEL", "")

    cmd = [
        sys.executable, "-u", str(REVIEW_SCRIPT),
        "--inputs", json.dumps(job["files"]),
        "--attempts", str(max(1, attempts)),
        "--output-format", output_format,
        "--output-root", job["outputRoot"],
        "--max-concurrency", str(clamp_review_concurrency(max_concurrency)),
        "--compact-result",
    ]
    if local_parse:
        cmd.append("--local-parse")
    if skip_llm_files:
        cmd.extend(["--skip-llm-files", skip_llm_files])
    if file_groups:
        cmd.extend(["--file-groups", file_groups])

    result_payload: Optional[Dict[str, Any]] = None
    process: Optional[asyncio.subprocess.Process] = None
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(SCRIPT_DIR),
            limit=32 * 1024 * 1024,
        )
        job["pid"] = process.pid
        job["_process"] = process

        async def read_stdout() -> None:
            nonlocal result_payload
            assert process.stdout is not None
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                message = line.decode(errors="replace").strip()
                if not message:
                    continue
                if message.startswith("__RESULT__"):
                    result_payload = json.loads(message[len("__RESULT__"):])
                else:
                    append_review_job_log(job, message)

        async def read_stderr() -> None:
            assert process.stderr is not None
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                message = line.decode(errors="replace").strip()
                if message:
                    append_review_job_log(job, f"⚠️ {message}", "warn")

        await asyncio.gather(read_stdout(), read_stderr())
        return_code = await process.wait()
        if return_code != 0:
            raise RuntimeError(f"批阅进程退出码 {return_code}")
        if not result_payload:
            raise RuntimeError("批阅结果缺少完成标记")

        output_root = Path(job["outputRoot"])
        absolute_files = [str(output_root / item) for item in result_payload.get("output_files", [])]
        job["result"] = {
            "jobId": job_id,
            "outputFiles": absolute_files,
            "summary": result_payload.get("result", {}),
            "scoreTable": result_payload.get("score_table"),
            "downloadBaseUrl": "/api/homework-review/download",
        }
        job["status"] = "completed"
        append_review_job_log(job, "🎉 全部批阅完成")
    except asyncio.CancelledError:
        await terminate_review_job_process(job)
        if job.get("status") != "cancelled":
            job["status"] = "cancelled"
            append_review_job_log(job, "⏹️ 批阅任务已取消", "warn")
        raise
    except Exception as exc:
        if process is not None and process.returncode is None:
            await terminate_review_job_process(job)
        job["status"] = "failed"
        job["error"] = str(exc)
        append_review_job_log(job, f"❌ 批阅任务失败：{exc}", "error")
    finally:
        job.pop("pid", None)
        job.pop("_process", None)
        job["updatedAt"] = datetime.now(timezone.utc).isoformat()


async def run_async_review_job(job_id: str, **settings: Any) -> None:
    """Keep aggregate platform pressure bounded even when users submit together."""
    job = get_review_job(job_id)
    if REVIEW_JOB_SEMAPHORE.locked():
        append_review_job_log(job, "⏳ 已进入全局队列，当前有其他批阅任务在执行")
    async with REVIEW_JOB_SEMAPHORE:
        if job.get("cancelRequested"):
            return
        await execute_async_review_job(job_id, **settings)


@app.get("/")
async def root():
    return {
        "service": "作业批阅API",
        "status": "running",
        "message": "API服务正常运行"
    }


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/api/files")
async def download_file(path: str = Query(..., description="文件路径")):
    """下载服务器上的临时文件（用于生成后的批阅流程）"""
    file_path = Path(path)
    if not file_path.exists():
        raise HTTPException(
            status_code=404, 
            detail=f"文件不存在（可能服务已重启）: {path}"
        )
    # 安全检查：只允许下载/tmp目录下的文件
    if not str(file_path.resolve()).startswith("/tmp/"):
        raise HTTPException(status_code=403, detail="只允许访问临时文件")
    return FileResponse(
        file_path,
        filename=file_path.name,
        media_type="application/octet-stream",
    )


@app.get("/api/preview")
async def preview_file(path: str = Query(..., description="文件路径")):
    """预览文件 - 支持 docx/pdf/ppt/pptx"""
    file_path = Path(path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"文件不存在: {path}")
    if not str(file_path.resolve()).startswith("/tmp/"):
        raise HTTPException(status_code=403, detail="只允许访问临时文件")
    
    ext = file_path.suffix.lower()
    
    if ext in (".ppt", ".pptx"):
        # PPT 文件返回简要信息
        try:
            from pptx import Presentation
            prs = Presentation(str(file_path))
            slide_count = len(prs.slides)
            html = f"<p>📊 PPT 文件: {file_path.name}</p><p>共 {slide_count} 页幻灯片</p><p style='color:#b45309;font-size:0.85em'>PPT 类型作业跳过 LLM 校验</p>"
        except ImportError:
            html = f"<p>📊 PPT 文件: {file_path.name}</p><p style='color:#b45309;font-size:0.85em'>PPT 类型作业跳过 LLM 校验</p>"
        except Exception as e:
            html = f"<p>📊 PPT 文件: {file_path.name}</p><p style='color:red'>预览失败: {str(e)}</p>"
        return {"html": html, "fileName": file_path.name}
    
    if ext == ".pdf":
        html = f"<p>📄 PDF 文件: {file_path.name}</p><p style='color:#6366f1;font-size:0.85em'>PDF 文件将通过云端解析</p>"
        return {"html": html, "fileName": file_path.name}
    
    if ext not in (".docx", ".doc"):
        raise HTTPException(status_code=400, detail="仅支持预览 .docx/.pdf/.ppt/.pptx 文件")
    
    try:
        from docx import Document
        doc = Document(str(file_path))
        paragraphs = []
        for p in doc.paragraphs:
            text = p.text.strip()
            if text:
                # 简单样式处理
                if p.style and p.style.name and "Heading" in p.style.name:
                    paragraphs.append(f"<h3>{text}</h3>")
                else:
                    paragraphs.append(f"<p>{text}</p>")
        html = "\n".join(paragraphs) if paragraphs else "<p>文档内容为空</p>"
        return {"html": html, "fileName": file_path.name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"预览失败: {str(e)}")


@app.get("/test")
async def test():
    """测试环境变量"""
    return {
        "env": {
            "PORT": os.getenv("PORT", "未设置"),
            "LLM_API_KEY": "已设置" if os.getenv("LLM_API_KEY") else "未设置",
            "AUTHORIZATION": "前端传递" if not os.getenv("AUTHORIZATION") else "已设置"
        },
        "generate_script": str(GENERATE_SCRIPT),
        "generate_script_exists": GENERATE_SCRIPT.exists(),
        "review_script": str(REVIEW_SCRIPT),
        "review_script_exists": REVIEW_SCRIPT.exists(),
    }


@app.post("/api/generate")
async def generate_answers(
    file: Optional[UploadFile] = File(None),
    exam_text: Optional[str] = Form(None),
    exam_title: Optional[str] = Form(None),
    authorization: Optional[str] = Form(None),
    cookie: Optional[str] = Form(None),
    instance_nid: Optional[str] = Form(None),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    levels: Optional[str] = Form(None),
    auto_review: Optional[str] = Form(None),
    custom_prompt: Optional[str] = Form(None),
    custom_levels: Optional[str] = Form(None),
):
    """生成学生答案 - 调用 generate_and_review_service.py"""
    
    # 创建临时目录
    temp_dir = Path(tempfile.mkdtemp(prefix="homework_"))
    output_root = temp_dir / "output"
    output_root.mkdir(exist_ok=True)
    exam_file: Optional[Path] = None
    text_input_file: Optional[Path] = None

    raw_exam_text = exam_text or ""
    if not file and not raw_exam_text.strip():
        raise HTTPException(status_code=400, detail="请上传题卷文件或粘贴题卷文字")

    if file and file.filename:
        exam_file = temp_dir / file.filename
        content = await file.read()
        exam_file.write_bytes(content)
    elif raw_exam_text.strip():
        safe_title = (exam_title or "作业").strip() or "作业"
        safe_title = "".join(ch if ch.isalnum() or ch in "-_." or "\u4e00" <= ch <= "\u9fff" else "_" for ch in safe_title)[:40]
        text_input_file = temp_dir / f"{safe_title or '作业'}.txt"
        text_input_file.write_text(raw_exam_text, encoding="utf-8")
    
    # 解析等级 - 前端发送的是字符串数组 ["优秀的回答", "良好的回答", ...]
    levels_list = ["优秀的回答", "良好的回答", "中等的回答", "合格的回答", "较差的回答"]
    if levels:
        try:
            parsed = json.loads(levels)
            if isinstance(parsed, list) and len(parsed) > 0:
                levels_list = parsed
        except json.JSONDecodeError:
            pass
    
    # 创建环境变量 - 始终设置认证变量（子脚本会检查这些变量来决定是否加载.env）
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["AUTHORIZATION"] = authorization or ""
    env["COOKIE"] = cookie or ""
    env["INSTANCE_NID"] = instance_nid or ""
    env["LLM_API_KEY"] = llm_api_key or os.getenv("LLM_API_KEY", "")
    env["LLM_API_URL"] = llm_api_url or os.getenv("LLM_API_URL", "")
    env["LLM_MODEL"] = llm_model or os.getenv("LLM_MODEL", "")
    if custom_prompt:
        env["CUSTOM_PROMPT"] = custom_prompt
    if custom_levels:
        env["CUSTOM_LEVELS"] = custom_levels
    
    # 构建命令行参数 - 与前端本地模式一致
    cmd = [
        sys.executable, "-u",
        str(GENERATE_SCRIPT),
        "--output-root", str(output_root),
        "--levels", *levels_list,
        "--llm-api-key", llm_api_key or os.getenv("LLM_API_KEY", ""),
        "--llm-api-url", llm_api_url or os.getenv("LLM_API_URL", ""),
        "--llm-model", llm_model or os.getenv("LLM_MODEL", ""),
    ]
    if exam_file is not None:
        cmd[3:3] = ["--input", str(exam_file)]
    elif text_input_file is not None:
        cmd[3:3] = ["--input-text-file", str(text_input_file)]
        if exam_title and exam_title.strip():
            cmd[5:5] = ["--input-title", exam_title.strip()]
    
    async def event_stream():
        """SSE流式响应 - 读取子进程的JSON行协议输出"""
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRIPT_DIR),
                limit=10 * 1024 * 1024,  # 10MB行缓冲，防止大JSON超限
            )
            
            # 读取stdout（JSON行协议），带心跳保活防止Railway空闲超时
            while True:
                try:
                    line = await asyncio.wait_for(process.stdout.readline(), timeout=15)
                except asyncio.TimeoutError:
                    # 子进程无输出时发送SSE心跳注释，防止Railway 60秒空闲断连
                    yield ": heartbeat\n\n"
                    continue
                if not line:
                    break
                msg = line.decode().strip()
                if not msg:
                    continue
                # generate_and_review_service.py 输出JSON行协议
                # 直接转发为SSE
                try:
                    data = json.loads(msg)
                    yield f'data: {json.dumps(data, ensure_ascii=False)}\n\n'
                except json.JSONDecodeError:
                    # 非JSON行作为日志
                    yield f'data: {json.dumps({"type": "log", "message": msg}, ensure_ascii=False)}\n\n'
            
            await process.wait()
            
            if process.returncode != 0:
                stderr = await process.stderr.read()
                err_msg = stderr.decode().strip()
                if err_msg:
                    yield f'data: {json.dumps({"type": "error", "message": err_msg}, ensure_ascii=False)}\n\n'
                
        except Exception as e:
            yield f'data: {json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False)}\n\n'
        finally:
            yield f'data: {json.dumps({"type": "done"})}\n\n'
    
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@app.post("/api/review/jobs", status_code=201)
async def create_review_job():
    """Create an upload session for a long-running review job."""
    job_id = uuid.uuid4().hex
    job_dir = REVIEW_JOBS_ROOT / job_id
    upload_dir = job_dir / "uploads"
    output_root = job_dir / "output"
    upload_dir.mkdir(parents=True, exist_ok=False)
    output_root.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    REVIEW_JOBS[job_id] = {
        "jobId": job_id,
        "status": "uploading",
        "files": [],
        "uploadedNames": [],
        "uploadBatches": {},
        "chunkUploads": {},
        "uploadDir": str(upload_dir),
        "outputRoot": str(output_root),
        "logs": [],
        "result": None,
        "error": None,
        "cancelRequested": False,
        "createdAt": now,
        "updatedAt": now,
    }
    return {
        "jobId": job_id,
        "status": "uploading",
        "maxFiles": MAX_REVIEW_FILES,
        "maxConcurrency": MAX_REVIEW_CONCURRENCY,
    }


@app.post("/api/review/jobs/{job_id}/files")
async def upload_review_job_files(
    job_id: str,
    files: List[UploadFile] = File(...),
    upload_batch_id: str = Form(...),
    file_keys: Optional[str] = Form(None),
):
    """Upload one idempotent chunk of files into an asynchronous job."""
    job = get_review_job(job_id)
    if job["status"] != "uploading":
        raise HTTPException(status_code=409, detail="当前任务已结束上传阶段")

    batch_id = upload_batch_id.strip()
    if not batch_id:
        raise HTTPException(status_code=400, detail="upload_batch_id 不能为空")
    cached = job["uploadBatches"].get(batch_id)
    if cached:
        return cached

    valid_files = [item for item in files if item.filename]
    if not valid_files:
        raise HTTPException(status_code=400, detail="请至少上传一个作业文件")
    pending_chunks = sum(1 for item in job["chunkUploads"].values() if not item.get("complete"))
    if len(job["files"]) + pending_chunks + len(valid_files) > MAX_REVIEW_FILES:
        raise HTTPException(status_code=400, detail=f"每个批阅任务最多 {MAX_REVIEW_FILES} 份文件")

    parsed_keys: List[str] = []
    if file_keys:
        try:
            value = json.loads(file_keys)
            if isinstance(value, list):
                parsed_keys = [str(item) for item in value]
        except json.JSONDecodeError:
            pass

    upload_dir = Path(job["uploadDir"])
    uploaded = []
    for index, upload in enumerate(valid_files):
        target = unique_upload_path(upload_dir, upload.filename or "file")
        with target.open("wb") as output:
            while True:
                chunk = await upload.read(REVIEW_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                output.write(chunk)
        await upload.close()
        job["files"].append(str(target))
        job["uploadedNames"].append(target.name)
        uploaded.append({
            "clientKey": parsed_keys[index] if index < len(parsed_keys) else "",
            "originalName": upload.filename,
            "storedName": target.name,
        })

    response = {
        "jobId": job_id,
        "uploaded": uploaded,
        "uploadedCount": len(job["files"]),
        "maxFiles": MAX_REVIEW_FILES,
    }
    job["uploadBatches"][batch_id] = response
    append_review_job_log(job, f"📦 已上传 {len(job['files'])}/{MAX_REVIEW_FILES} 份文件")
    return response


@app.post("/api/review/jobs/{job_id}/chunks")
async def upload_review_job_chunk(
    job_id: str,
    file: UploadFile = File(...),
    upload_id: str = Form(...),
    client_key: str = Form(""),
    original_name: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
):
    """Append one idempotent chunk for a large file."""
    job = get_review_job(job_id)
    if job["status"] != "uploading":
        raise HTTPException(status_code=409, detail="当前任务已结束上传阶段")
    if not upload_id.strip() or total_chunks < 1 or chunk_index < 0 or chunk_index >= total_chunks:
        raise HTTPException(status_code=400, detail="分片参数不正确")

    chunk_uploads = job["chunkUploads"]
    state = chunk_uploads.get(upload_id)
    if state is None:
        pending_count = sum(1 for item in chunk_uploads.values() if not item.get("complete"))
        if len(job["files"]) + pending_count >= MAX_REVIEW_FILES:
            raise HTTPException(status_code=400, detail=f"每个批阅任务最多 {MAX_REVIEW_FILES} 份文件")
        target = unique_upload_path(Path(job["uploadDir"]), original_name)
        state = {
            "target": str(target),
            "part": str(target.with_name(f".{target.name}.{upload_id}.part")),
            "nextChunk": 0,
            "totalChunks": total_chunks,
            "clientKey": client_key,
            "originalName": original_name,
            "complete": False,
        }
        chunk_uploads[upload_id] = state

    if state["complete"]:
        return {
            "jobId": job_id,
            "complete": True,
            "uploadedCount": len(job["files"]),
            "uploaded": {
                "clientKey": state["clientKey"],
                "originalName": state["originalName"],
                "storedName": Path(state["target"]).name,
            },
        }
    if total_chunks != state["totalChunks"]:
        raise HTTPException(status_code=409, detail="分片总数与已建立的上传会话不一致")
    if chunk_index < state["nextChunk"]:
        return {
            "jobId": job_id,
            "complete": False,
            "nextChunk": state["nextChunk"],
            "uploadedCount": len(job["files"]),
        }
    if chunk_index != state["nextChunk"]:
        raise HTTPException(status_code=409, detail=f"请先上传第 {state['nextChunk'] + 1} 个分片")

    content = await file.read()
    await file.close()
    with Path(state["part"]).open("ab") as output:
        output.write(content)
    state["nextChunk"] += 1

    if state["nextChunk"] == state["totalChunks"]:
        part_path = Path(state["part"])
        target_path = Path(state["target"])
        part_path.replace(target_path)
        state["complete"] = True
        job["files"].append(str(target_path))
        job["uploadedNames"].append(target_path.name)
        append_review_job_log(job, f"📦 已上传 {len(job['files'])}/{MAX_REVIEW_FILES} 份文件")

    return {
        "jobId": job_id,
        "complete": state["complete"],
        "nextChunk": state["nextChunk"],
        "uploadedCount": len(job["files"]),
        "uploaded": {
            "clientKey": state["clientKey"],
            "originalName": state["originalName"],
            "storedName": Path(state["target"]).name,
        } if state["complete"] else None,
    }


@app.post("/api/review/jobs/{job_id}/start", status_code=202)
async def start_review_job(
    job_id: str,
    authorization: str = Form(...),
    cookie: str = Form(...),
    instance_nid: str = Form(...),
    attempts: int = Form(5),
    output_format: str = Form("json"),
    max_concurrency: int = Form(DEFAULT_REVIEW_CONCURRENCY),
    local_parse: bool = Form(False),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    skip_llm_files: Optional[str] = Form(None),
    file_groups: Optional[str] = Form(None),
):
    """Start the worker and return immediately; progress is read by polling."""
    job = get_review_job(job_id)
    if job["status"] in {"queued", "running", "completed"}:
        return {"jobId": job_id, "status": job["status"]}
    if job["status"] == "cancelled":
        raise HTTPException(status_code=409, detail="任务已取消")
    if job["status"] == "failed":
        raise HTTPException(status_code=409, detail=job.get("error") or "任务已失败")
    if not job["files"]:
        raise HTTPException(status_code=400, detail="请先上传作业文件")
    if any(not item.get("complete") for item in job["chunkUploads"].values()):
        raise HTTPException(status_code=409, detail="仍有大文件分片未上传完成")
    if not authorization.strip() or not cookie.strip() or not instance_nid.strip():
        raise HTTPException(status_code=400, detail="请填写完整的智慧树认证信息")
    if output_format not in {"json", "pdf"}:
        raise HTTPException(status_code=400, detail="不支持的输出格式")

    concurrency = clamp_review_concurrency(max_concurrency)
    job["status"] = "queued"
    job["configuredConcurrency"] = concurrency
    append_review_job_log(job, f"✅ {len(job['files'])} 份文件已就绪，进入批阅队列")
    task = asyncio.create_task(run_async_review_job(
        job_id,
        authorization=authorization.strip(),
        cookie=cookie.strip(),
        instance_nid=instance_nid.strip(),
        attempts=max(1, attempts),
        output_format=output_format,
        max_concurrency=concurrency,
        local_parse=local_parse,
        llm_api_key=(llm_api_key or "").strip(),
        llm_api_url=(llm_api_url or "").strip(),
        llm_model=(llm_model or "").strip(),
        skip_llm_files=skip_llm_files,
        file_groups=file_groups,
    ))
    REVIEW_JOB_TASKS.add(task)
    job["_task"] = task

    def clear_task(completed_task: asyncio.Task) -> None:
        REVIEW_JOB_TASKS.discard(completed_task)
        if job.get("_task") is completed_task:
            job.pop("_task", None)

    task.add_done_callback(clear_task)
    return {"jobId": job_id, "status": "queued", "maxConcurrency": concurrency}


@app.delete("/api/review/jobs/{job_id}")
async def cancel_review_job(job_id: str):
    """Cancel an upload, queued job, or running review process."""
    job = get_review_job(job_id)
    if job["status"] == "cancelled":
        return {"jobId": job_id, "status": "cancelled"}
    if job["status"] in {"completed", "failed"}:
        raise HTTPException(status_code=409, detail=f"任务已{'完成' if job['status'] == 'completed' else '失败'}")

    job["cancelRequested"] = True
    await terminate_review_job_process(job)
    task = job.get("_task")
    if task is not None and not task.done():
        task.cancel()
    job["status"] = "cancelled"
    job["error"] = None
    append_review_job_log(job, "⏹️ 用户已取消本次批阅", "warn")
    return {"jobId": job_id, "status": "cancelled"}


@app.get("/api/review/jobs/{job_id}")
async def get_review_job_status(
    job_id: str,
    cursor: int = Query(0, ge=0),
    log_limit: int = Query(250, ge=1, le=1000),
):
    """Return a compact status snapshot and logs after the supplied cursor."""
    job = get_review_job(job_id)
    end = min(len(job["logs"]), cursor + log_limit)
    response: Dict[str, Any] = {
        "jobId": job_id,
        "status": job["status"],
        "uploadedCount": len(job["files"]),
        "configuredConcurrency": job.get("configuredConcurrency"),
        "logs": job["logs"][cursor:end],
        "nextCursor": end,
        "hasMoreLogs": end < len(job["logs"]),
        "error": job.get("error"),
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
    }
    if job["status"] == "completed":
        response["result"] = job["result"]
    return response


@app.post("/api/review")
async def review_answers(
    files: List[UploadFile] = File(None),
    server_paths: Optional[str] = Form(None),
    authorization: Optional[str] = Form(None),
    cookie: Optional[str] = Form(None),
    instance_nid: Optional[str] = Form(None),
    attempts: int = Form(5),
    max_workers: int = Form(3),
    output_format: str = Form("json"),
    max_concurrency: int = Form(DEFAULT_REVIEW_CONCURRENCY),
    local_parse: bool = Form(False),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    skip_llm_files: Optional[str] = Form(None),
    file_groups: Optional[str] = Form(None),
):
    """批阅学生答案 - 调用 review_service.py"""
    
    # 创建临时目录
    temp_dir = Path(tempfile.mkdtemp(prefix="homework_"))
    output_root = temp_dir / "output"
    output_root.mkdir(exist_ok=True)
    student_files = []

    incoming_file_count = len([item for item in (files or []) if item.filename])
    if incoming_file_count > MAX_REVIEW_FILES:
        raise HTTPException(status_code=400, detail=f"每个批阅任务最多 {MAX_REVIEW_FILES} 份文件")
    
    # 保存上传的文件
    if files:
        for f in files:
            if f.filename:
                target = temp_dir / f.filename
                content = await f.read()
                target.write_bytes(content)
                student_files.append(str(target))
    
    # 或使用服务器路径
    if server_paths:
        try:
            paths = json.loads(server_paths)
            if len(paths) + incoming_file_count > MAX_REVIEW_FILES:
                raise HTTPException(status_code=400, detail=f"每个批阅任务最多 {MAX_REVIEW_FILES} 份文件")
            student_files.extend(paths)
        except json.JSONDecodeError:
            pass
    
    if not student_files:
        raise HTTPException(status_code=400, detail="请提供至少一个学生答案文件")
    
    # 创建环境变量 - 始终设置认证变量（子脚本会检查这些变量来决定是否加载.env）
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["AUTHORIZATION"] = authorization or ""
    env["COOKIE"] = cookie or ""
    env["INSTANCE_NID"] = instance_nid or ""
    env["LLM_API_KEY"] = llm_api_key or os.getenv("LLM_API_KEY", "")
    env["LLM_API_URL"] = llm_api_url or os.getenv("LLM_API_URL", "")
    env["LLM_MODEL"] = llm_model or os.getenv("LLM_MODEL", "")
    
    # 构建命令 - 与前端本地模式一致，调用 review_service.py
    cmd = [
        sys.executable, "-u",
        str(REVIEW_SCRIPT),
        "--inputs", json.dumps(student_files),
        "--attempts", str(max(1, attempts)),
        "--output-format", output_format,
        "--output-root", str(output_root),
        "--max-concurrency", str(clamp_review_concurrency(max_concurrency)),
    ]
    if local_parse:
        cmd.append("--local-parse")
    if skip_llm_files:
        cmd.extend(["--skip-llm-files", skip_llm_files])
    if file_groups:
        cmd.extend(["--file-groups", file_groups])
    
    async def event_stream():
        """SSE流式响应"""
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRIPT_DIR),
                limit=10 * 1024 * 1024,  # 10MB行缓冲，防止__RESULT__大JSON超限
            )
            
            # 读取stdout，带心跳保活防止Railway空闲超时
            while True:
                try:
                    line = await asyncio.wait_for(process.stdout.readline(), timeout=15)
                except asyncio.TimeoutError:
                    # 子进程无输出时发送SSE心跳注释，防止Railway 60秒空闲断连
                    yield ": heartbeat\n\n"
                    continue
                if not line:
                    break
                msg = line.decode().strip()
                if not msg:
                    continue
                
                # 识别 __RESULT__ 标记（review_service.py 的最终输出）
                if msg.startswith("__RESULT__"):
                    try:
                        payload = json.loads(msg[len("__RESULT__"):])
                        # 将相对路径转为绝对路径，前端用 /api/files?path= 下载
                        rel_files = payload.get("output_files", [])
                        abs_files = [str(output_root / f) for f in rel_files]
                        # 转换为前端期望的 "complete" 事件格式
                        complete_event = {
                            "type": "complete",
                            "jobId": "",
                            "outputFiles": abs_files,
                            "summary": payload.get("result", {}),
                            "scoreTable": payload.get("score_table", None),
                            "downloadBaseUrl": "/api/homework-review/download",
                        }
                        yield f'data: {json.dumps(complete_event, ensure_ascii=False)}\n\n'
                    except json.JSONDecodeError:
                        yield f'data: {json.dumps({"type": "log", "message": msg}, ensure_ascii=False)}\n\n'
                    continue
                
                try:
                    data = json.loads(msg)
                    yield f'data: {json.dumps(data, ensure_ascii=False)}\n\n'
                except json.JSONDecodeError:
                    yield f'data: {json.dumps({"type": "log", "message": msg}, ensure_ascii=False)}\n\n'
            
            await process.wait()
            
            if process.returncode != 0:
                stderr = await process.stderr.read()
                err_msg = stderr.decode().strip()
                if err_msg:
                    yield f'data: {json.dumps({"type": "error", "message": err_msg}, ensure_ascii=False)}\n\n'
                
        except Exception as e:
            yield f'data: {json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False)}\n\n'
        finally:
            yield f'data: {json.dumps({"type": "done"})}\n\n'
    
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
