// @ts-check

import eslint from '@eslint/js';
import globals from 'globals';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.jsx'], // Apply to both .js and .jsx files
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true, // Enable JSX parsing
        },
      },
      globals: {
        ...globals.node, // Remove globals.browser as it's added manually below
        React: 'readonly', // Add React if it's a global
        chrome: 'readonly', // Add chrome global
        browser: 'readonly', // Add browser global
        document: 'readonly',
        window: 'readonly',
        WebSocket: 'readonly',
        NodeFilter: 'readonly',
        InputEvent: 'readonly',
        MouseEvent: 'readonly',
        MutationObserver: 'readonly',
        location: 'readonly',
        // Add any other global variables your project uses
      }
    },
    settings: {
      react: {
        version: 'detect', // Automatically detect React version
      },
    },
    rules: {
      // Add any project-specific rules here
      'no-unused-vars': 'warn',
      'no-console': 'off',
      // Add React specific rules if needed, e.g.:
      // 'react/jsx-uses-react': 'error',
      // 'react/jsx-uses-vars': 'error',
    }
  }
];
