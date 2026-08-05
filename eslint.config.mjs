import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

/**
 * Obsidian 社区插件的本地审核配置。
 *
 * 直接复用 Obsidian 官方提供的推荐规则，以便在发布前发现
 * 类型安全、多窗口兼容性、DOM 操作和 manifest 等问题。
 */
export default defineConfig([
	{
		// main.js 是 esbuild 产物；源码告警应在 main.ts 中修复，避免对同一问题重复计数。
		ignores: ['main.js', 'scripts/**', 'eslint.config.mjs'],
	},
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// 界面以中文为主，且包含 OpenRouter、Google AI Studio 等官方品牌大小写。
			// 英文 sentence-case 自动建议会错改品牌名，与社区页当前展示的告警也无关。
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
]);
