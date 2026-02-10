"""
作业批阅后端API服务 - 简化版本
直接调用 homework_reviewer_v2.py 脚本
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

app = FastAPI(title="作业批阅API", version="1.0.0")

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境建议限制具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def cleanup_old_jobs(max_age_hours: int = 24):
    """清理超过指定时间的临时文件"""
    import time
    now = time.time()
    for item in TEMP_DIR.iterdir():
        if item.is_dir():
            age_hours = (now - item.stat().st_mtime) / 3600
            if age_hours > max_age_hours:
                shutil.rmtree(item, ignore_errors=True)


@app.on_event("startup")
async def startup_event():
    """启动时清理旧文件"""
    cleanup_old_jobs()


@app.get("/")
async def root():
    return {
        "service": "作业批阅API服务",
        "status": "running",
        "endpoints": {
            "generate": "POST /api/generate - 生成学生答案",
            "review": "POST /api/review - 批阅评测",
            "health": "GET /health - 健康检查"
        }
    }


@app.get("/health")
async def health_check():
    """健康检查接口"""
    return {"status": "healthy", "service": "homework-review-api"}


@app.post("/api/generate")
async def generate_answers(
    file: UploadFile = File(...),
    authorization: str = Form(...),
    cookie: str = Form(...),
    instance_nid: str = Form(...),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    levels: str = Form(...),  # JSON字符串
):
    """
    生成学生答案
    
    返回 Server-Sent Events 流式响应
    """
    job_id = str(uuid.uuid4())[:8]
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(exist_ok=True)
    
    # 保存上传的题卷文件
    exam_file = job_dir / file.filename
    content = await file.read()
    exam_file.write_bytes(content)
    
    # 解析等级配置
    try:
        levels_data = json.loads(levels)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="levels参数格式错误")
    
    # 构建配置
    config = JobConfig(
        authorization=authorization,
        cookie=cookie,
        instance_nid=instance_nid,
        task_id="",  # 生成模式不需要
        exam_file=str(exam_file),
        student_levels=[
            LevelConfig(
                level=lv["level"],
                label=lv["label"],
                requirement=lv["requirement"]
            ) for lv in levels_data
        ],
        attempts=1,
        max_workers=3,
        llm_api_key=llm_api_key or os.getenv("LLM_API_KEY", ""),
        llm_api_url=llm_api_url or os.getenv("LLM_API_URL", ""),
        llm_model=llm_model or os.getenv("LLM_MODEL", ""),
        job_id=job_id,
        output_dir=str(job_dir),
    )
    
    async def event_stream():
        """SSE流式响应"""
        try:
            yield f'data: {json.dumps({"type": "log", "message": "开始生成学生答案..."})}\n\n'
            
            # 调用生成逻辑
            result = await generate_student_answers(config)
            
            # 发送生成完成事件
            yield f'data: {json.dumps({"type": "generate_complete", "files": result["generated_files"], "job_id": job_id})}\n\n'
            
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
            "X-Accel-Buffering": "no",
        }
    )


@app.post("/api/review")
async def review_answers(
    files: List[UploadFile] = File(None),
    server_paths: Optional[str] = Form(None),  # JSON数组，服务器已有文件路径
    authorization: str = Form(...),
    cookie: str = Form(...),
    instance_nid: str = Form(...),
    task_id: str = Form(...),
    attempts: int = Form(5),
    max_workers: int = Form(3),
    llm_api_key: Optional[str] = Form(None),
    llm_api_url: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
):
    """
    批阅学生答案
    
    返回 Server-Sent Events 流式响应
    """
    job_id = str(uuid.uuid4())[:8]
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(exist_ok=True)
    
    # 收集学生答案文件路径
    student_files = []
    
    # 如果有上传文件
    if files:
        for file in files:
            target = job_dir / file.filename
            content = await file.read()
            target.write_bytes(content)
            student_files.append(str(target))
    
    # 如果有服务器路径（生成模式第二步）
    if server_paths:
        try:
            paths = json.loads(server_paths)
            student_files.extend(paths)
        except json.JSONDecodeError:
            pass
    
    if not student_files:
        raise HTTPException(status_code=400, detail="请提供至少一个学生答案文件")
    
    # 构建配置
    config = JobConfig(
        authorization=authorization,
        cookie=cookie,
        instance_nid=instance_nid,
        task_id=task_id,
        exam_file="",  # 批阅模式不需要
        student_files=student_files,
        attempts=attempts,
        max_workers=max_workers,
        llm_api_key=llm_api_key or os.getenv("LLM_API_KEY", ""),
        llm_api_url=llm_api_url or os.getenv("LLM_API_URL", ""),
        llm_model=llm_model or os.getenv("LLM_MODEL", ""),
        job_id=job_id,
        output_dir=str(job_dir),
    )
    
    async def event_stream():
        """SSE流式响应"""
        try:
            yield f'data: {json.dumps({"type": "log", "message": f"开始批阅 {len(student_files)} 份答案..."})}\n\n'
            
            # 调用批阅逻辑
            async for event in review_student_answers(config):
                yield f'data: {json.dumps(event)}\n\n'
            
            yield f'data: {json.dumps({"type": "done"})}\n\n'
            
        except Exception as e:
            yield f'data: {json.dumps({"type": "error", "message": str(e)})}\n\n'
    
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
