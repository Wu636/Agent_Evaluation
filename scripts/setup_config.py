#!/usr/bin/env python3
"""
.env配置向导
帮助用户快速设置LLM API配置
"""

import os
import sys


def create_env_file():
    """交互式创建.env文件"""
    print("="*70)
    print("  LLM评测系统配置向导")
    print("="*70)
    print()
    
    # 检查是否已存在.env文件
    if os.path.exists('.env'):
        print("⚠️  检测到已存在 .env 文件")
        choice = input("是否覆盖? (y/n): ").strip().lower()
        if choice != 'y':
            print("取消配置")
            return
        print()
    
    print("请按提示输入配置信息:")
    print()
    
    # 1. API Key
    print("1️⃣  请输入你的 API Key:")
    print("   (示例: sk-abc123xyz789)")
    api_key = input("   API_KEY: ").strip()
    
    if not api_key:
        print("❌ API Key不能为空!")
        return
    
    print()
    
    # 2. API URL
    print("2️⃣  请输入 API 地址:")
    print("   (默认: http://llm-service.polymas.com/api/openai/v1/chat/completions)")
    api_url = input("   API_URL [回车使用默认]: ").strip()
    
    if not api_url:
        api_url = "http://llm-service.polymas.com/api/openai/v1/chat/completions"
    
    print()
    
    # 3. Model
    print("3️⃣  请输入使用的模型:")
    print("   (默认: gpt-4o)")
    model = input("   MODEL [回车使用默认]: ").strip()
    
    if not model:
        model = "gpt-4o"
    
    print()
    
    # 确认配置
    print("="*70)
    print("  配置预览")
    print("="*70)
    print(f"API_KEY: {api_key[:10]}...{api_key[-5:] if len(api_key) > 15 else ''}")
    print(f"API_URL: {api_url}")
    print(f"MODEL:   {model}")
    print("="*70)
    print()
    
    choice = input("确认保存? (y/n): ").strip().lower()
    if choice != 'y':
        print("取消配置")
        return
    
    # 写入.env文件
    env_content = f"""# LLM API 配置文件
# 由配置向导自动生成

# API密钥
LLM_API_KEY={api_key}

# API地址
LLM_BASE_URL={api_url}

# 使用的模型
LLM_MODEL={model}
"""
    
    with open('.env', 'w', encoding='utf-8') as f:
        f.write(env_content)
    
    print()
    print("✅ 配置文件已保存至: .env")
    print()
    print("现在可以运行评测系统:")
    print("  python llm_evaluation_agent.py 教师文档.docx 对话记录.json")
    print()


def test_connection():
    """测试API连接"""
    if not os.path.exists('.env'):
        print("❌ 未找到.env文件,请先运行配置向导")
        return
    
    # 读取配置
    config = {}
    with open('.env', 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                config[key.strip()] = value.strip()
    
    api_key = config.get('LLM_API_KEY')
    api_url = config.get('LLM_BASE_URL')
    model = config.get('LLM_MODEL', 'gpt-4o')
    
    if not api_key or not api_url:
        print("❌ .env文件配置不完整")
        return
    
    print("="*70)
    print("  测试API连接")
    print("="*70)
    print(f"API地址: {api_url}")
    print(f"模型: {model}")
    print()
    print("正在发送测试请求...")
    
    try:
        import requests
        
        headers = {
            'api-key': api_key,
            'Content-Type': 'application/json'
        }
        
        payload = {
            "maxTokens": 100,
            "messages": [
                {
                    "role": "system",
                    "content": "你是一个测试助手"
                },
                {
                    "role": "user",
                    "content": "请回复'连接成功'"
                }
            ],
            "model": model,
            "n": 1,
            "temperature": 0.5
        }
        
        response = requests.post(api_url, headers=headers, json=payload, timeout=30)
        
        if response.status_code == 200:
            result = response.json()
            if 'choices' in result and len(result['choices']) > 0:
                content = result['choices'][0]['message']['content']
                print()
                print("✅ 连接成功!")
                print(f"   模型回复: {content}")
                
                if 'usage' in result:
                    usage = result['usage']
                    print(f"   Token使用: {usage.get('total_tokens', 'N/A')}")
                
                print()
                print("配置正确,可以开始使用评测系统!")
            else:
                print("⚠️ API返回格式异常")
                print(f"   响应: {result}")
        else:
            print(f"❌ 连接失败: HTTP {response.status_code}")
            print(f"   响应: {response.text[:500]}")
    
    except requests.exceptions.Timeout:
        print("❌ 请求超时,请检查网络或API地址")
    except requests.exceptions.ConnectionError:
        print("❌ 无法连接到API服务器,请检查URL是否正确")
    except Exception as e:
        print(f"❌ 测试失败: {str(e)}")


def show_menu():
    """显示菜单"""
    print()
    print("="*70)
    print("  LLM评测系统配置工具")
    print("="*70)
    print()
    print("请选择操作:")
    print("  1. 配置API设置(创建.env文件)")
    print("  2. 测试API连接")
    print("  3. 查看当前配置")
    print("  0. 退出")
    print()
    
    choice = input("请输入选项 (0-3): ").strip()
    return choice


def show_current_config():
    """显示当前配置"""
    if not os.path.exists('.env'):
        print("❌ 未找到.env文件")
        return
    
    print("="*70)
    print("  当前配置")
    print("="*70)
    
    with open('.env', 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                if 'API_KEY' in line and '=' in line:
                    # 隐藏API Key的中间部分
                    key, value = line.split('=', 1)
                    if len(value) > 15:
                        masked = value[:10] + '...' + value[-5:]
                    else:
                        masked = value[:5] + '...'
                    print(f"{key}={masked}")
                else:
                    print(line)


def main():
    """主函数"""
    while True:
        choice = show_menu()
        
        if choice == '1':
            create_env_file()
        elif choice == '2':
            test_connection()
        elif choice == '3':
            show_current_config()
        elif choice == '0':
            print("\n再见!")
            break
        else:
            print("\n⚠️ 无效选项,请重新选择")
        
        input("\n按回车继续...")


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n用户取消操作")
        sys.exit(0)
