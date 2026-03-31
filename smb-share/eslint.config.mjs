export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // ─── Bug catchers ───────────────────────────────────────
      'no-undef': 'error',              // catch typos and missing requires
      'no-unused-vars': ['warn', {
        vars: 'all',
        args: 'none',                   // handler signatures often have unused params
        caughtErrors: 'none',           // catch(e) {} is intentional in this codebase
      }],
      'no-redeclare': 'error',          // accidental var shadowing
      'no-dupe-keys': 'error',          // duplicate keys in object literals
      'no-duplicate-case': 'error',     // duplicate case labels in switch
      'no-unreachable': 'warn',         // dead code after return/break
      'no-constant-condition': 'warn',  // if(true), while(false), etc.
      'no-self-assign': 'error',        // x = x
      'no-self-compare': 'error',       // x === x
      'no-template-curly-in-string': 'warn', // likely template literal mistake
      'use-isnan': 'error',             // NaN comparisons
      'valid-typeof': 'error',          // typeof x === 'strig'
      'eqeqeq': ['warn', 'smart'],     // prefer === but allow == null
      'no-throw-literal': 'warn',       // throw 'string' → throw new Error(...)

      // ─── Intentionally OFF ──────────────────────────────────
      // The codebase uses var intentionally for clarity/compatibility
      'no-var': 'off',
      'prefer-const': 'off',
      'prefer-template': 'off',
      'no-plusplus': 'off',
      // We use console.log for server output
      'no-console': 'off',
    },
  },
  {
    // Ignore node_modules and share directory (user files)
    ignores: ['node_modules/**', 'share/**'],
  },
];
