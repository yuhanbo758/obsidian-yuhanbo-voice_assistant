# 语音助手 (Voice Assistant) - Obsidian 插件

一个功能完整的 Obsidian 语音助手插件，支持讯飞在线语音识别、语音合成、语音唤醒，以及多种大模型集成。

## ✨ 主要功能

### 🎤 语音功能
- **语音唤醒**: 支持讯飞在线语音唤醒，可自定义唤醒词
- **语音识别 (ASR)**: 讯飞在线语音转文字
- **语音合成 (TTS)**: 讯飞在线文字转语音
- **录音控制**: 灵活的录音参数配置和测试功能

### 🤖 AI 集成
- **Google AI Studio**: 支持 Gemini 模型
- **OpenRouter**: 支持多种开源模型
- **讯飞星火**: 讯飞自研大语言模型


### 📝 笔记集成
- 自动将对话内容插入到当前笔记
- 支持自定义插入模板
- 音频文件可选保存到 Vault

## 🚀 快速开始

### 安装插件

1. 将插件文件复制到 `.obsidian/plugins/obsidian-yuhanbo-voice_assistant/` 目录
2. 在 Obsidian 设置中启用插件
3. 配置必要的 API 密钥和参数

### 基础配置

1. **选择 LLM 提供商**
   - Google AI Studio: 需要 API Key
   - OpenRouter: 需要 API Key  
   - 讯飞星火: 需要 App ID、API Key、API Secret

2. **配置语音功能**
   - 填写讯飞开放平台的认证信息

## 📋 使用说明

### 命令列表

| 命令 | 功能 | 快捷键 |
|------|------|--------|
| `语音助手：开始对话` | 开始语音对话流程 | 可自定义 |
| `语音助手：停止监听` | 停止语音监听 | 可自定义 |
| `语音助手：测试讯飞在线 ASR` | 测试在线语音识别 | - |
| `语音助手：测试讯飞在线 TTS` | 测试在线语音合成 | - |

### 语音对话流程

1. **触发方式**:
   - 手动执行"开始对话"命令
   - 语音唤醒 (如果启用)

2. **对话流程**:
   ```
   录音 → 语音识别 → AI 处理 → 插入笔记 → 语音播放
   ```

3. **结果格式**:
   ```markdown
   ## 语音对话 - 2024-01-01 12:00:00
   
   **用户：** 你好，请帮我总结一下今天的工作
   
   **AI：** 根据您的描述，今天的主要工作包括...
   ```

## ⚙️ 详细配置

### LLM 配置

#### Google AI Studio
1. 访问 [Google AI Studio](https://makersuite.google.com/)
2. 创建 API Key
3. 在插件设置中填入 API Key

#### OpenRouter
1. 访问 [OpenRouter](https://openrouter.ai/)
2. 注册账号并获取 API Key
3. 在插件设置中填入 API Key

#### 讯飞星火
1. 访问 [讯飞开放平台](https://www.xfyun.cn/doc/) <mcreference link="https://www.xfyun.cn/doc/" index="0">0</mcreference>
2. 创建应用获取 App ID、API Key、API Secret
3. 在插件设置中填入相关信息

### 语音功能配置

1. 注册讯飞开放平台账号
2. 创建应用并获取认证信息
3. 在插件设置中填入 App ID、API Key、API Secret

### 唤醒词管理

1. **默认唤醒词**: "你好，小三"、"小三同学"、"小三小三"
2. **自定义唤醒词**: 在设置中添加、编辑或删除
3. **唤醒模式**:
   - 禁用: 关闭语音唤醒
   - 在线: 使用讯飞在线唤醒服务

### 录音参数

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| 采样率 | 16000 Hz | 讯飞 API 推荐采样率 |
| 声道数 | 1 (单声道) | 减少数据量，提高识别准确率 |
| 音频格式 | PCM/WAV | 支持的音频格式 |

## 🔧 故障排除

### 常见问题

#### 1. 录音权限问题
**问题**: 无法访问麦克风
**解决**: 
- 检查浏览器麦克风权限
- 在 Windows 设置中允许应用访问麦克风

#### 2. API 调用失败
**问题**: LLM 或语音 API 调用失败
**解决**:
- 检查网络连接
- 验证 API Key 是否正确
- 查看控制台错误日志

#### 3. 语音识别准确率低
**问题**: ASR 识别结果不准确
**解决**:
- 确保录音环境安静
- 调整麦克风音量
- 检查采样率设置 (推荐 16kHz)

### 调试模式

启用调试日志可以帮助诊断问题:
1. 在插件设置中开启"启用调试日志"
2. 打开浏览器开发者工具 (F12)
3. 查看控制台输出的详细日志

### 日志示例

```
[语音助手] 插件已加载
[语音助手] 开始语音对话
[语音助手] 识别到文本: 你好，请帮我写一篇关于AI的文章
[语音助手] AI 回复: 当然可以帮您写一篇关于AI的文章...
[语音助手] 内容已插入到笔记
```

## 🔒 安全与隐私

### 数据处理说明

- **语音数据**: 录音会发送到讯飞服务器进行处理
- **文本数据**: 识别结果会发送到选定的 LLM 服务商
- **存储**: 插件本身不存储任何语音或文本数据

### 隐私建议

1. **API Key 安全**: 
   - 不要在公共场所展示设置界面
   - 定期更换 API Key
   - 不要将配置文件分享给他人

2. **敏感信息**: 
   - 避免在语音对话中包含敏感个人信息

3. **网络安全**: 
   - 确保网络连接安全
   - 在公共网络环境下谨慎使用

## 🛠️ 开发信息

### 技术栈
- **语言**: TypeScript
- **框架**: Obsidian Plugin API
- **语音处理**: Web Audio API, 讯飞语音 SDK
- **网络通信**: WebSocket, HTTP/HTTPS
- **构建工具**: esbuild

### 项目结构
```
obsidian-yuhanbo-voice_assistant/
├── main.ts              # 主插件文件
├── manifest.json        # 插件清单
├── package.json         # 项目配置
├── tsconfig.json        # TypeScript 配置
├── esbuild.config.mjs   # 构建配置
├── styles.css           # 样式文件
└── README.md           # 说明文档
```

### 构建命令
```bash
# 开发模式
npm run dev

# 生产构建
npm run build

# 版本更新
npm run version
```

## 📄 许可证

MIT License - 详见 LICENSE 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献指南
1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 发起 Pull Request

## 📞 支持

如果您遇到问题或有建议，请:
1. 查看本文档的故障排除部分
2. 在 GitHub 上提交 Issue
3. 参考讯飞开放平台官方文档

## 🔗 相关链接

- [Obsidian 官网](https://obsidian.md/)
- [讯飞开放平台](https://www.xfyun.cn/doc/) <mcreference link="https://www.xfyun.cn/doc/" index="0">0</mcreference>
- [Google AI Studio](https://makersuite.google.com/)
- [OpenRouter](https://openrouter.ai/)

## 📝 更新日志

### v1.0.0 (20250930
- 🎉 首次发布
- ✨ 支持讯飞在线语音功能
- 🤖 集成多种 LLM 服务
- 🎤 语音唤醒功能
- 📝 笔记自动插入
- ⚙️ 完整的设置界面





## 👨‍💻 作者信息

**余汉波** - 编程爱好者-量化交易和效率工具开发

- **GitHub**: [@yuhanbo758](https://github.com/yuhanbo758)

- **Email**: yuhanbo@sanrenjz.com

- **Website**: [三人聚智](https://www.sanrenjz.com)

## 🌐 相关链接

- 🏠 [项目主页](https://www.sanrenjz.com)

- 📚 [在线文档](https://docs.sanrenjz.com)（财经、代码和库文档等）

- 🛒 [插件商店](https://shop.sanrenjz.com)（个人开发的所有程序，包括开源和不开源）


## 联系我们

[联系我们 - 三人聚智-余汉波](https://www.sanrenjz.com/contact_us/)

python 程序管理工具下载：[sanrenjz - 三人聚智-余汉波](https://www.sanrenjz.com/sanrenjz/)

效率工具程序管理下载：[sanrenjz-tools - 三人聚智-余汉波](https://www.sanrenjz.com/sanrenjz-tools/)

![三码合一](https://gdsx.sanrenjz.com/image/sanrenjz_yuhanbolh_yuhanbo758.png?imageSlim&t=1ab9b82c-e220-8022-beff-e265a194292a)

![余汉波打赏码](https://gdsx.sanrenjz.com/image/%E6%89%93%E8%B5%8F%E7%A0%81%E5%90%88%E4%B8%80.png?imageSlim)

## 🙏 致谢

感谢所有为本项目贡献代码和想法的开发者们！

---
**⭐ 如果这个项目对您有帮助，请给它一个 Star！**

