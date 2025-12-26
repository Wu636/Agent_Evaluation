import sys
import os
import shutil
import json
from typing import Optional
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from history_manager import HistoryManager
from txt_to_json_converter import parse_txt_dialogue

# Add scripts directory to sys.path to import agent code
current_dir = os.path.dirname(os.path.abspath(__file__))

# Try multiple possible locations for scripts directory
# 1. Docker: /app/scripts (same level as main.py)
# 2. Local: ../scripts (parent directory)
possible_scripts_dirs = [
    os.path.join(current_dir, 'scripts'),  # Docker: /app/scripts
    os.path.join(os.path.dirname(current_dir), 'scripts'),  # Local: ../scripts
]

found_scripts_dir = None
for scripts_dir in possible_scripts_dirs:
    if os.path.exists(scripts_dir):
        sys.path.insert(0, scripts_dir)
        found_scripts_dir = scripts_dir
        print(f"✓ 找到 scripts 目录: {scripts_dir}")
        break

try:
    from llm_evaluation_agent import LLMEvaluationAgent, EvaluationReport, DimensionScore
    print("✓ 成功导入 LLMEvaluationAgent")
except ImportError as e:
    print(f"Error importing modules: {e}")
    LLMEvaluationAgent = None

app = FastAPI(title="LLM Evaluation API")

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For dev convenience
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize history manager
history_manager = HistoryManager()

@app.get("/")
def read_root():
    return {"status": "ok", "message": "LLM Evaluation API is running"}

@app.post("/api/evaluate")
async def evaluate(
    teacher_doc: UploadFile = File(...),
    dialogue_record: UploadFile = File(...),
    api_key: Optional[str] = Form(None),
    api_url: Optional[str] = Form(None),
    model: Optional[str] = Form("gpt-4o")
):
    """
    Endpoint to upload files and run evaluation
    """
    temp_teacher_path = f"temp_{teacher_doc.filename}"
    temp_dialogue_path = f"temp_{dialogue_record.filename}"
    
    try:
        # Save files temporarily
        with open(temp_teacher_path, "wb") as buffer:
            shutil.copyfileobj(teacher_doc.file, buffer)
            
        with open(temp_dialogue_path, "wb") as buffer:
            shutil.copyfileobj(dialogue_record.file, buffer)
        
        # Convert TXT to JSON if needed
        if temp_dialogue_path.lower().endswith('.txt'):
            with open(temp_dialogue_path, 'r', encoding='utf-8') as f:
                txt_content = f.read()
            json_data = parse_txt_dialogue(txt_content)
            # Save as JSON file
            json_dialogue_path = temp_dialogue_path.rsplit('.', 1)[0] + '.json'
            with open(json_dialogue_path, 'w', encoding='utf-8') as f:
                json.dump(json_data, f, ensure_ascii=False, indent=2)
            # Update path to use the converted JSON
            temp_dialogue_path = json_dialogue_path
            print(f"✓ 已将 TXT 对话记录转换为 JSON: {json_dialogue_path}")
            
        # Initialize Agent
        # Note: LLMEvaluationAgent expects to find .env in working dir or passed explicitly.
        # We will assume .env is in parent_dir. We can copy it or let agent find it if we change CWD.
        # Safer: let's switch CWD to parent_dir temporarily or pass keys if we parse them.
        # The agent code: `_load_env_config` looks in `os.getcwd()` and `.env`.
        # Let's simple pass the paths.
        
        # We need to make sure we are in the right directory for the agent to find .env if it uses relative paths
        # But wait, the agent uses os.getenv mostly or loads .env.
        
        # Let's instantiate the agent
        # We might need to adjust CWD so imports inside agent (if any) or .env loading works
        original_cwd = os.getcwd()
        # Use parent of scripts_dir (project root) or current_dir for Docker
        env_dir = os.path.dirname(found_scripts_dir) if found_scripts_dir else current_dir
        os.chdir(env_dir)
        
        # Map frontend IDs to API model names (required by the proxy service)
        MODEL_NAME_MAPPING = {
            "gpt-4.1": "gpt-4.1",
            "gpt-4.1-mini": "gpt-4.1-mini",
            "gpt-4.1-nano": "gpt-4.1-nano",
            "gemini-2.5-pro": "gemini-2.5-pro",
            "gemini-2.5-flash": "gemini-2.5-flash",
            "claude-sonnet-4.5": "Claude Sonnet 4.5",
            "claude-haiku-4.5": "Claude Haiku 4.5",
            "claude-opus-4": "Claude Opus 4",
            "grok-4": "grok-4"
        }
        
        # Use mapped name if available, otherwise use original ID (e.g. gpt-4o)
        api_model_name = MODEL_NAME_MAPPING.get(model, model)
        
        try:
            agent = LLMEvaluationAgent(
                teacher_doc_path=os.path.join(current_dir, temp_teacher_path),
                dialogue_json_path=os.path.join(current_dir, temp_dialogue_path),
                llm_api_key=api_key,
                llm_base_url=api_url,
                llm_model=api_model_name or "gpt-4o"
            )
            
            report = agent.evaluate()
            
            # Serialize Report
            # The report object might need helper to convert to dict if not Pydantic
            # EvaluationReport is a dataclass
            
            from dataclasses import asdict
            report_dict = asdict(report)
            
            # Helper to convert Enum to str
            def convert_enums(obj):
                if isinstance(obj, dict):
                    return {k: convert_enums(v) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [convert_enums(i) for i in obj]
                elif hasattr(obj, 'value') and isinstance(obj.value, str): # Enum
                    return obj.value
                else:
                    return obj
            
            result = convert_enums(report_dict)
            
            # Transform to frontend expected format
            # Frontend expects: { total_score, dimensions: Record<string, {score, comment}>, analysis, issues, suggestions }
            frontend_result = {
                "total_score": result["total_score"],
                "dimensions": {
                    dim["dimension"]: {
                        "score": dim["score"],
                        "comment": dim["analysis"]
                    }
                    for dim in result.get("dimensions", [])
                },
                "analysis": result.get("executive_summary", ""),
                "issues": result.get("critical_issues", []),
                "suggestions": result.get("actionable_suggestions", []),
                "final_level": result.get("final_level", ""),
                "pass_criteria_met": result.get("pass_criteria_met", False),
                "veto_reasons": result.get("veto_reasons", [])
            }
            
            # Save to history (save original full result for history)
            eval_id = history_manager.save_evaluation(
                report=result,
                teacher_doc_name=teacher_doc.filename,
                dialogue_record_name=dialogue_record.filename,
                model=model or "gpt-4o"
            )

            frontend_result["history_id"] = eval_id
            return frontend_result
            
        finally:
            os.chdir(original_cwd)

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Cleanup
        if os.path.exists(temp_teacher_path):
            os.remove(temp_teacher_path)
        if os.path.exists(temp_dialogue_path):
            os.remove(temp_dialogue_path)
        # Also cleanup original TXT file if it was converted
        original_txt_path = f"temp_{dialogue_record.filename}"
        if original_txt_path != temp_dialogue_path and os.path.exists(original_txt_path):
            os.remove(original_txt_path)

@app.get("/api/models")
def get_models():
    """
    Return list of available models
    """
    return {
        "models": [
            {"id": "gpt-4o", "name": "GPT-4o", "description": "Most capable"},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "description": "Faster, cost-effective"},
            {"id": "gpt-4.1", "name": "GPT-4.1", "description": "Latest GPT-4 version"},
            {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini", "description": "Compact GPT-4.1"},
            {"id": "gpt-4.1-nano", "name": "GPT-4.1 Nano", "description": "Ultra-compact"},
            {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "Google's flagship"},
            {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "description": "Fast Gemini"},
            {"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "description": "Newest Sonnet"},
            {"id": "claude-haiku-4.5", "name": "Claude Haiku 4.5", "description": "Latest Haiku"},
            {"id": "claude-opus-4", "name": "Claude Opus 4", "description": "Most capable Claude"},
            {"id": "grok-4", "name": "Grok-4", "description": "xAI's model"}
        ]
    }

@app.get("/api/history")
def get_history():
    """
    Get all evaluation history (summaries)
    """
    try:
        history = history_manager.get_all()
        return {"history": history}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/history/{eval_id}")
def get_history_item(eval_id: str):
    """
    Get specific evaluation details by ID
    """
    try:
        item = history_manager.get_by_id(eval_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Evaluation not found")

        # Transform the stored report to frontend expected format
        raw_report = item.get("report", {})

        # Check if this is already in the new format (has "issues" key directly)
        # or needs transformation (has "critical_issues" key)
        if "critical_issues" in raw_report or "dimensions" in raw_report and isinstance(raw_report.get("dimensions"), list):
            # Transform to frontend format
            frontend_report = {
                "total_score": raw_report.get("total_score", 0),
                "dimensions": {
                    dim["dimension"]: {
                        "score": dim["score"],
                        "comment": dim["analysis"]
                    }
                    for dim in raw_report.get("dimensions", [])
                } if isinstance(raw_report.get("dimensions"), list) else raw_report.get("dimensions", {}),
                "analysis": raw_report.get("executive_summary", ""),
                "issues": raw_report.get("critical_issues", []),
                "suggestions": raw_report.get("actionable_suggestions", []),
                "final_level": raw_report.get("final_level", ""),
                "pass_criteria_met": raw_report.get("pass_criteria_met", False),
                "veto_reasons": raw_report.get("veto_reasons", []),
                "history_id": eval_id
            }
        else:
            # Already in frontend format
            frontend_report = raw_report
            frontend_report["history_id"] = eval_id

        return {"report": frontend_report}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/history/{eval_id}")
def delete_history_item(eval_id: str):
    """
    Delete an evaluation from history
    """
    try:
        success = history_manager.delete_by_id(eval_id)
        if not success:
            raise HTTPException(status_code=404, detail="Evaluation not found")
        return {"success": True, "message": "Evaluation deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
