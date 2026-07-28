import pluginSecurity from 'eslint-plugin-security';
import baseConfig from './eslint.config.js';

export default [
  ...baseConfig,
  {
    files: ['packages/*/src/**/*.ts'],
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
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-non-literal-regexp': 'error',
    },
  },
];
