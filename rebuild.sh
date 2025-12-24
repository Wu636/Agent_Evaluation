#!/bin/bash

# =============================================================================
# 代码修改后重新构建和部署脚本
# 用法: ./rebuild.sh [选项]
# =============================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

# 显示帮助信息
show_help() {
    echo "用法: ./rebuild.sh [选项]"
    echo ""
    echo "选项:"
    echo "  -f, --frontend    只重建前端"
    echo "  -b, --backend     只重建后端"
    echo "  -a, --all         重建所有服务 (默认)"
    echo "  -c, --clean       清理后完全重建 (不使用缓存)"
    echo "  -h, --help        显示帮助信息"
    echo ""
    echo "示例:"
    echo "  ./rebuild.sh           # 重建所有服务"
    echo "  ./rebuild.sh -f        # 只重建前端"
    echo "  ./rebuild.sh -b        # 只重建后端"
    echo "  ./rebuild.sh -c        # 清理缓存后完全重建"
}

# 解析命令行参数
BUILD_FRONTEND=false
BUILD_BACKEND=false
NO_CACHE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--frontend)
            BUILD_FRONTEND=true
            shift
            ;;
        -b|--backend)
            BUILD_BACKEND=true
            shift
            ;;
        -a|--all)
            BUILD_FRONTEND=true
            BUILD_BACKEND=true
            shift
            ;;
        -c|--clean)
            NO_CACHE="--no-cache"
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            print_error "未知参数: $1"
            show_help
            exit 1
            ;;
    esac
done

# 如果没有指定服务，默认重建所有
if [ "$BUILD_FRONTEND" = false ] && [ "$BUILD_BACKEND" = false ]; then
    BUILD_FRONTEND=true
    BUILD_BACKEND=true
fi

# 进入项目目录
cd "$(dirname "$0")"

echo ""
echo "=============================================="
echo "       代码修改后重新构建和部署"
echo "=============================================="
echo ""

# 构建前端
if [ "$BUILD_FRONTEND" = true ]; then
    print_info "正在重建前端..."
    docker-compose build $NO_CACHE frontend
    print_success "前端构建完成"
fi

# 构建后端
if [ "$BUILD_BACKEND" = true ]; then
    print_info "正在重建后端..."
    docker-compose build $NO_CACHE backend
    print_success "后端构建完成"
fi

# 重启服务
print_info "正在重启服务..."
if [ "$BUILD_FRONTEND" = true ] && [ "$BUILD_BACKEND" = true ]; then
    docker-compose up -d
else
    if [ "$BUILD_FRONTEND" = true ]; then
        docker-compose up -d frontend
    fi
    if [ "$BUILD_BACKEND" = true ]; then
        docker-compose up -d backend
    fi
fi

echo ""
print_success "部署完成！"
echo ""
echo "服务访问地址:"
echo "  🌐 前端: http://localhost:3000"
echo "  🔌 后端: http://localhost:8000"
echo ""

# 显示容器状态
print_info "容器状态:"
docker-compose ps
