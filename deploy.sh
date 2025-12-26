#!/bin/bash

# =============================================================================
# LLM 评测系统 - Docker 部署管理脚本
# 用法: ./deploy.sh [命令] [选项]
# =============================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }
print_step() { echo -e "${CYAN}▶ $1${NC}"; }

# 显示横幅
show_banner() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║     LLM 工作流智能体评测系统 - Docker 部署工具        ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# 显示帮助信息
show_help() {
    show_banner
    echo "用法: ./deploy.sh [命令] [选项]"
    echo ""
    echo "命令:"
    echo "  start          启动服务 (默认)"
    echo "  stop           停止服务"
    echo "  restart        重启服务"
    echo "  build          重新构建镜像"
    echo "  logs           查看日志"
    echo "  status         查看服务状态"
    echo "  clean          清理容器和卷"
    echo "  backup         备份数据"
    echo "  restore        恢复数据"
    echo "  help           显示帮助信息"
    echo ""
    echo "选项:"
    echo "  --no-cache     构建时不使用缓存"
    echo "  --force        强制执行"
    echo "  --tail N       显示最后 N 行日志"
    echo ""
    echo "示例:"
    echo "  ./deploy.sh start              # 启动服务"
    echo "  ./deploy.sh build              # 重新构建并启动"
    echo "  ./deploy.sh logs --tail 50     # 查看最后 50 行日志"
    echo "  ./deploy.sh stop               # 停止服务"
    echo "  ./deploy.sh clean              # 清理所有容器和数据"
    echo ""
}

# 检查环境变量
check_env() {
    if [ ! -f ".env" ]; then
        print_warning "未找到 .env 文件"
        if [ -f ".env.template" ]; then
            print_info "正在从 .env.template 创建 .env..."
            cp .env.template .env
            print_warning "请编辑 .env 文件，填写 LLM_API_KEY"
            print_info "运行: vim .env"
            return 1
        else
            print_error "未找到 .env.template 文件"
            return 1
        fi
    fi
    return 0
}

# 启动服务
cmd_start() {
    show_banner
    print_step "检查环境配置..."
    if ! check_env; then
        print_error "环境配置未完成，请先配置 .env 文件"
        exit 1
    fi
    
    print_step "启动服务..."
    docker-compose up -d
    
    echo ""
    print_success "服务已启动！"
    echo ""
    echo -e "${GREEN}访问地址:${NC}"
    echo "  🌐 应用: ${CYAN}http://localhost:3000${NC}"
    echo ""
    echo -e "${GREEN}常用命令:${NC}"
    echo "  查看日志: ./deploy.sh logs"
    echo "  查看状态: ./deploy.sh status"
    echo "  停止服务: ./deploy.sh stop"
    echo ""
}

# 停止服务
cmd_stop() {
    show_banner
    print_step "停止服务..."
    docker-compose down
    print_success "服务已停止"
}

# 重启服务
cmd_restart() {
    show_banner
    print_step "重启服务..."
    docker-compose restart
    print_success "服务已重启"
}

# 构建镜像
cmd_build() {
    show_banner
    print_step "重新构建镜像..."
    
    if [ "$NO_CACHE" = "true" ]; then
        print_info "使用 --no-cache 选项"
        docker-compose build --no-cache
    else
        docker-compose build
    fi
    
    print_step "重启服务..."
    docker-compose up -d
    
    print_success "构建完成并已启动服务"
}

# 查看日志
cmd_logs() {
    local tail_lines=""
    if [ "$TAIL_COUNT" != "" ]; then
        tail_lines="--tail $TAIL_COUNT"
    fi
    
    print_info "显示日志 (Ctrl+C 退出)..."
    docker-compose logs -f $tail_lines
}

# 查看状态
cmd_status() {
    show_banner
    print_info "容器状态:"
    echo ""
    docker-compose ps
    echo ""
    
    # 检查服务健康状态
    print_info "服务健康检查:"
    if docker-compose ps | grep -q "Up"; then
        echo -e "  ${GREEN}●${NC} 服务运行中"
        
        # 尝试访问 API
        if curl -s http://localhost:3000/api/models > /dev/null 2>&1; then
            echo -e "  ${GREEN}●${NC} API 响应正常"
        else
            echo -e "  ${YELLOW}●${NC} API 正在启动..."
        fi
    else
        echo -e "  ${RED}●${NC} 服务未运行"
    fi
    echo ""
    
    # 显示磁盘使用
    print_info "磁盘使用情况:"
    docker system df --format "table {{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}" 2>/dev/null || true
}

# 清理
cmd_clean() {
    show_banner
    print_warning "这将删除所有容器、镜像和数据卷"
    read -p "确认清理? (yes/no): " confirm
    
    if [ "$confirm" = "yes" ]; then
        print_step "停止并删除容器..."
        docker-compose down --volumes --remove-orphans
        
        print_step "删除镜像..."
        docker rmi agent_evaluation-app 2>/dev/null || true
        
        print_step "清理未使用的资源..."
        docker system prune -f
        
        print_success "清理完成"
    else
        print_info "已取消清理操作"
    fi
}

# 备份数据
cmd_backup() {
    show_banner
    print_step "备份数据..."
    
    local backup_dir="./backups"
    local backup_name="eval-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    
    mkdir -p "$backup_dir"
    
    docker run --rm \
        -v agent_evaluation_agent-data:/data \
        -v "$(pwd)/$backup_dir:/backup" \
        alpine tar czf "/backup/$backup_name" /data
    
    print_success "备份完成: $backup_dir/$backup_name"
}

# 恢复数据
cmd_restore() {
    show_banner
    
    local backup_dir="./backups"
    
    if [ ! -d "$backup_dir" ]; then
        print_error "备份目录不存在: $backup_dir"
        exit 1
    fi
    
    print_info "可用的备份文件:"
    ls -lht "$backup_dir"/*.tar.gz 2>/dev/null | head -10 || true
    echo ""
    
    read -p "输入要恢复的备份文件名: " backup_file
    
    if [ ! -f "$backup_dir/$backup_file" ]; then
        print_error "备份文件不存在: $backup_dir/$backup_file"
        exit 1
    fi
    
    print_warning "这将覆盖当前数据"
    read -p "确认恢复? (yes/no): " confirm
    
    if [ "$confirm" = "yes" ]; then
        print_step "停止服务..."
        docker-compose down
        
        print_step "恢复数据..."
        docker run --rm \
            -v agent_evaluation_agent-data:/data \
            -v "$(pwd)/$backup_dir:/backup" \
            alpine sh -c "rm -rf /data/* && tar xzf /backup/$backup_file -C /"
        
        print_step "启动服务..."
        docker-compose up -d
        
        print_success "数据恢复完成"
    else
        print_info "已取消恢复操作"
    fi
}

# 解析命令行参数
NO_CACHE=false
TAIL_COUNT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-cache)
            NO_CACHE=true
            shift
            ;;
        --tail)
            TAIL_COUNT="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

# 主命令处理
COMMAND="${1:-start}"
shift || true

case "$COMMAND" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    build)
        cmd_build
        ;;
    logs)
        cmd_logs
        ;;
    status)
        cmd_status
        ;;
    clean)
        cmd_clean
        ;;
    backup)
        cmd_backup
        ;;
    restore)
        cmd_restore
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        print_error "未知命令: $COMMAND"
        echo ""
        show_help
        exit 1
        ;;
esac
