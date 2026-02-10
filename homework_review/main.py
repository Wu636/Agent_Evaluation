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

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

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
REVIEWER_SCRIPT = SCRIPT_DIR / "homework_reviewer_v2.py"


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


@app.get("/test")
async def test():
    """测试环境变量"""
    return {
        "env": {
            "PORT": os.getenv("PORT", "未设置"),
            "LLM_API_KEY": "已设置" if os.getenv("LLM_API_KEY") else "未设置",
            "AUTHORIZATION": "前端传递" if not os.getenv("AUTHORIZATION") else "已设置"
        },
        "reviewer_script": str(REVIEWER_SCRIPT),
        "script_exists": REVIEWER_SCRIPT.exists()
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
    """生成学生答案 - 调用Python脚本"""
    
    # 创建临时目录
    temp_dir = Path(tempfile.mkdtemp(prefix="homework_"))
    exam_file = temp_dir / file.filename
    
    # 保存上传的文件
    content = await file.read()
    exam_file.write_bytes(content)
    
    # 解析等级配置
    levels_data = []
    if levels:
        try:
            levels_data = json.loads(levels)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="levels参数格式错误")
    
    # 创建环境变量
    env = os.environ.copy()
    if authorization:
        env["AUTHORIZATION"] = authorization
    if cookie:
        env["COOKIE"] = cookie
    if instance_nid:
        env["INSTANCE_NID"] = instance_nid
    env["LLM_API_KEY"] = llm_api_key or os.getenv("LLM_API_KEY", "")
    env["LLM_API_URL"] = llm_api_url or os.getenv("LLM_API_URL", "")
    env["LLM_MODEL"] = llm_model or os.getenv("LLM_MODEL", "")
    
    # 构建命令行参数
    cmd = [
        "python3",
        str(REVIEWER_SCRIPT),
        "--generate",
        "--exam-file", str(exam_file),
        "--output-dir", str(temp_dir),
    ]
    
    # 添加等级配置
    for lv in levels_data:
        cmd.extend(["--level", f"{lv['level']}:{lv['label']}:{lv['requirement']}"])
    
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
            
            yield f'data: {json.dumps({"type": "log", "message": "开始生成学生答案..."})}\n\n'
            
            # 读取输出
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                msg = line.decode().strip()
                if msg:
                    yield f'data: {json.dumps({"type": "log", "message": msg})}\n\n'
            
            await process.wait()
            
            if process.returncode == 0:
                # 查找生成的文件
                generated_files = list(temp_dir.glob("*.docx"))
                yield f'data: {json.dumps({"type": "generate_complete", "files": [str(f) for f in generated_files]})}\n\n'
            else:
                stderr = await process.stderr.read()
                yield f'data: {json.dumps({"type": "error", "message": stderr.decode()})}\n\n'
                
        except Exception as e:
            yield f'data: {json.dumps({"type": "error", "message": str(e)})}\n\n'
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
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
):
    """批阅学生答案 - 调用Python脚本"""
    
    # 创建临时目录
    temp_dir = Path(tempfile.mkdtemp(prefix="homework_"))
    student_files = []
    
    # 保存上传的文件
    if files:
        for f in files:
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
    
    # 创建环境变量
    env = os.environ.copy()
    if authorization:
        env["AUTHORIZATION"] = authorization
    if cookie:
        env["COOKIE"] = cookie
    if instance_nid:
        env["INSTANCE_NID"] = instance_nid
    env["LLM_API_KEY"] = llm_api_key or os.getenv("LLM_API_KEY", "")
    env["LLM_API_URL"] = llm_api_url or os.getenv("LLM_API_URL", "")
    env["LLM_MODEL"] = llm_model or os.getenv("LLM_MODEL", "")
    if task_id:
        env["TASK_ID"] = task_id
    
    # 构建命令
    cmd = [
        "python3",
        str(REVIEWER_SCRIPT),
        "--review",
        "--output-dir", str(temp_dir),
        "--attempts", str(attempts),
        "--max-workers", str(max_workers),
    ]
    cmd.extend(student_files)
    
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
            
            yield f'data: {json.dumps({"type": "log", "message": f"开始批阅{len(student_files)}份答案..."})}\n\n'
            
            # 读取输出
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                msg = line.decode().strip()
                if msg:
                    yield f'data: {json.dumps({"type": "log", "message": msg})}\n\n'
            
            await process.wait()
            
            if process.returncode != 0:
                stderr = await process.stderr.read()
                yield f'data: {json.dumps({"type": "error", "message": stderr.decode()})}\n\n'
                
        except Exception as e:
            yield f'data: {json.dumps({"type": "error", "message": str(e)})}\n\n'
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
