import unittest

from refine_training import (
    graph_positions,
    overlay_refined_fields,
    source_detail_for_plan_node,
    validate_plan,
)


def source_node(step_id, name, resources=None):
    return {
        "stepId": step_id,
        "stepDetailDTO": {
            "nodeType": "SCRIPT_NODE",
            "stepName": name,
            "description": f"{name}目标",
            "trainerName": "训练官",
            "prologue": "开场白",
            "llmPrompt": "原提示词 " * 20,
            "interactiveRounds": 3,
            "knowledgeBaseSwitch": 1,
            "scriptStepResourceList": resources or [],
            "stepExtProperty": {"resources": [{"list": resources or []}]},
        },
    }


class RefineTrainingTests(unittest.TestCase):
    def setUp(self):
        self.nodes = [
            {
                "stepId": "start-live",
                "stepDetailDTO": {"nodeType": "SCRIPT_START"},
            },
            source_node(
                "node-a",
                "卡片A",
                [{"fileId": "file-1", "fileName": "资料.pdf"}],
            ),
            source_node("node-b", "卡片B"),
            {
                "stepId": "end-live",
                "stepDetailDTO": {"nodeType": "SCRIPT_END"},
            },
        ]
        self.flows = [
            {
                "flowId": "flow-start-a",
                "scriptStepStartId": "start-live",
                "scriptStepEndId": "node-a",
            },
            {
                "flowId": "flow-a-b",
                "scriptStepStartId": "node-a",
                "scriptStepEndId": "node-b",
            },
            {
                "flowId": "flow-b-end",
                "scriptStepStartId": "node-b",
                "scriptStepEndId": "end-live",
            },
        ]
        self.plan = {
            "taskName": "优化训练",
            "description": "根据教师意见优化",
            "summary": "增加一张追问卡片",
            "architectureRationale": "先分析再追问",
            "nodes": [
                {
                    "id": "node-a",
                    "sourceStepId": "node-a",
                    "stepName": "卡片A优化",
                    "description": "优化目标",
                    "trainerName": "训练官",
                    "prologue": "优化开场白",
                    "llmPrompt": "优化提示词 " * 20,
                    "interactiveRounds": 4,
                },
                {
                    "id": "new-node",
                    "templateSourceStepId": "node-a",
                    "stepName": "追问卡",
                    "description": "引导追问",
                    "trainerName": "训练官",
                    "prologue": "请再思考",
                    "llmPrompt": "追问提示词 " * 20,
                    "interactiveRounds": 2,
                },
            ],
            "flows": [
                {
                    "id": "f1",
                    "sourceFlowId": "flow-start-a",
                    "from": "START",
                    "to": "node-a",
                    "condition": "",
                    "transitionPrompt": "",
                    "isDefault": True,
                },
                {
                    "id": "f2",
                    "from": "node-a",
                    "to": "new-node",
                    "condition": "",
                    "transitionPrompt": "继续追问",
                    "isDefault": True,
                },
                {
                    "id": "f3",
                    "from": "new-node",
                    "to": "END",
                    "condition": "",
                    "transitionPrompt": "",
                    "isDefault": True,
                },
            ],
        }

    def test_valid_graph_passes(self):
        errors, warnings = validate_plan(self.plan, self.nodes, self.flows)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_unreachable_node_is_rejected(self):
        broken = {**self.plan, "flows": self.plan["flows"][:1]}
        errors, _ = validate_plan(broken, self.nodes, self.flows)
        self.assertTrue(any("不能流向 END" in item for item in errors))
        self.assertTrue(any("从 START 不可达" in item for item in errors))

    def test_existing_node_keeps_resources_new_node_clears_them(self):
        by_id = {node["stepId"]: node for node in self.nodes}
        existing = source_detail_for_plan_node(
            self.plan["nodes"][0], by_id, self.nodes[1]
        )
        added = source_detail_for_plan_node(
            self.plan["nodes"][1], by_id, self.nodes[1]
        )
        self.assertEqual(len(existing["scriptStepResourceList"]), 1)
        self.assertEqual(added["scriptStepResourceList"], [])
        self.assertEqual(added["stepExtProperty"]["resources"], [])

        refined = overlay_refined_fields(existing, self.plan["nodes"][0])
        self.assertEqual(refined["stepName"], "卡片A优化")
        self.assertEqual(refined["interactiveRounds"], 4)
        self.assertEqual(refined["knowledgeBaseSwitch"], 1)

    def test_layout_follows_graph_layers(self):
        positions, _ = graph_positions(self.plan)
        self.assertLess(positions["node-a"]["x"], positions["new-node"]["x"])


if __name__ == "__main__":
    unittest.main()
