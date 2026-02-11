"""
作业批阅后端API服务
提供生成学生答案和批阅评测功能
"""

import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional

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

# 确保.env文件存在（子脚本会尝试加载它，不存在会报错）
env_file = SCRIPT_DIR / ".env"
if not env_file.exists():
    env_file.touch()


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
    file: UploadFile = File(...),
    authorization: Optional[str] = Form(None),
    cookie: Optional[str] = Form(None),
    instance_nid: Optional[str] = Form(None),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    levels: Optional[str] = Form(None),
):
    """生成学生答案 - 调用 generate_and_review_service.py"""
    
    # 创建临时目录
    temp_dir = Path(tempfile.mkdtemp(prefix="homework_"))
    exam_file = temp_dir / file.filename
    output_root = temp_dir / "output"
    output_root.mkdir(exist_ok=True)
    
    # 保存上传的文件
    content = await file.read()
    exam_file.write_bytes(content)
    
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
    
    # 构建命令行参数 - 与前端本地模式一致
    cmd = [
        "python3", "-u",
        str(GENERATE_SCRIPT),
        "--input", str(exam_file),
        "--output-root", str(output_root),
        "--levels", *levels_list,
        "--llm-api-key", llm_api_key or os.getenv("LLM_API_KEY", ""),
        "--llm-api-url", llm_api_url or os.getenv("LLM_API_URL", ""),
        "--llm-model", llm_model or os.getenv("LLM_MODEL", ""),
    ]
    
    async def event_stream():
        """SSE流式响应 - 读取子进程的JSON行协议输出"""
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRIPT_DIR)
            )
            
            # 读取stdout（JSON行协议）
            while True:
                line = await process.stdout.readline()
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


@app.post("/api/review")
async def review_answers(
    files: List[UploadFile] = File(None),
    server_paths: Optional[str] = Form(None),
    authorization: Optional[str] = Form(None),
    cookie: Optional[str] = Form(None),
    instance_nid: Optional[str] = Form(None),
    task_id: Optional[str] = Form(None),
    attempts: int = Form(5),
    max_workers: int = Form(3),
    output_format: str = Form("json"),
    max_concurrency: int = Form(5),
    local_parse: bool = Form(False),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
):
    """批阅学生答案 - 调用 review_service.py"""
    
    # 创建临时目录
    temp_dir = Path(tempfile.mkdtemp(prefix="homework_"))
    output_root = temp_dir / "output"
    output_root.mkdir(exist_ok=True)
    student_files = []
    
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
    if task_id:
        env["TASK_ID"] = task_id
    
    # 构建命令 - 与前端本地模式一致，调用 review_service.py
    cmd = [
        "python3", "-u",
        str(REVIEW_SCRIPT),
        "--inputs", json.dumps(student_files),
        "--attempts", str(max(1, attempts)),
        "--output-format", output_format,
        "--output-root", str(output_root),
        "--max-concurrency", str(max(1, max_concurrency)),
    ]
    if local_parse:
        cmd.append("--local-parse")
    
    async def event_stream():
        """SSE流式响应"""
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRIPT_DIR)
            )
            
            # 读取stdout
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                msg = line.decode().strip()
                if not msg:
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
