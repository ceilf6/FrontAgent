# 模型适配层（Model Wrapper）。只负责“把 prompt+history 发给模型服务并拿到回复”，
# 屏蔽具体 API（OpenAI SDK、base_url、model 名、temperature 等），一般不做工具选择/解析/执行。
# export SILICONFLOW_API_KEY='你的siliconflow-key'
# export SERPER_API_KEY='你的serper-key'
# /Users/a86198/Desktop/Lab/.venv/bin/python agent.py

from __future__ import annotations

import os
from typing import Dict, List, Optional, Tuple

from openai import OpenAI


class BaseModel:
    def __init__(self, api_key: str = "") -> None:
        self.api_key = api_key

    def chat(
        self,
        prompt: str,
        history: List[Dict[str, str]],
        system_prompt: str = "",
    ) -> Tuple[str, List[Dict[str, str]]]:
        """
        基础聊天接口
        
        Args:
            prompt: 用户输入
            history: 对话历史
            system_prompt: 系统提示
            
        Returns:
            (模型响应, 更新后的对话历史)
        """
        pass

    
class Siliconflow(BaseModel):
    def __init__(self, api_key: str = ""):
        api_key = api_key or os.getenv("SILICONFLOW_API_KEY", "")
        if not api_key:
            raise ValueError(
                "Missing Siliconflow API key. Pass api_key or set env SILICONFLOW_API_KEY."
            )

        self.api_key = api_key
        self.client = OpenAI(api_key=self.api_key, base_url="https://api.siliconflow.cn/v1")

    def chat(
        self,
        prompt: str,
        history: Optional[List[Dict[str, str]]] = None,
        system_prompt: str = "",
    ) -> Tuple[str, List[Dict[str, str]]]:
        """
        与 Siliconflow API 进行聊天
        
        Args:
            prompt: 用户输入
            history: 对话历史
            system_prompt: 系统提示
            
        Returns:
            (模型响应, 更新后的对话历史)
        """
        # 构建消息列表
        messages = [
            {"role": "system", "content": system_prompt or "You are a helpful assistant."}
        ]
        
        # 添加历史消息
        if history:
            messages.extend(history)
        
        # 添加当前用户消息
        messages.append({"role": "user", "content": prompt})

        # 调用 API
        response = self.client.chat.completions.create(
            model="Qwen/Qwen3-30B-A3B-Instruct-2507",
            messages=messages,
            temperature=0.6,
            max_tokens=2000,
        )

        model_response = response.choices[0].message.content
        
        # 更新对话历史
        updated_history = messages.copy()
        updated_history.append({"role": "assistant", "content": model_response})

        return model_response, updated_history

if __name__ == "__main__":
    llm = Siliconflow(api_key=os.getenv("SILICONFLOW_API_KEY", ""))
    prompt = "你好"
    response, history = llm.chat(prompt)
    print("Response:", response)
    print("History:", history)