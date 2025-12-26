import json
import os
from datetime import datetime
from typing import List, Dict, Optional
import uuid

class HistoryManager:
    """Manages evaluation history using JSON file storage"""

    def __init__(self, history_file: str = None):
        # Use /tmp for Vercel/serverless environments (only writable directory)
        if history_file is None:
            # Check if running in Vercel/serverless environment
            # Vercel sets VERCEL env var, Lambda/AWS sets AWS_LAMBDA_FUNCTION_VERSION
            is_serverless = (
                os.environ.get('VERCEL') is not None
                or os.environ.get('AWS_LAMBDA_FUNCTION_VERSION') is not None
                or os.path.exists('/var/task')  # Vercel/AWS Lambda marker
            )
            if is_serverless:
                history_file = "/tmp/evaluations_history.json"
            else:
                history_file = "evaluations_history.json"
        self.history_file = history_file
        self._ensure_file_exists()
    
    def _ensure_file_exists(self):
        """Create history file if it doesn't exist"""
        if not os.path.exists(self.history_file):
            with open(self.history_file, 'w') as f:
                json.dump([], f)
    
    def _read_history(self) -> List[Dict]:
        """Read all history records"""
        try:
            with open(self.history_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error reading history: {e}")
            return []
    
    def _write_history(self, history: List[Dict]):
        """Write history records to file"""
        try:
            with open(self.history_file, 'w', encoding='utf-8') as f:
                json.dump(history, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Error writing history: {e}")
    
    def save_evaluation(self, 
                       report: Dict,
                       teacher_doc_name: str,
                       dialogue_record_name: str,
                       model: str = "gpt-4o") -> str:
        """
        Save an evaluation to history
        Returns the generated history ID
        """
        history = self._read_history()
        
        # Generate unique ID
        eval_id = str(uuid.uuid4())
        
        # Create history entry
        entry = {
            "id": eval_id,
            "timestamp": datetime.now().isoformat(),
            "teacher_doc_name": teacher_doc_name,
            "dialogue_record_name": dialogue_record_name,
            "model": model,
            "total_score": report.get("total_score", 0),
            "final_level": report.get("final_level", ""),
            "report": report  # Full report data
        }
        
        # Add to beginning of list (most recent first)
        history.insert(0, entry)
        
        # Limit history to last 100 entries
        if len(history) > 100:
            history = history[:100]
        
        self._write_history(history)
        return eval_id
    
    def get_all(self) -> List[Dict]:
        """Get all evaluation history (summary only, without full reports)"""
        history = self._read_history()
        # Return summaries without full report data to reduce payload
        return [{
            "id": entry["id"],
            "timestamp": entry["timestamp"],
            "teacher_doc_name": entry["teacher_doc_name"],
            "dialogue_record_name": entry["dialogue_record_name"],
            "model": entry["model"],
            "total_score": entry["total_score"],
            "final_level": entry["final_level"]
        } for entry in history]
    
    def get_by_id(self, eval_id: str) -> Optional[Dict]:
        """Get a specific evaluation by ID"""
        history = self._read_history()
        for entry in history:
            if entry["id"] == eval_id:
                return entry
        return None
    
    def delete_by_id(self, eval_id: str) -> bool:
        """Delete an evaluation by ID. Returns True if successful."""
        history = self._read_history()
        original_length = len(history)
        history = [entry for entry in history if entry["id"] != eval_id]
        
        if len(history) < original_length:
            self._write_history(history)
            return True
        return False
