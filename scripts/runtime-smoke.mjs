import { createHmac, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/**
 * 为打包后的插件提供最小 Obsidian API 替身。
 * 冒烟测试只加载模块并验证纯函数，不执行插件生命周期。
 */
function createObsidianStub() {
	class Base {}
	return {
		App: Base,
		Editor: Base,
		MarkdownView: Base,
		Modal: class {},
		Notice: class {},
		Plugin: class {},
		PluginSettingTab: class {},
		Setting: class {},
		requestUrl: async () => {
			throw new Error('冒烟测试不应发起网络请求');
		},
	};
}

/**
 * 加载最终 CommonJS 产物，并暴露需要回归验证的编码与签名函数。
 * 如果打包产物意外引入 crypto-js 等运行时依赖，require 会立即报错。
 */
async function loadBundleForTest() {
	const code = await readFile(new URL('../main.js', import.meta.url), 'utf8');
	const sandbox = {
		module: { exports: {} },
		exports: {},
		require: (id) => {
			if (id === 'obsidian') {
				return createObsidianStub();
			}
			throw new Error(`发现意外运行时依赖: ${id}`);
		},
		window: {
			crypto: webcrypto,
			btoa,
			atob,
			AudioContext: class {},
		},
		TextEncoder,
		Uint8Array,
		ArrayBuffer,
		Blob,
		Error,
		JSON,
		String,
		console,
	};

	vm.runInNewContext(
		`${code}\nmodule.exports.__test = { encodeUtf8ToBase64, hmacSha256Base64 };`,
		sandbox,
	);
	return sandbox.module.exports;
}

const bundle = await loadBundleForTest();
if (typeof bundle.default !== 'function') {
	throw new Error('打包产物没有导出 Obsidian 插件类');
}

const utf8Base64 = bundle.__test.encodeUtf8ToBase64('\u4f60\u597d');
if (utf8Base64 !== '5L2g5aW9') {
	throw new Error(`UTF-8 Base64 编码结果不一致: ${utf8Base64}`);
}

const message = 'The quick brown fox jumps over the lazy dog';
const webCryptoSignature = await bundle.__test.hmacSha256Base64('key', message);
const nodeSignature = createHmac('sha256', 'key').update(message).digest('base64');
if (webCryptoSignature !== nodeSignature) {
	throw new Error(`HMAC-SHA256 签名结果不一致: ${webCryptoSignature} !== ${nodeSignature}`);
}

console.info('运行时冒烟测试通过：打包加载、UTF-8 Base64 和 HMAC-SHA256 结果一致。');
