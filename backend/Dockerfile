FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖（pandoc 用于 docx 转换）
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件并安装
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码
COPY backend/ ./

# 复制 scripts 目录（评测 Agent 依赖）
COPY scripts/ ./scripts/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
