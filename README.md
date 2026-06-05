# speech

这个仓库汇总了多个语音与会议智能相关项目，覆盖浏览器实时语音助手、Windows 本地 Voice Live 助手、会议总结，以及基础语音识别实验。各项目可以独立运行，但目标场景、依赖环境和接入方式并不相同。

## 项目概览

| 项目 | 适用场景 | 关键特点 | 链接 |
| --- | --- | --- | --- |
| Voice_Agent_VoiceLive | Windows 本机语音助手与设备控制 | Azure Voice Live、本地 Python 控制层、摄像头分析、天气新闻查询、桌面动作触发 | [Voice_Agent_VoiceLive](./Voice_Agent_VoiceLive/) |
| Voice_Agent_Realtime | 浏览器端实时语音 Agent | Azure OpenAI / Azure AI Foundry Realtime API、WebRTC、多工具调用、中文交互界面 | [Voice_Agent_Realtime](./Voice_Agent_Realtime/) |
| meeting_summary | 会议转录与内容总结 | Streamlit、Azure Speech Fast Transcription、图像与文本分析 | [meeting_summary](./meeting_summary/) |
| speech_to_text | 底层语音识别实验 | Azure Speech SDK、连续识别、partial/final 文本拼接与翻译验证 | [speech_to_text](./speech_to_text/) |

## 如何选择

- 如果你要的是 Windows 本机上的语音助手，能够直接控制音量、触发桌面动作、结合摄像头画面理解，请看 [Voice_Agent_VoiceLive](./Voice_Agent_VoiceLive/)。
- 如果你要的是浏览器里的实时语音 Agent，更关注 WebRTC 会话、多工具调用和纯 Web 交互，请看 [Voice_Agent_Realtime](./Voice_Agent_Realtime/)。
- 如果你要做会议录音转写、纪要整理和多模态分析，请看 [meeting_summary](./meeting_summary/)。
- 如果你要验证更底层的 Azure Speech SDK 识别流程，请看 [speech_to_text](./speech_to_text/)。

## 项目详情

## Voice_Agent_VoiceLive

- 最新加入的 Windows 本地语音助手项目，界面名称为 Nebula PC Assistant。
- 浏览器控制台负责展示实时对话、状态、摄像头预览和桌面动作入口。
- Node.js 负责静态页面、本地 API 和事件桥接，Python 负责音量控制、Windows 动作执行，以及多帧摄像头分析。
- 适合需要 Azure Voice Live 中文语音交互和本机设备联动的场景。

项目入口： [Voice_Agent_VoiceLive](./Voice_Agent_VoiceLive/)

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

- [Voice_Agent_VoiceLive](https://github.com/henrynn/speech/tree/master/Voice_Agent_VoiceLive)
- [Voice_Agent_Realtime](https://github.com/henrynn/speech/tree/master/Voice_Agent_Realtime)
- [meeting_summary](https://github.com/henrynn/speech/tree/master/meeting_summary)
- [speech_to_text](https://github.com/henrynn/speech/tree/master/speech_to_text)
