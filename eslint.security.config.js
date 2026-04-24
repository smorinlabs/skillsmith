import tsParser from '@typescript-eslint/parser';
import pluginSecurity from 'eslint-plugin-security';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'docs/**',
      'research/**',
      'scripts/**',
      'packages/*/tests/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      security: pluginSecurity,
    },
    rules: {
      ...pluginSecurity.configs.recommended.rules,
      // High false-positive rules disabled for this codebase:
      // - object-injection flags every obj[variable] access (half of normal JS)
      // - non-literal-fs-filename is designed for web servers; a CLI reading
      //   user-configured paths is the intended behavior, not a vulnerability
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
];
