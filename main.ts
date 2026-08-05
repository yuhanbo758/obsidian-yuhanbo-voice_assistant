import { App, Editor, EditorPosition, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, requestUrl, Setting } from 'obsidian';

/** 兼容旧版 Chromium 中带 webkit 前缀的音频上下文。 */
interface AudioContextWindow extends Window {
	webkitAudioContext?: typeof AudioContext;
}

/** 讯飞 ASR WebSocket 响应。 */
interface XunfeiAsrResponse {
	code: number;
	message?: string;
	data?: {
		status?: number;
		result?: {
			ws?: Array<{ cw?: Array<{ w?: string }> }>;
		};
	};
}

/** 讯飞 TTS WebSocket 响应。 */
interface XunfeiTtsResponse {
	code: number;
	message?: string;
	data?: {
		audio?: string;
		status?: number;
	};
}

/** 讯飞星火 WebSocket 响应。 */
interface XunfeiSparkResponse {
	header?: {
		code?: number;
		message?: string;
		status?: number;
	};
	payload?: {
		choices?: {
			text?: Array<{ content?: string }>;
		};
	};
}

/** Google Generative Language API 响应的最小子集。 */
interface GoogleAiResponse {
	error?: { message?: string };
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
}

/** OpenRouter chat completions 响应的最小子集。 */
interface OpenRouterResponse {
	choices?: Array<{
		message?: { content?: string };
	}>;
}

/**
 * 将外部 JSON 解析为指定响应结构。
 * 调用点仍会检查必需字段，该函数只集中隔离 JSON.parse 的 any 返回值。
 */
function parseJsonResponse<T>(source: string): T {
	const parsed: unknown = JSON.parse(source);
	return parsed as T;
}

/** 将任意抛出值归一化为 Error，避免 Promise 使用非 Error 拒绝原因。 */
function normalizeError(reason: unknown, fallbackMessage = '未知错误'): Error {
	if (reason instanceof Error) {
		return reason;
	}
	return new Error(typeof reason === 'string' ? reason : fallbackMessage);
}

/** 获取可安全展示的错误文本。 */
function getErrorMessage(reason: unknown): string {
	return normalizeError(reason).message;
}

/** 将字节数组转为 Base64，分块处理以避免超大音频导致调用栈溢出。 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 8192;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return window.btoa(binary);
}

/** 使用标准 Web Crypto API 生成讯飞鉴权所需的 HMAC-SHA256 Base64 签名。 */
async function hmacSha256Base64(secret: string, content: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await window.crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await window.crypto.subtle.sign('HMAC', key, encoder.encode(content));
	return bytesToBase64(new Uint8Array(signature));
}

/** 按 UTF-8 字节编码文本，替代已废弃的 unescape 组合。 */
function encodeUtf8ToBase64(text: string): string {
	return bytesToBase64(new TextEncoder().encode(text));
}

/** 创建当前 Obsidian 窗口所属的音频上下文。 */
function createAudioContext(): AudioContext {
	const AudioContextConstructor = window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
	if (!AudioContextConstructor) {
		throw new Error('当前环境不支持 Web Audio API');
	}
	return new AudioContextConstructor();
}

/**
 * 按浏览器真实支持情况创建录音器。
 * 不伪装音频格式：如果指定格式均不可用，则让浏览器选择默认容器和编码器。
 */
function createCompatibleMediaRecorder(stream: MediaStream): MediaRecorder {
	const preferredMimeTypes = [
		'audio/webm;codecs=opus',
		'audio/webm',
		'audio/mp4',
	];
	const mimeType = preferredMimeTypes.find(candidate => MediaRecorder.isTypeSupported(candidate));
	return mimeType
		? new MediaRecorder(stream, { mimeType })
		: new MediaRecorder(stream);
}

// 插件设置接口定义
interface VoiceAssistantSettings {
	// LLM 配置
	llmProvider: 'google' | 'openrouter' | 'xunfei' | 'custom';
	googleApiKey: string;
	googleModel: string;
	openrouterApiKey: string;
	openrouterModel: string;
	xunfeiAppId: string;
	xunfeiApiKey: string;
	xunfeiApiSecret: string;
	xunfeiModel: string;
	customModels: Array<{name: string, provider: string, modelId: string}>;
	selectedCustomModel: string;
	
	// 语音唤醒配置
	wakeMode: 'online' | 'disabled';
	wakeWords: string[];
	autoEnterDialogAfterWake: boolean;
	wakeDetectionInterval: number; // 唤醒检测间隔时间（毫秒）
	
	// 持续对话配置
	continuousDialogDuration: number; // 持续对话时长（秒）
	showDialogControls: boolean; // 是否显示对话控制界面
	conversationSaveFolder: string; // 对话保存文件夹路径
	
	// 语音听写配置
	dictationSilenceTimeout: number; // 持续听写静默超时时间（秒）
	dictationSilenceInterval: number; // 录音静默间隔时间（秒），用户停止说话后多久进行识别
	
	// 语音检测配置
	voiceDetectionThreshold: number; // 语音检测阈值 (0-100)
	voiceDetectionSensitivity: number; // 检测敏感度 (50-500ms)
	enableVoiceInterruption: boolean; // 是否启用语音打断
	
	// 自定义提示词配置
	customPrompts: Array<{
		name: string;
		trigger: string; // 触发关键词
		prompt: string; // 提示词内容
		enabled: boolean;
	}>;
	
	// 语音识别配置
	asrProvider: 'xunfei';
	
	// 语音合成配置
	ttsMode: 'disabled' | 'online';
	ttsProvider: 'xunfei';
	ttsVoice: string; // 朗读人声音
	ttsSpeed: number; // 语速 (0-100)
	ttsVolume: number; // 音量 (0-100)
	ttsPitch: number; // 音调 (0-100)
	saveAudioToVault: boolean;
	audioSavePath: string;
	
	// 录音配置
	sampleRate: number;
	channels: number;
	audioFormat: 'pcm' | 'wav';
	
	// 调试配置
	enableDebugLog: boolean;
}

// 默认设置
const DEFAULT_SETTINGS: VoiceAssistantSettings = {
	llmProvider: 'google',
	googleApiKey: '',
	googleModel: 'gemini-pro',
	openrouterApiKey: '',
	openrouterModel: 'openai/gpt-3.5-turbo',
	xunfeiAppId: '',
	xunfeiApiKey: '',
	xunfeiApiSecret: '',
	xunfeiModel: 'generalv3.5',
	customModels: [],
	selectedCustomModel: '',
	
	wakeMode: 'disabled',
	wakeWords: ['你好，小三', '小三同学', '小三小三'],
	autoEnterDialogAfterWake: true,
	wakeDetectionInterval: 1000, // 默认1秒检测间隔
	
	continuousDialogDuration: 60, // 默认1分钟
	showDialogControls: true,
	conversationSaveFolder: 'voice-assistant/conversations', // 默认对话保存文件夹
	
	dictationSilenceTimeout: 10, // 默认10秒静默超时
	dictationSilenceInterval: 2, // 默认2秒静默间隔
	
	voiceDetectionThreshold: 30, // 默认阈值30
	voiceDetectionSensitivity: 100, // 默认100ms检测间隔
	enableVoiceInterruption: true, // 默认启用语音打断
	
	customPrompts: [
		{
			name: '任务提醒',
			trigger: '提醒我',
			prompt: '请根据用户的描述，生成一个符合Markdown格式的任务提醒。格式要求：\n- [ ] 任务内容\n- 时间：具体时间\n- 备注：相关说明\n\n请确保生成的内容可以直接插入到Obsidian笔记中。',
			enabled: true
		}
	],
	
	asrProvider: 'xunfei',
	
	ttsMode: 'disabled',
	ttsProvider: 'xunfei',
	ttsVoice: 'xiaoyan', // 默认朗读人：小燕
	ttsSpeed: 50, // 默认语速
	ttsVolume: 50, // 默认音量
	ttsPitch: 50, // 默认音调
	saveAudioToVault: false,
	audioSavePath: 'voice-assistant/audio',
	
	sampleRate: 16000,
	channels: 1,
	audioFormat: 'pcm',
	
	enableDebugLog: false
};

/**
 * 语音助手主插件类
 * 提供完整的语音交互功能，包括语音唤醒、识别、合成和AI对话
 */
export default class VoiceAssistantPlugin extends Plugin {
	settings: VoiceAssistantSettings;
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	private isRecording = false;
	private isListening = false;
	private wakeWebSocket: WebSocket | null = null;
	private statusFloat: HTMLElement | null = null;
	private currentAudio: HTMLAudioElement | null = null;
	private isPlaying = false;
	private autoHideTimer: number | null = null;
	private wakeStatusBarItem: HTMLElement | null = null;
	
	// 持续对话状态管理
	private isInContinuousDialog = false;
	private conversationHistory: Array<{user: string, assistant: string, timestamp: Date}> = [];
	private silenceTimer: number | null = null;
	private silenceDetectionDuration = 20000; // 20秒静默检测
	
	// 背景语音检测
	private backgroundVoiceDetection = false;
	private backgroundMediaRecorder: MediaRecorder | null = null;
	private backgroundStream: MediaStream | null = null;
	private voiceDetectionTimer: number | null = null;
	
	// 持续听写相关属性
	private isDictating = false;
	private dictationTimer: number | null = null;
	private dictationStartTime: number = 0;
	private dictationAudioChunks: Blob[] = []; // 累积的音频片段
	private lastVoiceDetectedTime: number = 0; // 最后检测到语音的时间
	private silenceCheckTimer: number | null = null; // 静默检测定时器
	
	// 预录音缓冲区相关
	private preRecordingBuffer: Blob[] = []; // 预录音缓冲区
	private preRecordingStream: MediaStream | null = null; // 预录音流
	private preRecordingRecorder: MediaRecorder | null = null; // 预录音记录器
	private isPreRecording = false; // 是否正在预录音
	private preRecordingBufferSize = 10; // 缓冲区大小（保留最近10个音频片段）
	
	// 唤醒对话相关
	private isWakeConversation = false; // 标记是否为唤醒触发的对话
	private wakeSessionId: string | null = null; // 唤醒会话ID
	private wakeSessionFileName: string | null = null; // 唤醒会话文件名
	private wakeSessionAudioSaved = false; // 标记唤醒会话是否已保存音频
	
	// 语音唤醒监听相关
	private wakeMediaRecorder: MediaRecorder | null = null;
	private wakeStream: MediaStream | null = null;


	/**
	 * 插件加载时的初始化方法
	 */
	async onload() {
		await this.loadSettings();

		// 注册插件命令
		this.addCommand({
			id: 'start-voice-conversation',
			name: '开始对话',
			callback: () => this.startVoiceConversation()
		});

		this.addCommand({
			id: 'start-listening',
			name: '开始监听',
			callback: () => this.startListening()
		});

		this.addCommand({
			id: 'stop-listening',
			name: '停止监听',
			callback: () => this.stopListening()
		});

		this.addCommand({
			id: 'end-dialog',
			name: '结束对话',
			callback: () => this.endContinuousDialog()
		});

		this.addCommand({
			id: 'voice-dictation',
			name: '语音听写',
			callback: () => this.startVoiceDictation()
		});

		this.addCommand({
			id: 'continuous-dictation',
			name: '持续听写',
			callback: () => this.startVoiceDictation()
		});

		this.addCommand({
			id: 'voice-reading',
			name: '语音朗读',
			callback: () => this.startVoiceReading()
		});

		// 添加设置面板
		this.addSettingTab(new VoiceAssistantSettingTab(this.app, this));

		// 等待工作区布局就绪后再操作全局 DOM，避免影响 Obsidian 启动阶段。
		this.app.workspace.onLayoutReady(() => {
			this.createStatusFloat();
			this.showStatusFloat();
			this.updateStatusFloat('语音助手已加载 - 停止监听', 'info');
		});

		// 插件加载后默认为停止监听状态，用户需要手动启动监听
		// 不再自动启动语音唤醒监听

		this.debugLog('语音助手插件已加载 - 默认停止监听状态');
	}

	/**
	 * 插件卸载时的清理方法
	 */
	onunload() {
		this.stopListening();
		this.stopWakeListening();
		this.stopTTS();

		// 清理自动隐藏定时器
		if (this.autoHideTimer) {
			window.clearTimeout(this.autoHideTimer);
			this.autoHideTimer = null;
		}
		
		// 清理听写相关定时器
		if (this.silenceCheckTimer) {
			window.clearTimeout(this.silenceCheckTimer);
			this.silenceCheckTimer = null;
		}
		
		this.removeStatusFloat();
		this.wakeStatusBarItem = null;
		this.debugLog('语音助手插件已卸载');
	}

	/**
	 * 加载插件设置
	 */
	async loadSettings() {
		const savedSettings = await this.loadData() as Partial<VoiceAssistantSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(savedSettings ?? {}) };
	}

	/**
	 * 保存插件设置
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 调试日志输出
	 */
	private debugLog(message: string, ...args: unknown[]) {
		// 生产版本不向控制台输出笔记、音频、凭据或第三方响应。
		// 保留该方法以兼容现有调用点，并避免泄露用户内容。
		void message;
		void args;
	}

	/**
	 * 测试TTS功能
	 */
	async testTTS() {
		new Notice('开始TTS测试...');
		
		try {
			const testText = '这是一个TTS功能测试，如果你能听到这段话，说明TTS功能正常工作。';
			
			await this.textToSpeech(testText);
			new Notice('TTS测试完成');
		} catch (error) {
			new Notice(`TTS测试失败: ${getErrorMessage(error)}`);
		}
	}

	/**
	 * 开始语音对话流程
	 * 录音 → ASR → LLM → 插入笔记 → TTS
	 */
	async startVoiceConversation() {
		try {
			// 如果不在持续对话模式，则启动持续对话
			if (!this.isInContinuousDialog) {
				this.startContinuousDialog();
			}
			
			await this.processSingleConversation();
			
		} catch (error) {
			this.debugLog('语音对话出错:', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
			new Notice(`语音对话出错: ${errorMessage}`);
		}
	}

	/**
	 * 启动持续对话模式
	 */
	private startContinuousDialog(): void {
		this.isInContinuousDialog = true;
		this.debugLog('启动持续对话模式');
		
		// 清空对话历史，开始新的对话会话
		this.conversationHistory = [];
		
		// 启动预录音缓冲
		void this.startPreRecordingBuffer();
		
		// 显示对话控制界面
		if (this.settings.showDialogControls) {
			this.showDialogControls();
		}
		
		new Notice('持续对话模式已启动，开始说话或20秒无语音将自动结束');
	}

	/**
	 * 处理单次对话
	 */
	private async processSingleConversation(): Promise<void> {
		this.debugLog('开始语音对话');
		
		// 清除静默检测计时器（有新的语音输入）
		this.clearSilenceTimer();
		
		new Notice('开始录音，请说话...');
		
		// 开始录音
		const audioBlob = await this.startRecording();
		
		// 语音识别
		const text = await this.speechToText(audioBlob);
		if (!text || text === '未识别到语音内容') {
			new Notice('语音识别失败，请重试');
			// 在持续对话模式下，启动静默检测
			if (this.isInContinuousDialog) {
				this.startSilenceDetection();
			}
			return;
		}
		
		this.debugLog('识别到文本:', text);
		new Notice(`识别到：${text}`);
		
		// 检查自定义提示词
		const enhancedText = this.processCustomPrompts(text);
		
		// 调用大模型
		const response = await this.callLLM(enhancedText);
		if (!response) {
			new Notice('AI 回复失败，请检查配置');
			// 在持续对话模式下，启动静默检测
			if (this.isInContinuousDialog) {
				this.startSilenceDetection();
			}
			return;
		}
		
		this.debugLog('AI 回复:', response);
		
		// 在持续对话模式下，存储对话历史而不是立即插入笔记
		if (this.isInContinuousDialog) {
			this.conversationHistory.push({
				user: text,
				assistant: response,
				timestamp: new Date()
			});
			this.debugLog('对话已存储到历史记录，当前对话数:', this.conversationHistory.length);
		} else {
			// 非持续对话模式，直接插入笔记
			this.insertToNote(text, response);
		}
		
		// 语音合成（如果启用）
		if (this.settings.ttsMode !== 'disabled') {
			// 在持续对话模式下，TTS播放期间启动背景语音检测和预录音缓冲
			if (this.isInContinuousDialog) {
				void this.startBackgroundVoiceDetection();
				void this.startPreRecordingBuffer();
			}
			await this.textToSpeech(response);
			// TTS播放完成后停止背景语音检测，但保持预录音缓冲
			if (this.isInContinuousDialog) {
				this.stopBackgroundVoiceDetection();
			}
		}
		
		// 在持续对话模式下，启动静默检测等待下一轮对话
		if (this.isInContinuousDialog) {
			this.startSilenceDetection();
			new Notice('继续说话或等待20秒自动结束对话...');
		}
	}

	/**
	 * 开始语音听写
	 * 使用持续模式进行听写，按快捷键开始，静默超时自动结束
	 */
	private async startVoiceDictation(): Promise<void> {
		try {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) {
				new Notice('请先打开一个笔记文件');
				return;
			}

			// 如果已经在听写中，则停止当前听写
			if (this.isDictating) {
				this.stopDictation();
				return;
			}

			// 直接使用持续听写模式
			await this.startContinuousDictation();
		} catch (error) {
			this.debugLog('语音听写错误:', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
			new Notice('语音听写失败: ' + errorMessage);
			this.stopDictation();
		}
	}

	/**
	 * 按住模式听写
	 * 支持连续触发检测，模拟按住效果
	 */


	/**
	 * 持续模式听写
	 * 按快捷键开始，静默超时自动结束
	 */
	private async startContinuousDictation(): Promise<void> {
		this.isDictating = true;
		this.dictationStartTime = Date.now();
		this.updateStatusFloat('听写中', 'info', false);
		
		// 显示听写控制界面
		this.showDictationControls();
		
		// 开始持续录音和识别
		await this.startContinuousDictationLoop();
	}

	/**
	 * 持续听写循环
	 * 使用真正的静默检测，在指定时间内无语音输入则自动结束
	 */
	/**
	 * 持续听写循环 - 改进版本
	 * 连续录音，只有在静默间隔后才进行语音识别，避免打断连续语音
	 */
	private async startContinuousDictationLoop(): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			this.stopDictation();
			return;
		}

		const editor = activeView.editor;
		let allRecognizedText = '';
		let lastVoiceTime = Date.now();
		const silenceTimeoutMs = this.settings.dictationSilenceTimeout * 1000; // 总超时时间
		const silenceIntervalMs = this.settings.dictationSilenceInterval * 1000; // 静默间隔时间
		
		// 记录听写开始时的光标位置，用于跟踪插入位置
		let insertPosition = editor.getCursor();
		
		// 初始化音频片段数组和最后语音时间
		this.dictationAudioChunks = [];
		this.lastVoiceDetectedTime = Date.now();

		// 启动总体静默超时检测定时器
		this.dictationTimer = window.setInterval(() => {
			if (!this.isDictating) {
				return;
			}
			
			const currentTime = Date.now();
			const totalSilenceDuration = currentTime - lastVoiceTime;
			
			if (totalSilenceDuration >= silenceTimeoutMs) {
				this.debugLog(`持续听写静默超时 ${this.settings.dictationSilenceTimeout} 秒，自动结束`);
				this.stopDictation();
				
				if (allRecognizedText.trim()) {
					this.updateStatusFloat('听写结束', 'success', true);
					new Notice(`听写完成，共识别：${allRecognizedText.trim()}`);
				} else {
					this.updateStatusFloat('听写结束', 'warning', true);
					new Notice('听写结束，未识别到语音内容');
				}
			}
		}, 1000); // 每秒检查一次

		// 持续录音循环 - 使用较短的片段进行实时检测
		while (this.isDictating) {
			try {
				// 录音500ms的短片段进行实时语音检测
				const audioBlob = await this.recordAudioSegment(500);
				
				// 检测是否有语音内容
				const hasVoice = await this.detectVoiceInAudio(audioBlob);
				
				if (hasVoice) {
					// 检测到语音，累积音频片段
					this.dictationAudioChunks.push(audioBlob);
					this.lastVoiceDetectedTime = Date.now();
					lastVoiceTime = Date.now(); // 更新总体最后语音时间
					
					this.updateStatusFloat('正在录音...', 'info', false);
					this.debugLog('检测到语音，累积音频片段');
					
					// 清除之前的静默检测定时器
					if (this.silenceCheckTimer) {
						window.clearTimeout(this.silenceCheckTimer);
						this.silenceCheckTimer = null;
					}
				} else {
					// 没有检测到语音，检查是否需要处理累积的音频
					const currentTime = Date.now();
					const silenceDuration = currentTime - this.lastVoiceDetectedTime;
					
					// 如果有累积的音频片段且静默时间达到间隔要求
					if (this.dictationAudioChunks.length > 0 && silenceDuration >= silenceIntervalMs) {
						const recognizedText = await this.processAccumulatedAudio(editor, insertPosition);
						
						if (recognizedText && recognizedText.trim()) {
							allRecognizedText += recognizedText + ' ';
							
							// 更新插入位置到新插入文字的末尾
							const textToInsert = recognizedText + ' ';
							const newLine = insertPosition.line;
							const newCh = insertPosition.ch + textToInsert.length;
							insertPosition = { line: newLine, ch: newCh };
						}
						
						// 清空累积的音频片段
						this.dictationAudioChunks = [];
					}
				}
			} catch (error) {
				this.debugLog('持续听写循环错误:', error);
				break;
			}
		}
	}

	/**
	 * 处理累积的音频片段进行语音识别
	 * @returns 识别到的文本，如果没有识别到则返回空字符串
	 */
	private async processAccumulatedAudio(editor: Editor, insertPosition: EditorPosition): Promise<string> {
		if (this.dictationAudioChunks.length === 0) {
			return '';
		}

		try {
			this.updateStatusFloat('正在识别语音...', 'info', false);
			
			// 合并所有音频片段，并保留录音器返回的真实容器格式。
			// Chromium 可以连续解码这些同格式片段；错误标记为 WAV 会在部分版本中导致解码失败。
			const combinedAudioBlob = new Blob(this.dictationAudioChunks, {
				type: this.dictationAudioChunks[0]?.type || 'application/octet-stream'
			});
			
			// 进行语音识别
			const recognizedText = await this.speechToText(combinedAudioBlob);
			
			if (recognizedText && recognizedText.trim()) {
				// 在当前插入位置插入识别的文字
				const textToInsert = recognizedText + ' ';
				editor.replaceRange(textToInsert, insertPosition);
				
				// 将光标移动到新的插入位置
				const newLine = insertPosition.line;
				const newCh = insertPosition.ch + textToInsert.length;
				editor.setCursor({ line: newLine, ch: newCh });
				
				this.updateStatusFloat('听写中', 'info', false);
				this.debugLog('持续听写识别到:', recognizedText);
				
				return recognizedText;
			}
			
			return '';
		} catch (error) {
			this.debugLog('处理累积音频错误:', error);
			return '';
		}
	}

	/**
	 * 录制指定时长的音频片段
	 */
	private async recordAudioSegment(duration: number): Promise<Blob> {
		return new Promise((resolve, reject) => {
			navigator.mediaDevices.getUserMedia({ audio: true })
				.then(stream => {
					let mediaRecorder: MediaRecorder;
					try {
						mediaRecorder = createCompatibleMediaRecorder(stream);
					} catch (error) {
						stream.getTracks().forEach(track => track.stop());
						throw normalizeError(error, '无法创建录音器');
					}
					const audioChunks: Blob[] = [];

					mediaRecorder.ondataavailable = (event) => {
						if (event.data.size > 0) {
							audioChunks.push(event.data);
						}
					};

					mediaRecorder.onstop = () => {
						const audioBlob = new Blob(audioChunks, {
							type: mediaRecorder.mimeType || audioChunks[0]?.type || 'application/octet-stream'
						});
						stream.getTracks().forEach(track => track.stop());
						resolve(audioBlob);
					};

					mediaRecorder.onerror = (error) => {
						stream.getTracks().forEach(track => track.stop());
						reject(normalizeError(error, '录音过程出错'));
					};

					mediaRecorder.start();
					window.setTimeout(() => {
						if (mediaRecorder.state === 'recording') {
							mediaRecorder.stop();
						}
					}, duration);
				})
				.catch((error: unknown) => reject(normalizeError(error, '无法访问麦克风')));
		});
	}

	/**
	 * 检测音频中是否包含语音
	 * 改进的语音活动检测算法，结合音量、频率分析和能量分布
	 */
	private async detectVoiceInAudio(audioBlob: Blob): Promise<boolean> {
		return new Promise((resolve) => {
			const audioContext = new AudioContext();
			const fileReader = new FileReader();

			fileReader.onload = () => {
				const arrayBuffer = fileReader.result as ArrayBuffer;
				audioContext.decodeAudioData(arrayBuffer)
					.then(audioBuffer => {
						const channelData = audioBuffer.getChannelData(0);
						const sampleRate = audioBuffer.sampleRate;
						
						// 1. 基本音量检测
						let sum = 0;
						let maxAmplitude = 0;
						for (let i = 0; i < channelData.length; i++) {
							const amplitude = Math.abs(channelData[i]);
							sum += amplitude;
							maxAmplitude = Math.max(maxAmplitude, amplitude);
						}
						
						const averageVolume = sum / channelData.length;
						const volumeThreshold = this.settings.voiceDetectionThreshold / 1000;
						
						// 如果音量太低，直接判断为无语音
						if (averageVolume < volumeThreshold) {
							resolve(false);
							return;
						}
						
						// 2. 动态范围检测 - 语音通常有较大的动态范围
						const dynamicRange = maxAmplitude / (averageVolume + 0.001); // 避免除零
						
						// 3. 零交叉率检测 - 语音通常有适中的零交叉率
						let zeroCrossings = 0;
						for (let i = 1; i < channelData.length; i++) {
							if ((channelData[i] >= 0) !== (channelData[i - 1] >= 0)) {
								zeroCrossings++;
							}
						}
						const zeroCrossingRate = zeroCrossings / channelData.length;
						
						// 4. 能量分布检测 - 分析音频能量的分布
						const frameSize = Math.floor(sampleRate * 0.025); // 25ms帧
						const frameCount = Math.floor(channelData.length / frameSize);
						let energyVariance = 0;
						let frameEnergies: number[] = [];
						
						for (let frame = 0; frame < frameCount; frame++) {
							let frameEnergy = 0;
							const startIdx = frame * frameSize;
							const endIdx = Math.min(startIdx + frameSize, channelData.length);
							
							for (let i = startIdx; i < endIdx; i++) {
								frameEnergy += channelData[i] * channelData[i];
							}
							frameEnergy = Math.sqrt(frameEnergy / (endIdx - startIdx));
							frameEnergies.push(frameEnergy);
						}
						
						// 计算能量方差
						if (frameEnergies.length > 1) {
							const meanEnergy = frameEnergies.reduce((a, b) => a + b, 0) / frameEnergies.length;
							energyVariance = frameEnergies.reduce((acc, energy) => acc + Math.pow(energy - meanEnergy, 2), 0) / frameEnergies.length;
						}
						
						// 5. 综合判断
						const hasVoice = this.evaluateVoiceActivity(
							averageVolume,
							volumeThreshold,
							dynamicRange,
							zeroCrossingRate,
							energyVariance,
							maxAmplitude
						);
						
						this.debugLog(`语音检测结果: ${hasVoice}, 音量: ${averageVolume.toFixed(4)}, 动态范围: ${dynamicRange.toFixed(2)}, 零交叉率: ${zeroCrossingRate.toFixed(4)}, 能量方差: ${energyVariance.toFixed(6)}`);
						
						resolve(hasVoice);
					})
					.catch((error) => {
						this.debugLog('音频解码失败:', error);
						// 如果解码失败，假设有语音
						resolve(true);
					});
			};

			fileReader.onerror = () => {
				this.debugLog('音频文件读取失败');
				// 如果读取失败，假设有语音
				resolve(true);
			};

			fileReader.readAsArrayBuffer(audioBlob);
		});
	}

	/**
	 * 综合评估语音活动
	 * @param averageVolume 平均音量
	 * @param volumeThreshold 音量阈值
	 * @param dynamicRange 动态范围
	 * @param zeroCrossingRate 零交叉率
	 * @param energyVariance 能量方差
	 * @param maxAmplitude 最大振幅
	 * @returns 是否检测到语音
	 */
	private evaluateVoiceActivity(
		averageVolume: number,
		volumeThreshold: number,
		dynamicRange: number,
		zeroCrossingRate: number,
		energyVariance: number,
		maxAmplitude: number
	): boolean {
		// 基础音量检测
		if (averageVolume < volumeThreshold) {
			return false;
		}
		
		// 如果音量很高，可能是语音
		if (averageVolume > volumeThreshold * 3) {
			return true;
		}
		
		// 语音特征评分系统
		let voiceScore = 0;
		
		// 1. 动态范围评分 (语音通常有较好的动态范围)
		if (dynamicRange > 2.0 && dynamicRange < 20.0) {
			voiceScore += 2;
		} else if (dynamicRange > 1.5) {
			voiceScore += 1;
		}
		
		// 2. 零交叉率评分 (语音通常在0.01-0.3之间)
		if (zeroCrossingRate > 0.01 && zeroCrossingRate < 0.3) {
			voiceScore += 2;
		} else if (zeroCrossingRate > 0.005 && zeroCrossingRate < 0.5) {
			voiceScore += 1;
		}
		
		// 3. 能量方差评分 (语音有一定的能量变化)
		if (energyVariance > 0.0001) {
			voiceScore += 1;
		}
		
		// 4. 最大振幅评分
		if (maxAmplitude > volumeThreshold * 2) {
			voiceScore += 1;
		}
		
		// 需要至少3分才认为是语音
		return voiceScore >= 3;
	}

	/**
	 * 停止听写
	 */
	private stopDictation(): void {
		this.isDictating = false;
		
		if (this.dictationTimer) {
			window.clearInterval(this.dictationTimer);
			this.dictationTimer = null;
		}
		
		// 隐藏听写控制界面
		this.hideDictationControls();
		
		// 停止录音
		if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
			this.mediaRecorder.stop();
		}
		
		this.updateStatusFloat('听写结束', 'info', true);
	}

	/**
	 * 开始语音朗读
	 * 朗读当前笔记的全部内容或选中的文字
	 */
	private async startVoiceReading(): Promise<void> {
		let statusNotice: Notice | null = null;
		
		try {
			
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) {
				this.updateStatusFloat('没有活动的笔记视图', 'error');
				return;
			}

			const editor = activeView.editor;
			let textToRead = '';
			
			// 检查是否有选中的文字
			const selectedText = editor.getSelection();
			if (selectedText.trim()) {
				textToRead = selectedText.trim();
				this.updateStatusFloat(`准备朗读选中文字 (${textToRead.length}字符)`, 'info');
				statusNotice = new Notice('正在朗读选中文字...', 4000);
			} else {
				// 朗读整篇笔记
				textToRead = editor.getValue().trim();
				this.updateStatusFloat(`准备朗读整篇笔记 (${textToRead.length}字符)`, 'info');
				statusNotice = new Notice('正在朗读整篇笔记...', 4000);
			}
			
			if (!textToRead) {
				this.updateStatusFloat('没有可朗读的内容', 'warning');
				return;
			}
			
			// 移除 Markdown 标记，只保留纯文本
			const cleanText = this.cleanMarkdownText(textToRead);
			this.updateStatusFloat(`文本处理完成，准备合成语音 (${cleanText.length}字符)`, 'info');
			
			this.debugLog('开始语音朗读，文本长度:', cleanText.length);
			
			// 根据设置选择合成方式
			if (this.settings.ttsMode === 'online') {
				const providerName = '讯飞';
				this.updateStatusFloat(`正在连接${providerName}在线TTS服务...`, 'info');
				await this.textToSpeech(cleanText);

			} else {
				this.updateStatusFloat('TTS功能未启用', 'error');
				if (statusNotice) statusNotice.hide();
				return;
			}
			
			// 朗读完成
			if (statusNotice) statusNotice.hide();
			this.updateStatusFloat('语音朗读流程完成', 'success');
			
		} catch (error) {
			this.debugLog('语音朗读错误:', error);
			if (statusNotice) statusNotice.hide();
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.updateStatusFloat('语音朗读失败: ' + errorMessage, 'error');
		}
	}

	/**
	 * 清理 Markdown 文本，移除标记符号
	 */
	private cleanMarkdownText(text: string): string {
		return text
			// 移除标题标记
			.replace(/^#{1,6}\s+/gm, '')
			// 移除粗体和斜体标记
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/\*([^*]+)\*/g, '$1')
			.replace(/__([^_]+)__/g, '$1')
			.replace(/_([^_]+)_/g, '$1')
			// 移除链接标记，保留链接文字
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			// 移除代码块标记
			.replace(/```[\s\S]*?```/g, '')
			.replace(/`([^`]+)`/g, '$1')
			// 移除列表标记
			.replace(/^[\s]*[-*+]\s+/gm, '')
			.replace(/^[\s]*\d+\.\s+/gm, '')
			// 移除引用标记
			.replace(/^>\s+/gm, '')
			// 移除多余的空行
			.replace(/\n\s*\n/g, '\n')
			.trim();
	}

	/**
	 * 开始录音
	 */
	private async startRecording(): Promise<Blob> {
		// 在持续对话模式下，录音开始时自动暂停TTS播报
		if (this.isInContinuousDialog && this.currentAudio && !this.currentAudio.paused) {
			this.debugLog('持续对话中开始录音，自动暂停TTS播报');
			this.currentAudio.pause();
			this.isPlaying = false;
			this.updatePlayPauseButton('▶️ 继续');
		}
		
		return new Promise((resolve, reject) => {
			navigator.mediaDevices.getUserMedia({ 
				audio: {
					sampleRate: 16000,  // 讯飞API要求16kHz
					channelCount: 1,    // 单声道
					echoCancellation: true,
					noiseSuppression: true
				} 
			})
			.then(stream => {
				try {
					this.mediaRecorder = createCompatibleMediaRecorder(stream);
				} catch (error) {
					stream.getTracks().forEach(track => track.stop());
					throw normalizeError(error, '无法创建录音器');
				}

				const mediaRecorder = this.mediaRecorder;
				this.debugLog('使用音频格式:', mediaRecorder.mimeType || '浏览器默认格式');
				this.audioChunks = [];
				this.isRecording = true;

				mediaRecorder.ondataavailable = (event) => {
					if (event.data.size > 0) {
						this.audioChunks.push(event.data);
					}
				};

				mediaRecorder.onstop = () => {
					const audioBlob = new Blob(this.audioChunks, {
						type: mediaRecorder.mimeType || this.audioChunks[0]?.type || 'application/octet-stream'
					});
					stream.getTracks().forEach(track => track.stop());
					this.isRecording = false;
					this.debugLog('录音完成，音频大小:', audioBlob.size, '字节');
					resolve(audioBlob);
				};

				mediaRecorder.onerror = (event) => {
					stream.getTracks().forEach(track => track.stop());
					this.isRecording = false;
					reject(normalizeError(event, '录音过程出错'));
				};

				mediaRecorder.start();

				// 5秒后自动停止录音
				window.setTimeout(() => {
					if (this.mediaRecorder && this.isRecording) {
						this.mediaRecorder.stop();
					}
				}, 5000);
			})
			.catch(reject);
		});
	}

	/**
	 * 语音转文字
	 */
	private async speechToText(audioBlob: Blob): Promise<string> {
		switch (this.settings.asrProvider) {
			case 'xunfei':
			default:
				return this.xunfeiOnlineASR(audioBlob);
		}
	}

	/**
	 * 语音唤醒专用ASR - 强制使用讯飞ASR
	 * 确保语音唤醒功能使用正确的ASR服务
	 */
	private async speechToTextForWakeup(audioBlob: Blob): Promise<string> {
		// 语音唤醒始终使用讯飞ASR，不受asrProvider设置影响
		return this.xunfeiOnlineASR(audioBlob);
	}

	/**
	 * 将音频转换为PCM格式
	 */
	private async convertToPCM(audioBlob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const audioContext = createAudioContext();
			const fileReader = new FileReader();
			
			fileReader.onload = async () => {
				try {
					const arrayBuffer = fileReader.result as ArrayBuffer;
					const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
					
					// 转换为16kHz单声道PCM
					const sampleRate = 16000;
					const length = Math.floor(audioBuffer.duration * sampleRate);
					const pcmData = new Float32Array(length);
					
					// 重采样到16kHz
					const ratio = audioBuffer.sampleRate / sampleRate;
					const inputData = audioBuffer.getChannelData(0);
					
					for (let i = 0; i < length; i++) {
						const index = Math.floor(i * ratio);
						pcmData[i] = inputData[index] || 0;
					}
					
					// 转换为16位PCM
					const pcm16 = new Int16Array(length);
					for (let i = 0; i < length; i++) {
						pcm16[i] = Math.max(-32768, Math.min(32767, pcmData[i] * 32767));
					}
					
					// 转换为base64 - 分块处理避免调用栈溢出
					const uint8Array = new Uint8Array(pcm16.buffer);
					let binaryString = '';
					const chunkSize = 8192; // 每次处理8KB
					
					for (let i = 0; i < uint8Array.length; i += chunkSize) {
						const chunk = uint8Array.slice(i, i + chunkSize);
						binaryString += String.fromCharCode.apply(null, Array.from(chunk));
					}
					
					const base64 = window.btoa(binaryString);
					resolve(base64);
				} catch (error) {
					reject(normalizeError(error, '音频转换失败'));
				}
			};
			
			fileReader.onerror = () => reject(new Error('读取音频文件失败'));
			fileReader.readAsArrayBuffer(audioBlob);
		});
	}

	/**
	 * 讯飞在线语音识别
	 */
	private async xunfeiOnlineASR(audioBlob: Blob): Promise<string> {
		try {
			this.debugLog('开始转换音频格式...');
			// 将音频转换为PCM格式的base64
			const base64Audio = await this.convertToPCM(audioBlob);
			this.debugLog('音频转换完成，base64长度:', base64Audio.length);
			
			// 构建请求参数
			const host = 'iat-api.xfyun.cn';
			const path = '/v2/iat';
			const apiKey = this.settings.xunfeiApiKey;
			const apiSecret = this.settings.xunfeiApiSecret;
			const appId = this.settings.xunfeiAppId;
			
			// 生成鉴权参数 - 按照讯飞官方文档格式
			const date = new Date().toUTCString();
			const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
			const signature = await hmacSha256Base64(apiSecret, signatureOrigin);
			const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
			const authorization = encodeURIComponent(window.btoa(authorizationOrigin));
			
			const url = `wss://${host}${path}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
			
			this.debugLog('讯飞ASR WebSocket URL:', url);
			
			return new Promise((resolve, reject) => {
				const ws = new WebSocket(url);
				
				let result = '';
				let hasReceivedData = false;
				
				ws.onopen = () => {
					this.debugLog('讯飞ASR WebSocket 连接已建立');
					const params = {
						common: { app_id: appId },
						business: { 
							language: 'zh_cn', 
							domain: 'iat', 
							accent: 'mandarin',
							vinfo: 1,
							vad_eos: 10000
						},
						data: { 
							status: 2, 
							format: 'audio/L16;rate=16000', 
							encoding: 'raw', 
							audio: base64Audio 
						}
					};
					this.debugLog('发送ASR参数:', JSON.stringify(params, null, 2));
					ws.send(JSON.stringify(params));
				};
				
				ws.onmessage = (event: MessageEvent) => {
					try {
						const data = parseJsonResponse<XunfeiAsrResponse>(String(event.data));
						this.debugLog('收到ASR响应:', JSON.stringify(data, null, 2));
						
						if (data.code !== 0) {
							this.debugLog('ASR错误代码:', data.code, '错误信息:', data.message);
							reject(new Error(`ASR错误: ${data.code} - ${data.message}`));
							return;
						}
						
						if (data.data && data.data.result) {
							hasReceivedData = true;
							const text = (data.data.result.ws ?? []).map(item =>
								(item.cw ?? []).map(word => word.w ?? '').join('')
							).join('');
							result += text;
							this.debugLog('识别到文本片段:', text);
						}
						
						if (data.data && data.data.status === 2) {
							this.debugLog('ASR识别完成，最终结果:', result);
							ws.close();
							resolve(result || '未识别到语音内容');
						}
					} catch (error) {
						this.debugLog('解析ASR响应时出错:', error);
						reject(normalizeError(error, '解析 ASR 响应失败'));
					}
				};
				
				ws.onerror = (error) => {
					this.debugLog('ASR WebSocket错误:', error);
					reject(new Error('ASR WebSocket连接错误'));
				};
				
				ws.onclose = (event) => {
					this.debugLog('ASR WebSocket连接关闭:', event.code, event.reason);
					if (!hasReceivedData && !result) {
						reject(new Error(`ASR连接关闭，未获取到结果。关闭代码: ${event.code}, 原因: ${event.reason}`));
					}
				};
			});
			
		} catch (error) {
			this.debugLog('讯飞在线 ASR 错误:', error);
			throw normalizeError(error, '讯飞在线 ASR 调用失败');
		}
	}





	/**
	 * 调用大模型
	 */
	private async callLLM(text: string): Promise<string> {
		switch (this.settings.llmProvider) {
			case 'google':
				return this.callGoogleAI(text);
			case 'openrouter':
				return this.callOpenRouter(text);
			case 'xunfei':
				return this.callXunfeiSpark(text);
			case 'custom':
				return this.callCustomModel(text);
			default:
				throw new Error('未知的 LLM 提供商');
		}
	}

	/**
	 * 调用 Google AI Studio
	 */
	private async callGoogleAI(text: string): Promise<string> {
		try {
			const model = this.settings.googleModel || 'gemini-2.5-flash';
			this.debugLog(`调用 Google AI 模型: ${model}`);
			
			const response = await requestUrl({
				url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.settings.googleApiKey)}`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					contents: [{
						parts: [{ text: text }]
					}]
				}),
				throw: false
			});

			if (response.status < 200 || response.status >= 300) {
				const errorText = response.text;
				this.debugLog(`Google AI API 错误 (${response.status}):`, errorText);
				throw new Error(`Google AI API 调用失败: ${response.status} - ${errorText}`);
			}

			const data = response.json as GoogleAiResponse;
			this.debugLog('Google AI 完整响应:', data);
			
			// 检查是否有错误信息
			if (data.error) {
				this.debugLog('Google AI 返回错误:', data.error);
				throw new Error(`Google AI 错误: ${data.error.message || JSON.stringify(data.error)}`);
			}
			
			// 检查响应格式
			if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
				this.debugLog('Google AI 响应格式错误:', data);
				throw new Error('Google AI 返回的响应格式不正确 - 缺少candidates');
			}
			
			const candidate = data.candidates[0];
			if (!candidate.content || !candidate.content.parts || !Array.isArray(candidate.content.parts) || candidate.content.parts.length === 0) {
				this.debugLog('Google AI 候选内容格式错误:', candidate);
				throw new Error('Google AI 返回的内容格式不正确 - 缺少content.parts');
			}
			
			const result = candidate.content.parts[0].text;
			if (typeof result !== 'string') {
				throw new Error('Google AI 返回的内容格式不正确 - text 不是字符串');
			}
			this.debugLog('Google AI 返回结果:', result);
			return result;
		} catch (error) {
			this.debugLog('Google AI 调用错误:', error);
			throw normalizeError(error, 'Google AI 调用失败');
		}
	}

	/**
	 * 调用 OpenRouter
	 */
	private async callOpenRouter(text: string): Promise<string> {
		try {
			const model = this.settings.openrouterModel || 'openai/gpt-3.5-turbo';
			const response = await requestUrl({
				url: 'https://openrouter.ai/api/v1/chat/completions',
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.openrouterApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: model,
					messages: [{ role: 'user', content: text }]
				}),
				throw: false
			});

			if (response.status < 200 || response.status >= 300) {
				throw new Error(`OpenRouter API 错误: ${response.status}`);
			}

			const data = response.json as OpenRouterResponse;
			
			// 检查响应格式
			if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
				this.debugLog('OpenRouter 响应格式错误:', data);
				throw new Error('OpenRouter 返回的响应格式不正确');
			}
			
			const choice = data.choices[0];
			if (!choice.message || typeof choice.message.content !== 'string') {
				this.debugLog('OpenRouter 消息格式错误:', choice);
				throw new Error('OpenRouter 返回的消息格式不正确');
			}
			
			return choice.message.content;
		} catch (error) {
			this.debugLog('OpenRouter 调用错误:', error);
			throw normalizeError(error, 'OpenRouter 调用失败');
		}
	}

	/**
	 * 调用讯飞星火
	 */
	private async callXunfeiSpark(text: string): Promise<string> {
		try {
			const apiKey = this.settings.xunfeiApiKey;
			const apiSecret = this.settings.xunfeiApiSecret;
			const appId = this.settings.xunfeiAppId;
			
			if (!apiKey || !apiSecret || !appId) {
				throw new Error('讯飞星火配置不完整，请检查 App ID、API Key 和 API Secret');
			}
			
			// 根据模型选择对应的WebSocket地址和domain
			const model = this.settings.xunfeiModel || 'lite';
			let host = 'spark-api.xf-yun.com';
			let path = '/v1.1/chat';
			let domain = model;
			
			// 根据最新文档配置不同模型的URL和domain
			switch (model) {
				case 'lite':
					host = 'spark-api.xf-yun.com';
					path = '/v1.1/chat';
					domain = 'lite';
					break;
				case 'generalv3':
					host = 'spark-api.xf-yun.com';
					path = '/v3.1/chat';
					domain = 'generalv3';
					break;
				case 'pro-128k':
					host = 'spark-api.xf-yun.com';
					path = '/chat/pro-128k';
					domain = 'pro-128k';
					break;
				case 'generalv3.5':
					host = 'spark-api.xf-yun.com';
					path = '/v3.5/chat';
					domain = 'generalv3.5';
					break;
				case 'max-32k':
					host = 'spark-api.xf-yun.com';
					path = '/chat/max-32k';
					domain = 'max-32k';
					break;
				case '4.0Ultra':
					host = 'spark-api.xf-yun.com';
					path = '/v4.0/chat';
					domain = '4.0Ultra';
					break;
				case 'generalv2':
					host = 'spark-api.xf-yun.com';
					path = '/v2.1/chat';
					domain = 'generalv2';
					break;
				case 'general':
					host = 'spark-api.xf-yun.com';
					path = '/v1.1/chat';
					domain = 'general';
					break;
				default:
					// 默认使用Spark Lite
					host = 'spark-api.xf-yun.com';
					path = '/v1.1/chat';
					domain = 'lite';
					break;
			}
			const date = new Date().toUTCString();
			
			// 构建签名字符串
			const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
			
			// 使用浏览器标准 Web Crypto API 生成签名。
			const signature = await hmacSha256Base64(apiSecret, signatureOrigin);
			
			// 构建鉴权参数
			const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
			const authorization = encodeUtf8ToBase64(authorizationOrigin);
			
			// 构建WebSocket URL
			const url = `wss://${host}${path}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
			
			this.debugLog('讯飞星火 WebSocket URL:', url);
			
			return new Promise((resolve, reject) => {
				const ws = new WebSocket(url);
				let result = '';
				let timeout: number;
				
				// 设置超时
				timeout = window.setTimeout(() => {
					ws.close();
					reject(new Error('讯飞星火调用超时'));
				}, 30000);
				
				ws.onopen = () => {
					this.debugLog('讯飞星火 WebSocket 连接已建立');
					this.debugLog('使用模型:', model, '域名:', domain);
					
					const params = {
						header: { 
							app_id: appId, 
							uid: 'user' 
						},
						parameter: { 
							chat: { 
								domain: domain, 
								temperature: 0.5, 
								max_tokens: 2048 
							} 
						},
						payload: { 
							message: { 
								text: [{ role: 'user', content: text }] 
							} 
						}
					};
					
					this.debugLog('发送到讯飞星火的参数:', JSON.stringify(params, null, 2));
					ws.send(JSON.stringify(params));
				};
				
				ws.onmessage = (event: MessageEvent) => {
					try {
						const data = parseJsonResponse<XunfeiSparkResponse>(String(event.data));
						this.debugLog('讯飞星火响应:', data);
						
						// 检查错误
						if (data.header && data.header.code !== 0) {
							window.clearTimeout(timeout);
							const errorMsg = `讯飞星火API错误: ${data.header.message || '未知错误'} (代码: ${data.header.code})`;
							this.debugLog(errorMsg);
							reject(new Error(errorMsg));
							return;
						}
						
						// 提取响应内容
						if (data.payload && data.payload.choices && data.payload.choices.text && Array.isArray(data.payload.choices.text) && data.payload.choices.text.length > 0) {
							const textItem = data.payload.choices.text[0];
							if (textItem && textItem.content) {
								result += textItem.content;
								this.debugLog('累积结果:', result);
							}
						}
						
						// 检查是否完成
						if (data.header && data.header.status === 2) {
							window.clearTimeout(timeout);
							ws.close();
							this.debugLog('讯飞星火最终结果:', result);
							resolve(result || '讯飞星火返回了空响应');
						}
					} catch (parseError) {
						this.debugLog('解析讯飞星火响应时出错:', parseError);
						this.debugLog('原始响应数据:', event.data);
						window.clearTimeout(timeout);
						reject(new Error(`解析讯飞星火响应失败: ${getErrorMessage(parseError)}`));
					}
				};
				
				ws.onerror = (error) => {
					this.debugLog('讯飞星火 WebSocket 错误:', error);
					window.clearTimeout(timeout);
					reject(new Error('讯飞星火连接失败'));
				};
				
				ws.onclose = (event) => {
					this.debugLog('讯飞星火 WebSocket 连接关闭:', event.code, event.reason);
					window.clearTimeout(timeout);
					if (!result) {
						reject(new Error('讯飞星火连接意外关闭'));
					}
				};
			});
			
		} catch (error) {
			this.debugLog('讯飞星火调用错误:', error);
			throw normalizeError(error, '讯飞星火调用失败');
		}
	}




	/**
	 * 调用自定义模型
	 */
	private async callCustomModel(text: string): Promise<string> {
		if (!this.settings.selectedCustomModel) {
			throw new Error('请先选择一个自定义模型');
		}

		const selectedModel = this.settings.customModels.find(
			model => model.name === this.settings.selectedCustomModel
		);

		if (!selectedModel) {
			throw new Error('选择的自定义模型不存在');
		}

		this.debugLog('调用自定义模型:', selectedModel);

		// 根据提供商调用相应的API
		switch (selectedModel.provider.toLowerCase()) {
			case 'google':
				return this.callCustomGoogleAI(text, selectedModel.modelId);
			case 'openrouter':
				return this.callCustomOpenRouter(text, selectedModel.modelId);
			case 'xunfei':
				return this.callCustomXunfeiSpark(text, selectedModel.modelId);
			default:
				throw new Error(`不支持的自定义模型提供商: ${selectedModel.provider}`);
		}
	}

	/**
	 * 调用自定义Google AI模型
	 */
	private async callCustomGoogleAI(text: string, modelId: string): Promise<string> {
		if (!this.settings.googleApiKey) {
			throw new Error('请先配置 Google API Key');
		}

		try {
			this.debugLog(`调用自定义 Google AI 模型: ${modelId}`);
			
			const response = await requestUrl({
				url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(this.settings.googleApiKey)}`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					contents: [{
						parts: [{
							text: text
						}]
					}]
				}),
				throw: false
			});

			if (response.status < 200 || response.status >= 300) {
				const errorText = response.text;
				this.debugLog(`自定义Google AI API 错误 (${response.status}):`, errorText);
				throw new Error(`自定义Google AI API 调用失败: ${response.status} - ${errorText}`);
			}

			const data = response.json as GoogleAiResponse;
			this.debugLog('自定义Google AI 完整响应:', data);
			
			// 检查是否有错误信息
			if (data.error) {
				this.debugLog('自定义Google AI 返回错误:', data.error);
				throw new Error(`自定义Google AI 错误: ${data.error.message || JSON.stringify(data.error)}`);
			}
			
			// 检查响应格式
			if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
				this.debugLog('自定义Google AI 响应格式错误:', data);
				throw new Error('自定义Google AI 返回的响应格式不正确 - 缺少candidates');
			}
			
			const candidate = data.candidates[0];
			if (!candidate.content || !candidate.content.parts || !Array.isArray(candidate.content.parts) || candidate.content.parts.length === 0) {
				this.debugLog('自定义Google AI 候选内容格式错误:', candidate);
				throw new Error('自定义Google AI 返回的内容格式不正确 - 缺少content.parts');
			}
			
			const result = candidate.content.parts[0].text;
			if (typeof result !== 'string') {
				throw new Error('自定义 Google AI 返回的 text 不是字符串');
			}
			this.debugLog('自定义Google AI 返回结果:', result);
			return result;
		} catch (error) {
			this.debugLog('自定义Google AI调用错误:', error);
			throw normalizeError(error, '自定义 Google AI 调用失败');
		}
	}

	/**
	 * 调用自定义OpenRouter模型
	 */
	private async callCustomOpenRouter(text: string, modelId: string): Promise<string> {
		if (!this.settings.openrouterApiKey) {
			throw new Error('请先配置 OpenRouter API Key');
		}

		try {
			const response = await requestUrl({
				url: 'https://openrouter.ai/api/v1/chat/completions',
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.openrouterApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: modelId,
					messages: [
						{
							role: 'user',
							content: text
						}
					]
				}),
				throw: false
			});

			if (response.status < 200 || response.status >= 300) {
				throw new Error(`OpenRouter API 错误: ${response.status}`);
			}

			const data = response.json as OpenRouterResponse;
			
			// 检查响应格式
			if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
				this.debugLog('自定义OpenRouter 响应格式错误:', data);
				throw new Error('自定义OpenRouter 返回的响应格式不正确');
			}
			
			const choice = data.choices[0];
			if (!choice.message || typeof choice.message.content !== 'string') {
				this.debugLog('自定义OpenRouter 消息格式错误:', choice);
				throw new Error('自定义OpenRouter 返回的消息格式不正确');
			}
			
			return choice.message.content;
		} catch (error) {
			this.debugLog('自定义OpenRouter调用错误:', error);
			throw normalizeError(error, '自定义 OpenRouter 调用失败');
		}
	}

	/**
	 * 调用自定义讯飞星火模型
	 */
	private async callCustomXunfeiSpark(text: string, modelId: string): Promise<string> {
		if (!this.settings.xunfeiAppId || !this.settings.xunfeiApiKey || !this.settings.xunfeiApiSecret) {
			throw new Error('请先配置讯飞星火 API 信息');
		}

		try {
			// 使用自定义模型ID作为domain
			const domain = modelId;
			
			// 根据模型版本确定API路径
			let apiPath = '/v3.1/chat';
			if (modelId.includes('v1.5') || modelId === 'general') {
				apiPath = '/v1.1/chat';
			} else if (modelId.includes('v2') || modelId === 'generalv2') {
				apiPath = '/v2.1/chat';
			} else if (modelId.includes('v3') || modelId === 'generalv3') {
				apiPath = '/v3.1/chat';
			} else if (modelId.includes('v3.5') || modelId === 'generalv3.5') {
				apiPath = '/v3.5/chat';
			} else if (modelId.includes('4.0') || modelId === '4.0Ultra') {
				apiPath = '/v4.0/chat';
			}

			// 生成认证URL
			const host = 'spark-api.xf-yun.com';
			const date = new Date().toUTCString();
			const algorithm = 'hmac-sha256';
			const headers = `host date request-line`;
			const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${apiPath} HTTP/1.1`;
			
			const signature = await hmacSha256Base64(this.settings.xunfeiApiSecret, signatureOrigin);
			
			const authorizationOrigin = `api_key="${this.settings.xunfeiApiKey}", algorithm="${algorithm}", headers="${headers}", signature="${signature}"`;
			const authorization = window.btoa(authorizationOrigin);
			
			const wsUrl = `wss://${host}${apiPath}?authorization=${authorization}&date=${date}&host=${host}`;

			return new Promise((resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				let result = '';
				
				// 30秒超时
				const timeout = window.setTimeout(() => {
					ws.close();
					reject(new Error('讯飞星火自定义模型调用超时'));
				}, 30000);

				ws.onopen = () => {
					this.debugLog('讯飞星火自定义模型 WebSocket 连接已建立');
					
					const params = {
						header: {
							app_id: this.settings.xunfeiAppId,
							uid: 'user'
						},
						parameter: {
							chat: {
								domain: domain,
								temperature: 0.5,
								max_tokens: 2048
							}
						},
						payload: {
							message: {
								text: [
									{
										role: 'user',
										content: text
									}
								]
							}
						}
					};
					
					ws.send(JSON.stringify(params));
				};

				ws.onmessage = (event) => {
					try {
						const response = parseJsonResponse<XunfeiSparkResponse>(String(event.data));
						this.debugLog('讯飞星火自定义模型响应:', response);
						
						if (response.header?.code !== 0) {
							window.clearTimeout(timeout);
							reject(new Error(`讯飞星火自定义模型错误: ${response.header.message}`));
							return;
						}
						
						if (response.payload && response.payload.choices && response.payload.choices.text && Array.isArray(response.payload.choices.text) && response.payload.choices.text.length > 0) {
							const textItem = response.payload.choices.text[0];
							if (textItem && textItem.content) {
								result += textItem.content;
							}
						}
						
						if (response.header?.status === 2) {
							window.clearTimeout(timeout);
							ws.close();
							resolve(result);
						}
					} catch (error) {
						this.debugLog('讯飞星火自定义模型解析响应错误:', error);
						window.clearTimeout(timeout);
						reject(new Error('讯飞星火自定义模型响应解析失败'));
					}
				};
				
				ws.onerror = (error) => {
					this.debugLog('讯飞星火自定义模型 WebSocket 错误:', error);
					window.clearTimeout(timeout);
					reject(new Error('讯飞星火自定义模型连接失败'));
				};
				
				ws.onclose = (event) => {
					this.debugLog('讯飞星火自定义模型 WebSocket 连接关闭:', event.code, event.reason);
					window.clearTimeout(timeout);
					if (!result) {
						reject(new Error('讯飞星火自定义模型连接意外关闭'));
					}
				};
			});
			
		} catch (error) {
			this.debugLog('讯飞星火自定义模型调用错误:', error);
			throw normalizeError(error, '讯飞星火自定义模型调用失败');
		}
	}

	/**
	 * 文字转语音
	 */
	private async textToSpeech(text: string): Promise<void> {
		if (this.settings.ttsMode === 'online') {
			switch (this.settings.ttsProvider) {
				case 'xunfei':
					await this.xunfeiOnlineTTS(text);
					break;
				default:
					await this.xunfeiOnlineTTS(text);
					break;
			}
		}
	}

	/**
	 * 讯飞在线语音合成
	 */
	private async xunfeiOnlineTTS(text: string): Promise<void> {
		try {
			
			// 构建 TTS 请求
			const host = 'tts-api.xfyun.cn';
			const path = '/v2/tts';
			const apiKey = this.settings.xunfeiApiKey;
			const apiSecret = this.settings.xunfeiApiSecret;
			const appId = this.settings.xunfeiAppId;
			
			
			// 生成鉴权参数 - 按照讯飞官方文档格式
			const date = new Date().toUTCString();
			const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
			const signature = await hmacSha256Base64(apiSecret, signatureOrigin);
			const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
			const authorization = encodeURIComponent(window.btoa(authorizationOrigin));
			
			const url = `wss://${host}${path}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
			
			this.debugLog('讯飞TTS WebSocket URL:', url);
			
			return new Promise((resolve, reject) => {
				const ws = new WebSocket(url);
				const audioChunks: string[] = [];
				let hasReceivedData = false;
				
				ws.onopen = () => {
					this.debugLog('讯飞TTS WebSocket 连接已建立');
					const params = {
						common: { app_id: appId },
						business: { 
							aue: 'lame', // 使用MP3格式
							auf: 'audio/L16;rate=16000', // PCM格式，16kHz采样率
							vcn: this.settings.ttsVoice, 
							speed: this.settings.ttsSpeed, 
							volume: this.settings.ttsVolume, 
							pitch: this.settings.ttsPitch, 
							bgs: 0, // 背景音乐关闭
							tte: 'UTF8' // 文本编码格式
						},
						data: { 
							status: 2, 
							text: encodeUtf8ToBase64(text)
						}
					};
					this.debugLog('发送TTS参数:', JSON.stringify(params, null, 2));
					ws.send(JSON.stringify(params));
				};
				
				ws.onmessage = (event: MessageEvent) => {
					try {
						const data = parseJsonResponse<XunfeiTtsResponse>(String(event.data));
						this.debugLog('收到TTS响应:', JSON.stringify(data, null, 2));
						
						if (data.code !== 0) {
							this.debugLog('TTS错误代码:', data.code, '错误信息:', data.message);
							reject(new Error(`TTS错误: ${data.code} - ${data.message}`));
							return;
						}
						
						if (data.data && data.data.audio) {
							hasReceivedData = true;
							audioChunks.push(data.data.audio);
							this.debugLog('收到音频数据块，大小:', data.data.audio.length);
						}
						
						if (data.data && data.data.status === 2) {
							this.debugLog('TTS合成完成，音频块数量:', audioChunks.length);
							ws.close();
							if (audioChunks.length > 0) {
								// 正确拼接Base64音频数据
								const combinedAudio = audioChunks.join('');
								this.debugLog('拼接后的音频数据长度:', combinedAudio.length);
								
								// 验证Base64格式
								if (!combinedAudio || combinedAudio.length === 0) {
									reject(new Error('音频数据为空'));
									return;
								}
								
								// 检查是否为有效的Base64字符串
								if (!/^[A-Za-z0-9+/]*={0,2}$/.test(combinedAudio)) {
									reject(new Error('接收到的音频数据格式无效'));
									return;
								}
								
								// 等待音频播放完成
								this.playAudioFromBase64(combinedAudio).then(() => {
									resolve();
								}).catch((error) => {
									this.debugLog('音频播放失败:', error);
									reject(normalizeError(error, '音频播放失败'));
								});
							} else {
								this.debugLog('没有收到音频数据');
								resolve();
							}
						}
					} catch (error) {
						this.debugLog('解析TTS响应时出错:', error);
						reject(normalizeError(error, '解析 TTS 响应失败'));
					}
				};
				
				ws.onerror = (error) => {
					this.debugLog('TTS WebSocket错误:', error);
					reject(new Error('TTS WebSocket连接错误'));
				};
				
				ws.onclose = (event) => {
					this.debugLog('TTS WebSocket连接关闭:', event.code, event.reason);
					if (!hasReceivedData) {
						reject(new Error(`TTS连接关闭，未获取到音频数据。关闭代码: ${event.code}, 原因: ${event.reason}`));
					}
				};
			});
			
		} catch (error) {
			this.debugLog('讯飞在线 TTS 错误:', error);
			throw normalizeError(error, '讯飞在线 TTS 调用失败');
		}
	}








	/**
	 * 播放Base64编码的音频数据
	 */
	private async playAudioFromBase64(base64Audio: string): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.debugLog('开始播放音频，base64长度:', base64Audio.length);
				
				// 清理和验证Base64字符串
				let cleanBase64 = base64Audio.replace(/[^A-Za-z0-9+/=]/g, '');
				
				// 确保Base64字符串长度是4的倍数
				while (cleanBase64.length % 4 !== 0) {
					cleanBase64 += '=';
				}
				
				this.debugLog('清理后的base64长度:', cleanBase64.length);
				
				// 验证Base64格式
				if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
					throw new Error('无效的Base64格式');
				}
				
				// 将base64转换为ArrayBuffer (MP3格式)
				this.debugLog('Base64前50字符:', cleanBase64.substring(0, 50));
				
				let binaryString: string;
				try {
					binaryString = window.atob(cleanBase64);
				} catch (decodeError) {
					throw new Error(`Base64解码失败: ${getErrorMessage(decodeError)}`);
				}
				
				// 直接创建MP3音频数据
				const mp3Data = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					mp3Data[i] = binaryString.charCodeAt(i);
				}
				
				this.debugLog('MP3音频数据转换完成，字节长度:', mp3Data.length);
				
				// 创建MP3音频Blob
				const audioBlob = new Blob([mp3Data], { type: 'audio/mpeg' });
				const audioUrl = URL.createObjectURL(audioBlob);
				const audio = new Audio(audioUrl);
				
				// 设置当前音频对象
				this.currentAudio = audio;
				this.isPlaying = true;
				this.updatePlayPauseButton('⏸️ 暂停');
				
				// 添加音频事件监听器
				audio.onloadeddata = () => {
					this.debugLog('音频数据加载完成');
					this.updateStatusFloat('音频数据加载完成', 'success');
				};
				
				audio.oncanplay = () => {
					this.debugLog('音频可以播放');
					this.updateStatusFloat('音频准备就绪', 'success');
				};
				
				audio.onplay = () => {
					this.debugLog('音频开始播放');
					this.updateStatusFloat('开始播放语音', 'info');
					this.isPlaying = true;
				};
				
				audio.onpause = () => {
					this.updateStatusFloat('音频已暂停', 'info');
					this.isPlaying = false;
				};
				
				audio.onended = () => {
					this.debugLog('音频播放结束');
					this.updateStatusFloat('语音播放完成', 'success');
					URL.revokeObjectURL(audioUrl);
					this.currentAudio = null;
					this.isPlaying = false;
					this.updatePlayPauseButton('⏸️ 暂停');
					resolve();
				};
				
				audio.onerror = (error) => {
					this.debugLog('音频播放错误:', error);
					this.updateStatusFloat('音频播放失败', 'error');
					URL.revokeObjectURL(audioUrl);
					this.currentAudio = null;
					this.isPlaying = false;
					reject(new Error('音频播放失败'));
				};
				
				// 设置音量
				audio.volume = 1.0;
				
				// 开始播放
				audio.play().then(() => {
					this.debugLog('音频播放命令执行成功');
				}).catch((error) => {
					this.debugLog('音频播放命令执行失败:', error);
					reject(normalizeError(error, '音频播放失败'));
				});
				
				// 如果设置了保存音频到 Vault
				if (this.settings.saveAudioToVault) {
					// 如果是唤醒会话，只保存第一次的音频
					if (this.isWakeConversation && this.wakeSessionAudioSaved) {
						this.debugLog('唤醒会话音频已保存，跳过此次保存');
					} else {
						this.saveAudioToVaultFromBase64(base64Audio).catch((error) => {
							this.debugLog('保存音频到Vault失败:', error);
						});
						// 如果是唤醒会话，标记音频已保存
						if (this.isWakeConversation) {
							this.wakeSessionAudioSaved = true;
							this.debugLog('唤醒会话音频已保存，标记为已保存状态');
						}
					}
				}
				
			} catch (error) {
				this.debugLog('播放音频错误:', error);
				reject(normalizeError(error, '音频播放失败'));
			}
		});
	}

	/**
	 * 将Base64音频保存到 Vault
	 */
	private async saveAudioToVaultFromBase64(base64Audio: string): Promise<void> {
		try {
			// 确保音频保存文件夹存在
			const folderPath = this.settings.audioSavePath;
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			}
			
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const fileName = `voice-${timestamp}.wav`;
			const filePath = `${this.settings.audioSavePath}/${fileName}`;
			
			// 将base64转换为ArrayBuffer
			const binaryString = window.atob(base64Audio);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}
			
			await this.app.vault.createBinary(filePath, bytes.buffer);
			this.debugLog(`音频已保存到: ${filePath}`);
			
		} catch (error) {
			this.debugLog('保存音频到 Vault 错误:', error);
		}
	}

	/**
	 * 插入内容到笔记
	 */
	private insertToNote(userText: string, aiResponse: string): void {
		// 如果是唤醒对话，不在光标处插入内容
		if (this.isWakeConversation) {
			this.debugLog('唤醒对话内容不插入到光标处，将在对话结束后保存');
			return;
		}
		
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			const editor = activeView.editor;
			const cursor = editor.getCursor();
			
			const timestamp = new Date().toLocaleString();
			const content = `\n## 语音对话 - ${timestamp}\n\n**用户：** ${userText}\n\n**AI：** ${aiResponse}\n\n`;
			
			editor.replaceRange(content, cursor);
			this.debugLog('内容已插入到笔记');
		} else {
			new Notice('请先打开一个笔记文件');
		}
	}

	/**
	 * 开始语音唤醒监听
	 */
	private startWakeListening(): void {
		// 显示唤醒监听状态
		new Notice('语音唤醒已启动，正在监听...', 5000);
		this.debugLog('启动语音唤醒监听，模式:', this.settings.wakeMode);
		
		if (this.settings.wakeMode === 'online') {
			void this.startOnlineWakeListening();
		}
		
		// 更新状态浮窗显示唤醒状态
		this.updateWakeStatus(true);
	}

	/**
	 * 开始在线语音唤醒监听
	 */
	private async startOnlineWakeListening(): Promise<void> {
		try {
			this.debugLog('开始在线语音唤醒监听');
			
			// 先停止之前的监听
			this.stopWakeListening();
			
			// 获取麦克风权限
			this.wakeStream = await navigator.mediaDevices.getUserMedia({ 
				audio: {
					sampleRate: 16000,
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true
				} 
			});
			
			// 设置监听状态
			this.isListening = true;
			
			// 开始持续监听循环
			this.startWakeListeningLoop();
			
		} catch (error) {
			this.debugLog('启动在线语音唤醒失败:', error);
			new Notice('启动语音唤醒失败，请检查麦克风权限');
			this.isListening = false;
		}
	}

	/**
	 * 唤醒监听循环
	 */
	private startWakeListeningLoop(): void {
		if (!this.isListening || !this.wakeStream) {
			return;
		}

		try {
			// 创建新的MediaRecorder
			this.wakeMediaRecorder = new MediaRecorder(this.wakeStream);
			let audioChunks: Blob[] = [];
			
			this.wakeMediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					audioChunks.push(event.data);
				}
			};
			
			this.wakeMediaRecorder.onstop = async () => {
				if (audioChunks.length > 0) {
					const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
					try {
						const text = await this.speechToTextForWakeup(audioBlob);
						this.debugLog('唤醒监听识别到:', text);
						
						// 检查是否包含唤醒词
						const hasWakeWord = this.settings.wakeWords.some(word => 
							text.toLowerCase().includes(word.toLowerCase())
						);
						
						if (hasWakeWord) {
							this.debugLog('检测到唤醒词:', text);
							await this.onWakeWordDetected();
						}
					} catch (error) {
						this.debugLog('唤醒监听识别错误:', error);
					}
				}
				
				// 继续下一轮监听
				if (this.isListening) {
					window.setTimeout(() => {
						this.startWakeListeningLoop();
					}, 100);
				}
			};

			this.wakeMediaRecorder.onerror = (event) => {
				this.debugLog('唤醒监听录音错误:', event);
				// 重新开始监听
				if (this.isListening) {
					window.setTimeout(() => {
						this.startWakeListeningLoop();
					}, 1000);
				}
			};
			
			// 开始录音
			this.wakeMediaRecorder.start();
			
			// 根据配置的间隔时间停止录音进行识别
			window.setTimeout(() => {
				if (this.wakeMediaRecorder && this.wakeMediaRecorder.state === 'recording') {
					this.wakeMediaRecorder.stop();
				}
			}, this.settings.wakeDetectionInterval);
			
		} catch (error) {
			this.debugLog('唤醒监听循环错误:', error);
			// 重新开始监听
			if (this.isListening) {
				window.setTimeout(() => {
					this.startWakeListeningLoop();
				}, 1000);
			}
		}
	}




	/**
	 * 创建新的唤醒会话
	 */
	private startNewWakeSession(): void {
		// 生成唯一的会话ID
		this.wakeSessionId = Date.now().toString();
		
		// 生成文件名（格式：YYYY-MM-DD HH-mm-ss）
		const now = new Date();
		this.wakeSessionFileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.md`;
		
		// 标记为唤醒对话
		this.isWakeConversation = true;
		
		// 重置音频保存标记
		this.wakeSessionAudioSaved = false;
		
		// 清空对话历史，开始新的对话记录
		this.conversationHistory = [];
		
		this.debugLog(`开始新的唤醒会话: ${this.wakeSessionId}, 文件名: ${this.wakeSessionFileName}`);
	}

	/**
	 * 结束唤醒会话
	 */
	private endWakeSession(): void {
		this.debugLog(`结束唤醒会话: ${this.wakeSessionId}`);
		
		// 重置唤醒会话相关变量
		this.isWakeConversation = false;
		this.wakeSessionId = null;
		this.wakeSessionFileName = null;
		
		// 清空对话历史
		this.conversationHistory = [];
	}

	/**
	 * 检测到唤醒词时的处理
	 */
	private async onWakeWordDetected(): Promise<void> {
		this.debugLog('检测到唤醒词');
		new Notice('语音助手已唤醒');
		
		// 语音回复确认唤醒（不保存此音频）
		if (this.settings.ttsMode !== 'disabled') {
			const originalSaveAudio = this.settings.saveAudioToVault;
			try {
				// 临时禁用音频保存
				this.settings.saveAudioToVault = false;
				
				await this.textToSpeech('hi，你好');
			} catch (error) {
				this.debugLog('唤醒语音回复失败:', error);
			} finally {
				// 无论合成是否成功，都恢复用户原始选项。
				this.settings.saveAudioToVault = originalSaveAudio;
			}
		}
		
		if (this.settings.autoEnterDialogAfterWake) {
			// 创建新的唤醒会话
			this.startNewWakeSession();
			void this.startVoiceConversation();
		}
	}

	/**
	 * 开始监听
	 */
	private startListening(): void {
		if (this.isListening) {
			new Notice('语音监听已在运行中');
			return;
		}

		if (this.settings.wakeMode === 'disabled') {
			new Notice('语音唤醒功能已禁用，请在设置中启用');
			return;
		}

		this.startWakeListening();
		this.updateStatusFloat('正在监听唤醒词...', 'info', false);
	}

	/**
	 * 停止监听
	 */
	private stopListening(): void {
		this.isListening = false;
		if (this.mediaRecorder && this.isRecording) {
			this.mediaRecorder.stop();
		}
		this.stopWakeListening();
		this.updateStatusFloat('已停止监听', 'warning');
		new Notice('语音监听已停止');
		this.debugLog('已停止监听');
	}

	/**
	 * 停止语音唤醒监听
	 */
	private stopWakeListening(): void {
		this.isListening = false;
		
		// 停止在线语音唤醒的MediaRecorder
		if (this.wakeMediaRecorder) {
			if (this.wakeMediaRecorder.state === 'recording') {
				this.wakeMediaRecorder.stop();
			}
			this.wakeMediaRecorder = null;
		}
		
		// 停止音频流
		if (this.wakeStream) {
			this.wakeStream.getTracks().forEach(track => track.stop());
			this.wakeStream = null;
		}
		
		// 停止离线语音唤醒进程
		// 停止WebSocket连接
		if (this.wakeWebSocket) {
			this.wakeWebSocket.close();
			this.wakeWebSocket = null;
		}
		
		this.debugLog('已停止语音唤醒监听');
		new Notice('语音唤醒已停止');
		this.updateWakeStatus(false);
	}

	/**
	 * 测试在线 ASR
	 */
	async testOnlineASR(): Promise<void> {
		try {
			new Notice('开始测试在线 ASR，请说话...');
			const audioBlob = await this.startRecording();
			const result = await this.xunfeiOnlineASR(audioBlob);
			new Notice(`在线 ASR 测试结果：${result}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			new Notice(`在线 ASR 测试失败：${errorMessage}`);
		}
	}



	/**
	 * 测试在线 TTS
	 */
	async testOnlineTTS(): Promise<void> {
		try {
			const providerName = '讯飞';
			await this.textToSpeech('这是在线语音合成测试');
			new Notice(`${providerName} TTS 测试完成`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const providerName = '讯飞';
			new Notice(`${providerName} TTS 测试失败：${errorMessage}`);
		}
	}






	/**
	 * 将PCM音频数据转换为WAV格式
	 * @param pcmData PCM音频数据
	 * @param sampleRate 采样率
	 * @param channels 声道数
	 * @param bitsPerSample 每样本位数
	 * @returns WAV格式的音频数据
	 */
	private pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
		const dataLength = pcmData.length;
		const buffer = new ArrayBuffer(44 + dataLength);
		const view = new DataView(buffer);
		
		// WAV文件头
		const writeString = (offset: number, string: string) => {
			for (let i = 0; i < string.length; i++) {
				view.setUint8(offset + i, string.charCodeAt(i));
			}
		};
		
		// RIFF标识符
		writeString(0, 'RIFF');
		// 文件长度
		view.setUint32(4, 36 + dataLength, true);
		// WAVE标识符
		writeString(8, 'WAVE');
		// fmt子块标识符
		writeString(12, 'fmt ');
		// fmt子块长度
		view.setUint32(16, 16, true);
		// 音频格式 (PCM = 1)
		view.setUint16(20, 1, true);
		// 声道数
		view.setUint16(22, channels, true);
		// 采样率
		view.setUint32(24, sampleRate, true);
		// 字节率
		view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
		// 块对齐
		view.setUint16(32, channels * bitsPerSample / 8, true);
		// 每样本位数
		view.setUint16(34, bitsPerSample, true);
		// data子块标识符
		writeString(36, 'data');
		// data子块长度
		view.setUint32(40, dataLength, true);
		
		// 复制PCM数据
		const wavData = new Uint8Array(buffer);
		wavData.set(pcmData, 44);
		
		return wavData;
	}

	/**
	 * 测试所有朗读人
	 * 逐一测试每个朗读人是否能正常工作
	 */
	async testAllVoiceSpeakers(): Promise<void> {
		const testVoices = [
			// 基础发音人（免费）
			{ id: 'xiaoyan', name: '小燕 (女声) - 经典' },
			{ id: 'aisjiuxu', name: '爱思九旭 (男声) - 经典' },
			{ id: 'aisxping', name: '爱思小萍 (女声) - 经典' },
			{ id: 'aisjinger', name: '爱思金儿 (女声) - 经典' },
			{ id: 'aisbabyxu', name: '爱思宝旭 (男童声) - 经典' },
			// 新版发音人
			{ id: 'x2_xiaolu', name: '讯飞小露 (亲切女声)' },
			{ id: 'x2_yifei', name: '讯飞一菲 (甜美女声)' },
			{ id: 'x2_qige', name: '讯飞七哥 (磁性男声)' },
			{ id: 'x2_chaoge', name: '讯飞超哥 (磁性男声)' },
			{ id: 'x2_mengxiaoxin', name: '讯飞萌小新 (可爱男童)' }
		];

		this.updateStatusFloat('=== 开始测试所有朗读人 ===', 'info', false);
		
		const originalVoice = this.settings.ttsVoice;
		const testText = '你好，我是语音测试';
		
		for (let i = 0; i < testVoices.length; i++) {
			const voice = testVoices[i];
			this.updateStatusFloat(`[${i + 1}/${testVoices.length}] 测试 ${voice.name}...`, 'info', false);
			
			// 临时更改朗读人设置
			this.settings.ttsVoice = voice.id;
			
			try {
				// 测试TTS连接
				const success = await this.testSingleVoice(voice.id, testText);
				if (success) {
					this.updateStatusFloat(`✅ ${voice.name} - 测试成功`, 'success');
				} else {
					this.updateStatusFloat(`❌ ${voice.name} - 测试失败`, 'error');
				}
			} catch (error) {
				this.updateStatusFloat(`❌ ${voice.name} - 错误: ${error instanceof Error ? error.message : String(error)}`, 'error');
			}
			
			// 等待一秒再测试下一个
			await new Promise(resolve => window.setTimeout(resolve, 1000));
		}
		
		// 恢复原始设置
		this.settings.ttsVoice = originalVoice;
		await this.saveSettings();
		
		this.updateStatusFloat('=== 朗读人测试完成 ===', 'success');
	}

	/**
	 * 测试单个朗读人
	 */
	private async testSingleVoice(voiceId: string, text: string): Promise<boolean> {
		const { xunfeiAppId, xunfeiApiKey, xunfeiApiSecret } = this.settings;
			
		if (!xunfeiAppId || !xunfeiApiKey || !xunfeiApiSecret) {
			return false;
		}

		// 鉴权需要异步 Web Crypto，因此在 Promise 执行器之前完成。
		const host = 'tts-api.xfyun.cn';
		const path = '/v2/tts';
		const date = new Date().toUTCString();
			
		const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
		const signature = await hmacSha256Base64(xunfeiApiSecret, signatureOrigin);
		const authorizationOrigin = `api_key="${xunfeiApiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
		const authorization = encodeURIComponent(window.btoa(authorizationOrigin));
			
		const url = `wss://${host}${path}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;

		return new Promise((resolve) => {
			
			const ws = new WebSocket(url);
			let testResult = false;
			
			// 设置超时
			const timeout = window.setTimeout(() => {
				ws.close();
				resolve(false);
			}, 5000);
			
			ws.onopen = () => {
				const params = {
					common: { app_id: xunfeiAppId },
					business: { 
						aue: 'lame',
						auf: 'audio/L16;rate=16000', 
						vcn: voiceId, 
						speed: 50, 
						volume: 50, 
						pitch: 50, 
						bgs: 0,
						tte: 'UTF8'
					},
					data: { 
						status: 2, 
						text: encodeUtf8ToBase64(text)
					}
				};
				ws.send(JSON.stringify(params));
			};
			
			ws.onmessage = (event: MessageEvent) => {
				try {
					const data = parseJsonResponse<XunfeiTtsResponse>(String(event.data));
					if (data.code === 0) {
						testResult = true;
						if (data.data && data.data.status === 2) {
							window.clearTimeout(timeout);
							ws.close();
							resolve(true);
						}
					} else {
						window.clearTimeout(timeout);
						ws.close();
						resolve(false);
					}
				} catch {
					window.clearTimeout(timeout);
					ws.close();
					resolve(false);
				}
			};
			
			ws.onerror = () => {
				window.clearTimeout(timeout);
				resolve(false);
			};
			
			ws.onclose = () => {
				window.clearTimeout(timeout);
				resolve(testResult);
			};
		});
	}

	/**
	 * 调试TTS连接
	 */
	/**
	 * 调试文本内容获取
	 * 显示当前选中的文本或整篇笔记内容
	 */
	async debugTextContent(): Promise<void> {
		try {
			this.updateStatusFloat('=== 文本内容调试 ===', 'info', false);
			
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) {
				this.updateStatusFloat('没有活动的笔记视图', 'error');
				return;
			}

			const editor = activeView.editor;
			
			// 检查选中文本
			const selectedText = editor.getSelection();
			if (selectedText.trim()) {
				this.updateStatusFloat(`选中文本长度: ${selectedText.length}字符`, 'info');
				this.updateStatusFloat(`选中文本内容: "${selectedText.substring(0, 100)}${selectedText.length > 100 ? '...' : ''}"`, 'info');
				this.updateStatusFloat(`Base64编码: ${encodeUtf8ToBase64(selectedText.trim())}`, 'info');
			} else {
				this.updateStatusFloat('没有选中文本', 'warning');
				
				// 显示整篇笔记信息
				const fullText = editor.getValue().trim();
				if (fullText) {
					this.updateStatusFloat(`整篇笔记长度: ${fullText.length}字符`, 'info');
					this.updateStatusFloat(`笔记内容预览: "${fullText.substring(0, 100)}${fullText.length > 100 ? '...' : ''}"`, 'info');
				} else {
					this.updateStatusFloat('笔记内容为空', 'warning');
				}
			}
			
			// 显示当前光标位置
			const cursor = editor.getCursor();
			this.updateStatusFloat(`光标位置: 行${cursor.line + 1}, 列${cursor.ch + 1}`, 'info');
			
		} catch (error) {
			this.updateStatusFloat('调试文本内容失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
		}
	}

	async debugTTSConnection(): Promise<void> {
		try {
			this.updateStatusFloat('=== TTS连接调试 ===', 'info', false);
			
			// 检查API配置
			const { xunfeiAppId, xunfeiApiKey, xunfeiApiSecret, ttsMode } = this.settings;
			this.updateStatusFloat(`TTS模式: ${ttsMode}`, 'info');
			this.updateStatusFloat(`AppId: ${xunfeiAppId || '未设置'}`, xunfeiAppId ? 'info' : 'error');
			this.updateStatusFloat(`ApiKey: ${xunfeiApiKey ? '已设置' : '未设置'}`, xunfeiApiKey ? 'info' : 'error');
			this.updateStatusFloat(`ApiSecret: ${xunfeiApiSecret ? '已设置' : '未设置'}`, xunfeiApiSecret ? 'info' : 'error');
			
			if (!xunfeiAppId || !xunfeiApiKey || !xunfeiApiSecret) {
				this.updateStatusFloat('API配置不完整，无法进行TTS测试', 'error');
				return;
			}
			
			// 测试简单文本
			const testText = '你好，这是TTS连接测试';
			this.updateStatusFloat(`测试文本: "${testText}"`, 'info');
			
			if (ttsMode === 'online') {
				this.updateStatusFloat('开始测试在线TTS连接...', 'info');
				
				// 构建连接参数
				const host = 'tts-api.xfyun.cn';
				const path = '/v2/tts';
				const date = new Date().toUTCString();
				
				this.updateStatusFloat(`连接地址: wss://${host}${path}`, 'info');
				this.updateStatusFloat(`请求时间: ${date}`, 'info');
				
				// 生成签名
				const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
				const signature = await hmacSha256Base64(xunfeiApiSecret, signatureOrigin);
				const authorizationOrigin = `api_key="${xunfeiApiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
				const authorization = encodeURIComponent(window.btoa(authorizationOrigin));
				
				const url = `wss://${host}${path}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
				
				this.updateStatusFloat('正在建立WebSocket连接...', 'info');
				
				// 测试连接
				const ws = new WebSocket(url);
				let connectionSuccess = false;
				
				ws.onopen = () => {
					connectionSuccess = true;
					this.updateStatusFloat('WebSocket连接成功！', 'success');
					
					// 发送测试请求
					const params = {
						common: { app_id: xunfeiAppId },
						business: { 
							aue: 'lame',
							auf: 'audio/L16;rate=16000', 
							vcn: this.settings.ttsVoice, 
							speed: this.settings.ttsSpeed, 
							volume: this.settings.ttsVolume, 
							pitch: this.settings.ttsPitch, 
							bgs: 0,
							tte: 'UTF8'
						},
						data: { 
							status: 2, 
							text: encodeUtf8ToBase64(testText)
						}
					};
					
					this.updateStatusFloat('发送TTS请求...', 'info');
					ws.send(JSON.stringify(params));
				};
				
				ws.onmessage = (event: MessageEvent) => {
					try {
						const data = parseJsonResponse<XunfeiTtsResponse>(String(event.data));
						this.updateStatusFloat(`收到响应: code=${data.code}`, data.code === 0 ? 'success' : 'error');
						
						if (data.code !== 0) {
							this.updateStatusFloat(`错误信息: ${data.message}`, 'error');
						} else if (data.data && data.data.audio) {
							this.updateStatusFloat(`收到音频数据: ${data.data.audio.length}字符`, 'success');
						}
						
						if (data.data && data.data.status === 2) {
							this.updateStatusFloat('TTS合成完成！', 'success');
							ws.close();
						}
					} catch (error) {
						this.updateStatusFloat('解析响应失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
					}
				};
				
				ws.onerror = (error) => {
					this.updateStatusFloat('WebSocket连接错误', 'error');
					this.debugLog('TTS WebSocket 错误:', error);
				};
				
				ws.onclose = (event) => {
					if (!connectionSuccess) {
						this.updateStatusFloat(`连接失败: code=${event.code}, reason=${event.reason}`, 'error');
					} else {
						this.updateStatusFloat('连接已关闭', 'info');
					}
				};
				
				// 设置超时
				window.setTimeout(() => {
					if (!connectionSuccess) {
						this.updateStatusFloat('连接超时', 'error');
						ws.close();
					}
				}, 10000);
				
			}
			
		} catch (error) {
			this.updateStatusFloat('TTS调试失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
		}
	}

	/**
	 * 创建状态浮窗
	 */
	private createStatusFloat(): void {
		// 移除已存在的浮窗
		this.removeStatusFloat();

		// 创建浮窗容器
		this.statusFloat = createDiv();
		this.statusFloat.className = 'voice-assistant-status-float';

		// 创建标题栏
		const header = createDiv();
		header.className = 'voice-assistant-status-header';
		const titleEl = createSpan();
		titleEl.className = 'voice-assistant-status-title';
		titleEl.textContent = '语音助手';
		header.appendChild(titleEl);

		// 添加拖拽功能
		let isDragging = false;
		let dragOffset = { x: 0, y: 0 };

		this.registerDomEvent(header, 'mousedown', (e: MouseEvent) => {
			isDragging = true;
			const rect = this.statusFloat.getBoundingClientRect();
			dragOffset.x = e.clientX - rect.left;
			dragOffset.y = e.clientY - rect.top;
			
			// 防止文本选择
			e.preventDefault();
		});

		this.registerDomEvent(document, 'mousemove', (e: MouseEvent) => {
			if (!isDragging || !this.statusFloat) return;
			
			const x = e.clientX - dragOffset.x;
			const y = e.clientY - dragOffset.y;
			
			// 限制在窗口范围内
			const maxX = window.innerWidth - this.statusFloat.offsetWidth;
			const maxY = window.innerHeight - this.statusFloat.offsetHeight;
			
			const constrainedX = Math.max(0, Math.min(x, maxX));
			const constrainedY = Math.max(0, Math.min(y, maxY));
			
			this.statusFloat.addClass('is-dragged');
			this.statusFloat.setCssProps({
				'--voice-assistant-left': `${constrainedX}px`,
				'--voice-assistant-top': `${constrainedY}px`
			});
		});

		this.registerDomEvent(document, 'mouseup', () => {
			isDragging = false;
		});

		// 创建关闭按钮
		const closeBtn = createEl('button');
		closeBtn.textContent = '×';
		closeBtn.className = 'voice-assistant-close-button';
		closeBtn.setAttribute('aria-label', '关闭语音助手状态');
		closeBtn.onclick = () => this.hideStatusFloat();
		header.appendChild(closeBtn);

		// 创建内容区域
		const content = createDiv();
		content.className = 'voice-assistant-content';

		// 创建控制按钮区域
		const controls = createDiv();
		controls.className = 'voice-assistant-controls';

		// 暂停/继续按钮
		const playPauseBtn = createEl('button');
		playPauseBtn.textContent = '⏸️ 暂停';
		playPauseBtn.className = 'voice-assistant-control-button';
		playPauseBtn.onclick = () => this.toggleTTSPlayback();

		// 停止按钮
		const stopBtn = createEl('button');
		stopBtn.textContent = '⏹️ 停止';
		stopBtn.className = 'voice-assistant-control-button';
		stopBtn.onclick = () => this.stopTTS();

		controls.appendChild(playPauseBtn);
		controls.appendChild(stopBtn);

		// 结束对话按钮（仅在持续对话模式下显示）
		const endDialogBtn = createEl('button');
		endDialogBtn.className = 'voice-assistant-control-button end-dialog-btn is-hidden';
		endDialogBtn.textContent = '🔚 结束对话';
		endDialogBtn.onclick = () => this.endContinuousDialogWithSummary();

		// 停止听写按钮（仅在听写模式下显示）
		const stopDictationBtn = createEl('button');
		stopDictationBtn.className = 'voice-assistant-control-button stop-dictation-btn is-hidden';
		stopDictationBtn.textContent = '⏹️ 停止听写';
		stopDictationBtn.onclick = () => this.stopDictation();

		controls.appendChild(endDialogBtn);
		controls.appendChild(stopDictationBtn);

		// 组装浮窗
		this.statusFloat.appendChild(header);
		this.statusFloat.appendChild(content);
		this.statusFloat.appendChild(controls);

		// 添加到页面
		document.body.appendChild(this.statusFloat);
	}

	/**
	 * 移除状态浮窗
	 */
	private removeStatusFloat(): void {
		if (this.statusFloat) {
			this.statusFloat.remove();
			this.statusFloat = null;
		}
	}

	/**
	 * 显示状态浮窗
	 */
	private showStatusFloat(): void {
		if (this.statusFloat) {
			this.statusFloat.removeClass('is-hidden');
		}
	}

	/**
	 * 隐藏状态浮窗
	 */
	private hideStatusFloat(): void {
		if (this.statusFloat) {
			this.statusFloat.addClass('is-hidden');
		}
	}

	/**
	 * 更新状态浮窗内容
	 */
	private updateStatusFloat(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info', autoHide: boolean = true): void {
		if (!this.statusFloat) return;

		const content = this.statusFloat.querySelector('.voice-assistant-content');
		if (!content) return;

		const timestamp = new Date().toLocaleTimeString();
		const messageDiv = createDiv();
		messageDiv.className = 'voice-assistant-status-message';
		const timestampEl = createSpan();
		timestampEl.className = `voice-assistant-status-timestamp is-${type}`;
		timestampEl.textContent = `[${timestamp}]`;
		const messageEl = createSpan();
		messageEl.className = 'voice-assistant-status-message-text';
		messageEl.textContent = message;
		messageDiv.append(timestampEl, messageEl);

		content.appendChild(messageDiv);
		content.scrollTop = content.scrollHeight;

		// 自动显示浮窗
		this.showStatusFloat();

		// 限制消息数量
		const messages = content.children;
		if (messages.length > 10) {
			content.removeChild(messages[0]);
		}

		// 清除之前的自动隐藏定时器
		if (this.autoHideTimer) {
			window.clearTimeout(this.autoHideTimer);
		}

		// 根据消息类型设置自动隐藏时间
		// 如果正在播放TTS，不自动隐藏控制面板
		if (autoHide && !this.isPlaying) {
			let hideDelay = 3000; // 默认3秒
			
			switch (type) {
				case 'success':
					hideDelay = 2000; // 成功消息2秒后隐藏
					break;
				case 'error':
					hideDelay = 5000; // 错误消息5秒后隐藏
					break;
				case 'warning':
					hideDelay = 4000; // 警告消息4秒后隐藏
					break;
				case 'info':
					hideDelay = 3000; // 信息消息3秒后隐藏
					break;
			}

			this.autoHideTimer = window.setTimeout(() => {
				// 再次检查是否还在播放，如果还在播放则不隐藏
				if (!this.isPlaying) {
					this.hideStatusFloat();
				}
			}, hideDelay);
		}
	}

	/**
	 * 更新唤醒状态指示器
	 */
	private updateWakeStatus(isActive: boolean): void {
		// 复用同一个状态栏元素，避免重复切换时不断创建 DOM 节点。
		if (!this.wakeStatusBarItem) {
			this.wakeStatusBarItem = this.addStatusBarItem();
			this.wakeStatusBarItem.addClass('voice-assistant-status-bar');
		}
		this.wakeStatusBarItem.setText(isActive ? '🎤 唤醒监听中' : '🔇 唤醒已停止');
		this.wakeStatusBarItem.title = isActive ? '语音唤醒正在监听中' : '语音唤醒已停止';
		this.wakeStatusBarItem.toggleClass('is-active', isActive);
		this.wakeStatusBarItem.toggleClass('is-inactive', !isActive);
		
		this.debugLog(`唤醒状态更新: ${isActive ? '激活' : '停止'}`);
	}

	/**
	 * 切换TTS播放状态
	 */
	private toggleTTSPlayback(): void {
		if (!this.currentAudio) {
			this.updateStatusFloat('没有正在播放的音频', 'warning');
			return;
		}

		if (this.isPlaying) {
			this.currentAudio.pause();
			this.isPlaying = false;
			this.updateStatusFloat('音频已暂停', 'info');
			this.updatePlayPauseButton('▶️ 继续');
		} else {
			void this.currentAudio.play();
			this.isPlaying = true;
			this.updateStatusFloat('音频继续播放', 'info');
			this.updatePlayPauseButton('⏸️ 暂停');
		}
	}

	/**
	 * 停止TTS播放
	 */
	private stopTTS(): void {
		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio.currentTime = 0;
			this.currentAudio = null;
		}
		this.isPlaying = false;
		this.updateStatusFloat('音频播放已停止', 'info');
		this.updatePlayPauseButton('⏸️ 暂停');
	}

	/**
	 * 更新播放/暂停按钮文本
	 */
	private updatePlayPauseButton(text: string): void {
		if (!this.statusFloat) return;
		const playPauseBtn = this.statusFloat.querySelector('.voice-assistant-controls button');
		if (playPauseBtn) {
			playPauseBtn.textContent = text;
		}
	}

	/**
	 * 重置对话计时器
	 */
	/**
	 * 启动静默检测
	 */
	private startSilenceDetection(): void {
		this.clearSilenceTimer();
		this.debugLog('启动静默检测，20秒后自动结束对话');
		
		this.silenceTimer = window.setTimeout(() => {
			this.debugLog('检测到20秒静默，自动结束对话');
			void this.endContinuousDialogWithSummary();
		}, this.silenceDetectionDuration);
	}

	/**
	 * 清除静默检测计时器
	 */
	private clearSilenceTimer(): void {
		if (this.silenceTimer) {
			window.clearTimeout(this.silenceTimer);
			this.silenceTimer = null;
		}
	}

	/**
	 * 结束持续对话模式
	 */
	private endContinuousDialog(): void {
		if (!this.isInContinuousDialog) return;
		
		this.isInContinuousDialog = false;
		this.debugLog('结束持续对话模式');
		
		// 清除静默检测计时器
		this.clearSilenceTimer();
		
		// 停止背景语音检测
		this.stopBackgroundVoiceDetection();
		
		// 停止预录音缓冲
		this.stopPreRecordingBuffer();
		
		// 隐藏对话控制界面
		this.hideDialogControls();
		
		// 如果是唤醒对话，生成总结并保存到指定文件
		if (this.isWakeConversation && this.wakeSessionFileName) {
			this.debugLog('检测到唤醒对话结束，开始生成总结');
			void this.generateWakeConversationSummary();
			this.endWakeSession(); // 结束唤醒会话
		}
		
		new Notice('持续对话模式已结束');
	}

	/**
	 * 结束持续对话模式并生成总结
	 */
	private async endContinuousDialogWithSummary(): Promise<void> {
		if (!this.isInContinuousDialog) return;
		
		this.debugLog('结束持续对话模式并生成总结');
		
		// 如果有对话历史，生成总结
		if (this.conversationHistory.length > 0) {
			new Notice('正在生成对话总结...');
			
			// 根据是否为唤醒对话选择不同的处理方式
			if (this.isWakeConversation && this.wakeSessionFileName) {
				await this.generateWakeConversationSummary();
				this.endWakeSession(); // 结束唤醒会话
			} else {
				await this.generateConversationSummary();
				// 清空对话历史
				this.conversationHistory = [];
			}
		} else {
			new Notice('没有对话内容需要总结');
		}
		
		// 结束对话模式
		this.isInContinuousDialog = false;
		this.clearSilenceTimer();
		this.stopBackgroundVoiceDetection();
		this.stopPreRecordingBuffer();
		this.hideDialogControls();
	}

	/**
	 * 显示对话控制界面
	 */
	private showDialogControls(): void {
		// 在状态浮窗中显示结束对话按钮
		if (this.statusFloat) {
			const endDialogBtn = this.statusFloat.querySelector('.end-dialog-btn');
			if (endDialogBtn) {
				endDialogBtn.removeClass('is-hidden');
			}
			
			// 更新状态浮窗标题显示持续对话状态
			const title = this.statusFloat.querySelector('.voice-assistant-status-title');
			if (title) {
				title.textContent = '语音助手 - 持续对话中';
				title.addClass('is-active');
			}
		}
	}

	/**
	 * 隐藏对话控制界面
	 */
	private hideDialogControls(): void {
		// 在状态浮窗中隐藏结束对话按钮
		if (this.statusFloat) {
			const endDialogBtn = this.statusFloat.querySelector('.end-dialog-btn');
			if (endDialogBtn) {
				endDialogBtn.addClass('is-hidden');
			}
			
			// 恢复状态浮窗标题
			const title = this.statusFloat.querySelector('.voice-assistant-status-title');
			if (title) {
				title.textContent = '语音助手';
				title.removeClass('is-active');
			}
		}
	}

	/**
	 * 显示听写控制界面
	 */
	private showDictationControls(): void {
		// 在状态浮窗中显示停止听写按钮
		if (this.statusFloat) {
			const stopDictationBtn = this.statusFloat.querySelector('.stop-dictation-btn');
			if (stopDictationBtn) {
				stopDictationBtn.removeClass('is-hidden');
			}
			
			// 更新状态浮窗标题显示听写状态
			const title = this.statusFloat.querySelector('.voice-assistant-status-title');
			if (title) {
				title.textContent = '语音助手 - 听写中';
				title.addClass('is-active');
			}
		}
	}

	/**
	 * 隐藏听写控制界面
	 */
	private hideDictationControls(): void {
		// 在状态浮窗中隐藏停止听写按钮
		if (this.statusFloat) {
			const stopDictationBtn = this.statusFloat.querySelector('.stop-dictation-btn');
			if (stopDictationBtn) {
				stopDictationBtn.addClass('is-hidden');
			}
			
			// 恢复状态浮窗标题
			const title = this.statusFloat.querySelector('.voice-assistant-status-title');
			if (title) {
				title.textContent = '语音助手';
				title.removeClass('is-active');
			}
		}
	}

	/**
	 * 启动背景语音检测
	 */
	private async startBackgroundVoiceDetection(): Promise<void> {
		if (this.backgroundVoiceDetection || !this.settings.enableVoiceInterruption) {
			return; // 已经在检测中或未启用语音打断
		}
		
		try {
			this.debugLog('启动背景语音检测，阈值:', this.settings.voiceDetectionThreshold);
			this.backgroundVoiceDetection = true;
			
			// 获取音频流
			this.backgroundStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					sampleRate: 16000,
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true
				}
			});
			
			// 创建音频分析器检测音量
			const audioContext = createAudioContext();
			const analyser = audioContext.createAnalyser();
			const source = audioContext.createMediaStreamSource(this.backgroundStream);
			source.connect(analyser);
			
			analyser.fftSize = 256;
			const bufferLength = analyser.frequencyBinCount;
			const dataArray = new Uint8Array(bufferLength);
			
			let consecutiveDetections = 0;
			const requiredDetections = 3; // 需要连续检测到3次才触发
			
			// 检测音量变化
			const checkVolume = () => {
				if (!this.backgroundVoiceDetection) return;
				
				analyser.getByteFrequencyData(dataArray);
				const average = dataArray.reduce((a, b) => a + b) / bufferLength;
				
				// 如果检测到语音（音量超过阈值）
				if (average > this.settings.voiceDetectionThreshold) {
					consecutiveDetections++;
					this.debugLog(`语音检测 ${consecutiveDetections}/${requiredDetections}，音量: ${average.toFixed(1)}`);
					
					if (consecutiveDetections >= requiredDetections) {
						this.debugLog('连续检测到语音输入，停止TTS并开始新对话');
						this.handleVoiceInterruption();
						return;
					}
				} else {
					// 重置连续检测计数
					if (consecutiveDetections > 0) {
						consecutiveDetections = 0;
					}
				}
				
				// 继续检测
				this.voiceDetectionTimer = window.setTimeout(checkVolume, this.settings.voiceDetectionSensitivity);
			};
			
			checkVolume();
			
		} catch (error) {
			this.debugLog('启动背景语音检测失败:', error);
			this.backgroundVoiceDetection = false;
		}
	}
	
	/**
	 * 停止背景语音检测
	 */
	private stopBackgroundVoiceDetection(): void {
		if (!this.backgroundVoiceDetection) return;
		
		this.debugLog('停止背景语音检测');
		this.backgroundVoiceDetection = false;
		
		// 清除定时器
		if (this.voiceDetectionTimer) {
			window.clearTimeout(this.voiceDetectionTimer);
			this.voiceDetectionTimer = null;
		}
		
		// 停止音频流
		if (this.backgroundStream) {
			this.backgroundStream.getTracks().forEach(track => track.stop());
			this.backgroundStream = null;
		}
	}
	
	/**
	 * 启动预录音缓冲
	 * 在TTS播放期间持续录音，保存到缓冲区
	 */
	private async startPreRecordingBuffer(): Promise<void> {
		if (this.isPreRecording) {
			return; // 已经在预录音中
		}
		
		try {
			this.debugLog('启动预录音缓冲');
			this.isPreRecording = true;
			this.preRecordingBuffer = [];
			
			// 获取音频流
			this.preRecordingStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					sampleRate: this.settings.sampleRate,
					channelCount: this.settings.channels,
					echoCancellation: true,
					noiseSuppression: true
				}
			});
			
			// 创建录音器
			this.preRecordingRecorder = new MediaRecorder(this.preRecordingStream, {
				mimeType: 'audio/webm;codecs=opus'
			});
			
			let currentChunk: Blob[] = [];
			
			this.preRecordingRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					currentChunk.push(event.data);
				}
			};
			
			this.preRecordingRecorder.onstop = () => {
				if (currentChunk.length > 0) {
					const audioBlob = new Blob(currentChunk, { type: 'audio/webm;codecs=opus' });
					this.addToPreRecordingBuffer(audioBlob);
					currentChunk = [];
				}
			};
			
			// 每200ms记录一个音频片段
			const recordSegment = () => {
				if (!this.isPreRecording || !this.preRecordingRecorder) {
					return;
				}
				
				if (this.preRecordingRecorder.state === 'recording') {
					this.preRecordingRecorder.stop();
				}
				
				window.setTimeout(() => {
					if (this.isPreRecording && this.preRecordingRecorder) {
						this.preRecordingRecorder.start();
						window.setTimeout(recordSegment, 200);
					}
				}, 10);
			};
			
			this.preRecordingRecorder.start();
			window.setTimeout(recordSegment, 200);
			
		} catch (error) {
			this.debugLog('启动预录音缓冲失败:', error);
			this.isPreRecording = false;
		}
	}
	
	/**
	 * 添加音频片段到预录音缓冲区
	 */
	private addToPreRecordingBuffer(audioBlob: Blob): void {
		this.preRecordingBuffer.push(audioBlob);
		
		// 保持缓冲区大小限制
		if (this.preRecordingBuffer.length > this.preRecordingBufferSize) {
			this.preRecordingBuffer.shift(); // 移除最旧的片段
		}
		
		this.debugLog(`预录音缓冲区大小: ${this.preRecordingBuffer.length}`);
	}
	
	/**
	 * 停止预录音缓冲
	 */
	private stopPreRecordingBuffer(): void {
		if (!this.isPreRecording) {
			return;
		}
		
		this.debugLog('停止预录音缓冲');
		this.isPreRecording = false;
		
		if (this.preRecordingRecorder) {
			if (this.preRecordingRecorder.state === 'recording') {
				this.preRecordingRecorder.stop();
			}
			this.preRecordingRecorder = null;
		}
		
		if (this.preRecordingStream) {
			this.preRecordingStream.getTracks().forEach(track => track.stop());
			this.preRecordingStream = null;
		}
	}
	
	/**
	 * 获取预录音缓冲区的音频数据
	 */
	private getPreRecordingBufferAudio(): Blob | null {
		if (this.preRecordingBuffer.length === 0) {
			return null;
		}
		
		// 合并所有缓冲的音频片段
		const combinedBlob = new Blob(this.preRecordingBuffer, { type: 'audio/webm;codecs=opus' });
		this.debugLog(`获取预录音缓冲音频，大小: ${combinedBlob.size} bytes`);
		return combinedBlob;
	}
	
	/**
	 * 处理语音打断
	 */
	private handleVoiceInterruption(): void {
		this.debugLog('处理语音打断');
		
		// 停止当前TTS播放
		if (this.currentAudio && !this.currentAudio.paused) {
			this.debugLog('语音打断：停止TTS播放');
			this.currentAudio.pause();
			this.currentAudio.currentTime = 0;
			this.currentAudio = null;
			this.isPlaying = false;
			this.updatePlayPauseButton('⏸️ 暂停');
		}
		
		// 停止背景语音检测
		this.stopBackgroundVoiceDetection();
		
		// 清除静默检测计时器
		this.clearSilenceTimer();
		
		// 更新状态显示
		this.updateStatusFloat('检测到语音输入，正在处理...');
		
		// 立即开始新的对话，使用预录音缓冲
		if (this.isInContinuousDialog) {
			void this.processSingleConversationWithBuffer();
		}
	}

	/**
	 * 使用预录音缓冲处理单次对话
	 */
	private async processSingleConversationWithBuffer(): Promise<void> {
		try {
			this.debugLog('开始处理带缓冲的单次对话');
			
			// 获取预录音缓冲的音频
			const bufferedAudio = this.getPreRecordingBufferAudio();
			
			// 开始新的录音
			const newAudioBlob = await this.startRecording();
			
			// 合并预录音缓冲和新录音
			let finalAudioBlob: Blob;
			if (bufferedAudio && bufferedAudio.size > 0) {
				this.debugLog('合并预录音缓冲和新录音');
				finalAudioBlob = new Blob([bufferedAudio, newAudioBlob], { type: 'audio/wav' });
			} else {
				this.debugLog('没有预录音缓冲，使用新录音');
				finalAudioBlob = newAudioBlob;
			}
			
			// 语音转文字
			this.updateStatusFloat('正在识别语音...');
			const userText = await this.speechToText(finalAudioBlob);
			
			if (!userText || userText.trim() === '' || userText === '未识别到语音内容') {
				this.updateStatusFloat('未识别到有效语音，请重试', 'warning');
				this.startSilenceDetection();
				return;
			}
			
			this.debugLog('用户输入:', userText);
			
			// 处理自定义提示词
			const processedText = this.processCustomPrompts(userText);
			
			// 调用LLM
			this.updateStatusFloat('正在思考回复...');
			const aiResponse = await this.callLLM(processedText);
			
			// 保存对话历史
			this.conversationHistory.push({
				user: userText,
				assistant: aiResponse,
				timestamp: new Date()
			});
			
			// 插入到笔记
			this.insertToNote(userText, aiResponse);
			
			// TTS播放
			if (this.settings.ttsMode !== 'disabled') {
				this.updateStatusFloat('正在播放回复...');
				await this.textToSpeech(aiResponse);
				
				// TTS播放完成后，重新启动预录音缓冲和背景语音检测
				if (this.isInContinuousDialog) {
					void this.startPreRecordingBuffer();
					void this.startBackgroundVoiceDetection();
				}
			} else {
				this.updateStatusFloat('回复已生成', 'success');
				// 没有TTS时，直接重新启动检测
				if (this.isInContinuousDialog) {
					this.startSilenceDetection();
				}
			}
			
		} catch (error) {
			this.debugLog('处理带缓冲的单次对话时出错:', error);
			this.updateStatusFloat('处理对话时出错，请重试', 'error');
			if (this.isInContinuousDialog) {
				this.startSilenceDetection();
			}
		}
	}

	/**
	 * 处理自定义提示词
	 */
	private processCustomPrompts(text: string): string {
		if (!this.settings.customPrompts || this.settings.customPrompts.length === 0) {
			return text;
		}
		
		// 查找匹配的提示词
		for (const prompt of this.settings.customPrompts) {
			if (!prompt.enabled) continue;
			
			// 检查触发词是否匹配
			if (text.toLowerCase().includes(prompt.trigger.toLowerCase())) {
				this.debugLog(`匹配到自定义提示词: ${prompt.name}`);
				// 将提示词与用户输入结合
				return `${prompt.prompt}\n\n用户输入：${text}`;
			}
		}
		
		return text;
	}

	/**
	 * 生成对话总结并保存到独立文件
	 */
	private async generateConversationSummary(): Promise<void> {
		if (this.conversationHistory.length === 0) {
			this.debugLog('没有对话历史需要总结');
			return;
		}

		try {
			// 构建对话历史文本
			let conversationText = '请对以下对话进行总结，提取关键信息和要点：\n\n';
			
			this.conversationHistory.forEach((item, index) => {
				const timeStr = item.timestamp.toLocaleTimeString();
				conversationText += `[${timeStr}] 用户：${item.user}\n`;
				conversationText += `[${timeStr}] 助手：${item.assistant}\n\n`;
			});

			conversationText += '\n请生成一个简洁的总结，包括：\n1. 主要讨论的话题\n2. 关键信息和要点\n3. 如果有任务或行动项，请列出';

			this.debugLog('正在生成对话总结...');
			
			// 调用LLM生成总结
			const summary = await this.callLLM(conversationText);
			
			// 生成文件名（格式：YYYY-MM-DD HH-mm-ss）
			const now = new Date();
			const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.md`;
			
			if (summary) {
				// 构建完整的笔记内容
				const noteContent = `## 语音对话总结\n\n**时间：** ${now.toLocaleString()}\n**对话轮数：** ${this.conversationHistory.length}\n\n### 总结\n${summary}\n\n### 详细对话记录\n\n`;
				
				let detailedContent = '';
				this.conversationHistory.forEach((item, index) => {
					const timeStr = item.timestamp.toLocaleTimeString();
					detailedContent += `**[${timeStr}] 用户：** ${item.user}\n\n**[${timeStr}] 助手：** ${item.assistant}\n\n---\n\n`;
				});

				// 保存到独立文件
				await this.saveConversationToFile(fileName, noteContent + detailedContent);
				new Notice(`对话总结已保存到文件：${fileName}（共${this.conversationHistory.length}轮对话）`);
			} else {
				// 如果总结生成失败，直接保存原始对话记录
				let fallbackContent = `## 语音对话记录\n\n**时间：** ${now.toLocaleString()}\n**对话轮数：** ${this.conversationHistory.length}\n\n`;
				
				this.conversationHistory.forEach((item, index) => {
					const timeStr = item.timestamp.toLocaleTimeString();
					fallbackContent += `**[${timeStr}] 用户：** ${item.user}\n\n**[${timeStr}] 助手：** ${item.assistant}\n\n---\n\n`;
				});

				await this.saveConversationToFile(fileName, fallbackContent);
				new Notice(`对话记录已保存到文件：${fileName}（总结生成失败，保存原始记录）`);
			}

		} catch (error) {
			this.debugLog('生成对话总结失败:', error);
			new Notice('生成对话总结失败，请检查网络连接');
		}
	}

	/**
	 * 为唤醒对话生成总结并保存到指定文件
	 */
	private async generateWakeConversationSummary(): Promise<void> {
		if (this.conversationHistory.length === 0) {
			this.debugLog('对话历史为空，跳过总结生成');
			return;
		}

		if (!this.wakeSessionFileName) {
			this.debugLog('唤醒会话文件名为空，跳过保存');
			return;
		}

		try {
			// 构建对话历史文本
			let conversationText = '请对以下对话进行总结，提取关键信息和要点：\n\n';
			
			this.conversationHistory.forEach((item, index) => {
				const timeStr = item.timestamp.toLocaleTimeString();
				conversationText += `[${timeStr}] 用户：${item.user}\n`;
				conversationText += `[${timeStr}] 助手：${item.assistant}\n\n`;
			});

			conversationText += '\n请生成一个简洁的总结，包括：\n1. 主要讨论的话题\n2. 关键信息和要点\n3. 如果有任务或行动项，请列出';

			this.debugLog('正在生成唤醒对话总结...');
			
			// 调用LLM生成总结
			const summary = await this.callLLM(conversationText);
			
			// 使用预设的文件名
			const fileName = this.wakeSessionFileName;
			
			if (summary) {
				// 构建完整的笔记内容
				const now = new Date();
				const noteContent = `## 语音对话总结（唤醒会话）\n\n**时间：** ${now.toLocaleString()}\n**会话ID：** ${this.wakeSessionId}\n**对话轮数：** ${this.conversationHistory.length}\n\n### 总结\n${summary}\n\n### 详细对话记录\n\n`;
				
				let detailedContent = '';
				this.conversationHistory.forEach((item, index) => {
					const timeStr = item.timestamp.toLocaleTimeString();
					detailedContent += `**[${timeStr}] 用户：** ${item.user}\n\n**[${timeStr}] 助手：** ${item.assistant}\n\n---\n\n`;
				});

				// 保存到指定文件
				await this.saveConversationToFile(fileName, noteContent + detailedContent);
				new Notice(`唤醒对话总结已保存到文件：${fileName}（共${this.conversationHistory.length}轮对话）`);
			} else {
				// 如果总结生成失败，直接保存原始对话记录
				const now = new Date();
				let fallbackContent = `## 语音对话记录（唤醒会话）\n\n**时间：** ${now.toLocaleString()}\n**会话ID：** ${this.wakeSessionId}\n**对话轮数：** ${this.conversationHistory.length}\n\n`;
				
				this.conversationHistory.forEach((item, index) => {
					const timeStr = item.timestamp.toLocaleTimeString();
					fallbackContent += `**[${timeStr}] 用户：** ${item.user}\n\n**[${timeStr}] 助手：** ${item.assistant}\n\n---\n\n`;
				});

				await this.saveConversationToFile(fileName, fallbackContent);
				new Notice(`唤醒对话记录已保存到文件：${fileName}（总结生成失败，保存原始记录）`);
			}

		} catch (error) {
			this.debugLog('生成唤醒对话总结失败:', error);
			new Notice('生成对话总结失败，请检查网络连接');
		}
	}

	/**
	 * 保存对话内容到指定文件
	 */
	private async saveConversationToFile(fileName: string, content: string): Promise<void> {
		try {
			// 确保保存文件夹存在
			const folderPath = this.settings.conversationSaveFolder;
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			}
			
			// 创建完整的文件路径
			const filePath = `${folderPath}/${fileName}`;
			
			// 检查文件是否已存在，如果存在则添加序号
			let finalPath = filePath;
			let counter = 1;
			while (this.app.vault.getAbstractFileByPath(finalPath)) {
				const nameWithoutExt = fileName.replace('.md', '');
				finalPath = `${folderPath}/${nameWithoutExt}-${counter}.md`;
				counter++;
			}
			
			// 创建文件
			await this.app.vault.create(finalPath, content);
			this.debugLog(`对话已保存到文件: ${finalPath}`);
			
		} catch (error) {
			this.debugLog('保存对话文件失败:', error);
			throw normalizeError(error, '保存对话文件失败');
		}
	}
}

/**
 * 设置面板类
 */
class VoiceAssistantSettingTab extends PluginSettingTab {
	plugin: VoiceAssistantPlugin;

	constructor(app: App, plugin: VoiceAssistantPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('voice-assistant-settings');

		// LLM 配置
		new Setting(containerEl).setName('LLM').setHeading();
		
		new Setting(containerEl)
			.setName('LLM 提供商')
			.setDesc('选择要使用的大语言模型提供商')
			.addDropdown(dropdown => dropdown
				.addOption('google', 'Google AI Studio')
				.addOption('openrouter', 'OpenRouter')
				.addOption('xunfei', '讯飞星火')

				.addOption('custom', '自定义模型')
				.setValue(this.plugin.settings.llmProvider)
				.onChange(async (value: 'google' | 'openrouter' | 'xunfei' | 'custom') => {
					this.plugin.settings.llmProvider = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Google API Key')
			.setDesc('Google AI Studio API 密钥')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('输入 Google API Key')
					.setValue(this.plugin.settings.googleApiKey)
					.onChange(async (value) => {
					this.plugin.settings.googleApiKey = value;
					await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('OpenRouter API Key')
			.setDesc('OpenRouter API 密钥')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('输入 OpenRouter API Key')
					.setValue(this.plugin.settings.openrouterApiKey)
					.onChange(async (value) => {
					this.plugin.settings.openrouterApiKey = value;
					await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('讯飞 App ID')
			.setDesc('讯飞开放平台应用 ID')
			.addText(text => text
				.setPlaceholder('输入讯飞 App ID')
				.setValue(this.plugin.settings.xunfeiAppId)
				.onChange(async (value) => {
					this.plugin.settings.xunfeiAppId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('讯飞 API Key')
			.setDesc('讯飞开放平台 API Key')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('输入讯飞 API Key')
					.setValue(this.plugin.settings.xunfeiApiKey)
					.onChange(async (value) => {
					this.plugin.settings.xunfeiApiKey = value;
					await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('讯飞 API Secret')
			.setDesc('讯飞开放平台 API Secret')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('输入讯飞 API Secret')
					.setValue(this.plugin.settings.xunfeiApiSecret)
					.onChange(async (value) => {
					this.plugin.settings.xunfeiApiSecret = value;
					await this.plugin.saveSettings();
					});
			});







		// 模型选择配置
		new Setting(containerEl).setName('模型').setHeading();

		new Setting(containerEl)
			.setName('Google 模型')
			.setDesc('选择要使用的 Google AI Studio 模型')
			.addDropdown(dropdown => dropdown
				.addOption('gemini-2.5-flash', 'Gemini 2.5 Flash (推荐)')
				.addOption('gemini-2.5-pro', 'Gemini 2.5 Pro')
				.addOption('gemini-1.5-pro', 'Gemini 1.5 Pro')
				.addOption('gemini-1.5-flash', 'Gemini 1.5 Flash')
				.addOption('gemini-pro', 'Gemini Pro')
				.addOption('gemini-1.0-pro', 'Gemini 1.0 Pro')
				.setValue(this.plugin.settings.googleModel)
				.onChange(async (value) => {
					this.plugin.settings.googleModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('OpenRouter 模型')
			.setDesc('选择要使用的 OpenRouter 模型')
			.addDropdown(dropdown => dropdown
				.addOption('openai/gpt-3.5-turbo', 'GPT-3.5 Turbo')
				.addOption('openai/gpt-4', 'GPT-4')
				.addOption('openai/gpt-4-turbo', 'GPT-4 Turbo')
				.addOption('anthropic/claude-3-haiku', 'Claude 3 Haiku')
				.addOption('anthropic/claude-3-sonnet', 'Claude 3 Sonnet')
				.addOption('anthropic/claude-3-opus', 'Claude 3 Opus')
				.addOption('meta-llama/llama-2-70b-chat', 'Llama 2 70B Chat')
				.addOption('mistralai/mixtral-8x7b-instruct', 'Mixtral 8x7B Instruct')
				.addOption('google/gemma-7b-it', 'Gemma 7B IT')
				.setValue(this.plugin.settings.openrouterModel)
				.onChange(async (value) => {
					this.plugin.settings.openrouterModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('讯飞星火模型')
			.setDesc('选择要使用的讯飞星火模型版本')
			.addDropdown(dropdown => dropdown
				.addOption('lite', 'Spark Lite (推荐，永久免费)')
				.addOption('generalv3', 'Spark Pro (generalv3)')
				.addOption('pro-128k', 'Spark Pro-128K (pro-128k)')
				.addOption('generalv3.5', 'Spark Max (generalv3.5)')
				.addOption('max-32k', 'Spark Max-32K (max-32k)')
				.addOption('4.0Ultra', 'Spark 4.0 Ultra')
				.addOption('generalv2', 'Spark 2.0 (generalv2)')
				.addOption('general', 'Spark 1.5 (general)')
				.setValue(this.plugin.settings.xunfeiModel)
				.onChange(async (value) => {
					this.plugin.settings.xunfeiModel = value;
					await this.plugin.saveSettings();
				}));



		// 自定义模型配置
		new Setting(containerEl).setName('自定义模型').setHeading();
		
		const customModelsDesc = containerEl.createEl('p', { 
			text: '您可以添加自定义模型配置，支持Google AI Studio、OpenRouter和讯飞星火提供商' 
		});
		customModelsDesc.addClass('voice-assistant-muted-description');

		// 当前选择的自定义模型
		const customModelSetting = new Setting(containerEl)
			.setName('选择自定义模型')
			.setDesc('从已配置的自定义模型中选择一个');

		const updateCustomModelDropdown = () => {
			customModelSetting.clear();
			customModelSetting.addDropdown(dropdown => {
				dropdown.addOption('', '请选择模型');
				this.plugin.settings.customModels.forEach(model => {
					dropdown.addOption(model.name, `${model.name} (${model.provider})`);
				});
				dropdown.setValue(this.plugin.settings.selectedCustomModel);
				dropdown.onChange(async (value) => {
					this.plugin.settings.selectedCustomModel = value;
					await this.plugin.saveSettings();
				});
			});
		};

		updateCustomModelDropdown();

		// 添加新的自定义模型
		const addCustomModelContainer = containerEl.createDiv();
		new Setting(addCustomModelContainer).setName('添加新的自定义模型').setHeading();

		let newModelName = '';
		let newModelProvider = 'google';
		let newModelId = '';

		new Setting(addCustomModelContainer)
			.setName('模型名称')
			.setDesc('为这个模型设置一个易识别的名称')
			.addText(text => text
				.setPlaceholder('例如：GPT-4 Turbo')
				.onChange((value) => {
					newModelName = value;
				}));

		new Setting(addCustomModelContainer)
			.setName('提供商')
			.setDesc('选择模型的提供商')
			.addDropdown(dropdown => dropdown
				.addOption('google', 'Google AI Studio')
				.addOption('openrouter', 'OpenRouter')
				.addOption('xunfei', '讯飞星火')
				.setValue('google')
				.onChange((value) => {
					newModelProvider = value;
				}));

		new Setting(addCustomModelContainer)
			.setName('模型ID')
			.setDesc('输入模型的具体ID')
			.addText(text => text
				.setPlaceholder('例如：gemini-1.5-pro 或 openai/gpt-4')
				.onChange((value) => {
					newModelId = value;
				}));

		new Setting(addCustomModelContainer)
			.addButton(button => button
				.setButtonText('添加模型')
				.setCta()
				.onClick(async () => {
					if (!newModelName || !newModelId) {
						new Notice('请填写模型名称和模型ID');
						return;
					}

					// 检查是否已存在同名模型
					const existingModel = this.plugin.settings.customModels.find(m => m.name === newModelName);
					if (existingModel) {
						new Notice('已存在同名模型，请使用不同的名称');
						return;
					}

					// 添加新模型
					this.plugin.settings.customModels.push({
						name: newModelName,
						provider: newModelProvider,
						modelId: newModelId
					});

					await this.plugin.saveSettings();
					updateCustomModelDropdown();
					
					// 清空输入框
					newModelName = '';
					newModelId = '';
					addCustomModelContainer.querySelectorAll('input[type="text"]').forEach((input: HTMLInputElement) => {
						input.value = '';
					});

					new Notice('自定义模型添加成功');
				}));

		// 现有自定义模型列表
		const existingModelsContainer = containerEl.createDiv();
		new Setting(existingModelsContainer).setName('现有自定义模型').setHeading();

		const updateExistingModelsList = () => {
			existingModelsContainer.empty();
			new Setting(existingModelsContainer).setName('现有自定义模型').setHeading();

			if (this.plugin.settings.customModels.length === 0) {
				existingModelsContainer.createEl('p', { 
					text: '暂无自定义模型',
					cls: 'voice-assistant-empty-state'
				});
				return;
			}

			this.plugin.settings.customModels.forEach((model, index) => {
				const modelContainer = existingModelsContainer.createDiv('voice-assistant-model-card');

				const modelInfo = modelContainer.createDiv('voice-assistant-model-info');
				modelInfo.createEl('strong', { text: model.name });
				modelInfo.createDiv({ text: `提供商: ${model.provider}`, cls: 'voice-assistant-model-meta' });
				modelInfo.createDiv({ text: `模型 ID: ${model.modelId}`, cls: 'voice-assistant-model-meta' });

				const deleteButton = modelContainer.createEl('button', {
					text: '删除',
					cls: 'voice-assistant-delete-button'
				});
				
				deleteButton.addEventListener('click', () => {
					void (async () => {
						this.plugin.settings.customModels.splice(index, 1);
					
						// 如果删除的是当前选中的模型，清空选择
						if (this.plugin.settings.selectedCustomModel === model.name) {
							this.plugin.settings.selectedCustomModel = '';
						}
					
						await this.plugin.saveSettings();
						updateCustomModelDropdown();
						updateExistingModelsList();
						new Notice('自定义模型删除成功');
					})();
				});
			});
		};

		updateExistingModelsList();

		// 语音唤醒配置
		new Setting(containerEl).setName('语音唤醒').setHeading();
		
		new Setting(containerEl)
			.setName('唤醒模式')
			.setDesc('选择语音唤醒的工作模式')
			.addDropdown(dropdown => dropdown
				.addOption('disabled', '禁用')
				.addOption('online', '讯飞在线唤醒')
				.setValue(this.plugin.settings.wakeMode)
				.onChange(async (value: 'disabled' | 'online') => {
					this.plugin.settings.wakeMode = value;
					await this.plugin.saveSettings();
				}));

		// 唤醒词管理
		const wakeWordsContainer = containerEl.createDiv();
		this.displayWakeWords(wakeWordsContainer);



		new Setting(containerEl)
			.setName('自动进入对话')
			.setDesc('检测到唤醒词后自动进入对话模式')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoEnterDialogAfterWake)
				.onChange(async (value) => {
					this.plugin.settings.autoEnterDialogAfterWake = value;
					await this.plugin.saveSettings();
				}));

		// 唤醒检测间隔设置
		const wakeIntervalSetting = new Setting(containerEl)
			.setName('唤醒检测间隔')
			.setDesc('设置唤醒词检测的时间间隔，数值越小响应越快但消耗更多资源（0.5-5秒）');
		
		const wakeIntervalValueEl = wakeIntervalSetting.controlEl.createSpan({
			text: `${this.plugin.settings.wakeDetectionInterval / 1000}秒`,
			cls: 'setting-slider-value'
		});
		
		wakeIntervalSetting.addSlider(slider => slider
			.setLimits(500, 5000, 100)
			.setValue(this.plugin.settings.wakeDetectionInterval)
			.onChange(async (value) => {
				this.plugin.settings.wakeDetectionInterval = value;
				wakeIntervalValueEl.textContent = `${value / 1000}秒`;
				await this.plugin.saveSettings();
			}));

		// 语音识别配置
		new Setting(containerEl).setName('语音识别').setHeading();
		
		new Setting(containerEl)
			.setName('ASR 提供商')
			.setDesc('选择语音识别服务提供商')
			.addDropdown(dropdown => dropdown
				.addOption('xunfei', '讯飞语音识别')
				.setValue(this.plugin.settings.asrProvider)
				.onChange(async (value: 'xunfei') => {
					this.plugin.settings.asrProvider = value;
					await this.plugin.saveSettings();
				}));



		// 语音听写配置
		new Setting(containerEl).setName('语音听写').setHeading();
		


		const dictationTimeoutSetting = new Setting(containerEl)
			.setName('持续听写静默超时')
			.setDesc('持续听写模式下，静默多少秒后自动结束听写');
		
		const dictationTimeoutValueEl = dictationTimeoutSetting.controlEl.createSpan({
			text: `${this.plugin.settings.dictationSilenceTimeout}秒`,
			cls: 'setting-slider-value'
		});
		
		dictationTimeoutSetting.addSlider(slider => slider
			.setLimits(5, 30, 1)
			.setValue(this.plugin.settings.dictationSilenceTimeout)
			.onChange(async (value) => {
				this.plugin.settings.dictationSilenceTimeout = value;
				dictationTimeoutValueEl.textContent = `${value}秒`;
				await this.plugin.saveSettings();
			}));

		const dictationIntervalSetting = new Setting(containerEl)
			.setName('录音静默间隔')
			.setDesc('用户停止说话后多少秒进行语音识别（避免说话过程中被打断）');
		
		const dictationIntervalValueEl = dictationIntervalSetting.controlEl.createSpan({
			text: `${this.plugin.settings.dictationSilenceInterval}秒`,
			cls: 'setting-slider-value'
		});
		
		dictationIntervalSetting.addSlider(slider => slider
			.setLimits(1, 5, 0.5)
			.setValue(this.plugin.settings.dictationSilenceInterval)
			.onChange(async (value) => {
				this.plugin.settings.dictationSilenceInterval = value;
				dictationIntervalValueEl.textContent = `${value}秒`;
				await this.plugin.saveSettings();
			}));

		// 语音合成配置
		new Setting(containerEl).setName('语音合成').setHeading();
		
		new Setting(containerEl)
			.setName('TTS 提供商')
			.setDesc('选择语音合成服务提供商')
			.addDropdown(dropdown => dropdown
				.addOption('xunfei', '讯飞语音合成')
				.setValue(this.plugin.settings.ttsProvider)
				.onChange(async (value: 'xunfei') => {
					this.plugin.settings.ttsProvider = value;
					await this.plugin.saveSettings();
					// 触发朗读人选项更新
					updateVoiceOptions();
				}));

		new Setting(containerEl)
			.setName('TTS 模式')
			.setDesc('选择语音合成模式')
			.addDropdown(dropdown => dropdown
				.addOption('disabled', '禁用')
				.addOption('online', '在线 TTS')
				.setValue(this.plugin.settings.ttsMode)
				.onChange(async (value: 'disabled' | 'online') => {
					this.plugin.settings.ttsMode = value;
					await this.plugin.saveSettings();
				}));

		// 朗读人声音设置
		const voiceSetting = new Setting(containerEl)
			.setName('朗读人声音')
			.setDesc('选择语音合成的朗读人声音');

		// 根据TTS提供商动态添加选项
		const updateVoiceOptions = () => {
			voiceSetting.addDropdown(dropdown => {
				dropdown.selectEl.empty(); // 清空现有选项
				
				if (this.plugin.settings.ttsProvider === 'xunfei') {
					// 讯飞语音选项
					dropdown
						// 基础发音人（免费）
						.addOption('xiaoyan', '小燕 (女声) - 经典')
						.addOption('aisjiuxu', '爱思九旭 (男声) - 经典')
						.addOption('aisxping', '爱思小萍 (女声) - 经典')
						.addOption('aisjinger', '爱思金儿 (女声) - 经典')
						.addOption('aisbabyxu', '爱思宝旭 (男童声) - 经典')
						// 新版发音人
						.addOption('x2_xiaolu', '讯飞小露 (亲切女声)')
						.addOption('x2_yifei', '讯飞一菲 (甜美女声)')
						.addOption('x2_qige', '讯飞七哥 (磁性男声)')
						.addOption('x2_chaoge', '讯飞超哥 (磁性男声)')
						.addOption('x2_mengxiaoxin', '讯飞萌小新 (可爱男童)')
						.addOption('x2_xiaopeng', '讯飞小鹏 (成熟男声)')
						.addOption('x2_lingjiejie', '讯飞玲姐姐 (温柔女声)')
						.addOption('x2_songbaobao', '讯飞宋宝宝 (搞怪男声)')
						.addOption('x2_xiaojun', '讯飞小俊 (热情男声)')
						.addOption('x2_xiaonan', '讯飞小南 (知性女声)')
						.addOption('x2_chengcheng', '讯飞程程 (亲切女声)')
						.addOption('x2_xiaoxue', '讯飞小薛 (甜美女声)')
						.addOption('x2_yaoyao', '讯飞瑶瑶 (甜美女声)');
				}
				
				// 设置当前值，如果当前值不在新选项中，则设置为第一个选项
				const currentValue = this.plugin.settings.ttsVoice;
				const options = Array.from(dropdown.selectEl.options).map(option => option.value);
				if (options.includes(currentValue)) {
					dropdown.setValue(currentValue);
				} else {
					dropdown.setValue(options[0] || '');
					this.plugin.settings.ttsVoice = options[0] || '';
					void this.plugin.saveSettings();
				}
				
				dropdown.onChange(async (value) => {
					this.plugin.settings.ttsVoice = value;
					await this.plugin.saveSettings();
				});
				
				return dropdown;
			});
		};

		// 初始化选项
		updateVoiceOptions();

		const ttsSpeedSetting = new Setting(containerEl)
			.setName('语速')
			.setDesc('设置语音合成的语速 (0-100)');
		
		const ttsSpeedValueEl = ttsSpeedSetting.controlEl.createSpan({
			text: `${this.plugin.settings.ttsSpeed}`,
			cls: 'setting-slider-value'
		});
		
		ttsSpeedSetting.addSlider(slider => slider
			.setLimits(0, 100, 5)
			.setValue(this.plugin.settings.ttsSpeed)
			.onChange(async (value) => {
				this.plugin.settings.ttsSpeed = value;
				ttsSpeedValueEl.textContent = `${value}`;
				await this.plugin.saveSettings();
			}));

		const ttsVolumeSetting = new Setting(containerEl)
			.setName('音量')
			.setDesc('设置语音合成的音量 (0-100)');
		
		const ttsVolumeValueEl = ttsVolumeSetting.controlEl.createSpan({
			text: `${this.plugin.settings.ttsVolume}`,
			cls: 'setting-slider-value'
		});
		
		ttsVolumeSetting.addSlider(slider => slider
			.setLimits(0, 100, 5)
			.setValue(this.plugin.settings.ttsVolume)
			.onChange(async (value) => {
				this.plugin.settings.ttsVolume = value;
				ttsVolumeValueEl.textContent = `${value}`;
				await this.plugin.saveSettings();
			}));

		const ttsPitchSetting = new Setting(containerEl)
			.setName('音调')
			.setDesc('设置语音合成的音调 (0-100)');
		
		const ttsPitchValueEl = ttsPitchSetting.controlEl.createSpan({
			text: `${this.plugin.settings.ttsPitch}`,
			cls: 'setting-slider-value'
		});
		
		ttsPitchSetting.addSlider(slider => slider
			.setLimits(0, 100, 5)
			.setValue(this.plugin.settings.ttsPitch)
			.onChange(async (value) => {
				this.plugin.settings.ttsPitch = value;
				ttsPitchValueEl.textContent = `${value}`;
				await this.plugin.saveSettings();
			}));



		new Setting(containerEl)
			.setName('保存音频到 Vault')
			.setDesc('是否将生成的音频保存到 Obsidian Vault')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.saveAudioToVault)
				.onChange(async (value) => {
					this.plugin.settings.saveAudioToVault = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('音频保存路径')
			.setDesc('音频文件在 Vault 中的保存路径')
			.addText(text => text
				.setPlaceholder('voice-assistant/audio')
				.setValue(this.plugin.settings.audioSavePath)
				.onChange(async (value) => {
					this.plugin.settings.audioSavePath = value;
					await this.plugin.saveSettings();
				}));

		// 录音配置
		new Setting(containerEl).setName('录音').setHeading();
		
		new Setting(containerEl)
			.setName('采样率')
			.setDesc('音频采样率 (Hz)')
			.addDropdown(dropdown => dropdown
				.addOption('8000', '8000 Hz')
				.addOption('16000', '16000 Hz')
				.addOption('44100', '44100 Hz')
				.setValue(this.plugin.settings.sampleRate.toString())
				.onChange(async (value) => {
					this.plugin.settings.sampleRate = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('声道数')
			.setDesc('音频声道数')
			.addDropdown(dropdown => dropdown
				.addOption('1', '单声道')
				.addOption('2', '立体声')
				.setValue(this.plugin.settings.channels.toString())
				.onChange(async (value) => {
					this.plugin.settings.channels = parseInt(value);
					await this.plugin.saveSettings();
				}));

		// 测试按钮
		new Setting(containerEl)
			.setName('测试麦克风')
			.setDesc('测试麦克风录音功能')
			.addButton(button => button
				.setButtonText('测试录音')
				.onClick(async () => {
					try {
						new Notice('开始录音测试，请说话...');
						const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
						window.setTimeout(() => {
							stream.getTracks().forEach(track => track.stop());
							new Notice('录音测试完成');
						}, 3000);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						new Notice(`录音测试失败：${errorMessage}`);
					}
				}));

		// 持续对话配置
		new Setting(containerEl).setName('持续对话').setHeading();
		
		const dialogDurationSetting = new Setting(containerEl)
			.setName('持续对话时长')
			.setDesc('唤醒后保持对话状态的时长（秒）');
		
		const dialogDurationValueEl = dialogDurationSetting.controlEl.createSpan({
			text: `${this.plugin.settings.continuousDialogDuration}秒`,
			cls: 'setting-slider-value'
		});
		
		dialogDurationSetting.addSlider(slider => slider
			.setLimits(30, 300, 30)
			.setValue(this.plugin.settings.continuousDialogDuration)
			.onChange(async (value) => {
				this.plugin.settings.continuousDialogDuration = value;
				dialogDurationValueEl.textContent = `${value}秒`;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('显示对话控制界面')
			.setDesc('在持续对话模式下显示结束对话按钮')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showDialogControls)
				.onChange(async (value) => {
					this.plugin.settings.showDialogControls = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('对话保存文件夹')
			.setDesc('设置唤醒对话保存的文件夹路径（相对于库根目录）')
			.addText(text => text
				.setPlaceholder('voice-assistant/conversations')
				.setValue(this.plugin.settings.conversationSaveFolder)
				.onChange(async (value) => {
					this.plugin.settings.conversationSaveFolder = value || 'voice-assistant/conversations';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('启用语音打断')
			.setDesc('在TTS播放期间检测到语音输入时自动停止播放并开始新对话')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableVoiceInterruption)
				.onChange(async (value) => {
					this.plugin.settings.enableVoiceInterruption = value;
					await this.plugin.saveSettings();
				}));

		const voiceThresholdSetting = new Setting(containerEl)
			.setName('语音检测阈值')
			.setDesc('语音检测的音量阈值，数值越小越敏感（0-100）');
		
		const voiceThresholdValueEl = voiceThresholdSetting.controlEl.createSpan({
			text: `${this.plugin.settings.voiceDetectionThreshold}`,
			cls: 'setting-slider-value'
		});
		
		voiceThresholdSetting.addSlider(slider => slider
			.setLimits(10, 80, 5)
			.setValue(this.plugin.settings.voiceDetectionThreshold)
			.onChange(async (value) => {
				this.plugin.settings.voiceDetectionThreshold = value;
				voiceThresholdValueEl.textContent = `${value}`;
				await this.plugin.saveSettings();
			}));

		const voiceSensitivitySetting = new Setting(containerEl)
			.setName('检测敏感度')
			.setDesc('语音检测的时间间隔，数值越小检测越频繁（50-500毫秒）');
		
		const voiceSensitivityValueEl = voiceSensitivitySetting.controlEl.createSpan({
			text: `${this.plugin.settings.voiceDetectionSensitivity}ms`,
			cls: 'setting-slider-value'
		});
		
		voiceSensitivitySetting.addSlider(slider => slider
			.setLimits(50, 500, 25)
			.setValue(this.plugin.settings.voiceDetectionSensitivity)
			.onChange(async (value) => {
				this.plugin.settings.voiceDetectionSensitivity = value;
				voiceSensitivityValueEl.textContent = `${value}ms`;
				await this.plugin.saveSettings();
			}));

		// 自定义提示词配置
		new Setting(containerEl).setName('自定义提示词').setHeading();
		
		const promptsDesc = containerEl.createDiv('voice-assistant-description');
		promptsDesc.createEl('p', {
			text: '配置自定义提示词。当输入包含触发词时，插件会把对应提示词一并发送给所选模型。'
		});
		const promptExample = promptsDesc.createEl('p');
		promptExample.createEl('strong', { text: '示例：' });
		promptExample.appendText('触发词“提醒”，提示词“请生成一个 Markdown 格式的任务提醒”。');
		
		// 显示现有提示词
		this.displayCustomPrompts(containerEl);
		
		// 添加新提示词按钮
		new Setting(containerEl)
			.setName('添加新提示词')
			.setDesc('点击添加一个新的自定义提示词')
			.addButton(button => button
				.setButtonText('添加提示词')
				.setCta()
				.onClick(() => {
					this.addNewCustomPrompt(containerEl);
				}));

		// 测试功能
		new Setting(containerEl).setName('测试').setHeading();
		
		new Setting(containerEl)
			.setName('测试讯飞在线 ASR')
			.setDesc('测试语音识别功能是否正常工作')
			.addButton(button => button
				.setButtonText('测试 ASR')
				.onClick(() => {
					void this.plugin.testOnlineASR();
				}));

		new Setting(containerEl)
			.setName('测试讯飞在线 TTS')
			.setDesc('测试语音合成功能是否正常工作')
			.addButton(button => button
				.setButtonText('测试 TTS')
				.onClick(() => {
					void this.plugin.testOnlineTTS();
				}));

		new Setting(containerEl)
			.setName('测试TTS功能')
			.setDesc('测试基础TTS功能')
			.addButton(button => button
				.setButtonText('测试基础TTS')
				.onClick(() => {
					void this.plugin.testTTS();
				}));

		new Setting(containerEl)
			.setName('测试所有朗读人')
			.setDesc('测试所有可用的朗读人声音')
			.addButton(button => button
				.setButtonText('测试朗读人')
				.onClick(() => {
					void this.plugin.testAllVoiceSpeakers();
				}));

		new Setting(containerEl)
			.setName('调试TTS连接')
			.setDesc('调试TTS连接状态和配置')
			.addButton(button => button
				.setButtonText('调试TTS')
				.onClick(() => {
					void this.plugin.debugTTSConnection();
				}));

		new Setting(containerEl)
			.setName('调试文本内容')
			.setDesc('调试当前文本内容和处理状态')
			.addButton(button => button
				.setButtonText('调试文本')
				.onClick(() => {
					void this.plugin.debugTextContent();
				}));

		// 帮助信息
		new Setting(containerEl).setName('帮助').setHeading();

		const helpDiv = containerEl.createDiv('voice-assistant-help');
		helpDiv.createEl('strong', { text: '使用说明' });
		const providerHelp = helpDiv.createEl('p');
		providerHelp.appendText('1. 访问 ');
		providerHelp.createEl('a', {
			text: '讯飞开放平台',
			href: 'https://www.xfyun.cn/doc/',
			attr: { target: '_blank', rel: 'noopener noreferrer' }
		});
		providerHelp.appendText(' 获取 API 凭据。');
		helpDiv.createEl('p', { text: '2. 在上方设置中填写对应的 API 配置信息。' });
		helpDiv.createEl('strong', { text: '注意事项' });
		helpDiv.createEl('p', { text: '• 麦克风音频会发送到讯飞服务器进行处理。' });
		helpDiv.createEl('p', { text: '• API 凭据会保存在插件数据文件中，请妥善保管。' });
	}

	/**
	 * 显示唤醒词管理界面
	 */
	private displayWakeWords(container: HTMLElement): void {
		container.empty();
		
		const wakeWordsDiv = container.createDiv();
		new Setting(wakeWordsDiv).setName('唤醒词').setHeading();
		
		// 显示现有唤醒词
		this.plugin.settings.wakeWords.forEach((word, index) => {
			const wordDiv = wakeWordsDiv.createDiv({ cls: 'wake-word-item' });
			wordDiv.createSpan({ text: word });
			
			const deleteBtn = wordDiv.createEl('button', { text: '删除' });
			deleteBtn.onclick = async () => {
				this.plugin.settings.wakeWords.splice(index, 1);
				await this.plugin.saveSettings();
				this.displayWakeWords(container);
			};
		});
		
		// 添加新唤醒词
		const addDiv = wakeWordsDiv.createDiv('wake-word-add');
		const input = addDiv.createEl('input', { type: 'text', placeholder: '输入新唤醒词' });
		const addBtn = addDiv.createEl('button', { text: '添加' });
		
		addBtn.onclick = async () => {
			const newWord = input.value.trim();
			if (newWord && !this.plugin.settings.wakeWords.includes(newWord)) {
				this.plugin.settings.wakeWords.push(newWord);
				await this.plugin.saveSettings();
				this.displayWakeWords(container);
			}
		};
	}

	/**
	 * 显示自定义提示词列表
	 */
	private displayCustomPrompts(containerEl: HTMLElement): void {
		// 移除现有的提示词容器
		const existingContainer = containerEl.querySelector('.custom-prompts-container');
		if (existingContainer) {
			existingContainer.remove();
		}

		// 创建新的提示词容器
		const promptsContainer = containerEl.createDiv('custom-prompts-container');
		
		if (!this.plugin.settings.customPrompts || this.plugin.settings.customPrompts.length === 0) {
			promptsContainer.createEl('p', { text: '暂无自定义提示词' });
			return;
		}

		this.plugin.settings.customPrompts.forEach((prompt, index) => {
			const promptDiv = promptsContainer.createDiv('voice-assistant-prompt-card');

			// 提示词标题和启用状态
			const headerDiv = promptDiv.createDiv('voice-assistant-prompt-header');
			
			headerDiv.createSpan({ text: prompt.name, cls: 'voice-assistant-prompt-title' });

			const enableToggle = headerDiv.createEl('input', { type: 'checkbox' });
			enableToggle.checked = prompt.enabled;
			enableToggle.onchange = async () => {
				this.plugin.settings.customPrompts[index].enabled = enableToggle.checked;
				await this.plugin.saveSettings();
			};

			// 触发词
			const triggerDiv = promptDiv.createDiv('voice-assistant-prompt-trigger');
			triggerDiv.createEl('strong', { text: '触发词：' });
			triggerDiv.appendText(prompt.trigger);

			// 提示词内容
			const promptContentDiv = promptDiv.createDiv('voice-assistant-prompt-content');
			promptContentDiv.createEl('strong', { text: '提示词：' });
			promptContentDiv.createDiv({
				text: prompt.prompt,
				cls: 'voice-assistant-prompt-text'
			});

			// 操作按钮
			const actionsDiv = promptDiv.createDiv('voice-assistant-prompt-actions');

			const editBtn = actionsDiv.createEl('button', {
				text: '编辑',
				cls: 'voice-assistant-prompt-action'
			});
			editBtn.onclick = () => this.editCustomPrompt(containerEl, index);

			const deleteBtn = actionsDiv.createEl('button', {
				text: '删除',
				cls: ['voice-assistant-prompt-action', 'mod-warning']
			});
			deleteBtn.onclick = async () => {
				this.plugin.settings.customPrompts.splice(index, 1);
				await this.plugin.saveSettings();
				this.displayCustomPrompts(containerEl);
			};
		});
	}

	/**
	 * 添加新的自定义提示词
	 */
	private addNewCustomPrompt(containerEl: HTMLElement): void {
		const newPrompt = {
			name: '新提示词',
			trigger: '触发词',
			prompt: '请在这里输入提示词内容...',
			enabled: true
		};

		this.plugin.settings.customPrompts.push(newPrompt);
		void this.plugin.saveSettings().then(() => {
			this.displayCustomPrompts(containerEl);
			// 自动编辑新添加的提示词
			this.editCustomPrompt(containerEl, this.plugin.settings.customPrompts.length - 1);
		});
	}

	/**
	 * 编辑自定义提示词
	 */
	private editCustomPrompt(containerEl: HTMLElement, index: number): void {
		const prompt = this.plugin.settings.customPrompts[index];
		
		// 创建编辑对话框
		const modal = new Modal(this.app);
		modal.titleEl.textContent = '编辑自定义提示词';

		const { contentEl } = modal;

		// 名称输入
		new Setting(contentEl)
			.setName('提示词名称')
			.addText(text => text
				.setValue(prompt.name)
				.onChange(value => prompt.name = value));

		// 触发词输入
		new Setting(contentEl)
			.setName('触发词')
			.setDesc('当用户输入包含此词时触发')
			.addText(text => text
				.setValue(prompt.trigger)
				.onChange(value => prompt.trigger = value));

		// 提示词内容输入
		new Setting(contentEl)
			.setName('提示词内容')
			.setDesc('发送给大模型的提示词')
			.addTextArea(text => text
				.setValue(prompt.prompt)
				.onChange(value => prompt.prompt = value));

		// 保存按钮
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('保存')
				.setCta()
				.onClick(async () => {
					await this.plugin.saveSettings();
					this.displayCustomPrompts(containerEl);
					modal.close();
				}))
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => modal.close()));

		modal.open();
	}
}
