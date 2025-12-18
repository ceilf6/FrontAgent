import json
import os
from typing import Any, Dict, List, Optional

import requests

class ReactTools:
    """
    React Agent 工具类
    
    为 ReAct Agent 提供标准化的工具接口
    """
    
    def __init__(self, serper_api_key: str = "") -> None:
        self.serper_api_key = serper_api_key or os.getenv("SERPER_API_KEY", "")
        self.toolConfig = self._build_tool_config()
    
    def _build_tool_config(self) -> List[Dict[str, Any]]:
        """构建工具配置信息"""
        return [
            {
                'name_for_human': '谷歌搜索',
                'name_for_model': 'google_search',
                'description_for_model': '谷歌搜索是一个通用搜索引擎，可用于访问互联网、查询百科知识、了解时事新闻等。',
                'parameters': [
                    {
                        'name': 'search_query',
                        'description': '搜索关键词或短语',
                        'required': True,
                        'schema': {'type': 'string'},
                    }
                ],
            }
        ]

    def google_search(self, search_query: str) -> str:
        """执行谷歌搜索

        可在 https://serper.dev/dashboard 申请 api key

        Args:
            search_query: 搜索关键词
            
        Returns:
            格式化的搜索结果字符串
        """
        url = "https://google.serper.dev/search"

        if not self.serper_api_key:
            return "缺少 SERPER_API_KEY：请设置环境变量 SERPER_API_KEY 或在 ReactTools 初始化时传入 serper_api_key。"

        payload = json.dumps({"q": search_query})
        headers = {"X-API-KEY": self.serper_api_key, "Content-Type": "application/json"}

        try:
            response = requests.request(
                "POST", url, headers=headers, data=payload, timeout=20
            ).json()
            organic_results = response.get('organic', [])
            
            # 格式化搜索结果
            formatted_results = []
            for idx, result in enumerate(organic_results[:5], 1):
                title = result.get('title', '无标题')
                snippet = result.get('snippet', '无描述')
                link = result.get('link', '')
                formatted_results.append(f"{idx}. **{title}**\n   {snippet}\n   链接: {link}")
            
            return "\n\n".join(formatted_results) if formatted_results else "未找到相关结果"
            
        except Exception as e:
            return f"搜索时出现错误: {str(e)}"
    
    def get_available_tools(self) -> List[str]:
        """获取可用工具名称列表"""
        return [tool['name_for_model'] for tool in self.toolConfig]
    
    def get_tool_description(self, tool_name: str) -> str:
        """获取工具描述"""
        for tool in self.toolConfig:
            if tool['name_for_model'] == tool_name:
                return tool['description_for_model']
        return "未知工具"

if __name__ == "__main__":
    tools = ReactTools()
    result = tools.google_search("React前端框架和开发Agent的ReAct框架名称好像啊，你有什么见解吗？")
    print(result)