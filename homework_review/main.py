"""
作业批阅后端API服务 - 最小化版本
先确保基础服务能运行
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

app = FastAPI(title="作业批阅API", version="1.0.0")

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
            "AUTHORIZATION": "已设置" if os.getenv("AUTHORIZATION") else "未设置"
        }
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
