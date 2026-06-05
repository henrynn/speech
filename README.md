# speech

这个仓库汇总了多个语音与会议智能相关项目，覆盖实时语音助手、会议总结，以及基础语音识别实验。各项目可以独立查看与演示，但运行方式和环境要求各不相同。

## 项目概览

| 项目 | 简介 | 链接 |
| --- | --- | --- |
| Voice_Agent_Realtime | 基于 Azure OpenAI / Azure AI Foundry Realtime API 的浏览器语音助手，支持 WebRTC 实时语音、多工具调用、中文交互界面。 | [Voice_Agent_Realtime](./Voice_Agent_Realtime/) |
| meeting_summary | 基于 Streamlit 的会议助手，集成 Azure Speech Fast Transcription 与 GPT 分析能力，用于会议转录、图像分析和内容总结。 | [meeting_summary](./meeting_summary/) |
| speech_to_text | 基于 Azure Speech SDK 的语音识别与文本队列实验代码，包含连续识别、增量文本拼接和翻译处理逻辑。 | [speech_to_text](./speech_to_text/) |

## 项目详情

## Voice_Agent_Realtime

- 适合需要实时语音对话和工具调用的浏览器端语音 Agent 场景。
- 前端通过 WebRTC 连接 Realtime 会话，后端负责 Azure 身份鉴权和工具接口。
- 内置天气、AI 新闻、游戏攻略三个工具示例。

项目入口： [Voice_Agent_Realtime](./Voice_Agent_Realtime/)

## meeting_summary

- 适合会议录音转写、会议纪要整理和多模态分析场景。
- 主要由 Streamlit 界面、Azure Speech Fast Transcription 和 LLM 分析模块组成。
- 项目内包含会议摘要主程序、语音转写逻辑和图像/文本分析代码。

项目入口： [meeting_summary](./meeting_summary/)

## speech_to_text

- 适合做 Azure Speech SDK 连续识别流程验证和文本分段策略实验。
- 包含连续语音识别、实时翻译以及用于处理 partial/final 结果的文本队列逻辑。
- 更偏底层验证和脚本实验，需要按脚本内配置补齐密钥、区域和本地音频路径，而不是开箱即用的完整 Web 应用。

项目入口： [speech_to_text](./speech_to_text/)

## GitHub 快速链接

- [Voice_Agent_Realtime](https://github.com/henrynn/speech/tree/master/Voice_Agent_Realtime)
- [meeting_summary](https://github.com/henrynn/speech/tree/master/meeting_summary)
- [speech_to_text](https://github.com/henrynn/speech/tree/master/speech_to_text)
