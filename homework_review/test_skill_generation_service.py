import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from docx import Document

try:
    from .skill_generation_service import (
        build_grading_skill_zip,
        create_student_sample_docx,
        generate_student_sample_docx_files,
        generate_student_sample_blueprints,
        parse_json_object,
        select_sample_levels,
        validate_skill_blueprint,
    )
except ImportError:
    from skill_generation_service import (
        build_grading_skill_zip,
        create_student_sample_docx,
        generate_student_sample_docx_files,
        generate_student_sample_blueprints,
        parse_json_object,
        select_sample_levels,
        validate_skill_blueprint,
    )


def sample_blueprint():
    return {
        "skillName": "physics-report-grading",
        "displayName": "大学物理实验报告批阅",
        "description": "批阅大学物理实验报告，依据实验数据、计算过程、图表和误差分析逐项评分，并输出综合评语与改进建议；涉及大学物理实验作业批阅时使用。",
        "submissionRequirement": "请完成大学物理实验报告。必交成果包括实验目的、实验原理、实验数据、计算过程、图表、结论与误差分析；以可打开的 DOCX 或 PDF 提交，保证数据和图表清晰完整。",
        "scoreType": "dimension",
        "fullScore": 100,
        "itemSplit": "",
        "scoreItems": [
            {
                "key": "data",
                "name": "实验数据",
                "score": 40,
                "description": "数据记录、单位和有效数字完整正确",
                "rules": ["数据完整得基础分", "单位或有效数字错误按证据扣分"],
            },
            {
                "key": "analysis",
                "name": "计算与分析",
                "score": 60,
                "description": "计算过程、图表、结论和误差分析正确清楚",
                "rules": ["计算过程可复核", "结论与数据一致"],
            },
        ],
        "workflow": ["完整读取附件", "建立证据清单", "逐项评分并审计合计"],
        "evidenceRules": ["DOCX 与 PDF 为等价格式"],
        "missingRules": ["缺失评分项时该项不得分"],
        "courseRules": ["数据和结论必须自洽"],
        "calibrationNotes": ["暂无教师样本校准，按权威量表直接评分"],
        "evaluationItems": [
            {"name": "综合评语", "description": "整体表现概括"},
            {"name": "改进建议", "description": "下一次提交的可执行建议"},
        ],
    }


class SkillGenerationServiceTest(unittest.TestCase):
    def test_parse_json_object_accepts_fenced_json(self):
        result = parse_json_object('```json\n{"ok": true}\n```')
        self.assertTrue(result["ok"])

    def test_blueprint_and_generated_zip_pass_platform_validation(self):
        blueprint = sample_blueprint()
        self.assertEqual(validate_skill_blueprint(blueprint), [])
        with tempfile.TemporaryDirectory() as temp_dir:
            result = build_grading_skill_zip(
                blueprint=blueprint,
                output_dir=Path(temp_dir),
            )
            zip_path = Path(result["zipPath"])
            self.assertTrue(zip_path.is_file())
            self.assertEqual(result["package"]["rootName"], "physics-report-grading")
            self.assertEqual(result["submissionRequirement"], blueprint["submissionRequirement"])

    def test_create_student_sample_docx_has_neutral_content_and_styles(self):
        sample = {
            "title": "刚体转动实验报告",
            "sections": [
                {"heading": "实验目的", "paragraphs": ["验证刚体转动定律并分析测量误差。"]},
                {"heading": "数据处理", "paragraphs": ["记录五组测量数据，计算平均时间并绘制关系图。"]},
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "学生作业_01.docx"
            create_student_sample_docx(sample, path)
            document = Document(path)
            text = "\n".join(paragraph.text for paragraph in document.paragraphs)

        self.assertIn("刚体转动实验报告", text)
        self.assertIn("实验目的", text)
        self.assertNotIn("优秀", text)
        self.assertNotIn("AI生成", text)
        self.assertEqual(document.sections[0].top_margin.inches, 1.0)

    def test_generate_student_docx_files_uses_neutral_filenames(self):
        samples = [
            {"title": "课程作业", "sections": [{"heading": "正文", "paragraphs": ["第一份内容。"]}]},
            {"title": "课程作业", "sections": [{"heading": "正文", "paragraphs": ["第二份内容。"]}]},
        ]
        with tempfile.TemporaryDirectory() as temp_dir, patch(
            f"{generate_student_sample_docx_files.__module__}.generate_student_sample_blueprints",
            return_value=samples,
        ):
            result = generate_student_sample_docx_files(
                assignment_title="课程作业",
                submission_requirement="请完成一份结构完整的课程报告，包含背景、分析、结论，并以 DOCX 文件提交。",
                count=2,
                output_dir=Path(temp_dir),
                api_key="test",
                api_url="https://example.test/chat/completions",
                model="test-model",
            )

        self.assertEqual([item["name"] for item in result], ["学生作业_01.docx", "学生作业_02.docx"])
        self.assertEqual([item["level"] for item in result], ["优秀", "较差"])
        self.assertTrue(all(item["base64"] for item in result))

    def test_level_selection_spans_quality_range(self):
        self.assertEqual([item[0] for item in select_sample_levels(3)], ["优秀", "中等", "较差"])

    def test_student_generation_retries_when_internal_level_leaks(self):
        leaked = '{"assignments":[{"title":"优秀作业","sections":[{"heading":"正文","paragraphs":["内容。"]}]}]}'
        clean = '{"assignments":[{"title":"课程作业","sections":[{"heading":"正文","paragraphs":["内容完整且表达自然。"]}]}]}'
        with patch(
            f"{generate_student_sample_blueprints.__module__}.call_agenteval_llm",
            side_effect=[leaked, clean],
        ) as llm_call:
            result = generate_student_sample_blueprints(
                assignment_title="课程作业",
                submission_requirement="请完成一份结构完整的课程报告，包含背景、分析、结论，并以 DOCX 文件提交。",
                levels=select_sample_levels(1),
                api_key="test",
                api_url="https://example.test/chat/completions",
                model="test-model",
            )

        self.assertEqual(result[0]["title"], "课程作业")
        self.assertEqual(llm_call.call_count, 2)
        self.assertIn("泄漏了内部测试标签", llm_call.call_args_list[1].kwargs["user_prompt"])


if __name__ == "__main__":
    unittest.main()
