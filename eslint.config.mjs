import jsdoc from 'eslint-plugin-jsdoc'
import tsParser from '@typescript-eslint/parser'

export default [
    {
        ignores: ['**/dist/**']
    },
    {
        files: ['**/*.js'],
        plugins: {
            jsdoc: jsdoc
        },
        rules: {
            'jsdoc/require-description': 'error',
            'jsdoc/check-values': 'error'
        }
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module'
            }
        },
        plugins: {
            jsdoc: jsdoc
        },
        rules: {
            'jsdoc/require-description': 'error',
            'jsdoc/check-values': 'error'
        }
    }
]
