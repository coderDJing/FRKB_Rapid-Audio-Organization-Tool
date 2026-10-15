const tseslint = require('@electron-toolkit/eslint-config-ts')
const prettier = require('@electron-toolkit/eslint-config-prettier')
const vue = require('eslint-plugin-vue')
const tsParser = require('@typescript-eslint/parser')
const vueParser = require('vue-eslint-parser')

module.exports = [
  {
    ignores: [
      'node_modules',
      'dist',
      'out',
      '.gitignore',
      'build/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/.temp/**',
      'docs/.vitepress/temp/**'
    ]
  },
  {
    languageOptions: {
      globals: {
        NodeJS: 'readonly'
      }
    }
  },
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  prettier,
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser
      }
    }
  },
  {
    files: ['src/renderer/src/workers/*.worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        currentTime: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly'
      }
    }
  },
  {
    rules: {
      // Keep new ESLint 10 recommendations visible while existing code is migrated.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/require-v-for-key': 'off',
      'vue/no-unused-vars': 'off',
      'no-control-regex': 'off',
      'prefer-const': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off'
    }
  }
]
