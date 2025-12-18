# 编排器（Orchestrator）。负责循环（ReAct）、决定何时/用什么工具、解析模型输出里的“行动/行动输入”、执行工具、把“观察结果”再喂回模型，直到产出最终答案。

import json5
import os
import re
import time

from llm import Siliconflow
from tool import ReactTools


class ReactAgent:
    def __init__(self, api_key: str = '') -> None:
        self.api_key = api_key
        self.tools = ReactTools()
        self.model = Siliconflow(api_key=self.api_key)
        self.system_prompt = self._build_system_prompt()
        
    def _build_system_prompt(self) -> str:
        """构建系统提示，使用 ReAct 模式"""
        tool_descriptions = []
        for tool in self.tools.toolConfig:
            tool_descriptions.append(
                f"{tool['name_for_model']}: {tool['description_for_model']}"
                f" 参数: {json5.dumps(tool['parameters'], ensure_ascii=False)}"
            )
        
        tool_names = [tool['name_for_model'] for tool in self.tools.toolConfig]
        
        prompt = f"""现在时间是 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())}。你是一位智能助手，可以使用以下工具来回答问题：

{chr(10).join(tool_descriptions)}

请遵循以下 ReAct 模式：


思考：分析问题和需要使用的工具
行动：选择工具 [{', '.join(tool_names)}] 中的一个
行动输入：提供工具的参数
观察：工具返回的结果

你可以重复以上循环，直到获得足够的信息来回答问题。

最终答案：基于所有信息给出最终答案

开始！"""
        return prompt
    
    def _parse_action(self, text: str, verbose: bool = False) -> tuple[str, dict]:
        """从文本中解析行动和行动输入"""
        # 更灵活的正则表达式模式
        action_pattern = r"行动[:：]\s*(\w+)"
        action_input_pattern = r"行动输入[:：]\s*({.*?}|\{.*?\}|[^\n]*)"
        
        action_match = re.search(action_pattern, text, re.IGNORECASE)
        action_input_match = re.search(action_input_pattern, text, re.DOTALL)
        
        action = action_match.group(1).strip() if action_match else ""
        action_input_str = action_input_match.group(1).strip() if action_input_match else ""
        
        # 清理和解析JSON
        action_input_dict = {}
        if action_input_str:
            try:
                # 尝试解析为JSON对象
                action_input_str = action_input_str.strip()
                if action_input_str.startswith('{') and action_input_str.endswith('}'):
                    action_input_dict = json5.loads(action_input_str)
                else:
                    # 如果不是JSON格式，尝试解析为简单字符串参数
                    action_input_dict = {"search_query": action_input_str.strip('"\'')}
            except Exception as e:
                if verbose:
                    print(f"[ReAct Agent] 解析参数失败，使用字符串作为搜索查询: {e}")
                action_input_dict = {"search_query": action_input_str.strip('"\'')}
        
        return action, action_input_dict
    
    def _execute_action(self, action: str, action_input: dict) -> str:
        """执行指定的行动"""
        if action == "google_search":
            search_query = action_input.get("search_query", "")
            if search_query:
                results = self.tools.google_search(search_query)
                return f"观察：搜索完成，结果如下：\n{results}"
            else:
                return "观察：缺少搜索查询参数"
        
        return f"观察：未知行动 '{action}'"
    
    def _format_response(self, response_text: str) -> str:
        """格式化最终响应"""
        if "最终答案：" in response_text:
            return response_text.split("最终答案：")[-1].strip()
        return response_text
    
    def run(self, query: str, max_iterations: int = 3, verbose: bool = True) -> str:
        """运行 ReAct Agent
        
        Args:
            query: 用户查询
            max_iterations: 最大迭代次数
            verbose: 是否显示中间执行过程
        """
        conversation_history = []
        current_text = f"问题：{query}"
        
        # 绿色ANSI颜色代码
        GREEN = '\033[92m'
        RESET = '\033[0m'
        
        if verbose:
            print(f"{GREEN}[ReAct Agent] 开始处理问题: {query}{RESET}")
        
        for iteration in range(max_iterations):
            if verbose:
                print(f"{GREEN}[ReAct Agent] 第 {iteration + 1} 次思考...{RESET}")
            
            # 获取模型响应
            response, history = self.model.chat(
                current_text, 
                conversation_history, 
                self.system_prompt
            )
            
            if verbose:
                print(f"{GREEN}[ReAct Agent] 模型响应:\n{response}{RESET}")
            
            # 解析行动
            action, action_input = self._parse_action(response, verbose=verbose)
            
            if not action or action == "最终答案":
                final_answer = self._format_response(response)
                if verbose:
                    print(f"{GREEN}[ReAct Agent] 无需进一步行动，返回最终答案{RESET}")
                return final_answer
            
            if verbose:
                print(f"{GREEN}[ReAct Agent] 执行行动: {action} | 参数: {action_input}{RESET}")
            
            # 执行行动
            observation = self._execute_action(action, action_input)
            
            if verbose:
                print(f"{GREEN}[ReAct Agent] 观察结果:\n{observation}{RESET}")
            
            # 更新当前文本以继续对话
            current_text = f"{response}\n观察结果:{observation}\n"
            conversation_history = history
        
        # 达到最大迭代次数，返回当前响应
        if verbose:
            print(f"{GREEN}[ReAct Agent] 达到最大迭代次数，返回当前响应{RESET}")
        return self._format_response(response)

if __name__ == '__main__':
    # 推荐通过环境变量提供密钥，避免在代码里硬编码
    # export SILICONFLOW_API_KEY='你的siliconflow-key'
    # export SERPER_API_KEY='你的serper-key'
    api_key = os.getenv("SILICONFLOW_API_KEY", "").strip()
    if not api_key:
        raise ValueError(
            "缺少 SILICONFLOW_API_KEY：请先在终端 export SILICONFLOW_API_KEY='...'(以及可选的 SERPER_API_KEY)。"
        )

    agent = ReactAgent(api_key=api_key)

    response = agent.run(
        "React前端框架和开发Agent的ReAct框架名称好像啊，你有什么见解吗？",
        max_iterations=3,
        verbose=True,
    )
    print("最终答案：", response)